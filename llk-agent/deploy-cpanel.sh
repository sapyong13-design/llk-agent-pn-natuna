#!/bin/bash
# Run from private Git checkout. --prepare never restarts production; --apply ends active sessions.
set -euo pipefail
umask 077
MODE=${1:---prepare}
case "$MODE" in --prepare|--apply) ;; *) echo 'Usage: bash llk-agent/deploy-cpanel.sh [--prepare|--apply]' >&2; exit 2;; esac
REPO=$(git rev-parse --show-toplevel)
cd "$REPO"
[ "$(git branch --show-current)" = built-in-auth ] || { echo 'Use branch built-in-auth.' >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo 'Checkout changed; review before deployment.' >&2; exit 1; }
HOME_ROOT=/home/pnnatuna
BASE=$HOME_ROOT/private/llk
APP=$BASE/current
WEB=$HOME_ROOT/llk.pn-natuna.go.id
ENV=$HOME_ROOT/nodevenv/private/llk/current/24/bin/activate
[ -f "$APP/passenger.cjs" ] && [ -f "$WEB/.htaccess" ] && [ -f "$ENV" ] || { echo 'Existing LLK hosting setup required.' >&2; exit 1; }
mkdir -p "$BASE/releases" "$BASE/backups"
exec 9>"$BASE/deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
# CloudLinux activate reads unset variables; restore strict mode after sourcing it.
set +u
source "$ENV"
set -u
export NODE_ENV=development
unset LLK_PUBLIC_ORIGIN
SHA=$(git rev-parse HEAD)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RELEASE=$BASE/releases/$SHA-$STAMP
mkdir "$RELEASE"
FILES=(server.js passenger.cjs cas-auth.mjs llk-http.mjs llk-read.mjs llk-verification.mjs package.json package-lock.json public data/department-templates.json hosting-check.mjs multi-user-check.mjs submit-check.mjs cas-auth-check.mjs llk-http-check.mjs PRODUCT.md DESIGN.md)
PATHS=()
for file in "${FILES[@]}"; do PATHS+=("llk-agent/$file"); done
git archive HEAD "${PATHS[@]}" | tar -x --strip-components=1 -C "$RELEASE"
(
  cd "$RELEASE"
  npm ci --include=dev --no-audit --no-fund
  node hosting-check.mjs
  node multi-user-check.mjs
  node submit-check.mjs
  node cas-auth-check.mjs
  node llk-http-check.mjs
)
printf '%s\n' "$SHA" > "$RELEASE/RELEASE"
printf 'Prepared %s\n' "$RELEASE"
if [ "$MODE" = --prepare ]; then
  echo 'Production unchanged. --apply prepares again, backs up, and restarts LLK; users must login again.'
  exit 0
fi
BACKUP=$BASE/backups/$STAMP
mkdir "$BACKUP"
tar -czf "$BACKUP/app.tgz" -C "$APP" .
cp -p "$WEB/.htaccess" "$BACKUP/webroot.htaccess"
printf '%s\n' "$RELEASE" > "$BACKUP/new-release"
stop_workers() {
  cloudlinux-selector stop --json --interpreter nodejs --user pnnatuna --app-root private/llk/current
  local pid args
  while read -r pid args; do
    case "$args" in lsnode:/home/pnnatuna/private/llk/current/) kill -TERM "$pid";; esac
  done < <(ps -u pnnatuna -o pid=,args=)
  # Native runtime lock stays held while in-flight requests drain.
  flock -w 15 "$BASE/runtime/runtime.lock" true
}
rollback() {
  trap - ERR
  echo "Deploy failed. Restoring $BACKUP" >&2
  stop_workers || return 1
  tar -xzf "$BACKUP/app.tgz" -C "$APP"
  cp -p "$BACKUP/webroot.htaccess" "$WEB/.htaccess"
  cloudlinux-selector start --json --interpreter nodejs --user pnnatuna --app-root private/llk/current
  exit 1
}
trap rollback ERR
stop_workers
# Only release allowlist overwritten. Runtime reports, audit, browser data and proxy secrets stay intact.
for file in "${FILES[@]}"; do
  if [ "$file" = public ]; then
    rm -rf "$APP/public"
    cp -a "$RELEASE/public" "$APP/public"
  else
    mkdir -p "$(dirname "$APP/$file")"
    cp -p "$RELEASE/$file" "$APP/$file"
  fi
done
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
cp "$RELEASE/RELEASE" "$APP/RELEASE"
cloudlinux-selector start --json --interpreter nodejs --user pnnatuna --app-root private/llk/current
# Retry read-only startup probe; never retry LLK mutations.
SESSION=$(curl --fail --silent --show-error --retry 5 --retry-delay 2 --retry-all-errors --max-time 30 https://llk.pn-natuna.go.id/api/session)
node -e 'const state=JSON.parse(process.argv[1]);if(state.employee!==null||state.pending!==null)process.exit(1)' "$SESSION"
trap - ERR
echo "Deployed $SHA; backup $BACKUP. Active users must login again."
