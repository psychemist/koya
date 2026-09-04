// n8n Code node: Parse & Validate Insights
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Parse & Validate Insights               (Run Once for ALL Items)
//
// The gate between the model and the dashboard. Nothing Claude says
// reaches a stakeholder without passing through here.
//
// It does four jobs:
//
//   1. SURVIVES ANY RESPONSE. Anthropic error body, n8n error item after
//      the retries are spent, empty content, truncated JSON, a stray
//      sentence wrapped around the object - each becomes a handled outcome
//      with a reason, never a thrown exception that kills the run.
//
//   2. VALIDATES THE SHAPE. Structured outputs make a schema violation
//      unlikely, not impossible. Missing arrays are coerced to empty ones
//      and enum fields are checked, so the dashboard's rendering code can
//      trust what it is given.
//
//   3. CHECKS THE FIGURES. Every number in the model's prose is matched
//      against `allowed_figures` - the set of numbers actually present in
//      the brief. Anything unmatched is flagged as an unverified figure and
//      shown as such on the dashboard. This is the difference between
//      ASKING for grounded output and CHECKING that it is grounded.
//
//   4. FALLS BACK RATHER THAN FAILING. If the call failed or the output
//      cannot be trusted, a deterministic summary is generated from the
//      metrics themselves. The dashboard is never blank, and it always says
//      which of the two it is showing. A silent blank panel reads as "the
//      business is quiet"; an honest "AI commentary unavailable, here are
//      the numbers" does not.
// ============================================================

// Two paths reach this node: the Claude call, and the short-circuit taken
// when every source was unreachable and calling a model would be paying to
// analyse nothing. On the short-circuit, Build Claude Brief never ran - so
// its absence is an expected state, not an error.
let briefItem = { allowed_figures: [], allowed_entities: [], model: null, estimated_input_tokens: null };
try { briefItem = $('Build Claude Brief').first().json; } catch (e) { /* no-data path */ }

const metrics = $('Compute Metrics').first().json;
const response = $input.first().json || {};

const AREAS = ['sales', 'project_delivery', 'people_ops', 'cross_functional'];
const DEPARTMENTS = ['sales', 'project_delivery', 'people_ops'];
const SEVERITIES = ['high', 'medium', 'low'];
const SOURCES = ['sales', 'project_delivery', 'people_ops', 'period'];
const DEPARTMENT_LABELS = { sales: 'Sales', project_delivery: 'Project Delivery', people_ops: 'People Ops' };

// The teams, departments and lead sources that actually exist in this run's
// data. A name outside this set is treated exactly like a figure outside the
// brief: dropped, and noted. Otherwise the dashboard would file a finding
// under a team that does not exist, and the per-team panel would show it to
// whoever opened the nearest matching name.
const allowedEntities = Array.isArray(briefItem.allowed_entities) ? briefItem.allowed_entities : [];
const entityLookup = {};
for (const e of allowedEntities) entityLookup[String(e).toLowerCase()] = e;

const droppedEntities = [];
function entityOrEmpty(v) {
  const raw = str(v, 120);
  if (!raw) return '';
  const match = entityLookup[raw.toLowerCase()];
  if (match) return match;
  droppedEntities.push(raw);
  return '';
}

const validationNotes = [];

function str(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max || 2000);
}
function oneOf(v, allowed, fallback) {
  const s = str(v).toLowerCase();
  return allowed.indexOf(s) >= 0 ? s : fallback;
}

// ---- 1. did the call succeed at all? ------------------------
function readFailure() {
  // n8n's own error item, after retries are exhausted.
  if (response.error && !response.content) {
    const e = response.error;
    const detail = typeof e === 'string' ? e : str(e.message || e.description || JSON.stringify(e));
    return 'The Claude request failed: ' + detail.slice(0, 250);
  }
  // The Anthropic error body shape.
  if (response.type === 'error' && response.error) {
    return 'Claude returned an error: ' + str(response.error.type) + ' - ' + str(response.error.message).slice(0, 250);
  }
  if (!Array.isArray(response.content)) {
    return 'Claude returned no content block. Received keys: ' + Object.keys(response).join(', ').slice(0, 150);
  }
  // A refusal is a 200 with stop_reason "refusal" - it must not be read as
  // a successful empty answer.
  if (response.stop_reason === 'refusal') {
    return 'Claude declined to answer this request' + (response.stop_details && response.stop_details.category ? ' (' + response.stop_details.category + ')' : '') + '.';
  }
  return null;
}

let failure = readFailure();
let parsed = null;

