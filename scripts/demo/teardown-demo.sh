#!/usr/bin/env bash
# Removes the "Northside Interiors" demo workspace and its owner login, completely.
#
# Everything seeded hangs off accounts.id by ON DELETE CASCADE, so deleting the
# account row takes all of it: contacts, conversations, messages, deals, flows,
# automations, forms, bookings, broadcasts, templates, products, keys, invites.
#
# Order matters: accounts.owner_user_id is ON DELETE RESTRICT, so the account
# must go before the auth user.
set -euo pipefail

ACC=39795c53-4a45-43a2-acec-5cff48a889e1
OWN=8b5d67ba-0e33-4b83-8b36-1f94e39ecdf3
REPO=/home/sivakrishna/Desktop/Projects/wacrm

raw=$(grep -E '^DATABASE_URL=' "$REPO/apps/api/.env" | head -1 | sed 's/^DATABASE_URL=//; s/^"//; s/"$//')
base="${raw%%\?*}"; qs="${raw#*\?}"; [ "$qs" = "$raw" ] && qs=""
keep=""; IFS='&' read -ra parts <<< "$qs"
for p in "${parts[@]}"; do
  case "$p" in connection_limit=*|pool_timeout=*|pgbouncer=*|schema=*|connect_timeout=*|"") ;; *) keep="${keep:+$keep&}$p";; esac
done
PGURL="${base}${keep:+?$keep}"

echo "Deleting demo workspace $ACC ..."
psql "$PGURL" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DELETE FROM accounts           WHERE id = '$ACC';
DELETE FROM user_subscriptions WHERE user_id = '$OWN';
DELETE FROM profiles           WHERE user_id = '$OWN';
COMMIT;
SQL

echo "Deleting demo owner login demo@converse360.in ..."
node --input-type=module <<'JS'
import fs from 'node:fs';
const env = Object.fromEntries(
  fs.readFileSync('/home/sivakrishna/Desktop/Projects/wacrm/apps/api/.env','utf8')
    .split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#'))
    .map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^"|"$/g,'')];})
);
const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/8b5d67ba-0e33-4b83-8b36-1f94e39ecdf3`, {
  method:'DELETE',
  headers:{ apikey:env.SUPABASE_SERVICE_ROLE_KEY, Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
});
console.log(res.ok ? 'auth user deleted' : `auth delete failed: ${res.status} ${await res.text()}`);
JS

echo "Done. sivakrishnacoc@gmail.com's own workspaces are untouched."
