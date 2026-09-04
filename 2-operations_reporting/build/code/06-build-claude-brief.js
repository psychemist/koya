// n8n Code node: Build Claude Brief
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Build Claude Brief                      (Run Once for ALL Items)
//
// Turns the metrics payload into the exact request body sent to the
// Messages API. The prompt lives HERE, in a versioned Code node, rather
// than in an HTTP node's parameter box - a prompt is the most-edited and
// least-reviewed part of an AI workflow, and it deserves to sit somewhere
// a diff can be read.
//
// WHAT CLAUDE IS AND IS NOT ASKED TO DO
// --------------------------------------
// It receives ~40 finished numbers, their comparison values, and a data
// quality digest. It never sees a raw row and is never asked to count
// anything. Sending 313 rows would cost roughly 20x the tokens and invite
// arithmetic the workflow has already done correctly and deterministically.
// The division is the point: n8n owns the arithmetic, Claude owns the
// judgement, and a wrong number can only ever come from code you can test.
//
// THE ALLOWED-FIGURES LIST
// ------------------------
// Every number in the brief is also collected into `allowed_figures`. The
// parse node checks the model's prose against it and flags any figure that
// did not come from the data. That is how "grounded in the calculated
// metrics, not unsupported assumptions" gets enforced rather than merely
// requested in a prompt.
// ============================================================

const m = $input.first().json;

const MODEL = 'claude-sonnet-5';

// max_tokens is the ceiling on EVERYTHING the model emits, and on Sonnet 5
// that includes its thinking. Thinking is adaptive and ON BY DEFAULT here --
// omitting the parameter does not turn it off -- so a tight ceiling is spent
// reasoning before a single character of the answer is written. At 2000 this
// node failed exactly that way: usage came back thinking_tokens 2000 /
// output_tokens 2000, stop_reason max_tokens, and content held one thinking
// block and no text block. The run looked like "Claude returned an empty
// response" when the model had simply been cut off mid-thought.
//
// 16000 is the documented default for a non-streaming request: enough room
// that thinking plus a ~600-token JSON object never collides with the cap,
// and still well under the SDK's HTTP timeout. It is a CEILING, not a
// reservation -- a typical run finishes far below it and is billed on what
// it actually emits, so raising it costs nothing when it is not needed.
// Depth of reasoning is controlled by output_config.effort below, which is
// the knob to turn for cost; max_tokens is the safety net, not the budget.
const MAX_TOKENS = 16000;

function flat(node) {
  // {value, unavailable_reason} -> either the value, or a phrase that says
  // WHY it is missing. Claude must never see a bare null, because a bare
  // null is indistinguishable from zero once it is inside a sentence.
  if (node && typeof node === 'object' && 'value' in node) {
    return node.value === null ? { unavailable: node.unavailable_reason } : node.value;
  }
  return node;
}

function flatten(domain) {
  const out = {};
  for (const k of Object.keys(domain)) {
    if (k === '_coverage') continue;
    // The bucketed series is sent separately, under a key that says what it
    // is. Left inline it reads as just another metric and the model quotes a
    // single bucket as if it were the period total.
    if (k === 'trend_series') continue;
    out[k] = flat(domain[k]);
  }
  return out;
}

// The series, trimmed to what a sentence can use: the bucket, the flows, and
// nothing else. `partial` is kept because the first bucket of a window is
// usually short, and a model told only the number will read the dip as a fall.
function trimSeries(rows, keys) {
  return (rows || []).map(function (b) {
    const out = { bucket: b.label, days: b.days };
    if (b.partial) out.partial_bucket = true;
    for (const k of keys) out[k] = b[k];
    return out;
  });
}

