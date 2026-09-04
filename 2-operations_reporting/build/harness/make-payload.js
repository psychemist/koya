#!/usr/bin/env node
/**
 * Prints the Supabase payload for one reporting period, exactly as the
 * "Build Supabase Payloads" node would emit it in n8n.
 *
 *   node harness/make-payload.js last_30d [ok|fail] > payload.json
 *
 * run.js stops at the Claude brief, because everything past that point
 * needs a model response. This carries on: it feeds nodes 07 and 08 a
 * canned response so the payload can be produced offline, which is what
 * sql-tests.sh drives publish_report() with.
 *
 * The `fail` mode supplies an Anthropic error instead, so the payload
 * produced is the one the deterministic-fallback path builds.
 */
const path = require('path');
const H = require(path.join(__dirname, 'run.js'));

const period = process.argv[2] || 'last_30d';
const mode = process.argv[3] || 'ok';

const out = H.runPipeline({ period });
const nodeOutputs = out.nodeOutputs;

// A response that is deliberately ordinary: valid JSON, every required
// field, figures that all appear in the brief. Testing the write path, not
// the parser — 07's own edge cases are covered in assertions.js.
const claudeOK = {
  model: 'claude-sonnet-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 2400, output_tokens: 700 },
  content: [{
    type: 'text',
    text: JSON.stringify({
      executive_summary:
        'Revenue held while delivery slipped: every open project is past its due date.',
      risks_and_anomalies: [{
        title: 'Every open project is overdue',
        area: 'project_delivery',
        severity: 'high',
        detail: 'No project completed in the window met its due date.',
      }],
      recommended_actions: [{
        action: 'Triage the blocked projects this week',
        area: 'project_delivery',
        priority: 'high',
        rationale: 'Blocked work is the oldest item in the portfolio.',
      }],
      data_quality_warnings: [{
        issue: 'A lead carries an impossible date',
        source: 'sales',
        impact: 'Excluded from every sales metric.',
      }],
      confidence: 'medium',
    }),
  }],
};

const claudeFail = { error: { type: 'overloaded_error', message: 'Overloaded' } };

nodeOutputs['Parse & Validate Insights'] = H.runCodeNode(
  '07-parse-validate-insights.js',
  [{ json: mode === 'fail' ? claudeFail : claudeOK }],
  nodeOutputs, {},
);

nodeOutputs['Build Supabase Payloads'] = H.runCodeNode(
  '08-build-supabase-payloads.js',
  nodeOutputs['Parse & Validate Insights'],
  nodeOutputs, {},
);

process.stdout.write(JSON.stringify(nodeOutputs['Build Supabase Payloads'][0].json));
