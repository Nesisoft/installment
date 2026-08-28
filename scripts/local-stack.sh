#!/bin/bash
# Bring up a local Postgres 16 + Redis 7 without Docker.
#
# The remote/CI container ships the postgres and redis binaries but no working
# Docker daemon, so `pnpm db:up` (docker compose) cannot start the stack there.
# This script does the same job with the binaries directly, keeping its state in
# .pgdata/ and .redis/ (both gitignored).
#
#   ./scripts/local-stack.sh up      start both, create the database, migrate
#   ./scripts/local-stack.sh down    stop both
#   ./scripts/local-stack.sh status  report what is listening
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN=/usr/lib/postgresql/16/bin
PGDATA="$ROOT/.pgdata"
REDISDIR="$ROOT/.redis"
DB_USER=installment
DB_NAME=installment

# initdb and postgres refuse to run as root, so the server runs as an
# unprivileged account that owns the data directory.
PG_ACCOUNT=$(id -u postgres >/dev/null 2>&1 && echo postgres || echo "$(id -un)")
as_pg() { if [ "$(id -un)" = "$PG_ACCOUNT" ]; then bash -c "$1"; else su -s /bin/bash "$PG_ACCOUNT" -c "$1"; fi; }

up() {
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    rm -rf "$PGDATA"; mkdir -p "$PGDATA"
    chown -R "$PG_ACCOUNT" "$PGDATA" 2>/dev/null || true
    chmod 700 "$PGDATA"
    as_pg "$PGBIN/initdb -D '$PGDATA' -U $DB_USER --auth=trust" >/dev/null
  fi
  if ! "$PGBIN/pg_isready" -h localhost -p 5432 >/dev/null 2>&1; then
    as_pg "$PGBIN/pg_ctl -D '$PGDATA' -l '$PGDATA/server.log' -o '-p 5432 -k /tmp -c listen_addresses=localhost' start" >/dev/null
    for _ in $(seq 1 20); do "$PGBIN/pg_isready" -h localhost -p 5432 >/dev/null 2>&1 && break; sleep 0.5; done
  fi
  "$PGBIN/createdb" -h localhost -U "$DB_USER" "$DB_NAME" 2>/dev/null || true

  mkdir -p "$REDISDIR"
  redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes --dir "$REDISDIR" --port 6379 --save '' --appendonly no
  for _ in $(seq 1 20); do redis-cli ping >/dev/null 2>&1 && break; sleep 0.5; done

  export DATABASE_URL="postgresql://$DB_USER:$DB_USER@localhost:5432/$DB_NAME"
  export REDIS_URL=redis://localhost:6379
  (cd "$ROOT" && pnpm migrate)
  status
}

down() {
  as_pg "$PGBIN/pg_ctl -D '$PGDATA' stop -m fast" >/dev/null 2>&1 || true
  redis-cli shutdown nosave >/dev/null 2>&1 || true
  echo "stopped"
}

status() {
  "$PGBIN/pg_isready" -h localhost -p 5432 || true
  printf 'redis: %s\n' "$(redis-cli ping 2>&1)"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 {up|down|status}" >&2; exit 1 ;;
esac