function trimTrends(t) {
  // Only movements worth a sentence. Sending 24 rows of "flat" invites the
  // model to write about the ones that did not move.
  const out = {};
  for (const k of Object.keys(t)) {
    const x = t[k];
    if (x.direction === 'not_comparable' || x.direction === 'flat' || x.direction === 'stable') continue;
    out[k] = {
      now: x.current,
      was: x.previous,
      change: x.change,
      percent_change: x.percent_change,
      direction: x.direction,
    };
  }
  return out;
}

// Group the data quality list by code so 40 identical warnings arrive as
// one line with a count, not 40 lines that crowd out the numbers.
const dqByCode = {};
for (const d of m.data_quality) {
  const key = d.source + '/' + d.code;
  if (!dqByCode[key]) dqByCode[key] = { source: d.source, code: d.code, severity: d.severity, count: 0, examples: [], message: d.message };
  dqByCode[key].count += 1;
  if (d.record_id && dqByCode[key].examples.length < 3) dqByCode[key].examples.push(d.record_id);
}
const dataQualityDigest = Object.keys(dqByCode).map(function (k) { return dqByCode[k]; })
  .sort(function (a, b) {
    const rank = { error: 0, warning: 1, info: 2 };
    return (rank[a.severity] - rank[b.severity]) || (b.count - a.count);
  });

const brief = {
  reporting_period: {
    label: m.period.label,
    start: m.period.start,
    end: m.period.end,
    days: m.period.days,
    compared_against: m.period.compare_label + ' (' + m.period.compare_start + ' to ' + m.period.compare_end + ')',
  },
  sales: flatten(m.metrics.sales),
  project_delivery: flatten(m.metrics.delivery),
  people_ops: flatten(m.metrics.people_ops),
  movements_vs_comparison_period: {
    sales: trimTrends(m.trends.sales),
    project_delivery: trimTrends(m.trends.delivery),
    people_ops: trimTrends(m.trends.people_ops),
  },
  // The shape of the window, not just its total. Two totals can only say
  // "up" or "down"; this is what lets the commentary say whether something
  // is building, easing, or was one bad week.
  shape_of_the_period: {
    grain: m.trend_grain,
    note: 'Each row is one ' + m.trend_grain + ' inside the selected period. A row marked partial_bucket covers fewer days than the others and its totals are not comparable with theirs.',
    sales: trimSeries(m.metrics.sales.trend_series && m.metrics.sales.trend_series.value,
      ['leads', 'closed_won', 'closed_lost', 'revenue_won']),
    project_delivery: trimSeries(m.metrics.delivery.trend_series && m.metrics.delivery.trend_series.value,
      ['kickoffs', 'completed', 'completed_late']),
    people_ops: trimSeries(m.metrics.people_ops.trend_series && m.metrics.people_ops.trend_series.value,
      ['applications', 'new_hires', 'exits', 'active_headcount']),
  },
  calculation_notes: {
    marketing_spend: m.metrics.sales._coverage.marketing_spend_basis,
    headcount: m.metrics.people_ops._coverage.headcount_basis,
    delivery_status: 'Project status is a point-in-time snapshot, so "active" means open today and running at some point during the window.',
    win_rate: 'Closed won divided by closed won plus closed lost. Open deals are excluded from the denominator.',
    attrition: 'Exits in the window divided by headcount on the day before the window opened.',
  },
  records_behind_the_numbers: {
    sales: m.metrics.sales._coverage,
    project_delivery: m.metrics.delivery._coverage,
    people_ops: m.metrics.people_ops._coverage,
  },
  data_quality: dataQualityDigest,
  source_health: m.source_health,
  run_status: m.run_status,
};

// ---- the names the model is allowed to use -------------------
// Teams, departments and lead sources, exactly as they appear in the data.
// The parse node checks any `entity` the model returns against this list, so
// a finding can be filed under a real team rather than an invented one - the
// same treatment the figures get, applied to the names.
const namedEntities = []
  .concat(((m.metrics.sales.revenue_by_lead_source || {}).value || []).map(function (x) { return x.lead_source; }))
  .concat(((m.metrics.delivery.delivery_load_by_team || {}).value || []).map(function (x) { return x.team; }))
  .concat(((m.metrics.people_ops.headcount_by_department || {}).value || []).map(function (x) { return x.department; }))
  .filter(Boolean);