if (!failure) {
  const text = response.content
    .filter(function (b) { return b && b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('\n')
    .trim();

  if (!text) {
    // An empty response has two very different causes and they need very
    // different fixes, so do not report them with one message. The common
    // one is a max_tokens cut-off: thinking is adaptive and on by default,
    // so a ceiling sized for the answer alone gets spent reasoning and the
    // turn ends with a thinking block and no text block. Saying "empty
    // response" there sends the reader looking at the prompt, which is the
    // one place the problem is not.
    if (response.stop_reason === 'max_tokens') {
      var thought = (response.usage
        && response.usage.output_tokens_details
        && response.usage.output_tokens_details.thinking_tokens) || 0;
      failure = 'Claude hit the max_tokens ceiling before writing an answer'
        + (thought ? ' (' + thought + ' of '
            + ((response.usage && response.usage.output_tokens) || thought)
            + ' output tokens went to thinking)' : '')
        + '. Raise MAX_TOKENS in Build Claude Brief, or lower output_config.effort.';
    } else {
      failure = 'Claude returned an empty response'
        + (response.stop_reason ? ' (stop_reason: ' + response.stop_reason + ')' : '') + '.';
    }
  } else {
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // Structured outputs should make this unreachable. It is kept because
      // "should be unreachable" is not a runtime guarantee, and a fenced or
      // prefaced object is trivially recoverable.
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const candidate = fenced ? fenced[1] : text;
      const a = candidate.indexOf('{');
      const b = candidate.lastIndexOf('}');
      if (a >= 0 && b > a) {
        try {
          parsed = JSON.parse(candidate.slice(a, b + 1));
          validationNotes.push('Response was not clean JSON; the object was recovered from surrounding text.');
        } catch (e2) {
          failure = 'Claude returned unparseable output: ' + str(e2.message).slice(0, 150);
        }
      } else {
        failure = 'Claude returned text with no JSON object in it.';
      }
    }
  }

  if (response.stop_reason === 'max_tokens') {
    validationNotes.push('The response hit the max_tokens ceiling and may be truncated. Raise max_tokens in Build Claude Brief if this recurs.');
  }
}

// ---- 2. deterministic fallback ------------------------------
// Built only from figures already computed. It is deliberately plain: it
// must never be mistaken for the model's analysis.
function buildFallback(reason) {
  const s = metrics.metrics.sales;
  const d = metrics.metrics.delivery;
  const h = metrics.metrics.people_ops;
  const val = function (x) { return x && x.value !== null ? x.value : null; };
  const money = function (n) { return n === null ? 'not available' : n.toLocaleString('en-GB'); };
  const rate = function (n) { return n === null ? 'not available' : (n * 100).toFixed(1) + '%'; };

  const summary = [
    'AI commentary is unavailable for this run (' + reason + '). The figures below were calculated by the workflow and are unaffected.',
    'Sales: ' + val(s.total_leads) + ' leads, ' + val(s.closed_won_deals) + ' closed won, revenue ' + money(val(s.revenue_won)) + ', win rate ' + rate(val(s.win_rate)) + '.',
    'Delivery: ' + val(d.active_projects) + ' active, ' + val(d.completed_projects) + ' completed, ' + val(d.blocked_projects) + ' blocked, on-time rate ' + rate(val(d.on_time_completion_rate)) + '.',
    'People Ops: headcount ' + val(h.active_headcount) + ', ' + val(h.new_hires) + ' new hires, ' + val(h.exits) + ' exits, attrition ' + rate(val(h.attrition_rate)) + '.',
  ].join(' ');

  // A few rules-based risks, so the fallback is still useful rather than
  // merely present.
  const risks = [];
  if (val(d.blocked_projects) > 0) {
    risks.push({
      area: 'project_delivery', entity: '', severity: val(d.blocked_projects) >= 4 ? 'high' : 'medium',
      finding: val(d.blocked_projects) + ' project(s) are currently blocked.',
      evidence: 'blocked_projects = ' + val(d.blocked_projects) + (d._coverage.blocked_project_ids.length ? ' (' + d._coverage.blocked_project_ids.join(', ') + ')' : ''),
    });
  }
  if (val(d.on_time_completion_rate) !== null && val(d.on_time_completion_rate) < 0.7) {
    risks.push({
      area: 'project_delivery', entity: '', severity: 'high',
      finding: 'On-time completion is below 70%.',
      evidence: 'on_time_completion_rate = ' + rate(val(d.on_time_completion_rate)) + ' across ' + d._coverage.projects_completed_in_period + ' completions.',
    });
  }
  if (val(d.budget_variance) !== null && val(d.budget_variance) > 0) {
    risks.push({
      area: 'project_delivery', entity: '', severity: 'medium',
      finding: 'Completed projects came in over budget in aggregate.',
      evidence: 'budget_variance = ' + money(val(d.budget_variance)) + ' across ' + val(d.over_budget_projects) + ' over-budget project(s).',
    });
  }
  if (metrics.data_quality_summary.errors > 0) {
    risks.push({
      area: 'cross_functional', entity: '', severity: 'high',
      finding: 'One or more sources reported an error during this run.',
      evidence: metrics.data_quality_summary.errors + ' error-level data quality issue(s) recorded.',
    });
  }

  // The department sections exist in the fallback too. A dashboard that
  // shows three empty department panels whenever the model call fails reads
  // as a broken dashboard; these are plain, clearly rules-based, and made
  // only of figures the workflow already computed.
  const count = function (x) { return val(x) === null ? 'not available' : String(val(x)); };
  const departments = [
    {
      area: 'sales',
      headline: count(s.total_leads) + ' leads, ' + count(s.closed_won_deals) + ' won, ' + money(val(s.revenue_won)) + ' revenue',
      assessment: 'Written without AI commentary. ' + count(s.total_leads) + ' leads were recorded, ' + count(s.closed_won_deals)
        + ' closed won and ' + count(s.closed_lost_deals) + ' closed lost, giving a win rate of ' + rate(val(s.win_rate))
        + '. Revenue won was ' + money(val(s.revenue_won)) + ' against open pipeline of ' + money(val(s.pipeline_value))
        + ', at a cost per lead of ' + money(val(s.cost_per_lead)) + '.',
      what_is_working: 'Not assessed — this run has no AI commentary.',
      what_needs_attention: 'Not assessed — this run has no AI commentary.',
      priority_action: 'Re-run the report to restore the written analysis for Sales.',
      focus_entities: [],
    },
    {
      area: 'project_delivery',
      headline: count(d.active_projects) + ' active, ' + count(d.blocked_projects) + ' blocked, ' + count(d.completed_projects) + ' completed',
      assessment: 'Written without AI commentary. ' + count(d.active_projects) + ' projects were active and '
        + count(d.completed_projects) + ' completed, of which the on-time rate was ' + rate(val(d.on_time_completion_rate))
        + '. ' + count(d.blocked_projects) + ' are blocked. Budget variance across costed completions was ' + money(val(d.budget_variance)) + '.',
      what_is_working: 'Not assessed — this run has no AI commentary.',
      what_needs_attention: 'Not assessed — this run has no AI commentary.',
      priority_action: 'Re-run the report to restore the written analysis for Project Delivery.',
      focus_entities: [],
    },
    {
      area: 'people_ops',
      headline: count(h.active_headcount) + ' active, ' + count(h.new_hires) + ' hires, ' + count(h.exits) + ' exits',
      assessment: 'Written without AI commentary. Headcount ended the period at ' + count(h.active_headcount)
        + ' after ' + count(h.new_hires) + ' new hires and ' + count(h.exits) + ' exits, an attrition rate of '
        + rate(val(h.attrition_rate)) + '. Time to hire averaged ' + (val(h.time_to_hire_days) === null ? 'not available' : val(h.time_to_hire_days) + ' days') + '.',
      what_is_working: 'Not assessed — this run has no AI commentary.',
      what_needs_attention: 'Not assessed — this run has no AI commentary.',
      priority_action: 'Re-run the report to restore the written analysis for People Ops.',
      focus_entities: [],
    },
  ];

  return {
    executive_summary: summary,
    department_insights: departments,
    risks_and_anomalies: risks,
    recommended_actions: [{
      area: 'cross_functional', entity: '', priority: 'high',
      action: 'Re-run the report to restore AI commentary, and check the n8n execution log for the failed Claude call.',
      rationale: reason,
    }],
    data_quality_warnings: metrics.data_quality
      .filter(function (w) { return w.severity === 'error' || w.severity === 'warning'; })
      .slice(0, 10)
      .map(function (w) {
        return { source: w.source === 'delivery' ? 'project_delivery' : w.source, issue: w.code + (w.record_id ? ' (' + w.record_id + ')' : ''), impact: w.message };
      }),
    confidence: 'low',
  };
}

let insights;
let insightSource;
let failureReason = null;

if (failure) {
  insights = buildFallback(failure);
  insightSource = 'deterministic_fallback';
  failureReason = failure;
} else {
  // ---- 3. normalise & validate the shape --------------------
  const p = parsed || {};

  if (typeof p.executive_summary !== 'string' || !p.executive_summary.trim()) {
    validationNotes.push('executive_summary was missing or empty.');
  }

  function normaliseList(list, name, mapper) {
    if (list === undefined || list === null) {
      validationNotes.push(name + ' was missing; treated as empty.');
      return [];
    }
    if (!Array.isArray(list)) {
      validationNotes.push(name + ' was not an array; treated as empty.');
      return [];
    }
    return list.filter(function (x) { return x && typeof x === 'object'; }).map(mapper).slice(0, 20);
  }

  // Each department gets a section or an explicit blank one. A missing
  // section must not become an absent panel: the manager who opens People
  // Ops and finds nothing cannot tell "nothing to report" from "the model
  // skipped it", and those need different reactions.
  const returnedDepartments = normaliseList(p.department_insights, 'department_insights', function (x) {
    return {
      area: oneOf(x.area, DEPARTMENTS, ''),
      headline: str(x.headline, 200),
      assessment: str(x.assessment, 2000),
      what_is_working: str(x.what_is_working, 600),
      what_needs_attention: str(x.what_needs_attention, 600),
      priority_action: str(x.priority_action, 600),
      focus_entities: (Array.isArray(x.focus_entities) ? x.focus_entities : [])
        .map(entityOrEmpty).filter(Boolean).slice(0, 6),
    };
  }).filter(function (x) { return x.area && x.assessment; });

  const departmentInsights = DEPARTMENTS.map(function (area) {
    const found = returnedDepartments.filter(function (x) { return x.area === area; })[0];
    if (found) return found;
    validationNotes.push('No department section was returned for ' + DEPARTMENT_LABELS[area] + '.');
    return {
      area: area,
      headline: 'No section returned for ' + DEPARTMENT_LABELS[area],
      assessment: 'The analysis did not include a section for ' + DEPARTMENT_LABELS[area] +
        '. The figures for it above are unaffected — they are calculated by the workflow, not written by the model.',
      what_is_working: '',
      what_needs_attention: '',
      priority_action: '',
      focus_entities: [],
      missing: true,
    };
  });

  insights = {
    executive_summary: str(p.executive_summary, 3000) || 'No executive summary was returned.',
    department_insights: departmentInsights,
    risks_and_anomalies: normaliseList(p.risks_and_anomalies, 'risks_and_anomalies', function (r) {
      return {
        area: oneOf(r.area, AREAS, 'cross_functional'),
        entity: entityOrEmpty(r.entity),
        severity: oneOf(r.severity, SEVERITIES, 'medium'),
        finding: str(r.finding, 600),
        evidence: str(r.evidence, 600),
      };
    }).filter(function (r) { return r.finding; }),
    recommended_actions: normaliseList(p.recommended_actions, 'recommended_actions', function (a) {
      return {
        area: oneOf(a.area, AREAS, 'cross_functional'),
        entity: entityOrEmpty(a.entity),
        priority: oneOf(a.priority, SEVERITIES, 'medium'),
        action: str(a.action, 600),
        rationale: str(a.rationale, 600),
      };
    }).filter(function (a) { return a.action; }),
    data_quality_warnings: normaliseList(p.data_quality_warnings, 'data_quality_warnings', function (w) {
      return {
        source: oneOf(w.source, SOURCES, 'period'),
        issue: str(w.issue, 600),
        impact: str(w.impact, 600),
      };
    }).filter(function (w) { return w.issue; }),
    confidence: oneOf(p.confidence, ['high', 'medium', 'low'], 'medium'),
  };
  insightSource = 'claude';
}

// ---- 4. groundedness check ----------------------------------
// Pull every number out of the model's prose and match it against the
// figures it was actually given. Tolerances handle honest presentation:
// a rate of 0.6 written as "60%", a rounded 2867.74 written as "2,868",
// and counts restated as words are all legitimate.
const allowed = new Set();
for (const f of (briefItem.allowed_figures || [])) {
  allowed.add(f);
  allowed.add(Math.round(f));
  allowed.add(Math.round(f * 100) / 100);
  allowed.add(Math.round(f * 100));   // 0.6 -> 60, for percentages
  allowed.add(Math.round(f * 1000) / 10);
}
// Ordinals, small counts and years are not claims about the data.
const IGNORE = new Set([0, 1, 2, 3, 4, 5, 10, 20, 25, 30, 50, 75, 90, 100, 2024, 2025, 2026, 2027]);

const prose = [
  insights.executive_summary,
  // The department sections carry more figures than anything else the model
  // writes, so leaving them out of the check would have exempted most of the
  // commentary from the one guarantee this node exists to make.
  (insights.department_insights || []).map(function (x) {
    return [x.headline, x.assessment, x.what_is_working, x.what_needs_attention, x.priority_action].join(' ');
  }).join(' '),
  insights.risks_and_anomalies.map(function (r) { return r.finding + ' ' + r.evidence; }).join(' '),
  insights.recommended_actions.map(function (a) { return a.action + ' ' + a.rationale; }).join(' '),
  insights.data_quality_warnings.map(function (w) { return w.issue + ' ' + w.impact; }).join(' '),
].join(' ');

const unverifiedFigures = [];
if (insightSource === 'claude') {
  // The lookbehind is load-bearing. A bare /-?\d.../ reads the hyphen in an
  // IDENTIFIER as a minus sign, so "PROJ-2001 and PROJ-2002 completed without
  // a due date" yields the figures -2001 and -2002, and "starts 2026-07-07"
  // yields -07 and -07. -- none of which are in allowed_figures, because none
  // of them are numbers anyone claimed. That sentence alone produces enough
  // unverified figures to trip the >2 rule and pin the report at LOW
  // confidence forever.
  //
  // Which makes it worse than a false positive: the prompt asks Claude to
  // name the offending records in data_quality_warnings, and this check then
  // punished it for complying. Doing the right thing was what capped the
  // score, so the badge moved with how many ids the commentary happened to
  // mention rather than with whether the numbers were real.
  //
  // Requiring that a digit or a leading minus not be preceded by a letter,
  // digit, underscore or hyphen keeps genuine negatives ("slipped by -12
  // days") and drops identifier and date fragments.
  const tokens = prose.match(/(?<![A-Za-z0-9_-])-?\d[\d,]*\.?\d*/g) || [];
  const checked = new Set();
  for (const t of tokens) {
    const n = Number(t.replace(/,/g, ''));
    if (!Number.isFinite(n) || IGNORE.has(n) || checked.has(n)) continue;
    checked.add(n);
    // Accept an exact match, or a match within 1% - the tolerance that
    // covers a figure quoted to fewer decimal places than it was given.
    let ok = allowed.has(n);
    if (!ok) {
      for (const f of allowed) {
        if (f !== 0 && Math.abs((n - f) / f) < 0.01) { ok = true; break; }
        if (f === 0 && n === 0) { ok = true; break; }
      }
    }
    if (!ok) unverifiedFigures.push(n);
  }
}

if (droppedEntities.length) {
  validationNotes.push('Names used in the commentary that do not exist in this run\'s data, and were dropped: ' +
    Array.from(new Set(droppedEntities)).slice(0, 8).join(', ') + '.');
}

if (unverifiedFigures.length) {
  validationNotes.push('Figures in the commentary that do not appear in the brief: ' + unverifiedFigures.slice(0, 12).join(', ') + '. Treat those statements with caution.');
}

// Confidence is capped by what the CHECK found, not by what the model
// claimed about itself. A model asserting "high" while citing figures it
// was never given must not be able to badge its own output as reliable.
let finalConfidence = insights.confidence;
if (insightSource !== 'claude') {
  finalConfidence = 'low';
} else if (unverifiedFigures.length > 2 || metrics.data_quality_summary.errors > 0) {
  finalConfidence = 'low';
} else if (unverifiedFigures.length > 0 && finalConfidence === 'high') {
  finalConfidence = 'medium';
}

const usage = response.usage || {};

return [{
  json: {
    run_id: metrics.run_id,
    metrics_hash: metrics.metrics_hash,
    insight_source: insightSource,
    model: insightSource === 'claude' ? (response.model || briefItem.model) : null,
    insights: Object.assign({}, insights, { confidence: finalConfidence }),
    model_confidence_claimed: insights.confidence,
    validation_notes: validationNotes,
    unverified_figures: unverifiedFigures,
    grounded: insightSource === 'claude' && unverifiedFigures.length === 0,
    failure_reason: failureReason,
    stop_reason: response.stop_reason || null,
    usage: {
      input_tokens: usage.input_tokens || null,
      output_tokens: usage.output_tokens || null,
      cache_read_input_tokens: usage.cache_read_input_tokens || null,
    },
    generated_at: new Date().toISOString(),
  },
}];
