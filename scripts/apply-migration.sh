#!/bin/bash
#
# Apply one supabase/migrations/*.sql file via psql.
#
# Generic replacement for run-migration.sh, which is hardcoded to
# migration 044. Reads DATABASE_URL from apps/api/.env — the same
# connection string Prisma uses — so there is no second place to
# configure credentials.
#
# Usage:
#   ./scripts/apply-migration.sh 050_instagram_channel
#   ./scripts/apply-migration.sh 050_instagram_channel --dry-run
#
# Every migration in this repo is written to be idempotent, so
# re-running one is safe.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:-}"
DRY_RUN="${2:-}"

if [ -z "$NAME" ]; then
  echo "Usage: $0 <migration-name-without-.sql> [--dry-run]"
  echo ""
  echo "Available:"
  ls "$REPO_ROOT/supabase/migrations" | sed 's/\.sql$//' | sed 's/^/  /'
  exit 1
fi

FILE="$REPO_ROOT/supabase/migrations/${NAME}.sql"
if [ ! -f "$FILE" ]; then
  echo "✗ No such migration: $FILE"
  exit 1
fi

# DATABASE_URL lives in apps/api/.env. Pull it out without sourcing the
# whole file, which would also export unrelated secrets into this shell.
if [ -z "${DATABASE_URL:-}" ]; then
  ENV_FILE="$REPO_ROOT/apps/api/.env"
  if [ -f "$ENV_FILE" ]; then
    DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  fi
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "✗ DATABASE_URL is not set and was not found in apps/api/.env"
  exit 1
fi

# Prisma-only query parameters that libpq rejects outright with
# "invalid URI query parameter". Stripping them lets one connection
# string serve both Prisma and psql instead of needing a second copy
# that drifts.
DATABASE_URL=$(echo "$DATABASE_URL" | sed -E 's/[?&](connection_limit|pool_timeout|pgbouncer|schema|connect_timeout|socket_timeout|statement_cache_size)=[^&]*//g')
# A stripped first parameter can leave a dangling '?' or a '?&'.
DATABASE_URL=$(echo "$DATABASE_URL" | sed -E 's/\?&/?/; s/\?$//')

echo "📄 Migration: $NAME"
echo "🔗 Target:    $(echo "$DATABASE_URL" | sed -E 's#//[^:]+:[^@]+@#//***:***@#')"
echo ""

if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "— dry run, showing the statements that would execute —"
  echo ""
  cat "$FILE"
  exit 0
fi

# ON_ERROR_STOP so a failure halts instead of ploughing on and leaving
# the schema half-migrated.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$FILE"

echo ""
echo "✅ Applied $NAME"
