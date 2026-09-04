// n8n Code node: Compute Metrics
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Compute Metrics                         (Run Once for ALL Items)
//
// The analytical core. Every number the dashboard shows and every number
// Claude is given is produced here, in one deterministic pass, with no
// model involved. Claude interprets these figures; it never produces them.
// That split is the whole reliability story: an LLM that miscounts is a
// bug you cannot see, so the LLM is not allowed to count.
//
// The same function runs TWICE - once over the selected period and once
// over the comparison window - so "win rate declined" is a measured delta
// and not a model's impression.
//
// THREE JUDGEMENT CALLS, MADE EXPLICITLY:
//
// 1. MARKETING SPEND IS NOT A COLUMN SUM. The source repeats one monthly
//    budget on every row of that month. Summing it over the full history
//    returns 291,800 against a true 33,500, and cost per lead inherits the
//    error. Spend is collapsed to one figure per calendar month and then
//    pro-rated across the window's partial months.
//
// 2. A MISSING INPUT MAKES A METRIC UNAVAILABLE, NOT ZERO. Every ratio
//    returns null when its denominator is empty, and every null carries a
//    stated reason. A dashboard showing "0%" win rate when there were no
//    closed deals is lying; "not enough data" is the truth.
//
// 3. EVERY METRIC REPORTS WHAT IT COUNTED. Each figure ships with the
//    number of records included and excluded, so any number on the
//    dashboard can be reconciled against the source without opening n8n.
//
// 4. DATA QUALITY IS SCOPED TO THE SELECTED WINDOW. A warning about a
//    lead from March is not a warning about a June report. The normalizers
//    stamp every issue with the dates of the record it came from; this node
//    keeps the ones that touch the window, and folds the rest into a single
//    counted line. See "data quality, scoped to the window" below.
//
// 5. EVERY DOMAIN ALSO REPORTS ITS SHAPE, not only its total. A window's
//    figures cannot answer "is this getting worse?" - so each domain emits
//    a bucketed series across the window (daily, weekly or monthly, chosen
//    by span) which the dashboard draws as trend charts and Claude reads
//    as movement it did not have to infer.
// ============================================================

const period = $('Resolve Reporting Period').first().json;

function pull(nodeName) {
  // A source node that failed outright leaves nothing to reference. Return
  // an empty set and let the missing-source check downstream report it,
  // rather than throwing and taking the whole report down with it.
  try { return $(nodeName).all().map(function (i) { return i.json || {}; }); }
  catch (e) { return []; }
}

const salesRaw = pull('Normalize Sales');
const deliveryRaw = pull('Normalize Delivery');
const peopleRaw = pull('Normalize People Ops');

// A DEPLOYMENT problem and a DATA problem are different things and must not
// share a channel. An unset Supabase URL will break the write, but it says
// nothing about whether the numbers are trustworthy - and letting it into
// data_quality would downgrade the report's confidence badge for a reason
// that has nothing to do with the report.
const CONFIG_CODES = ['SUPABASE_URL_NOT_SET'];
const periodWarnings = period.period_warnings || [];
const configErrors = periodWarnings.filter(function (w) { return CONFIG_CODES.indexOf(w.code) >= 0; });

// Diagnostics were attached to the first item of each source.
const dataQuality = []
  .concat((salesRaw[0] && salesRaw[0]._source_issues) || [])
  .concat((deliveryRaw[0] && deliveryRaw[0]._source_issues) || [])
  .concat((peopleRaw[0] && peopleRaw[0]._source_issues) || [])
  .concat(periodWarnings
    .filter(function (w) { return CONFIG_CODES.indexOf(w.code) === -1; })
    .map(function (w) {
      return { source: 'period', severity: w.severity, code: w.code, record_id: null, message: w.message };
    }));

const sales = salesRaw.filter(function (r) { return r._source === 'sales' && !r._empty; });
const delivery = deliveryRaw.filter(function (r) { return r._source === 'delivery' && !r._empty; });
const people = peopleRaw.filter(function (r) { return r._source === 'people_ops' && !r._empty; });

// ---- small numeric helpers ----------------------------------
function inRange(d, start, end) { return Boolean(d) && d >= start && d <= end; }
function round(n, dp) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = Math.pow(10, dp === undefined ? 2 : dp);
  return Math.round(n * f) / f;
}
function sum(arr) { return arr.reduce(function (a, b) { return a + b; }, 0); }
function mean(arr) { return arr.length ? sum(arr) / arr.length : null; }
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
}
function pad2(n) { return String(n).padStart(2, '0'); }
function nextMonth(ym) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 12 ? (y + 1) + '-01' : y + '-' + pad2(m + 1);
}
function uniq(arr) { return Array.from(new Set(arr)); }
function daysInMonth(ym) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
// A metric that could not be computed. The reason travels with the null so
// the dashboard and Claude both explain the gap instead of showing a dash.
function unavailable(reason) { return { value: null, unavailable_reason: reason }; }
function value(v) { return { value: v, unavailable_reason: null }; }

