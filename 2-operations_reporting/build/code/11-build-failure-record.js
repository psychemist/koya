// n8n Code node: Build Failure Record
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Build Failure Record                    (Run Once for ALL Items)
//
// Runs on the Error Trigger branch, and only there. It turns whatever n8n
// hands an error workflow into the one shape record_failed_run() accepts.
//
// This node lived inline in harness/build-workflow.py until the Supabase URL
// stopped being a literal. That made it the one Code node a reviewer could
// not read as JavaScript and the one body sync-remote.py could not push to
// the live export — which is exactly how the old hardcoded project ref
// survived in the deployed workflow after it had been removed everywhere
// else. Nine code nodes in code/ and a tenth hiding in the build script is
// not a rule, it is an exception waiting to be missed.
// ============================================================

// Records the failure AS A REPORT RUN, so a broken run is visible on the
// dashboard rather than only in n8n's execution log. A stale dashboard that
// looks healthy is worse than one that says it is stale.
const e = $input.first().json || {};
const ex = e.execution || {};
const err = ex.error || e.error || {};
const stamp = new Date().toISOString().slice(0, 10);
return [{
  json: {
    rows: [{
      run_id: 'run_failed_' + stamp,
      period_key: 'failed',
      period_label: 'Run failed',
      period_start: stamp,
      period_end: stamp,
      reference_date: stamp,
      run_status: 'failed',
      insight_source: 'none',
      confidence: 'low',
      grounded: false,
      failure_reason: String(err.message || 'Unknown error')
        + (ex.lastNodeExecuted ? ' (failed at: ' + ex.lastNodeExecuted + ')' : ''),
      requested_by: 'error_trigger',
      updated_at: new Date().toISOString(),
    }],
    // Which period this run was trying to refresh, when it got far enough to
    // know. record_failed_run() stamps last_failure_at/reason on THAT period's
    // published report so the dashboard can say 'this is stale, and here is
    // why' - without touching the report itself. null is a fine answer: a run
    // that died before resolving a period damaged nothing.
    affected_period_key: (function () {
      try { return $('Resolve Reporting Period').first().json.period_key || null; }
      catch (x) { return null; }
    })(),
    // Configuration only, no literal fallback. Read the same two ways
    // Resolve Reporting Period reads it — $vars first (n8n Cloud, the only
    // one available there), then $env (self-hosted, and BLOCKED on Cloud,
    // where touching it throws rather than returning undefined). Reading
    // only $env here would mean a failure on Cloud could not even record
    // itself. Prefer the value the run already resolved, when there is one:
    // then the failure record cannot disagree with the run it describes.
    supabase_url: (function () {
      try {
        const resolved = $('Resolve Reporting Period').first().json.supabase_url;
        if (resolved) return String(resolved).replace(/\/+$/, '');
      } catch (x) { /* died before the period was resolved */ }
      try {
        const v = (typeof $vars !== 'undefined' && $vars) ? $vars.IKE_SUPABASE_URL : undefined;
        if (v) return String(v).trim().replace(/\/+$/, '');
      } catch (x) { /* no Variables on this instance */ }
      try {
        const v = (typeof $env !== 'undefined' && $env) ? $env.IKE_SUPABASE_URL : undefined;
        if (v) return String(v).trim().replace(/\/+$/, '');
      } catch (x) { /* env access blocked — the Cloud default */ }
      return '';
    })(),
  },
}];
