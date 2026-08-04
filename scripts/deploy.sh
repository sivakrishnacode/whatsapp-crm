#!/bin/bash
#
# Deploy converse360 to the VPS.
#
#   ./scripts/deploy.sh                 # checks, push, pull, rebuild, verify
#   ./scripts/deploy.sh --dry-run       # print the plan, change nothing
#   ./scripts/deploy.sh --skip-checks   # skip typecheck + tests (hotfix path)
#   ./scripts/deploy.sh --api-only      # rebuild just the api container
#   ./scripts/deploy.sh --web-only      # rebuild just web + site
#
# There is no CI in this repo, so "deploy" means: get the commit onto
# GitHub, pull it on the box, rebuild the containers. This script is that
# sequence plus the preflight checks that make it safe to run without
# thinking about it each time.
#
# Config via env (defaults suit the current box):
#   DEPLOY_HOST    ssh target                (root@app.converse360.in)
#   DEPLOY_PATH    checkout on the server    (/root/whatsapp-crm)
#   DEPLOY_BRANCH  branch the server tracks  (main)
#   DEPLOY_SSH_KEY private key to use        (unset = ssh default)
#   API_HEALTH_URL health probe              (https://api.converse360.in/health)
#   APP_HEALTH_URL health probe              (https://app.converse360.in/login)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DEPLOY_HOST="${DEPLOY_HOST:-root@app.converse360.in}"
DEPLOY_PATH="${DEPLOY_PATH:-/root/whatsapp-crm}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
API_HEALTH_URL="${API_HEALTH_URL:-https://api.converse360.in/health}"
APP_HEALTH_URL="${APP_HEALTH_URL:-https://app.converse360.in/login}"

DRY_RUN=0
SKIP_CHECKS=0
SERVICES=""

for arg in "$@"; do
  case "$arg" in
    --dry-run)     DRY_RUN=1 ;;
    --skip-checks) SKIP_CHECKS=1 ;;
    --api-only)    SERVICES="api" ;;
    --web-only)    SERVICES="web site" ;;
    -h|--help)     sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,\} \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 1 ;;
  esac
done

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)
[ -n "${DEPLOY_SSH_KEY:-}" ] && SSH_OPTS+=(-i "$DEPLOY_SSH_KEY")
remote() { ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "$@"; }

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }


# ============================================================
# 1) Local preflight
# ============================================================

step "Local checks"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "$DEPLOY_BRANCH" ] ||
  die "On '$BRANCH' but the server tracks '$DEPLOY_BRANCH'. Switch, or set DEPLOY_BRANCH."
ok "on $BRANCH"

# A dirty tree is the failure mode that looks like success: the deploy runs,
# the containers rebuild, and the change being tested is still only on this
# laptop. The server deploys from git, not from this directory.
if [ -n "$(git status --porcelain)" ]; then
  git status --short | sed 's/^/      /'
  die "Uncommitted changes — commit them first."
fi
ok "working tree clean"

git fetch --quiet origin "$DEPLOY_BRANCH"
BEHIND="$(git rev-list --count "HEAD..origin/$DEPLOY_BRANCH")"
AHEAD="$(git rev-list --count "origin/$DEPLOY_BRANCH..HEAD")"
# Behind means someone else pushed. The push below would be rejected, and
# force-pushing would drop their commits — so stop and let a human merge.
[ "$BEHIND" = "0" ] ||
  die "$BEHIND commit(s) behind origin/$DEPLOY_BRANCH. Pull and merge first."
ok "up to date with origin ($AHEAD to push)"

if [ "$SKIP_CHECKS" = "1" ]; then
  warn "skipping typecheck + tests (--skip-checks)"
else
  step "Typecheck + tests"
  npm run typecheck >/dev/null 2>&1 || die "typecheck failed — run 'npm run typecheck'"
  ok "typecheck"
  npm test >/dev/null 2>&1 || die "tests failed — run 'npm test'"
  ok "tests"
