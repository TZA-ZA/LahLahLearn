#!/usr/bin/env bash
# Starts the local test stack: Postgres DB lll_e2e (fresh), PostgREST on :3010, gateway on :54321.
# Needs: a running Postgres (PGHOST/PGPORT), the postgrest binary on PATH or in $POSTGREST, deno on PATH or in $DENO.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
PGHOST="${PGHOST:-/tmp}"; PGPORT="${PGPORT:-54329}"; DB=lll_e2e
SECRET="${JWT_SECRET:-test-secret-test-secret-test-secret-123}"
POSTGREST="${POSTGREST:-postgrest}"; DENO="${DENO:-deno}"
P="psql -h $PGHOST -p $PGPORT -U postgres -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB"
$P -d $DB -f "$ROOT/tests/supabase_shim.sql"
for f in "$ROOT"/migrations/*.sql; do $P -d $DB -f "$f"; done
$P -d $DB -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit password 'auth'; end if; end \$\$;" \
     -c "grant anon, authenticated, service_role to authenticator;" \
     -c "grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role; grant execute on all functions in schema public to service_role;"
cat > /tmp/lll_postgrest.conf <<CONF
db-uri = "postgres://authenticator:auth@localhost:$PGPORT/$DB?host=$PGHOST"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$SECRET"
server-port = 3010
db-pool = 5
CONF
for f in /tmp/lll_postgrest.pid /tmp/lll_gateway.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done; sleep 0.5
nohup "$POSTGREST" /tmp/lll_postgrest.conf > /tmp/lll_postgrest.log 2>&1 & echo $! > /tmp/lll_postgrest.pid
JWT_SECRET="$SECRET" nohup "$DENO" run -A --node-modules-dir=none "$HERE/gateway.ts" > /tmp/lll_gateway.log 2>&1 & echo $! > /tmp/lll_gateway.pid
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:54321/__keys && curl -s -o /dev/null http://127.0.0.1:3010/ && { echo "local stack up"; exit 0; }; sleep 1; done
echo "stack failed to start"; tail -n 20 /tmp/lll_postgrest.log /tmp/lll_gateway.log; exit 1