// ---- marketing spend ----------------------------------------
// Build the month -> budget map ONCE, from the whole dataset rather than
// the window, so a window covering half of June still knows June's budget.
const spendByMonth = {};
const spendConflicts = {};
for (const r of sales) {
  if (!r.spend_month || r.marketing_spend === null || r.marketing_spend === undefined) continue;
  if (spendByMonth[r.spend_month] === undefined) {
    spendByMonth[r.spend_month] = r.marketing_spend;
  } else if (spendByMonth[r.spend_month] !== r.marketing_spend) {
    // If the assumption ever breaks - two different budgets in one month -
    // the code must not quietly pick one. Keep the max and say so.
    spendConflicts[r.spend_month] = true;
    spendByMonth[r.spend_month] = Math.max(spendByMonth[r.spend_month], r.marketing_spend);
  }
}
for (const m of Object.keys(spendConflicts)) {
  dataQuality.push({
    source: 'sales', severity: 'warning', code: 'SPEND_CONFLICT', record_id: null,
    message: 'Month ' + m + ' carries more than one marketing spend figure. The highest was used; marketing spend for any window covering ' + m + ' is approximate.',
  });
}

// Pro-rates each month's budget by how much of it the window covers.
// "Last 30 days" = 31 May - 30 Jun takes 1/31 of May's budget and all of
// June's. Straight-summing the months touched would count a whole month of
// May spend for a single day of it.
function computeMarketingSpend(start, end, reportIssues) {
  let total = 0;
  const months = [];
  const missing = [];
  let cursor = start.slice(0, 7);
  const lastMonth = end.slice(0, 7);

  while (cursor <= lastMonth) {
    const dim = daysInMonth(cursor);
    const monthStart = cursor + '-01';
    const monthEnd = cursor + '-' + String(dim).padStart(2, '0');
    const overlapStart = monthStart > start ? monthStart : start;
    const overlapEnd = monthEnd < end ? monthEnd : end;
    const covered = Math.round((new Date(overlapEnd + 'T00:00:00Z') - new Date(overlapStart + 'T00:00:00Z')) / 86400000) + 1;

    if (spendByMonth[cursor] === undefined) {
      missing.push(cursor);
    } else {
      const share = spendByMonth[cursor] * (covered / dim);
      total += share;
      months.push({ month: cursor, monthly_spend: spendByMonth[cursor], days_covered: covered, days_in_month: dim, attributed: round(share) });
    }

    const y = Number(cursor.slice(0, 4));
    const m = Number(cursor.slice(5, 7));
    cursor = m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
  }

  if (missing.length && reportIssues) {
    dataQuality.push({
      source: 'sales', severity: 'warning', code: 'MISSING_SPEND_MONTH', record_id: null,
      message: 'No marketing spend figure exists for ' + missing.join(', ') + '. Marketing spend and cost per lead for this period are understated.',
    });
  }

  return { total: round(total), months: months, missing_months: missing };
}

