# admin-panel

The internal billing panel for Converse360: subscriber accounts, subscription
amounts, sales figures, and the user list.

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

| Route                   | Purpose                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `/`                     | MRR, at-risk and trial value, trials ending, renewals due, recent signups                 |
| `/subscribers`          | Every subscription, searchable and filterable by status/plan                              |
| `/subscribers/[userId]` | Edit one subscription; usage vs plan limits; account activity                             |
| `/sales`                | MRR/ARR, splits by plan / cycle / payment method, 12-month movement, expected collections |
| `/plans`                | The subscription amounts themselves — prices, trial length, limits                        |
| `/users`                | Everyone with a login, including users who never onboarded                                |

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

## Things it deliberately does not do

- **Attribute changes.** `user_subscriptions.manually_assigned_by` is a FK to
  `auth.users`, and this panel's administrator is an env credential, not a row in
  that table. Changes are therefore not attributable in the database; an audit
  table would be the fix.
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