// ---- allowed figures ----------------------------------------
// Every number that appears anywhere in the brief, so the parse node can
// check the model's prose against the data it was given.
const allowedFigures = [];
(function walk(node) {
  if (node === null || node === undefined) return;
  if (typeof node === 'number' && Number.isFinite(node)) { allowedFigures.push(node); return; }
  if (Array.isArray(node)) { node.forEach(walk); return; }
  if (typeof node === 'object') { Object.keys(node).forEach(function (k) { walk(node[k]); }); }
})(brief);
const uniqueFigures = Array.from(new Set(allowedFigures));

// ---- prompt -------------------------------------------------
const system = [
  'You brief the commercial team at Koya Talent - sales, marketing and the people who own the revenue number. You write the commentary that sits under the numbers on their dashboard.',
  '',
  'They are smart and busy, and they are not analysts. They care about pipeline, deals won and lost, what marketing spend bought, whether delivery is protecting the client relationship, and whether hiring can keep up with demand. Write to that.',
  '',
  'Every figure has already been calculated from the source systems and verified. Your job is interpretation, not arithmetic.',
  '',
  'Rules, in order of importance:',
  '1. Use ONLY the figures in the brief. Never estimate, extrapolate, or infer a number that is not there. If a number would help and you do not have it, say what is missing instead of producing one.',
  '2. Do not recompute anything. If two figures in the brief look inconsistent, report that as an observation rather than picking one and correcting it.',
  '3. A metric marked {"unavailable": "..."} was NOT zero. It could not be calculated, and the reason is given. Never describe an unavailable metric as a decline, a shortfall, or a zero.',
  '4. Only describe a trend when the brief contains a movement for it in movements_vs_comparison_period. Anything not listed there did not move meaningfully, and saying otherwise is inventing a trend.',
  '5. Volume matters. A rate computed from three records is not evidence of anything. Where a percentage rests on a small denominator, say so in the same sentence.',
  '6. Be specific, and put the number in a sentence a salesperson would say out loud. "We closed 18 of 30 deals - just under two in three" beats "win rate 0.6". Always give the figure, never only the figure.',
  '7. Lead with the money and the client. Revenue, pipeline, cost per lead, deals won and lost, work that is late or over budget in front of a client, hiring that is or is not keeping up. Process detail earns its place only when it explains one of those.',
  '8. Minimal internal or technical vocabulary. Write record ids (PROJ-2001, EMP-3086) sparingly. Never field names, "null", "records", "dataset", "denominator", "normalised" or "pipeline" in the software sense. If something is missing, say what it stops the team from knowing.',
  '9. No jargon and no filler openers. Do not open with "This period saw" or "Overall". Start with the fact. Short sentences. British spelling. Money is written as a bare number with a comma and NO currency symbol or code: 3,060, never GBP 3,060 and never a currency sign. Round percentages to one decimal place: 1.5%.',
  '10. Every risk needs a "so what". Name the commercial consequence: revenue at risk, a client likely to notice, a month where capacity runs out. A finding with no consequence is not a risk, it is trivia - leave it out.',
  '11. Recommended actions go to a named function - Sales, Marketing, Project Delivery or People Ops - and are something a person could start on Monday. Not "improve data quality" but "ask Project Delivery to add due dates to the two projects missing them before the next review".',
  '12. If a section genuinely has nothing worth reporting, return an empty list for it and say so in the executive summary. Do not manufacture findings to fill a quota.',
  '',
  'THE DEPARTMENT SECTIONS. department_insights carries one entry for Sales, one for Project Delivery and one for People Ops, every time, even when a department had a quiet period - a manager opening their own section and finding nothing there learns nothing. Each entry is read on its own, by the person who runs that department, so it has to stand up without the executive summary next to it. Answer the questions that department would ask:',
  '  Sales - which lead sources produced the revenue and which absorbed spend without returning it; whether win rate moved; what a lead cost; where the pipeline sits.',
  '  Project Delivery - which teams or owners are carrying the load; whether blocked work is building; whether work is landing late or over budget; the one delivery problem to fix first.',
  '  People Ops - whether hiring is keeping up; whether exits concentrate in one department; whether time to hire is moving; which gaps in the records reduce confidence.',
  'Name the specific team, department or lead source you mean, and put its figure beside it. A department section that could have been written about any company is a failed section.',
  '',
  'THE SHAPE OF THE PERIOD. shape_of_the_period breaks the window into buckets. Use it to say whether something is building or easing rather than only where it ended - "blocked work has grown in each of the last three weeks" is worth more than the count on its own. Never compare a bucket marked partial_bucket with a full one; it covers fewer days.',
  '',
  'ENTITIES. Where a finding or an action is about one team, department or lead source, put that name in `entity`, spelled exactly as the brief spells it. Where it is not about one, `entity` is an empty string. Never put a name there that does not appear in the brief.',
  '13. Capitalise department names exactly like this everywhere they appear: Sales, Marketing, People Ops, Project Delivery, Customer Success, Engineering.',
  '',
  'Return JSON matching the supplied schema. Nothing else.',
].join('\n');