// ============================================================
// SALES
// ============================================================
function computeSales(start, end, reportIssues) {
  const excludedNoDate = sales.filter(function (r) { return !r.usable_for_period; }).length;
  const rows = sales.filter(function (r) { return r.usable_for_period && inRange(r.date, start, end); });

  const won = rows.filter(function (r) { return r.status === 'Closed Won'; });
  const lost = rows.filter(function (r) { return r.status === 'Closed Lost'; });
  const open = rows.filter(function (r) { return r.status === 'Qualified' || r.status === 'Proposal Sent'; });
  const noStatus = rows.filter(function (r) { return r.status === null; });

  const wonWithAmount = won.filter(function (r) { return r.deal_amount !== null; });
  const openWithAmount = open.filter(function (r) { return r.deal_amount !== null; });

  const revenueWon = sum(wonWithAmount.map(function (r) { return r.deal_amount; }));
  const pipelineValue = sum(openWithAmount.map(function (r) { return r.deal_amount; }));

  const decided = won.length + lost.length;
  const spend = computeMarketingSpend(start, end, reportIssues);

  // Revenue by lead source. Every source that appeared in the window is
  // listed even at zero revenue - a source that generated 12 leads and no
  // revenue is exactly the finding leadership needs, and dropping the empty
  // rows would hide it.
  //
  // Each source carries its OWN full picture - leads, both closed states,
  // open pipeline, its own win rate - not just a revenue total. The
  // dashboard's per-source panel and Claude's source-level commentary both
  // read this, and neither can be assembled from a single number per row.
  const bySource = {};
  for (const r of rows) {
    const k = r.lead_source || 'Unattributed';
    if (!bySource[k]) bySource[k] = {
      lead_source: k, leads: 0, closed_won: 0, closed_lost: 0, open_deals: 0,
      revenue_won: 0, pipeline_value: 0, deals_missing_amount: 0, no_status: 0,
    };
    const b = bySource[k];
    b.leads += 1;
    if (r.status === 'Closed Won') {
      b.closed_won += 1;
      if (r.deal_amount !== null) b.revenue_won += r.deal_amount;
      else b.deals_missing_amount += 1;
    } else if (r.status === 'Closed Lost') {
      b.closed_lost += 1;
    } else if (r.status === 'Qualified' || r.status === 'Proposal Sent') {
      b.open_deals += 1;
      if (r.deal_amount !== null) b.pipeline_value += r.deal_amount;
    } else if (r.status === null) {
      b.no_status += 1;
    }
  }
  const revenueByLeadSource = Object.keys(bySource)
    .map(function (k) {
      const b = bySource[k];
      const decidedHere = b.closed_won + b.closed_lost;
      const wonWithAmountHere = b.closed_won - b.deals_missing_amount;
      return {
        lead_source: b.lead_source,
        leads: b.leads,
        closed_won: b.closed_won,
        closed_lost: b.closed_lost,
        open_deals: b.open_deals,
        no_status: b.no_status,
        revenue_won: round(b.revenue_won),
        pipeline_value: round(b.pipeline_value),
        deals_missing_amount: b.deals_missing_amount,
        // null, never 0: a source with nothing decided has no win rate, and
        // painting it 0% would read as "we lose everything from Referral".
        win_rate: decidedHere > 0 ? round(b.closed_won / decidedHere, 4) : null,
        average_won_deal: wonWithAmountHere > 0 ? round(b.revenue_won / wonWithAmountHere) : null,
        share_of_revenue: revenueWon > 0 ? round(b.revenue_won / revenueWon, 4) : null,
      };
    })
    .sort(function (a, b) { return b.revenue_won - a.revenue_won; });

  if (reportIssues && rows.length === 0) {
    dataQuality.push({
      source: 'sales', severity: 'warning', code: 'EMPTY_PERIOD', record_id: null,
      message: 'No Sales records fall inside ' + start + ' to ' + end + '. Sales metrics for this period are unavailable, not zero.',
    });
  }

  return {
    total_leads: value(rows.length),
    closed_won_deals: value(won.length),
    closed_lost_deals: value(lost.length),
    pipeline_value: openWithAmount.length || open.length === 0
      ? value(round(pipelineValue))
      : unavailable('All ' + open.length + ' open deals in this period are missing a deal amount.'),
    revenue_won: wonWithAmount.length || won.length === 0
      ? value(round(revenueWon))
      : unavailable('All ' + won.length + ' closed-won deals in this period are missing a deal amount.'),
    win_rate: decided > 0
      ? value(round(won.length / decided, 4))
      : unavailable('No deals were closed won or closed lost in this period, so there is no win rate to compute.'),
    marketing_spend: spend.total !== null && spend.months.length
      ? value(spend.total)
      : unavailable('No marketing spend figure is available for any month in this period.'),
    cost_per_lead: (rows.length > 0 && spend.months.length)
      ? value(round(spend.total / rows.length))
      : unavailable(rows.length === 0 ? 'No leads in this period, so cost per lead has no denominator.' : 'No marketing spend figure is available for this period.'),
    revenue_by_lead_source: value(revenueByLeadSource),
    average_won_deal_value: wonWithAmount.length
      ? value(round(revenueWon / wonWithAmount.length))
      : unavailable('No closed-won deals with an amount in this period.'),
    _coverage: {
      records_in_period: rows.length,
      records_excluded_no_usable_date: excludedNoDate,
      deals_missing_status: noStatus.length,
      won_missing_amount: won.length - wonWithAmount.length,
      open_missing_amount: open.length - openWithAmount.length,
      marketing_spend_basis: spend.months.length
        ? 'One budget figure per calendar month, pro-rated by days covered: ' + spend.months.map(function (m) { return m.month + ' ' + m.days_covered + '/' + m.days_in_month + ' of ' + m.monthly_spend; }).join('; ')
        : 'No monthly spend figure available for this window.',
      marketing_spend_months: spend.months,
    },
  };
}