fi


# ============================================================
# 2) Remote preflight
# ============================================================

step "Server checks ($DEPLOY_HOST)"

remote true 2>/dev/null || die "Cannot ssh to $DEPLOY_HOST — check the key, or set DEPLOY_SSH_KEY."
ok "ssh reachable"

REMOTE_SHA="$(remote "cd $DEPLOY_PATH && git rev-parse --short HEAD")"
REMOTE_DIRTY="$(remote "cd $DEPLOY_PATH && git status --porcelain | head -5")"
if [ -n "$REMOTE_DIRTY" ]; then
  echo "$REMOTE_DIRTY" | sed 's/^/      /'
  die "The server has local edits — a fast-forward pull will fail. Resolve them on the box."
fi
ok "server at $REMOTE_SHA, checkout clean"

# Migrations stay manual (scripts/apply-migration.sh) — dropping a column
# mid-deploy is not something to automate. But a migration shipping in this
# deploy and never being applied is precisely how production breaks
# silently, so name them loudly.
NEW_MIGRATIONS="$(git diff --name-only --diff-filter=A "$REMOTE_SHA..HEAD" -- supabase/migrations/ 2>/dev/null || true)"
if [ -n "$NEW_MIGRATIONS" ]; then
  warn "this deploy adds migration(s):"
  echo "$NEW_MIGRATIONS" | sed 's|supabase/migrations/|      |; s|\.sql$||'
  warn "apply each with: ./scripts/apply-migration.sh <name>"
  warn "a column the DB lacks fails at runtime, not at build time."
fi


# ============================================================
# 3) Plan / go
# ============================================================

LOCAL_SHA="$(git rev-parse --short HEAD)"
SUBJECT="$(git log -1 --pretty=%s)"

step "Plan"
echo "      $REMOTE_SHA  ->  $LOCAL_SHA  ($SUBJECT)"
echo "      rebuild: ${SERVICES:-all services}"

if [ "$DRY_RUN" = "1" ]; then
  printf '\n\033[33m— dry run, nothing changed —\033[0m\n'
  exit 0
fi

step "Push"
git push origin "$DEPLOY_BRANCH"
ok "pushed to origin/$DEPLOY_BRANCH"

step "Pull + rebuild on the server"
# `up -d --build`, never `restart`: NEXT_PUBLIC_* values and the /api/*
# rewrite target are baked into the web bundle by `next build`, so a restart
# silently keeps the old ones. See deploy/README.md.
remote "set -e
  cd $DEPLOY_PATH
  git pull --ff-only origin $DEPLOY_BRANCH
  docker compose up -d --build $SERVICES
  docker compose ps --format '{{.Name}}\t{{.Status}}'" | sed 's/^/      /'
ok "containers rebuilt"


# ============================================================
# 4) Verify
# ============================================================

step "Verify"

probe() {
  local name="$1" url="$2" i
  for i in $(seq 1 40); do
    if curl -sf -m 8 -o /dev/null "$url"; then ok "$name responding"; return 0; fi
    sleep 3
  done
  die "$name never came back: $url"
}

probe "api" "$API_HEALTH_URL"
probe "app" "$APP_HEALTH_URL"

HEALTH="$(curl -s -m 10 "$API_HEALTH_URL" || true)"
case "$HEALTH" in
  *'"status":"ok"'*) ok "health: ok" ;;
  *) warn "health body looks off: $HEALTH" ;;
esac

DEPLOYED="$(remote "cd $DEPLOY_PATH && git rev-parse --short HEAD")"
[ "$DEPLOYED" = "$LOCAL_SHA" ] ||
  die "Server is at $DEPLOYED but expected $LOCAL_SHA."

printf '\n\033[32m✓ Deployed %s — %s\033[0m\n' "$DEPLOYED" "$SUBJECT"
if [ -n "$NEW_MIGRATIONS" ]; then
  printf '\033[33m! Remember the migration(s) listed above.\033[0m\n'
fi