const user = [
  'Reporting period: ' + m.period.label + ' (' + m.period.start + ' to ' + m.period.end + ').',
  '',
  'Analyse the brief below and answer, where the data supports it:',
  '',
  'Sales and marketing — which lead sources are actually bringing in revenue and which are absorbing spend without returning it; whether we are winning more or less of what we chase; what a lead costs us now against what it cost before; where the pipeline is concentrated.',
  'Project Delivery — whether the work we sold is landing on time and on budget, and where a client would be the one to notice first; whether blocked work is stacking up; the single delivery problem worth fixing first; which teams or owners are overloaded this period.',
  'People Ops — whether we are hiring fast enough to service what sales is winning; whether people are leaving from one team in particular; whether offers are taking longer to land.',
  '',
  'BRIEF',
  JSON.stringify(brief, null, 1),
].join('\n');

// ---- response schema ----------------------------------------
// Structured outputs, not a "please reply in JSON" instruction. The API
// constrains generation to this schema, so the parse node never has to
// recover from a stray sentence wrapped around the object.
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['executive_summary', 'department_insights', 'risks_and_anomalies', 'recommended_actions', 'data_quality_warnings', 'confidence'],
  properties: {
    executive_summary: {
      type: 'string',
      description: 'Three to five sentences on what matters most in this period. Lead with the single most important fact.',
    },
    risks_and_anomalies: {
      type: 'array',
      description: 'Unusual trends, underperformance, spikes, delivery risks, or missing-data patterns. Empty array if there are none worth raising.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['area', 'entity', 'severity', 'finding', 'evidence'],
        properties: {
          area: { type: 'string', enum: ['sales', 'project_delivery', 'people_ops', 'cross_functional'] },
          entity: { type: 'string', description: 'The team, department or lead source this is about, spelled exactly as the brief spells it. Empty string when it is not about one.' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          finding: { type: 'string', description: 'One sentence naming the risk.' },
          evidence: { type: 'string', description: 'The figures from the brief that support it, quoted exactly.' },
        },
      },
    },
    recommended_actions: {
      type: 'array',
      description: 'Concrete next steps a manager could take this week. Empty array if nothing is warranted.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['area', 'entity', 'priority', 'action', 'rationale'],
        properties: {
          area: { type: 'string', enum: ['sales', 'project_delivery', 'people_ops', 'cross_functional'] },
          entity: { type: 'string', description: 'The team, department or lead source this is about, spelled exactly as the brief spells it. Empty string when it is not about one.' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          action: { type: 'string', description: 'An instruction, starting with a verb, that names who does what.' },
          rationale: { type: 'string', description: 'The figure that makes this worth doing.' },
        },
      },
    },
    department_insights: {
      type: 'array',
      description: 'Exactly three entries — one for sales, one for project_delivery, one for people_ops, in that order. Each is read on its own by the manager of that department.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['area', 'headline', 'assessment', 'what_is_working', 'what_needs_attention', 'priority_action', 'focus_entities'],
        properties: {
          area: { type: 'string', enum: ['sales', 'project_delivery', 'people_ops'] },
          headline: { type: 'string', description: 'One short line, under about twelve words, carrying the single most important fact for this department. It sits above the section as its title.' },
          assessment: { type: 'string', description: 'Three to five sentences answering the questions that department would ask, with the figures in them. Name teams, departments or lead sources rather than talking in general terms.' },
          what_is_working: { type: 'string', description: 'The one thing going well, with the figure behind it. Say plainly if there is nothing.' },
          what_needs_attention: { type: 'string', description: 'The one thing that is not, with the figure behind it, and what it costs the business.' },
          priority_action: { type: 'string', description: 'The single next step for this department, starting with a verb, naming who does it.' },
          focus_entities: {
            type: 'array',
            description: 'The teams, departments or lead sources this section is about, spelled exactly as the brief spells them. Empty array if none in particular.',
            items: { type: 'string' },
          },
        },
      },
    },
    data_quality_warnings: {
      type: 'array',
      description: 'Source issues that reduce confidence in this report, in the analyst\'s own words. Empty array if none affect the conclusions.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'issue', 'impact'],
        properties: {
          source: { type: 'string', enum: ['sales', 'project_delivery', 'people_ops', 'period'] },
          issue: { type: 'string' },
          impact: { type: 'string', description: 'Which metric this makes less reliable, and how.' },
        },
      },
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'Confidence in this report given data completeness and the volume behind the numbers.',
    },
  },
};