// ============================================================
// PROJECT DELIVERY
// ============================================================
function computeDelivery(start, end, reportIssues) {
  // "Active during the period" = the project's live span overlaps the
  // window AND it is open today. See the snapshot caveat in the normalizer.
  function overlaps(r) {
    if (!r.live_from) return false;
    if (r.live_from > end) return false;
    if (r.live_to && r.live_to < start) return false;
    return true;
  }

  const usable = delivery.filter(function (r) { return r.usable_for_period; });
  const openNow = usable.filter(function (r) { return r.status === 'In Progress' || r.status === 'Blocked'; });

  const active = openNow.filter(overlaps);
  const blocked = active.filter(function (r) { return r.status === 'Blocked'; });
  const completed = usable.filter(function (r) { return r.status === 'Completed' && inRange(r.completed_date, start, end); });

  const completedWithDue = completed.filter(function (r) { return r.due_date !== null; });
  const onTime = completedWithDue.filter(function (r) { return r.delay_days !== null && r.delay_days <= 0; });
  const late = completedWithDue.filter(function (r) { return r.delay_days !== null && r.delay_days > 0; });

  const costed = completed.filter(function (r) { return r.budget_variance !== null; });
  const variance = sum(costed.map(function (r) { return r.budget_variance; }));
  const overBudget = costed.filter(function (r) { return r.budget_variance > 0; });

  // Delivery load by team. Uses the union of teams seen across the whole
  // source, not just this window, so a team that shipped nothing appears
  // as a zero row instead of disappearing - silence is a finding.
  const allTeams = {};
  for (const r of usable) allTeams[r.team] = true;
  const byTeam = Object.keys(allTeams).sort().map(function (team) {
    const a = active.filter(function (r) { return r.team === team; });
    const c = completed.filter(function (r) { return r.team === team; });
    const blockedHere = a.filter(function (r) { return r.status === 'Blocked'; });
    const withDue = c.filter(function (r) { return r.due_date !== null; });
    const onTimeHere = withDue.filter(function (r) { return r.delay_days !== null && r.delay_days <= 0; });
    const lateHere = withDue.filter(function (r) { return r.delay_days !== null && r.delay_days > 0; });
    const costedHere = c.filter(function (r) { return r.budget_variance !== null; });
    return {
      team: team,
      active: a.length,
      blocked: blockedHere.length,
      completed: c.length,
      completed_on_time: onTimeHere.length,
      completed_late: lateHere.length,
      // Same rule as the headline metric: no completions with a due date
      // means there is no rate, not a rate of zero.
      on_time_rate: withDue.length > 0 ? round(onTimeHere.length / withDue.length, 4) : null,
      average_delay_days: lateHere.length ? round(mean(lateHere.map(function (r) { return r.delay_days; })), 1) : null,
      worst_delay_days: lateHere.length ? Math.max.apply(null, lateHere.map(function (r) { return r.delay_days; })) : null,
      budget_variance: costedHere.length ? round(sum(costedHere.map(function (r) { return r.budget_variance; }))) : null,
      // null, not 0, when nothing this team completed carries both costs -
      // "0 over budget" and "we cannot tell" are different claims, and the
      // team panel showed them as the same one.
      over_budget: costedHere.length ? costedHere.filter(function (r) { return r.budget_variance > 0; }).length : null,
      missing_due_date: c.length - withDue.length,
      missing_cost: c.length - costedHere.length,
      owners: uniq(a.concat(c).map(function (r) { return r.owner; })).sort(),
      // The named work behind the counts, so the team panel on the dashboard
      // can say WHICH project is blocked instead of only how many are.
      blocked_items: blockedHere.map(function (r) {
        return { project_id: r.project_id, project_name: r.project_name, owner: r.owner, due_date: r.due_date };
      }),
      late_items: lateHere
        .slice()
        .sort(function (x, y) { return y.delay_days - x.delay_days; })
        .slice(0, 5)
        .map(function (r) {
          return { project_id: r.project_id, project_name: r.project_name, owner: r.owner, delay_days: r.delay_days };
        }),
      total_load: a.length + c.length,
    };
  }).sort(function (x, y) { return y.total_load - x.total_load; });

  const byOwner = {};
  for (const r of active.concat(completed)) {
    if (!byOwner[r.owner]) byOwner[r.owner] = { owner: r.owner, team: r.team, active: 0, blocked: 0, completed: 0, completed_late: 0 };
  }
  for (const r of active) {
    byOwner[r.owner].active += 1;
    if (r.status === 'Blocked') byOwner[r.owner].blocked += 1;
  }
  for (const r of completed) {
    byOwner[r.owner].completed += 1;
    if (r.delay_days !== null && r.delay_days > 0) byOwner[r.owner].completed_late += 1;
  }

  if (reportIssues && active.length === 0 && completed.length === 0) {
    dataQuality.push({
      source: 'delivery', severity: 'warning', code: 'EMPTY_PERIOD', record_id: null,
      message: 'No projects were active or completed between ' + start + ' and ' + end + '. Delivery metrics for this period are unavailable, not zero.',
    });
  }

  return {
    active_projects: value(active.length),
    completed_projects: value(completed.length),
    blocked_projects: value(blocked.length),
    on_time_completion_rate: completedWithDue.length > 0
      ? value(round(onTime.length / completedWithDue.length, 4))
      : unavailable(completed.length === 0
        ? 'No projects completed in this period.'
        : 'None of the ' + completed.length + ' projects completed in this period has a due date to measure against.'),
    average_delay_days: late.length > 0
      ? value(round(mean(late.map(function (r) { return r.delay_days; })), 1))
      : unavailable(completedWithDue.length === 0
        ? 'No completed projects with a due date in this period.'
        : 'No project completed late in this period.'),
    budget_variance: costed.length > 0
      ? value(round(variance))
      : unavailable('No project completed in this period has both a budgeted and an actual cost.'),
    over_budget_projects: costed.length > 0
      ? value(overBudget.length)
      : unavailable('No project completed in this period has both a budgeted and an actual cost.'),
    delivery_load_by_team: value(byTeam),
    delivery_load_by_owner: value(Object.keys(byOwner).map(function (k) { return byOwner[k]; })
      .sort(function (a, b) { return (b.active + b.completed) - (a.active + a.completed); })),
    budgeted_cost_total: costed.length ? value(round(sum(costed.map(function (r) { return r.budgeted_cost; })))) : unavailable('No costed completions in this period.'),
    actual_cost_total: costed.length ? value(round(sum(costed.map(function (r) { return r.actual_cost; })))) : unavailable('No costed completions in this period.'),
    _coverage: {
      projects_completed_in_period: completed.length,
      completed_missing_due_date: completed.length - completedWithDue.length,
      completed_missing_cost: completed.length - costed.length,
      late_completions: late.length,
      worst_delay_days: late.length ? Math.max.apply(null, late.map(function (r) { return r.delay_days; })) : null,
      blocked_project_ids: blocked.map(function (r) { return r.project_id; }),
      status_is_point_in_time_snapshot: true,
    },
  };
}

