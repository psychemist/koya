#!/usr/bin/env bash
# ============================================================
# Transactional publish — SQL test suite
#
#   ./harness/sql-tests.sh
#
# Spins up a throwaway Postgres, loads supabase/schema.sql into it, drives
# publish_report() and record_failed_run() with payloads produced by the
# real Code node files, and asserts the behaviour that cannot be checked
# from JavaScript: that the write is atomic, that a re-run replaces rather
# than merges, and that a failure damages nothing.
#
# The cluster is created fresh and destroyed at the end. Nothing outside
# /tmp/koya-sqltest is touched, and no Supabase project is involved.
#
# Requires: postgresql 15+ on PATH (or Homebrew's postgresql@16), node 18+.
# ============================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PGROOT=/tmp/koya-sqltest
PORT=5599

for d in /usr/local/opt/postgresql@16/bin /opt/homebrew/opt/postgresql@16/bin \
         /usr/local/opt/postgresql@15/bin /opt/homebrew/opt/postgresql@15/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH LC_ALL=C LANG=C

command -v initdb >/dev/null || { echo "initdb not found — install postgresql first"; exit 2; }

pass=0; fail=0; failed_names=()

ok() {   # ok <name> <actual> <expected>
  if [ "$2" = "$3" ]; then printf '  ok    %s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL  %s\n          expected %s\n          actual   %s\n' "$1" "$3" "$2"
       fail=$((fail+1)); failed_names+=("$1"); fi
}
contains() {  # contains <name> <haystack> <needle>
  case "$2" in *"$3"*) printf '  ok    %s\n' "$1"; pass=$((pass+1));;
    *) printf '  FAIL  %s\n          %s\n          does not contain: %s\n' "$1" "$2" "$3"
       fail=$((fail+1)); failed_names+=("$1");; esac
}
P() { psql -h "$PGROOT" -p $PORT -U postgres -tA "$@" 2>&1; }
Q() { P -c "$1" | tail -1; }

cleanup() { pg_ctl -D "$PGROOT/data" stop -m immediate >/dev/null 2>&1; rm -rf "$PGROOT"; }
trap cleanup EXIT

# ---- cluster -------------------------------------------------
echo "TRANSACTIONAL PUBLISH — SQL suite"
echo
rm -rf "$PGROOT"; mkdir -p "$PGROOT"
initdb -D "$PGROOT/data" -U postgres --auth=trust --locale=C -E UTF8 >/dev/null 2>&1 \
  || { echo "initdb failed"; exit 2; }
pg_ctl -D "$PGROOT/data" -o "-k $PGROOT -h '' -p $PORT" -l "$PGROOT/log" start >/dev/null 2>&1
for _ in $(seq 1 20); do P -c 'select 1' >/dev/null 2>&1 && break; sleep 0.5; done

# Supabase's stock roles and their default grants on `public`. Recreated
# here because a bare Postgres has neither, and the point of the exercise is
# to test the schema as Supabase will actually run it.
P -q -c "create role anon; create role authenticated; create role service_role;
         grant usage on schema public to anon, authenticated, service_role;" >/dev/null

# Supabase hands anon and authenticated their select via ALTER DEFAULT
# PRIVILEGES, so the grant lands the moment an object is created -- BEFORE
# any later statement in the same file can revoke it. Applying it as a
# blanket `grant select on all tables` after the schema loads is not the
# same thing and quietly breaks the test: it re-grants what schema.sql
# deliberately took away, and every revoke in the file silently reads as
# a no-op. Set the default privilege first and let the schema run against
# the ordering it will actually meet in production.
P -q -c "alter default privileges in schema public
           grant select on tables to anon, authenticated;" >/dev/null

echo "-- schema --"
schema_err="$(psql -h "$PGROOT" -p $PORT -U postgres -v ON_ERROR_STOP=1 -q \
  -f "$ROOT/supabase/schema.sql" 2>&1 | grep -E '^psql.*ERROR' | head -3)"
ok "schema.sql loads with no errors" "${schema_err:-none}" "none"

# Nothing to grant here any more -- the default privilege above already
# covered every table and view as schema.sql created it.

ok "every view enforces the caller's RLS — no exceptions" \
   "$(Q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public' and c.relkind='v'
           and (c.reloptions is null or not ('security_invoker=on' = any(c.reloptions)));")" "0"

# The publishable key must not reach people data by any route: not the table
# (no policy) and not the aggregate view (grant revoked). This is the check
# that fails if someone re-adds the grant to get a department breakdown.
ok "anon cannot select people_headcount_by_department" \
   "$(Q "select has_table_privilege('anon','public.people_headcount_by_department','select')::text;")" "false"