// NOTE ON PARAMETERS: temperature, top_p and top_k are REMOVED on Claude
// Sonnet 5 and return a 400 if sent. Determinism is bought here with a
// structured output schema and a tightly scoped prompt instead. Sending
// `temperature: 0` out of habit is the fastest way to break this node.
// `budget_tokens` is gone the same way -- adaptive thinking replaced the
// fixed-budget form, and sending it is also a 400.
const requestBody = {
  model: MODEL,
  max_tokens: MAX_TOKENS,
  // Stated rather than omitted. Omitting it on Sonnet 5 does NOT mean "no
  // thinking" -- the model runs adaptive either way -- and a reader who
  // assumes otherwise will size max_tokens for the answer alone and
  // reintroduce the truncation above. Writing it down makes the thinking
  // budget a visible part of the request instead of an invisible default.
  // display stays at its default ('omitted'): nothing downstream reads the
  // reasoning, and it is billed identically whether or not it is returned.
  thinking: { type: 'adaptive' },
  system: system,
  messages: [{ role: 'user', content: user }],
  output_config: {
    format: { type: 'json_schema', schema: schema },
    effort: 'medium',
  },
};

// Rough token estimate at ~3.6 chars/token, used only for the cost note on
// the run record. It is an estimate and is labelled as one.
const promptChars = system.length + user.length;
const estimatedInputTokens = Math.round(promptChars / 3.6);

return [{
  json: {
    run_id: m.run_id,
    metrics_hash: m.metrics_hash,
    model: MODEL,
    request_body: requestBody,
    brief: brief,
    allowed_figures: uniqueFigures,
    allowed_entities: Array.from(new Set(namedEntities)),
    estimated_input_tokens: estimatedInputTokens,
    prompt_chars: promptChars,
  },
}];