// ============================================================
// PEOPLE OPS
// ============================================================
function computePeople(start, end, reportIssues) {
  const usable = people.filter(function (r) { return r.usable_for_period; });

  // Headcount is derived from dates, never from the status string, so a
  // record with a blank status is still counted correctly.
  function headcountAsOf(asOf) {
    return usable.filter(function (r) {
      if (!r.start_date || r.start_date > asOf) return false;
      if (r.exit_date && r.exit_date <= asOf) return false;
      return true;
    });
  }

  const applications = usable.filter(function (r) { return inRange(r.application_date, start, end); });
  const offers = usable.filter(function (r) { return inRange(r.offer_accepted_date, start, end); });
  const newHires = usable.filter(function (r) { return inRange(r.start_date, start, end); });
  const exits = usable.filter(function (r) { return inRange(r.exit_date, start, end); });

  const headcountEnd = headcountAsOf(end);
  const headcountOpen = headcountAsOf(addDays(start, -1)); // the day before the window opens

  // People marked Active whose start date is after the window closes have
  // accepted an offer but are not yet staff. Counting them as headcount
  // overstates capacity; ignoring them entirely hides a real pipeline.
  const notYetStarted = usable.filter(function (r) { return r.start_date && r.start_date > end; });
  if (reportIssues && notYetStarted.length) {
    dataQuality.push({
      source: 'people_ops', severity: 'info', code: 'FUTURE_START_DATE', record_id: null,
      message: notYetStarted.length + ' record(s) have a start date after ' + end + '. They are accepted offers, not headcount, and are excluded from active headcount for this period.',
    });
  }

  const tth = newHires.map(function (r) { return r.time_to_hire_days; }).filter(function (v) { return v !== null; });
  const oat = offers.map(function (r) { return r.offer_acceptance_days; }).filter(function (v) { return v !== null; });

  const allDepts = {};
  for (const r of usable) allDepts[r.department] = true;
  const inDept = function (list, dept) {
    return list.filter(function (r) { return r.department === dept; });
  };
  const byDept = Object.keys(allDepts).sort().map(function (dept) {
    const endHere = inDept(headcountEnd, dept);
    const openHere = inDept(headcountOpen, dept);
    const hiresHere = inDept(newHires, dept);
    const exitsHere = inDept(exits, dept);
    const offersHere = inDept(offers, dept);
    const tthHere = hiresHere.map(function (r) { return r.time_to_hire_days; }).filter(function (x) { return x !== null; });
    const oatHere = offersHere.map(function (r) { return r.offer_acceptance_days; }).filter(function (x) { return x !== null; });
    return {
      department: dept,
      active_headcount: endHere.length,
      opening_headcount: openHere.length,
      headcount_change: endHere.length - openHere.length,
      new_hires: hiresHere.length,
      exits: exitsHere.length,
      applications: inDept(applications, dept).length,
      offers_accepted: offersHere.length,
      accepted_not_started: inDept(notYetStarted, dept).length,
      // Department attrition on the same basis as the headline figure:
      // exits over the headcount this department opened the window with.
      attrition_rate: openHere.length > 0 ? round(exitsHere.length / openHere.length, 4) : null,
      time_to_hire_days: tthHere.length ? round(mean(tthHere), 1) : null,
      offer_acceptance_days: oatHere.length ? round(mean(oatHere), 1) : null,
      roles: uniq(endHere.map(function (r) { return r.role; }).filter(Boolean)).sort().slice(0, 8),
    };
  }).sort(function (a, b) { return b.active_headcount - a.active_headcount; });

  // A department with nothing at all in the window is a reportable gap -
  // it is usually a broken feed, not a quiet quarter.
  if (reportIssues) {
    const silent = byDept.filter(function (d) { return d.applications === 0 && d.new_hires === 0 && d.exits === 0; });
    if (silent.length) {
      dataQuality.push({
        source: 'people_ops', severity: 'info', code: 'DEPARTMENT_NO_ACTIVITY', record_id: null,
        message: 'No applications, hires or exits recorded between ' + start + ' and ' + end + ' for: ' + silent.map(function (d) { return d.department; }).join(', ') + '.',
      });
    }
  }

  return {
    applications: value(applications.length),
    offers_accepted: value(offers.length),
    new_hires: value(newHires.length),
    exits: value(exits.length),
    active_headcount: value(headcountEnd.length),
    opening_headcount: value(headcountOpen.length),
    time_to_hire_days: tth.length
      ? value(round(mean(tth), 1))
      : unavailable(newHires.length === 0
        ? 'Nobody started in this period, so there is no time to hire to average.'
        : 'None of the ' + newHires.length + ' new hires has both an application and a start date.'),
    offer_acceptance_days: oat.length
      ? value(round(mean(oat), 1))
      : unavailable(offers.length === 0
        ? 'No offers were accepted in this period.'
        : 'None of the offers accepted in this period has an application date to measure from.'),
    attrition_rate: headcountOpen.length > 0
      ? value(round(exits.length / headcountOpen.length, 4))
      : unavailable('Opening headcount was zero on ' + addDays(start, -1) + ', so attrition has no denominator.'),
    headcount_by_department: value(byDept),
    accepted_offers_not_yet_started: value(notYetStarted.length),
    _coverage: {
      total_records_considered: usable.length,
      records_missing_application_date: usable.filter(function (r) { return !r.application_date; }).length,
      records_missing_status: usable.filter(function (r) { return r.status === null; }).length,
      candidates_without_offer: usable.filter(function (r) { return !r.offer_accepted_date && !r.start_date; }).length,
      headcount_basis: 'Derived from start and exit dates as at ' + end + ', not from the status field.',
      exits_by_department: exits.reduce(function (acc, r) { acc[r.department] = (acc[r.department] || 0) + 1; return acc; }, {}),
    },
  };
}

