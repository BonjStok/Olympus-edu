#!/usr/bin/env bash
# Runs ON the production server; invoked by .github/workflows/deploy.yml over SSH:
#   bash -s -- <app-dir> <commit-sha> <image-prefix> < scripts/deploy/remote-deploy.sh
#
# Steps: backup PostgreSQL -> check out the commit (compose files, Caddyfile,
# migrations) -> pull the images CI built for that commit -> restart and wait
# for health checks -> roll back to the previous release if the new one is unhealthy.
set -euo pipefail

APP_DIR="${1:?app dir}"
SHA="${2:?commit sha}"
IMAGE_PREFIX="${3:?image prefix}"

cd "$APP_DIR"
COMPOSE=(docker compose -f compose.production.yaml)
STATE_DIR=".deploy"
mkdir -p "$STATE_DIR"

log() { printf '\n==> %s\n' "$*"; }

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked files were edited on the server; commit them to the repository or revert them first:" >&2
  git status --short >&2
  exit 1
fi

prev_sha="$(git rev-parse HEAD)"
prev_tag="$(cat "$STATE_DIR/current-tag" 2>/dev/null || true)"

log "Backup PostgreSQL before the release"
"${COMPOSE[@]}" --profile tools run --rm backup

log "Check out ${SHA}"
git fetch --quiet origin
git checkout --quiet --detach "$SHA"

export OLYMPUS_IMAGE_PREFIX="$IMAGE_PREFIX"
export OLYMPUS_IMAGE_TAG="$SHA"

log "Pull images ${IMAGE_PREFIX}-*:${SHA}"
"${COMPOSE[@]}" pull --quiet web runner

log "Start the new release"
if "${COMPOSE[@]}" up -d --no-build --remove-orphans --wait --wait-timeout 240; then
  # Caddy reads its bind-mounted Caddyfile only on startup or reload. The compose
  # definition is unchanged between releases, so explicitly apply routes/headers.
  log "Reload Caddy configuration"
  "${COMPOSE[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  echo "$SHA" > "$STATE_DIR/current-tag"
  docker logout ghcr.io >/dev/null 2>&1 || true
  docker image prune -f --filter "until=336h" >/dev/null || true
  log "Release ${SHA} is healthy"
  exit 0
fi

log "Release ${SHA} is unhealthy, rolling back to ${prev_sha}"
"${COMPOSE[@]}" logs --no-color --tail=200 web || true
git checkout --quiet --detach "$prev_sha"
if [ -n "$prev_tag" ]; then
  export OLYMPUS_IMAGE_TAG="$prev_tag"
  "${COMPOSE[@]}" up -d --no-build --remove-orphans --wait --wait-timeout 240 || true
else
  # The previous release was built on the server itself.
  unset OLYMPUS_IMAGE_PREFIX OLYMPUS_IMAGE_TAG
  "${COMPOSE[@]}" up -d --build --remove-orphans --wait --wait-timeout 300 || true
fi
docker logout ghcr.io >/dev/null 2>&1 || true
exit 1
