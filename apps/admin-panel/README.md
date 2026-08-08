# admin-panel

The internal operations panel for Converse360: subscriptions and the amounts
behind them, the tenant workspaces and who is inside them, and the AI credit
wallets that run on our own Gemini key.

Next.js 16 (App Router) on port **3002**. It reads and writes the same Supabase
Postgres the CRM uses, through Prisma — the schema comes from
[`@repo/database`](../../packages/database), so there is no second copy of it and
no new endpoints in `apps/api`.

## Setup

```bash
cp apps/admin-panel/.env.local.example apps/admin-panel/.env.local
# fill in ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_SESSION_SECRET,
# and copy DATABASE_URL out of apps/api/.env
npm run dev --workspace=admin-panel   # http://localhost:3002
```

`openssl rand -base64 48` for the session secret.

## Auth

One administrator, defined by `ADMIN_USERNAME` / `ADMIN_PASSWORD` in the env
file. No user table, no sign-up, no password reset — rotating the env value _is_
the reset, and rotating `ADMIN_SESSION_SECRET` is the "sign everyone out" button.

- Credentials are compared timing-safely (`lib/auth.ts`), username
  case-insensitively.
- A session is an HS256 JWT in an `httpOnly` cookie, 12 hours by default
  (`ADMIN_SESSION_TTL_HOURS`).
- `proxy.ts` bounces anonymous requests, but it is only a redirect convenience.
  Every page and every Server Action calls `requireAdmin()` itself, because a
  Server Action is reachable by direct POST regardless of what the proxy did.
- Failed logins are throttled per IP, in-memory: 10 per 5 minutes. That is a
  speed bump for a single container, not a distributed rate limit — behind more
  than one replica, put the real limit in the reverse proxy.

Deploy it on a hostname you control, loopback-bound behind the host proxy. It can
change what customers are charged.

## What the pages do

| Route                     | Purpose                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `/`                       | MRR, at-risk and trial value, AI credit position, trials ending, renewals due             |
| `/subscribers`            | Every subscription, searchable and filterable by status/plan                              |
| `/subscribers/[userId]`   | Edit one subscription; usage vs plan limits; account activity                             |
| `/sales`                  | MRR/ARR, splits by plan / cycle / payment method, 12-month movement, expected collections |
| `/plans`                  | The subscription amounts themselves — prices, trial length, limits                        |
| `/workspaces`             | Every tenant account: people, plan, channels, credits, what they've built                 |
| `/workspaces/[accountId]` | One workspace — membership, credit adjustments, AI setup, channel health                  |
| `/users`                  | Everyone with a login, including users who never onboarded                                |
| `/credits`                | AI credits across tenants: spend, top-up revenue, packs, manual adjustments               |
| `/audit`                  | Every write this panel has made, and by whom                                              |

## Workspaces and the people in them

A workspace is an `accounts` row; the people are `profiles` hanging off it. The
membership actions mirror what the CRM's own team screen does, and they have to
be re-implemented rather than reused: `set_member_role`,
`remove_account_member` and `transfer_account_ownership` (migration 018) all
authorise via `auth.uid()`, which is NULL for this panel's owner connection, so
every one of them refuses. Relaxing that check would remove the guard from the
customer's path too. `lib/actions/workspaces.ts` restates the rules and must
stay in step with 018.

- **Removing someone does not delete their login.** Their profile moves to a
  workspace of their own, as its owner — the same thing the RPC does. A user
  with no profile is read by the CRM as "never onboarded" and bounced into
  `/welcome` to buy a plan for a workspace they didn't ask for.
- **A workspace's plan is its owner's subscription.** `user_subscriptions` is
  keyed by user and `OnboardingService` always writes it for
  `accounts.owner_user_id`. So transferring ownership moves the subscription row
  too, or the workspace reads as having no plan while a person who no longer
  runs it keeps being billed. Usage counters (`usage_tracking`, also keyed by
  user) do **not** move; the panel says so when it happens.
- **Any other member holding a subscription row is surfaced, not summed.** Two
  subscriptions in one workspace means somebody is paying for a plan nobody
  uses.
- **One owner per workspace** (`idx_accounts_one_per_owner`). Promoting someone
  who already owns another workspace is refused with that sentence rather than a
  constraint violation in the logs.
- Nothing here writes to `auth.users`. Banning or deleting a login is Supabase's
  admin API — a SQL `UPDATE` on `banned_until` skips the session revocation that
  makes it take effect, so the panel would be reporting a lie.

## AI credits