// ============================================================
// TREND SERIES — the shape of the window
//
// The tiles answer "how much"; they cannot answer "is this getting worse".
// So each domain also emits a bucketed series across the SELECTED window,
// which the dashboard draws as trend charts and which Claude is given as
// measured movement rather than something it has to infer from two totals.
//
// TWO DECISIONS WORTH KNOWING ABOUT:
//
// 1. THE GRAIN FOLLOWS THE SPAN. A 7-day window bucketed monthly is one
//    bar; a year bucketed daily is 180 points of noise. Days up to three
//    weeks, weeks up to four months, calendar months beyond that.
//
// 2. BUCKETS ARE CUT BACKWARDS FROM THE PERIOD END, so the most recent
//    bucket is always whole. Cutting forwards from the start leaves the
//    LAST bucket short, and a short final bucket draws as a cliff — the
//    classic "our revenue collapsed" chart that is really "the week is
//    only half over". The short bucket ends up first, where it is
//    obviously the edge of the window, and it is flagged `partial` so the
//    chart can mark it.
// ============================================================
function buildBuckets(start, end) {
  const spanDays = daysBetween(start, end) + 1;
  const grain = spanDays <= 21 ? 'day' : (spanDays <= 120 ? 'week' : 'month');
  const buckets = [];

  if (grain === 'month') {
    let cursor = start.slice(0, 7);
    const lastMonth = end.slice(0, 7);
    while (cursor <= lastMonth) {
      const dim = daysInMonth(cursor);
      const monthStart = cursor + '-01';
      const monthEnd = cursor + '-' + pad2(dim);
      const bStart = monthStart > start ? monthStart : start;
      const bEnd = monthEnd < end ? monthEnd : end;
      buckets.push({
        bucket_start: bStart,
        bucket_end: bEnd,
        label: cursor,
        partial: bStart !== monthStart || bEnd !== monthEnd,
      });
      cursor = nextMonth(cursor);
    }
  } else {
    const size = grain === 'day' ? 1 : 7;
    let bEnd = end;
    while (bEnd >= start) {
      let bStart = addDays(bEnd, -(size - 1));
      const partial = bStart < start;
      if (partial) bStart = start;
      buckets.unshift({
        bucket_start: bStart,
        bucket_end: bEnd,
        label: size === 1 ? bStart : (bStart + ' to ' + bEnd),
        partial: partial,
      });
      bEnd = addDays(bStart, -1);
    }
  }

  return { grain: grain, buckets: buckets };
}

function buildTrendSeries(start, end) {
  const plan = buildBuckets(start, end);
  const usableSales = sales.filter(function (r) { return r.usable_for_period; });
  const usableDelivery = delivery.filter(function (r) { return r.usable_for_period; });
  const usablePeople = people.filter(function (r) { return r.usable_for_period; });

  const out = { sales: [], delivery: [], people_ops: [] };

  for (const b of plan.buckets) {
    const bs = b.bucket_start;
    const be = b.bucket_end;
    const days = daysBetween(bs, be) + 1;
    const meta = { bucket_start: bs, bucket_end: be, label: b.label, grain: plan.grain, partial: b.partial, days: days };

    // --- sales
    const leads = usableSales.filter(function (r) { return inRange(r.date, bs, be); });
    const wonHere = leads.filter(function (r) { return r.status === 'Closed Won'; });
    const lostHere = leads.filter(function (r) { return r.status === 'Closed Lost'; });
    const wonAmounts = wonHere.filter(function (r) { return r.deal_amount !== null; });
    const decidedHere = wonHere.length + lostHere.length;
    out.sales.push(Object.assign({}, meta, {
      leads: leads.length,
      closed_won: wonHere.length,
      closed_lost: lostHere.length,
      revenue_won: round(sum(wonAmounts.map(function (r) { return r.deal_amount; }))),
      win_rate: decidedHere > 0 ? round(wonHere.length / decidedHere, 4) : null,
    }));

    // --- delivery
    const completedHere = usableDelivery.filter(function (r) {
      return r.status === 'Completed' && inRange(r.completed_date, bs, be);
    });
    const lateHere = completedHere.filter(function (r) { return r.delay_days !== null && r.delay_days > 0; });
    out.delivery.push(Object.assign({}, meta, {
      kickoffs: usableDelivery.filter(function (r) { return inRange(r.kickoff_date, bs, be); }).length,
      completed: completedHere.length,
      completed_late: lateHere.length,
      completed_on_time: completedHere.filter(function (r) { return r.delay_days !== null && r.delay_days <= 0; }).length,
      average_delay_days: lateHere.length ? round(mean(lateHere.map(function (r) { return r.delay_days; })), 1) : null,
    }));

    // --- people ops
    // Headcount is a stock, not a flow: it is measured AT the bucket end
    // from start and exit dates, the same way the headline figure is.
    out.people_ops.push(Object.assign({}, meta, {
      applications: usablePeople.filter(function (r) { return inRange(r.application_date, bs, be); }).length,
      offers_accepted: usablePeople.filter(function (r) { return inRange(r.offer_accepted_date, bs, be); }).length,
      new_hires: usablePeople.filter(function (r) { return inRange(r.start_date, bs, be); }).length,
      exits: usablePeople.filter(function (r) { return inRange(r.exit_date, bs, be); }).length,
      active_headcount: usablePeople.filter(function (r) {
        if (!r.start_date || r.start_date > be) return false;
        if (r.exit_date && r.exit_date <= be) return false;
        return true;
      }).length,
    }));
  }

  return { grain: plan.grain, series: out };
}