# ---- payloads from the real node files -----------------------
node "$HERE/make-payload.js" last_30d > "$PGROOT/p30.json" || { echo "payload build failed"; exit 2; }
node "$HERE/make-payload.js" ytd      > "$PGROOT/pytd.json"
mkcall() { python3 -c "
import sys;p=open(sys.argv[1]).read()
open(sys.argv[2],'w').write('select public.publish_report(\$K\$'+p+'\$K\$::jsonb);')" "$1" "$2"; }
mkcall "$PGROOT/p30.json" "$PGROOT/c30.sql"
mkcall "$PGROOT/pytd.json" "$PGROOT/cytd.sql"

echo
echo "-- publish --"
res="$(P -f "$PGROOT/c30.sql" | tail -1)"
contains "publish_report returns ok" "$res" '"ok": true'
contains "publish_report publishes inside the transaction" "$res" '"publish_state": "published"'
ok "every metric row landed"        "$(Q 'select count(*) from public.report_metrics;')" \
   "$(python3 -c "import json;print(json.load(open('$PGROOT/p30.json'))['row_counts']['report_metrics'])")"
ok "every cleaned sales row landed" "$(Q 'select count(*) from public.sales_records;')" "148"
ok "the dashboard view returns the report" "$(Q 'select count(*) from public.dashboard_latest;')" "1"

echo
echo "-- repeat safety --"
P -f "$PGROOT/c30.sql" >/dev/null
ok "a second identical run adds no rows" "$(Q 'select count(*) from public.report_runs;')" "1"
ok "created_at survives the replace and stays <= updated_at" \
   "$(Q 'select bool_and(created_at <= updated_at) from public.report_runs;')" "t"

echo
echo "-- replace, not merge --"
before_dq="$(Q 'select count(*) from public.data_quality_warnings;')"
python3 -c "
import json
d=json.load(open('$PGROOT/p30.json')); d['data_quality_warnings']=d['data_quality_warnings'][:1]
open('$PGROOT/fewer.sql','w').write('select public.publish_report(\$K\$'+json.dumps(d)+'\$K\$::jsonb);')"
P -f "$PGROOT/fewer.sql" >/dev/null
ok "a re-run with fewer warnings removes the old ones (had $before_dq)" \
   "$(Q 'select count(*) from public.data_quality_warnings;')" "1"

echo
echo "-- atomicity --"
P -f "$PGROOT/c30.sql" >/dev/null
python3 -c "
import json
d=json.load(open('$PGROOT/p30.json'))
d['report_insights'][0]['executive_summary']='CLOBBERED'
d['report_metrics'][3]['metric_value']='not-a-number'
open('$PGROOT/bad.sql','w').write('select public.publish_report(\$K\$'+json.dumps(d)+'\$K\$::jsonb);')"
err="$(P -f "$PGROOT/bad.sql" | grep -oE 'failed at step \"[a-z_ ]*\"' | head -1)"
contains "a bad payload is rejected and names the step" "$err" 'insert report_metrics'
ok "the rollback left the metrics untouched" "$(Q 'select count(*) from public.report_metrics;')" \
   "$(python3 -c "import json;print(json.load(open('$PGROOT/p30.json'))['row_counts']['report_metrics'])")"
ok "the rollback left the commentary untouched" \
   "$(Q "select executive_summary = 'CLOBBERED' from public.report_insights;")" "f"
ok "the previous report is still published" \
   "$(Q 'select count(*) from public.dashboard_latest;')" "1"

echo
echo "-- failure recording --"
P -f "$PGROOT/cytd.sql" >/dev/null
python3 -c "
import json
f={'report_runs':[{'run_id':'run_failed_x','period_key':'failed','period_label':'Run failed',
 'period_start':'2026-09-03','period_end':'2026-09-03','reference_date':'2026-09-03',
 'run_status':'failed','failure_reason':'connect ETIMEDOUT api.airtable.com:443',
 'requested_by':'error_trigger','updated_at':'2026-09-03T06:00:00.000Z',
 'publish_state':'published'}],'affected_period_key':'last_30d'}
open('$PGROOT/fail.sql','w').write('select public.record_failed_run(\$K\$'+json.dumps(f)+'\$K\$::jsonb);')"
P -f "$PGROOT/fail.sql" >/dev/null
ok "a failure row cannot publish itself, whatever the payload claims" \
   "$(Q "select publish_state from public.report_runs where period_key='failed';")" "failed"
ok "the failure stays out of the period selector" \
   "$(Q 'select count(*) from public.dashboard_latest;')" "2"
ok "the report it failed to refresh is untouched" \
   "$(Q "select count(*) from public.report_metrics where run_id like '%last_30d%';")" \
   "$(python3 -c "import json;print(json.load(open('$PGROOT/p30.json'))['row_counts']['report_metrics'])")"
ok "the affected period is flagged stale" \
   "$(Q "select refresh_failing from public.report_freshness where period_key='last_30d';")" "t"
ok "an untouched period is not flagged" \
   "$(Q "select refresh_failing from public.report_freshness where period_key='ytd';")" "f"
P -f "$PGROOT/c30.sql" >/dev/null
ok "a successful re-run clears the stale flag by itself" \
   "$(Q "select refresh_failing from public.report_freshness where period_key='last_30d';")" "f"

echo
echo "-- who may do what --"
contains "anon cannot publish"          "$(P -c "set role anon;          select public.publish_report('{}'::jsonb);")"    "permission denied for function publish_report"
contains "authenticated cannot publish" "$(P -c "set role authenticated; select public.publish_report('{}'::jsonb);")"    "permission denied for function publish_report"
contains "anon cannot record failures"  "$(P -c "set role anon;          select public.record_failed_run('{}'::jsonb);")" "permission denied for function record_failed_run"
contains "service_role can publish"     "$(P -c "set role service_role;  select public.publish_report('{}'::jsonb);")"    "run_id is missing or empty"
ok       "anon can still read the dashboard" \
         "$(P -c 'set role anon; select count(*) from public.dashboard_latest;' | tail -1)" "2"
ok       "anon can read the freshness banner" \
         "$(P -c 'set role anon; select count(*) from public.report_freshness;' | tail -1)" "2"
contains "anon cannot delete a report"  "$(P -c 'set role anon; delete from public.report_runs;')" "permission denied for table report_runs"

echo
echo "=========================================================="
echo "  $pass passed, $fail failed"
if [ $fail -gt 0 ]; then printf '    - %s\n' "${failed_names[@]}"; fi
echo "=========================================================="
exit $(( fail > 0 ))
