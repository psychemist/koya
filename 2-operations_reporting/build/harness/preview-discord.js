#!/usr/bin/env node
/*
 * Renders the Discord report offline, exactly as the workflow would post it.
 *
 *   node harness/preview-discord.js [last_30d|last_90d|ytd] [ok|fail]
 *
 * run.js stops at the Claude brief, because everything past it needs a model
 * response. This carries on with a canned one, then runs 07 → 08 → 09 → 10
 * so the message that would land in the channel can be read before anyone
 * connects a webhook. The `fail` mode supplies an Anthropic error instead,
 * which is how the deterministic-fallback wording gets eyes on it too.
 *
 * The dividers below are where Discord's 2000-character cap would split the
 * report into separate messages. If a part is over the cap here, it is over
 * the cap in production and Discord rejects the POST outright.
 */
const path = require('path');
const H = require(path.join(__dirname, 'run.js'));

const period = process.argv[2] || 'last_30d';
const mode = process.argv[3] || 'ok';

const out = H.runPipeline({ period });
const nodeOutputs = out.nodeOutputs;

const claudeOK = {
  model: 'claude-sonnet-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 3490, output_tokens: 640 },
  content: [{
    type: 'text',
    text: JSON.stringify({
      executive_summary:
        'Sample commentary. Delivery is the story: both projects completed in the window landed '
        + 'late, so on-time completion is 0% and five projects sit blocked. Sales held a 60.0% win '
        + 'rate on 34,200 of revenue won, and People Ops added 5 hires against 1 exit.',
      risks_and_anomalies: [
        { area: 'project_delivery', severity: 'high',
          finding: 'Every project completed in this window finished late.',
          evidence: 'On-time completion 0% across 2 completions with a due date; average delay 6.5 days.' },
        { area: 'sales', severity: 'low',
          finding: 'Event-sourced leads produced no closed-won revenue this period.',
          evidence: '2 Event leads, 0 closed won.' },
      ],
      recommended_actions: [
        { area: 'project_delivery', priority: 'high',
          action: 'Run a blocker review with the four team leads before the next sprint.',
          rationale: 'Five projects are blocked with no completions from two teams this period.' },
      ],
      data_quality_warnings: [
        { source: 'sales', issue: 'One lead has no status and one has no deal amount.',
          impact: 'Win rate and revenue won each exclude one record, so both are marginally understated.' },
      ],
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
  nodeOutputs['Parse & Validate Insights'], nodeOutputs, {},
);

// Stand in for the publish_report() response: the row counts the payload
// says it sent, echoed back as the counts Postgres reports writing. 09's job
// is to compare the two, and here they agree.
const sent = nodeOutputs['Build Supabase Payloads'][0].json;
const rpcResponse = {
  ok: true,
  run_id: sent.run_id,
  publish_state: 'published',
  rows: Object.assign({}, sent.row_counts, { report_insights: 1 }),
};
nodeOutputs['Verify Publish'] = H.runCodeNode(
  '09-verify-publish.js', [{ json: rpcResponse }], nodeOutputs, {},
);

const messages = H.runCodeNode(
  '10-build-discord-report.js', nodeOutputs['Verify Publish'], nodeOutputs, {},
);

const CAP = 2000;
let over = 0;
messages.forEach((m, i) => {
  const body = m.json.content;
  const flag = body.length > CAP ? '  *** OVER DISCORD\'S 2000 CHARACTER CAP ***' : '';
  if (body.length > CAP) over += 1;
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  message ${i + 1} of ${messages.length}   ${body.length} chars${flag}`);
  console.log('═'.repeat(64));
  console.log(body);
});

console.log(`\n${'─'.repeat(64)}`);
console.log(`  ${messages.length} message(s), ${messages.reduce((a, m) => a + m.json.content.length, 0)} characters total`);
console.log('─'.repeat(64) + '\n');
process.exit(over ? 1 : 0);
