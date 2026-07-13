#!/bin/bash

# Script to run the subscription system migration
# Usage: ./scripts/run-migration.sh

# Load environment variables
SUPABASE_URL=${SUPABASE_URL:-$NEXT_PUBLIC_SUPABASE_URL}
SUPABASE_SECRET_KEY=${SUPABASE_SECRET_KEY:-$SUPABASE_SERVICE_ROLE_KEY}

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SECRET_KEY" ]; then
  echo "Error: Missing required environment variables"
  echo "Required: SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)"
  exit 1
fi

# Extract host from URL
DB_HOST=$(echo "$SUPABASE_URL" | sed -e 's|https://||' -e 's|http://||')

echo "🚀 Running subscription system migration..."
echo "📄 Database: $DB_HOST"

# Run migration using psql
# The password will be read from SUPABASE_SECRET_KEY
PGPASSWORD="$SUPABASE_SECRET_KEY" psql -h "$DB_HOST" -U postgres -d postgres -f supabase/migrations/044_subscription_system.sql

if [ $? -eq 0 ]; then
  echo "✅ Migration completed successfully!"
  echo ""
  echo "📋 Summary:"
  echo "- Created subscription_plans table"
  echo "- Created user_subscriptions table"
  echo "- Created usage_tracking table"
  echo "- Added FREE, STARTER, and GROWTH plans"
  echo "- Backfilled existing users with FREE plan"
  echo "- Created RPC functions for subscription management"
else
  echo "❌ Migration failed"
  exit 1
fi
