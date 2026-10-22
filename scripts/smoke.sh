#!/usr/bin/env bash
# End-to-end check of the local stack (run after `make up && make seed`):
#   simulated PITR export -> backfill (invariant, rejects) -> backfill again (inserts 0)
#   -> both append-only walls -> API (idempotent POST, filters, keyset paging = count) -> views -> digest
set -euo pipefail

API="${API:-http://localhost:3000}"
ok()   { printf '\033[32mok\033[0m  %s\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
job()  { LOG_LEVEL=warn docker compose run --rm -T jobs "$@"; }
sql()  { docker compose exec -T db psql -U audit_owner -d audit -Atq -c "$1"; }
# Last pretty-printed JSON document in a job's stdout (log lines are single-line JSON).
last_json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=s.lastIndexOf("\n{\n");process.stdout.write(i<0?s:s.slice(i+1))})'; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));process.stdout.write(String(v))})' "$1"; }
api() { curl -s -H "X-Tenant-Id: $TENANT" -H "X-Actor-Id: smoke" "$@"; }

step "health"
curl -sf "$API/v1/health" | grep -q '"ok"' || fail "api not healthy"
ok "api healthy"
LEGACY=$(LOG_LEVEL=warn docker compose run --rm -T jobs simulate-export | tail -1)
[ -n "$LEGACY" ] || fail "simulate-export printed no prefix"
ok "legacy table exported to s3://legacy-export/$LEGACY"

step "1. backfill"
M1=$(job backfill -- --export-prefix "$LEGACY" --run-id smoke-1 | last_json)
read_n=$(field read <<<"$M1"); ins=$(field inserted <<<"$M1"); dup=$(field alreadyPresent <<<"$M1"); rej=$(field rejected <<<"$M1")
echo "   read=$read_n inserted=$ins alreadyPresent=$dup rejected=$rej"
[ "$read_n" -gt 0 ] || fail "nothing read"
[ "$read_n" -eq $((ins + dup + rej)) ] || fail "invariant broken: read != inserted + alreadyPresent + rejected"
[ "$rej" -gt 0 ] || fail "the seed contains bad items, expected rejects"
[ "$(sql "select count(*) from audit_event where source = 'backfill'")" -eq "$ins" ] || fail "row count != inserted"
ok "invariant holds, $rej rejected with reasons: $(field rejectReasons <<<"$M1" | tr -d '\n')"

step "2. backfill again"
M2=$(job backfill -- --export-prefix "$LEGACY" --run-id smoke-2 | last_json)
[ "$(field inserted <<<"$M2")" -eq 0 ] || fail "second run inserted rows"
[ "$(field alreadyPresent <<<"$M2")" -eq "$ins" ] || fail "second run did not see every row as present"
ok "second run inserted 0, $(field alreadyPresent <<<"$M2") already present"

step "3. append-only walls"
wall() { # role password -> SQLSTATE of an UPDATE
  docker compose exec -T db psql "postgresql://$1:$2@localhost:5432/audit" -Atq -v VERBOSITY=verbose \
    -c "update audit_event set comment = 'x' where event_row_id = (select min(event_row_id) from audit_event)" 2>&1 \
    | sed -nE 's/.*ERROR: +([0-9A-Z]{5}):.*/\1/p' | head -1
}
[ "$(wall audit_writer writer)" = "42501" ] || fail "writer UPDATE was not stopped by the GRANT wall"
ok "writer UPDATE -> 42501 (GRANT wall)"
[ "$(wall audit_owner owner)" = "23001" ] || fail "owner UPDATE was not stopped by the trigger wall"
ok "owner UPDATE -> 23001 (trigger wall)"

step "4. API"
TENANT=$(sql "select tenant_id from audit_event group by 1 order by count(*) desc limit 1")
EID=$(node -e 'console.log(crypto.randomUUID())')
BODY=$(printf '{"event_id":"%s","scope":"billing","entity_type":"invoice","entity_id":"inv-smoke","entity_label":"Invoice INV-SMOKE","action":"update","actor_id":"smoke","actor_email":"smoke@example.test","occurred_at":"%s","changes":[{"field":"status","old":"open","new":"void"}]}' "$EID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")
c1=$(api -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "$BODY" "$API/v1/events")
c2=$(api -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "$BODY" "$API/v1/events")
[ "$c1" = 201 ] && [ "$c2" = 200 ] || fail "POST expected 201 then 200, got $c1 then $c2"
ok "POST is idempotent (201, then 200 on replay)"

FILTER="scope=billing"
total=$(api "$API/v1/events/count?$FILTER" | field count)
pages=0; cursor=""; ids=$(mktemp)
while :; do
  page=$(api "$API/v1/events?$FILTER&limit=200${cursor:+&cursor=$cursor}")
  node -e 'const p=JSON.parse(process.argv[1]);for(const e of p.items)console.log(e.event_id)' "$page" >>"$ids"
  cursor=$(field next_cursor <<<"$page"); pages=$((pages + 1))
  [ "$cursor" = "null" ] || [ "$cursor" = "undefined" ] && break
  [ "$pages" -lt 500 ] || fail "paging did not terminate"
done
seen=$(wc -l <"$ids"); unique=$(sort -u "$ids" | wc -l); rm -f "$ids"
[ "$seen" -eq "$total" ] && [ "$unique" -eq "$total" ] || fail "keyset paging returned $seen ($unique unique), count says $total"
ok "tenant $TENANT, $FILTER: $total events over $pages pages, no duplicates, equals /count"
[ "$(api -o /dev/null -w '%{http_code}' "$API/v1/events?scop=billing")" = 400 ] || fail "unknown filter was not rejected"
ok "misspelt filter -> 400 (never a silently unfiltered result)"

step "5. views and digest"
job mv-refresh >/dev/null
api "$API/v1/facets" | grep -q '"invoice"' || fail "facets missing after refresh"
ok "materialized views refreshed, facets served"
D=$(job digest | last_json)
[ "$(field mismatches.length <<<"$D")" = 0 ] || fail "digest reported mismatches"
ok "digest ran: sealed=$(field sealed <<<"$D") (rows recorded today are sealed tomorrow), 0 mismatches"

printf '\n\033[32mSmoke test passed.\033[0m\n'