// ---- run both windows ---------------------------------------
const current = {
  sales: computeSales(period.period_start, period.period_end, true),
  delivery: computeDelivery(period.period_start, period.period_end, true),
  people_ops: computePeople(period.period_start, period.period_end, true),
};
// The comparison window must not add data quality noise: an issue in a
// window nobody is looking at would clutter the report for the one they are.
const previous = {
  sales: computeSales(period.compare_start, period.compare_end, false),
  delivery: computeDelivery(period.compare_start, period.compare_end, false),
  people_ops: computePeople(period.compare_start, period.compare_end, false),
};

// The series is attached to the domain blocks as an array-valued metric, so
// it travels to Supabase through the same breakdown path as the other
// grouped figures - no new table, no new write node, one shape to render.
const trendSeries = buildTrendSeries(period.period_start, period.period_end);
current.sales.trend_series = value(trendSeries.series.sales);
current.delivery.trend_series = value(trendSeries.series.delivery);
current.people_ops.trend_series = value(trendSeries.series.people_ops);

// ---- a dead source is UNKNOWN, not zero ---------------------
// Every count above is a count of the rows that arrived. When a source
// arrived with nothing at all - a 401 from Airtable, a Sheets outage - that
// arithmetic is still correct and completely misleading: "0 active projects"
// is a measurement, and what actually happened is that nobody measured.
// A dashboard cannot tell the two apart from the number, and neither can a
// reader, so the figures for a source that did not answer are replaced with
// nulls that carry the reason.
//
// This is NOT the same as a source that answered and had nothing in the
// window. That is a real zero, it is reported as one, and EMPTY_PERIOD says
// so - which is why the test is on the SOURCE returning no rows at all,
// not on the window being empty.
const SOURCE_SYSTEMS = {
  sales: 'Sales (Google Sheets)',
  delivery: 'Project Delivery (Airtable)',
  people_ops: 'People Ops (API)',
};

function markSourceUnavailable(block, domainKey) {
  const reason = 'The ' + SOURCE_SYSTEMS[domainKey] + ' source returned no records for this run, ' +
    'so this figure is unknown rather than zero.';
  for (const k of Object.keys(block)) {
    if (k === '_coverage') continue;
    const node = block[k];
    if (!node || typeof node !== 'object' || !('value' in node)) continue;
    // A grouped figure becomes an empty list with the same reason attached,
    // so a breakdown chart renders "unavailable" instead of a set of zero bars.
    block[k] = Array.isArray(node.value)
      ? { value: [], unavailable_reason: reason }
      : unavailable(reason);
  }
}

const sourceRowsReceived = { sales: sales.length, delivery: delivery.length, people_ops: people.length };
for (const domainKey of ['sales', 'delivery', 'people_ops']) {
  if (sourceRowsReceived[domainKey] > 0) continue;
  markSourceUnavailable(current[domainKey], domainKey);
  markSourceUnavailable(previous[domainKey], domainKey);
}

// ---- deltas -------------------------------------------------
// Only across scalars, and only where BOTH windows produced a number.
// Comparing against a null would manufacture a trend out of missing data.
const TRENDED = {
  sales: ['total_leads', 'closed_won_deals', 'closed_lost_deals', 'pipeline_value', 'revenue_won', 'win_rate', 'marketing_spend', 'cost_per_lead', 'average_won_deal_value'],
  delivery: ['active_projects', 'completed_projects', 'blocked_projects', 'on_time_completion_rate', 'average_delay_days', 'budget_variance', 'over_budget_projects'],
  people_ops: ['applications', 'offers_accepted', 'new_hires', 'exits', 'active_headcount', 'time_to_hire_days', 'offer_acceptance_days', 'attrition_rate'],
};

const trends = {};
for (const domain of Object.keys(TRENDED)) {
  trends[domain] = {};
  for (const key of TRENDED[domain]) {
    const now = current[domain][key];
    const then = previous[domain][key];
    if (!now || !then || now.value === null || then.value === null) {
      trends[domain][key] = { current: now ? now.value : null, previous: then ? then.value : null, change: null, percent_change: null, direction: 'not_comparable' };
      continue;
    }
    const change = round(now.value - then.value, 4);

    // A percent change is only meaningful when the baseline is non-zero AND
    // the sign did not flip. Budget variance moving from -100 (under budget)
    // to +1050 (over budget) is a real and important change, but rendering
    // it as "+1150%" is noise dressed as precision. Suppress the percentage
    // and let the dashboard fall back to the absolute figures, which say the
    // useful thing: it went from 100 under to 1,050 over.
    const signFlipped = (then.value < 0) !== (now.value < 0);
    const pct = (then.value !== 0 && !signFlipped)
      ? round((now.value - then.value) / Math.abs(then.value), 4)
      : null;
    trends[domain][key] = {
      current: now.value,
      previous: then.value,
      change: change,
      percent_change: pct,
      // 2% is the noise floor. Below it, "stable" is the honest word, and
      // it stops Claude narrating a trend out of a rounding difference.
      direction: change === 0 ? 'flat' : (pct !== null && Math.abs(pct) < 0.02 ? 'stable' : (change > 0 ? 'up' : 'down')),
    };
  }
}