A workspace on `credit_mode = 'platform'` runs the agent on **our** Gemini key
and is metered against `ai_credit_wallets`; one on `byok` uses its own provider
key and is metered by nobody. The panel can top a wallet up or claw credits
back, and the balance only ever moves through `admin_adjust_ai_credits`
(migration 073) — the third and last supported writer, alongside 072's
`grant_ai_credits` and `consume_ai_credits`. A Prisma update on `balance` would
be a bug however carefully written: concurrent auto-replies meter the same
wallet, and the ledger row has to be written in the same statement as the move.

- **A manual grant is not a purchase.** It leaves `lifetime_purchased` alone, so
  top-up revenue stays equal to what customers actually paid, and it writes
  `feature = NULL`, so spend-by-feature never gains a phantom bucket.
- **A deduction takes only what is there.** `balance >= 0` is a CHECK
  constraint, and a negative wallet would mean a customer clearing a debt before
  the agent answers anybody. The panel reports what actually moved.
- **The reason is required**, and it lands twice: in the ledger note (with the
  operator's name, composed inside the SQL function) and in the audit log.
- `ADMIN_MAX_CREDIT_ADJUSTMENT` is a server-side ceiling independent of the
  form, defaulting to the largest purchasable pack.
- **⚠️ Credit money is in minor units.** `ai_credit_orders.amount_minor` and
  `ai_credit_packs.price_minor` are BIGINT paise; `subscription_plans.price_*`
  next door are major-unit decimals. Every minor-unit field is named
  `...Minor` and `minorToMajor()` in `lib/format.ts` is the only conversion.
  Never add one to an MRR figure.
- Credit pack prices are editable here, which is the point of them living in a
  table. Repricing does **not** rewrite history: an order records the amount it
  was charged.

## The audit log

Every write records a row in `admin_audit_log` (migration 073) with the
signed-in `ADMIN_USERNAME`, a stable dotted action, and a sentence written at the
time. It has **no foreign keys on purpose** — "who removed this workspace" is a
question you ask after the workspace is gone. RLS is on with no policies and
rights are revoked from `anon`/`authenticated`, so only an owner connection can
read it.

It starts at migration 073. Changes before that were not recorded, because
`user_subscriptions.manually_assigned_by` is a FK to `auth.users` and this
panel's administrator is an env credential — there was no column with an honest
value to write.

## Where the money numbers come from

**There is no payments or invoices table in this database.** `user_subscriptions`
records what someone is _on_, not what was _collected_ — no amount column, no
transaction history. So every figure in this panel is derived:

> amount for a period = the plan's price for that subscription's billing cycle

Which means:

- **MRR, ARR and expected collections are exact** statements about the current
  subscription set. MRR counts `active` only; `trial` and `past_due` are reported
  separately so the headline is never propped up by revenue that isn't arriving.
- **Historical revenue is not recoverable.** Editing a plan price rewrites what
  every past month appears to have earned. That is why the 12-month chart plots
  _counts of subscriptions started and ended_, never money.
- **A renewal listed as "due" is not a scheduled charge.** It means a period ends
  then. A subscription with no gateway subscription attached will not bill itself.

If you need real revenue history — what was actually charged, when, and whether
it succeeded — that needs a payments ledger the app writes to on every successful
charge. See `lib/queries/sql.ts`, which is where this reasoning lives in code.

**The one exception is AI credits.** `ai_credit_orders` records an amount
Razorpay actually collected and `ai_credit_ledger` records every credit that
moved, so `/credits` is allowed to put money and consumption on a time axis —
those numbers do not change when a pack is repriced. `lib/queries/credits.ts`
opens with why.

## Things it deliberately does not do

- **Change what powers a workspace's AI.** `credit_mode` is read-only here.
  Switching a `byok` workspace to platform mode would move their inference onto
  our bill without them asking, and switching the other way needs a provider key
  only they have. The customer owns that choice in the agent studio.
- **Delete a workspace.** It would cascade through contacts, conversations,
  messages, broadcasts, flows and the WhatsApp connection. Not a thing to have
  one click from a support screen.
- **Ban or delete a login.** That is Supabase's admin API; a SQL write to
  `auth.users.banned_until` skips session revocation and takes no effect.
- **Touch payment gateways.** Editing a price here does not change anything at
  Stripe or Razorpay, and gateway ids are read-only on the plans page. Detaching
  a gateway subscription is an explicit action, never a side effect of changing a
  plan — the api's own admin endpoint clears those ids on every manual
  assignment, which silently orphans a live subscription that keeps charging.
- **Call `apps/api`.** All reads and writes go through Prisma directly.

## Commands

```bash
npm run dev --workspace=admin-panel        # port 3002
npm run build --workspace=admin-panel
npm run typecheck --workspace=admin-panel
npm run lint --workspace=admin-panel
```

After editing the Prisma schema, run `npm run db:generate` from the repo root.
