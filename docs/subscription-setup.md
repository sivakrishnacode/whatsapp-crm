# Subscription System Setup Guide

## Running the Migration

### Option 1: Using psql (CLI - Recommended)

Get your database connection string from Supabase:
1. Go to your Supabase project dashboard
2. Navigate to **Settings → Database**
3. Copy the **Connection string** (URI format)

Then run:

```bash
psql "postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT].supabase.co:5432/postgres" -f supabase/migrations/044_subscription_system.sql
```

Or with individual parameters:

```bash
psql -h db.[YOUR-PROJECT].supabase.co -U postgres -d postgres -f supabase/migrations/044_subscription_system.sql
```

### Option 2: Using the Script

```bash
# Make sure your environment variables are set
# NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY

npx tsx scripts/run-migration.ts
```

### Option 3: Supabase Dashboard

1. Go to your Supabase project dashboard
2. Navigate to **SQL Editor** in the left sidebar
3. Click **New Query**
4. Copy the contents of `supabase/migrations/044_subscription_system.sql`
5. Paste it into the SQL editor
6. Click **Run** to execute the migration

## What the Migration Does

- Creates `subscription_plans` table with FREE, STARTER, and GROWTH plans
- Creates `user_subscriptions` table to track user subscriptions
- Creates `usage_tracking` table to monitor resource usage
- Adds RPC functions for subscription management
- Backfills existing users with FREE plan
- Sets up Row Level Security (RLS) policies

## Environment Variables

Add these to your `.env.local` file:

```bash
# Stripe (optional - for Stripe payments)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Razorpay (optional - for Razorpay payments)
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=secret_...
```

## Configure Payment Gateways

### Stripe

1. Go to [Stripe Dashboard](https://dashboard.stripe.com/)
2. Create products for STARTER and GROWTH plans
3. Create prices for monthly and yearly billing
4. Copy the price IDs
5. Update the `subscription_plans` table:

```sql
UPDATE subscription_plans 
SET stripe_price_id_monthly = 'price_...',
    stripe_price_id_yearly = 'price_...'
WHERE name = 'STARTER';

UPDATE subscription_plans 
SET stripe_price_id_monthly = 'price_...',
    stripe_price_id_yearly = 'price_...'
WHERE name = 'GROWTH';
```

6. Set up webhook endpoint: `https://your-domain.com/api/webhooks/stripe`
7. Configure webhook events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`

### Razorpay

1. Go to [Razorpay Dashboard](https://dashboard.razorpay.com/)
2. Create plans for STARTER and GROWTH
3. Copy the plan IDs
4. Update the `subscription_plans` table:

```sql
UPDATE subscription_plans 
SET razorpay_plan_id = 'plan_...'
WHERE name IN ('STARTER', 'GROWTH');
```

5. Set up webhook endpoint: `https://your-domain.com/api/webhooks/razorpay`
6. Configure webhook events

## Verify Installation

After running the migration, verify it worked:

```sql
-- Check plans
SELECT * FROM subscription_plans;

-- Check your subscription
SELECT * FROM get_user_subscription('your-user-id');

-- Check usage tracking
SELECT * FROM usage_tracking WHERE user_id = 'your-user-id';
```

## Next Steps

1. Install npm dependencies: `npm install`
2. Configure payment gateway credentials (optional)
3. Test the pricing page: `/pricing`
4. Test admin subscription management: `/admin/subscriptions`