// ---- data quality, scoped to the window ---------------------
// The normalizers read the WHOLE source, so they see every issue in it -
// including issues in records the selected window never touches. Showing
// those under a heading that says "Last 30 days" is wrong twice over: the
// warning count contradicts the numbers above it, and a genuine in-window
// problem is buried among a hundred historical ones.
//
// So each issue is placed against the window using the record dates the
// normalizers stamped on it:
//
//   in_period       the record touches the window - shown, and counted
//   run             no record behind it (a source outage, an empty period,
//                   a missing spend month) - shown; it describes THIS run
//   undated_record  a record with no usable date at all - shown, because it
//                   is excluded from every window including this one
//   out_of_period   a dated record outside the window - NOT shown as its own
//                   row; folded into one counted line so the issue is still
//                   discoverable without drowning the panel
function scopeOf(w) {
  const dates = Array.isArray(w.record_dates) ? w.record_dates.filter(Boolean) : [];
  if (!dates.length) return w.record_id ? 'undated_record' : 'run';
  for (const d of dates) {
    if (inRange(d, period.period_start, period.period_end)) return 'in_period';
  }
  return 'out_of_period';
}

const scopedDataQuality = [];
const outOfPeriodIssues = [];

for (const w of dataQuality) {
  const dates = (Array.isArray(w.record_dates) ? w.record_dates.filter(Boolean) : []).slice().sort();
  const scope = scopeOf(w);
  const row = {
    source: w.source,
    severity: w.severity,
    code: w.code,
    record_id: w.record_id || null,
    message: w.message,
    record_date: dates.length ? dates[0] : null,
    scope: scope,
    in_period: scope !== 'out_of_period',
  };
  if (scope === 'out_of_period') outOfPeriodIssues.push(row);
  else scopedDataQuality.push(row);
}

if (outOfPeriodIssues.length) {
  const counts = {};
  for (const w of outOfPeriodIssues) counts[w.code] = (counts[w.code] || 0) + 1;
  const summary = Object.keys(counts).sort()
    .map(function (c) { return c + ' x' + counts[c]; })
    .join(', ');
  scopedDataQuality.push({
    source: 'period',
    severity: 'info',
    code: 'OUTSIDE_SELECTED_PERIOD',
    record_id: null,
    // Deliberately info, and deliberately last: it must not colour the
    // report's confidence badge, because it says nothing about the numbers
    // on screen. It exists so nobody concludes the sources are clean.
    message: outOfPeriodIssues.length + ' further source issue(s) affect records dated outside ' +
      period.period_start + ' to ' + period.period_end + ', so they are not counted against this report: ' +
      summary + '. Widen the period to see them individually.',
    record_date: null,
    scope: 'run',
    in_period: true,
  });
}

// ---- source health ------------------------------------------
const sourceHealth = {
  sales: { records_received: sourceRowsReceived.sales, healthy: sourceRowsReceived.sales > 0 },
  delivery: { records_received: sourceRowsReceived.delivery, healthy: sourceRowsReceived.delivery > 0 },
  people_ops: { records_received: sourceRowsReceived.people_ops, healthy: sourceRowsReceived.people_ops > 0 },
};
const failedSources = Object.keys(sourceHealth).filter(function (k) { return !sourceHealth[k].healthy; });

// A run missing a whole source is still published - a partial report beats
// no report - but it is labelled `partial` so nobody reads it as complete.
const runStatus = failedSources.length === 0
  ? 'succeeded'
  : (failedSources.length === 3 ? 'failed' : 'partial');

const errorCount = scopedDataQuality.filter(function (d) { return d.severity === 'error'; }).length;
const warningCount = scopedDataQuality.filter(function (d) { return d.severity === 'warning'; }).length;

// ---- content fingerprint ------------------------------------
// A cheap, stable hash of the numbers only. If nothing moved since the last
// run of this period, the Claude call is skipped and the stored insight is
// reused. Re-running the same report at 6am and 6:05am should not cost twice.
function fingerprint(obj) {
  const s = JSON.stringify(obj);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = (h1 ^ s.charCodeAt(i)) >>> 0;
    h1 = (h1 * 0x01000193) >>> 0;
    h2 = (h2 + s.charCodeAt(i) * (i + 1)) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

const metricsHash = fingerprint({ c: current, p: previous, w: period.period_start + period.period_end });

return [{
  json: {
    run_id: period.run_id,
    period: {
      key: period.period_key,
      label: period.period_label,
      start: period.period_start,
      end: period.period_end,
      days: period.period_days,
      reference_date: period.reference_date,
      compare_label: period.compare_label,
      compare_start: period.compare_start,
      compare_end: period.compare_end,
    },
    metrics: current,
    previous_period_metrics: previous,
    trends: trends,
    data_quality: scopedDataQuality,
    data_quality_summary: {
      errors: errorCount,
      warnings: warningCount,
      info: scopedDataQuality.length - errorCount - warningCount,
      total: scopedDataQuality.length,
      // Kept visible rather than dropped: "12 issues, none of them in this
      // window" is a different statement from "no issues".
      outside_period: outOfPeriodIssues.length,
      affected_sources: uniq(scopedDataQuality.map(function (d) { return d.source; })),
    },
    trend_grain: trendSeries.grain,
    source_health: sourceHealth,
    config_errors: configErrors,
    run_status: runStatus,
    failed_sources: failedSources,
    metrics_hash: metricsHash,
    force_refresh: period.force_refresh === true,
    requested_by: period.requested_by,
    computed_at: new Date().toISOString(),
  },
}];
