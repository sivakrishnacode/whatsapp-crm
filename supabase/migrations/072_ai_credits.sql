-- ============================================================
-- 072_ai_credits.sql — AI stops being bring-your-own-key only.
--
-- Until now every AI call ran on the account's own provider key, which
-- is why there was deliberately no quota anywhere in the AI module: the
-- provider billed the customer directly and a cap we invented would
-- have been theatre (see 069's note on test mode).
--
-- That changes here. A workspace may now run the agent on OUR Gemini
-- key, and when it does, WE pay the provider. So there has to be a
-- meter, and the meter has to be honest about three things:
--
--   1. WHOSE KEY IS IN USE. `ai_configs.credit_mode` is the explicit
--      choice — 'platform' (our key, spends credits) or 'byok' (their
--      key, spends nothing). It is a stored choice rather than an
--      inference from "is there a key present", because a workspace
--      that pasted a key months ago must not silently start paying us,
--      and a workspace that bought credits must not watch them sit
--      unused while their own Google bill grows.
--
--   2. WHAT A CREDIT COSTS US. Credits are metered from real token
--      counts, not per-action: an account with a large knowledge base
--      and tool-heavy skills costs several times what a one-line draft
--      costs, and a flat charge would overcharge the small user to
--      subsidise the large one. `ai_credit_ledger` stores the token
--      counts next to the charge so any bill is auditable back to the
--      call that caused it.
--
--   3. WHAT WAS ACTUALLY DEDUCTED. A call is gated on balance >= 1 but
--      its true cost is only known after the provider answers, so the
--      last call on a nearly-empty wallet can cost more than is left.
--      `consume_ai_credits` charges what is there and no more — the
--      shortfall is ours. A customer never ends a call owing us money.
--
-- MONEY IS BIGINT MINOR UNITS (paise), matching the ads module and
-- Razorpay's own API. No DECIMAL, no float rupees.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. ai_configs — which key powers this workspace's agent.
-- ============================================================

-- A platform-mode workspace has no key of its own, and every account
-- created from here on starts that way. `api_key` has been NOT NULL
-- since 029, when a key was the only way to use AI at all.
ALTER TABLE ai_configs ALTER COLUMN api_key DROP NOT NULL;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS credit_mode text NOT NULL DEFAULT 'platform';

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_credit_mode_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_credit_mode_check
  CHECK (credit_mode IN ('platform', 'byok'));

COMMENT ON COLUMN ai_configs.credit_mode IS
  'platform = runs on our Gemini key and spends ai_credit_wallets.balance; byok = runs on this row''s own api_key and spends nothing.';

-- Every row that exists before this migration was created by someone
-- pasting their own key — that is the only way ai_configs could exist.
-- Defaulting them to 'platform' would move a working agent onto our
-- bill without anybody asking for it.
UPDATE ai_configs SET credit_mode = 'byok'
WHERE api_key IS NOT NULL AND credit_mode = 'platform';

-- ============================================================
-- 2. ai_credit_wallets — one row per workspace, the fast read.
--
-- `balance` is the only number the badge in the header needs, and it is
-- the only number a hot path (every AI call) may touch. The ledger
-- below is the truth; this is the running total kept in step with it by
-- the two functions at the bottom of this file, which are the ONLY
-- supported way to move it.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_credit_wallets (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  balance                integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  -- Whether the one-time welcome grant has been given. A column rather
  -- than a ledger scan so re-granting is impossible even under a race.
  signup_granted_at      timestamptz,
  lifetime_purchased     integer NOT NULL DEFAULT 0,
  lifetime_consumed      integer NOT NULL DEFAULT 0,
  -- Set when the "running low" notification fires, cleared on top-up,
  -- so we warn once per depletion rather than on every reply.
  low_balance_notified_at timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ai_credit_wallets IS
  'Current AI credit balance per workspace. Derived from ai_credit_ledger; move it only via grant_ai_credits/consume_ai_credits.';

-- ============================================================
-- 3. ai_credit_ledger — every movement, append-only.
--
-- This is the audit trail behind an invoice dispute: what was charged,
-- for which feature, on which model, for how many tokens. Nothing here
-- is ever updated or deleted; a correction is a compensating row.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_credit_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Signed: negative is consumption, positive is a grant or purchase.
  delta           integer NOT NULL,
  balance_after   integer NOT NULL,
  reason          text NOT NULL CHECK (reason IN (
                    'signup_grant', 'purchase', 'usage', 'refund',
                    'plan_grant', 'admin_adjust'
                  )),
  -- Which part of the product spent it. Null on grants.
  feature         text CHECK (feature IN (
                    'draft', 'auto_reply', 'playground', 'embedding'
                  )),
  provider        text,
  model           text,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  order_id        uuid,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_credit_ledger_account
  ON ai_credit_ledger(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_credit_ledger_order
  ON ai_credit_ledger(order_id) WHERE order_id IS NOT NULL;

-- ============================================================
-- 4. ai_credit_packs — what may be bought, priced in the database.
--
-- A table rather than a constant so a price can be corrected without a
-- deploy, and — more importantly — so the server can look up what a
-- pack costs instead of believing an amount the browser sent it.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_credit_packs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  display_name text NOT NULL,
  credits      integer NOT NULL CHECK (credits > 0),
  -- Minor units. 29900 = Rs 299.00.
  price_minor  bigint NOT NULL CHECK (price_minor > 0),
  currency     text NOT NULL DEFAULT 'INR',
  -- Rendered as a "Popular"/"Best value" ribbon; purely cosmetic.
  badge        text,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN ai_credit_packs.price_minor IS
  'Minor units (paise). 29900 = Rs 299.00. Never a decimal — see the ads module note on money units.';

-- Priced against a measured ~Rs 0.15 provider cost per reply on Gemini
-- Flash, and against the Rs 300/Rs 500 monthly plans: the entry pack has
-- to sit under a month of the product or the add-on reads as the more
-- expensive thing.
INSERT INTO ai_credit_packs (code, display_name, credits, price_minor, currency, badge, sort_order)
VALUES
  ('credits_1k',  '1,000 credits',  1000,   29900, 'INR', NULL,         10),
  ('credits_3k',  '3,000 credits',  3000,   79900, 'INR', 'Popular',    20),
  ('credits_10k', '10,000 credits', 10000, 229900, 'INR', 'Best value', 30),
  ('credits_25k', '25,000 credits', 25000, 499900, 'INR', NULL,         40)
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- 5. ai_credit_orders — a top-up in flight.
--
-- The row is written BEFORE the customer is sent to Razorpay, carrying
-- the credits and the amount we decided. Verification then compares
-- what Razorpay says was paid against this row — never against anything
-- the browser posts back. Without it, "I paid for 25,000 credits" is a
-- claim the client gets to make.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_credit_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  pack_id             uuid REFERENCES ai_credit_packs(id) ON DELETE SET NULL,
  pack_code           text NOT NULL,
  credits             integer NOT NULL CHECK (credits > 0),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            text NOT NULL DEFAULT 'INR',
  status              text NOT NULL DEFAULT 'created'
                      CHECK (status IN ('created', 'paid', 'failed')),
  gateway             text NOT NULL DEFAULT 'razorpay',
  -- UNIQUE so the webhook and the browser callback racing each other
  -- resolve to the same row, and `credited_at` below makes the credit
  -- itself happen once.
  gateway_order_id    text UNIQUE,
  gateway_payment_id  text,
  -- The idempotency latch. Set inside the same transaction that moves
  -- the balance; a second confirmation finds it non-null and stops.
  credited_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_credit_orders_account
  ON ai_credit_orders(account_id, created_at DESC);

-- ============================================================
-- 6. Balance movement. These two functions are the only supported
--    writers of ai_credit_wallets.balance, and each one writes its
--    ledger row in the same statement — a balance that moved without a
--    ledger entry is an unauditable charge.
--
--    SECURITY INVOKER, and EXECUTE revoked from PUBLIC: apps/api
--    connects as the owner and needs no elevation, while a SECURITY
--    DEFINER function granted to `authenticated` would be a
--    mint-your-own-credits endpoint reachable from any browser session
--    (the trap documented in CLAUDE.md, and the bug migration 032 had
--    to undo).
-- ============================================================

CREATE OR REPLACE FUNCTION public.grant_ai_credits(
  p_account_id uuid,
  p_amount     integer,
  p_reason     text,
  p_order_id   uuid DEFAULT NULL,
  p_user_id    uuid DEFAULT NULL,
  p_note       text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'grant_ai_credits: amount must be positive (got %)', p_amount;
  END IF;

  INSERT INTO ai_credit_wallets (account_id, balance, lifetime_purchased)
  VALUES (
    p_account_id,
    p_amount,
    CASE WHEN p_reason = 'purchase' THEN p_amount ELSE 0 END
  )
  ON CONFLICT (account_id) DO UPDATE
    SET balance = ai_credit_wallets.balance + p_amount,
        lifetime_purchased = ai_credit_wallets.lifetime_purchased
          + CASE WHEN p_reason = 'purchase' THEN p_amount ELSE 0 END,
        -- Topping up clears the low-balance warning, so the next
        -- depletion is announced again rather than silently.
        low_balance_notified_at = NULL,
        updated_at = now()
  RETURNING balance INTO v_balance;

  INSERT INTO ai_credit_ledger (
    account_id, delta, balance_after, reason, order_id, user_id, note
  ) VALUES (
    p_account_id, p_amount, v_balance, p_reason, p_order_id, p_user_id, p_note
  );

  RETURN v_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_ai_credits(uuid, integer, text, uuid, uuid, text) FROM PUBLIC;

-- Charge for one AI call. Returns the number of credits ACTUALLY taken,
-- which is `p_amount` in every normal case and less only when the call
-- outran what was left — the caller gated on balance >= 1, but the true
-- cost is not knowable until the provider has answered. Eating that
-- shortfall costs us a fraction of a rupee; the alternative is a
-- customer with a negative balance to clear before the agent works.
CREATE OR REPLACE FUNCTION public.consume_ai_credits(
  p_account_id      uuid,
  p_amount          integer,
  p_feature         text,
  p_provider        text DEFAULT NULL,
  p_model           text DEFAULT NULL,
  p_input_tokens    integer DEFAULT 0,
  p_output_tokens   integer DEFAULT 0,
  p_conversation_id uuid DEFAULT NULL,
  p_user_id         uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_charged integer;
  v_balance integer;
BEGIN
  IF p_amount <= 0 THEN
    RETURN 0;
  END IF;

  -- One statement, so two concurrent replies on the same workspace
  -- cannot both read the same balance and each subtract from it. The
  -- CTE exists because RETURNING only sees the NEW row, and what was
  -- actually charged is the difference between the two — which matters
  -- precisely in the case that needs auditing, the call that drained
  -- the wallet.
  WITH locked AS (
    SELECT account_id, balance
      FROM ai_credit_wallets
     WHERE account_id = p_account_id
       FOR UPDATE
  ), moved AS (
    UPDATE ai_credit_wallets w
       SET balance = w.balance - LEAST(p_amount, w.balance),
           lifetime_consumed = w.lifetime_consumed + LEAST(p_amount, w.balance),
           updated_at = now()
      FROM locked l
     WHERE w.account_id = l.account_id
    RETURNING l.balance - w.balance AS charged, w.balance AS remaining
  )
  SELECT charged, remaining INTO v_charged, v_balance FROM moved;

  IF NOT FOUND THEN
    -- No wallet: nothing to charge against. The caller's pre-check
    -- should have stopped this, so it is worth a ledger-free zero
    -- rather than creating a wallet as a side effect of spending.
    RETURN 0;
  END IF;

  IF v_charged <= 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO ai_credit_ledger (
    account_id, delta, balance_after, reason, feature,
    provider, model, input_tokens, output_tokens,
    conversation_id, user_id
  ) VALUES (
    p_account_id, -v_charged, v_balance, 'usage', p_feature,
    p_provider, p_model, p_input_tokens, p_output_tokens,
    p_conversation_id, p_user_id
  );

  RETURN v_charged;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_ai_credits(uuid, integer, text, text, text, integer, integer, uuid, uuid) FROM PUBLIC;

-- ============================================================
-- 7. RLS.
--
-- apps/api writes all of this as the database owner, so no policy here
-- is what protects a write — the service layer's account scoping is.
-- These policies exist so the browser can READ its own wallet and
-- history through PostgREST without a round trip, and so that a future
-- direct-from-browser query cannot see another tenant's spend.
--
-- There are deliberately NO insert/update/delete policies: nothing
-- outside the two functions above may move a balance.
-- ============================================================
ALTER TABLE ai_credit_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_credit_ledger  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_credit_orders  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_credit_packs   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_credit_wallets_select ON ai_credit_wallets;
CREATE POLICY ai_credit_wallets_select ON ai_credit_wallets
  FOR SELECT USING (is_account_member(account_id));

-- Spend history is a billing record: admins and owners, not every agent.
DROP POLICY IF EXISTS ai_credit_ledger_select ON ai_credit_ledger;
CREATE POLICY ai_credit_ledger_select ON ai_credit_ledger
  FOR SELECT USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_credit_orders_select ON ai_credit_orders;
CREATE POLICY ai_credit_orders_select ON ai_credit_orders
  FOR SELECT USING (is_account_member(account_id, 'admin'));

-- The price list is the same for everyone and is shown on a page you
-- must be signed in to reach.
DROP POLICY IF EXISTS ai_credit_packs_select ON ai_credit_packs;
CREATE POLICY ai_credit_packs_select ON ai_credit_packs
  FOR SELECT TO authenticated USING (is_active);

-- ============================================================
-- 8. Backfill: every existing workspace gets the welcome grant.
--
-- Accounts that predate this migration have never had a chance to try
-- the agent without first going and buying a provider key, which is
-- exactly the friction the platform key removes. They start level with
-- a workspace signing up tomorrow.
-- ============================================================
DO $$
DECLARE
  v_account record;
BEGIN
  FOR v_account IN
    SELECT a.id FROM accounts a
    LEFT JOIN ai_credit_wallets w ON w.account_id = a.id
    WHERE w.id IS NULL
  LOOP
    PERFORM grant_ai_credits(
      v_account.id, 250, 'signup_grant', NULL, NULL,
      'Welcome credits'
    );
    UPDATE ai_credit_wallets
       SET signup_granted_at = now()
     WHERE account_id = v_account.id;
  END LOOP;
END;
$$;
