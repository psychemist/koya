import { ApifyClient } from 'apify-client';
import { config } from '../lib/config.ts';
import {
  buildActorCall, toCandidate, assertApifyAccount, headcountBuckets, settlementUsd,
  isShowcase, parseHeadcount, withinHeadcount, withinGeography,
} from '../lib/providers/apify.ts';
import { industryIds } from '../lib/industries.ts';

/**
 * The required first step before any 10-lead run.
 *
 * Runs the pinned actor ONCE with maxItems: 2 and prints what it actually
 * cost, so the actor choice is made from the Console's reported usage rather
 * than from its pricing page.
 */
/**
 * Usage:
 *   npm run discover:smoke -- "B2B SaaS" \
 *     --location "United States" --headcount "10 to 100" --industry "B2B SaaS"
 *
 * The query is KEYWORDS ONLY. Geography, headcount and industry are filters,
 * and writing them into the query instead returns companies matching none of
 * them: without --industry, "B2B SaaS" matches the consultancies that sell to
 * B2B SaaS just as well as it matches a B2B SaaS company.
 */
const USAGE = 'Usage: npm run discover:smoke -- "B2B SaaS" --location "United States" ' +
  '--headcount "10 to 100" --industry "B2B SaaS"';

const FLAGS = ['location', 'headcount', 'industry', 'limit'] as const;
const argv = process.argv.slice(2);

const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

// A flag and the value after it are both removed, so adding a flag above
// cannot leak its value into the query.
const consumed = new Set<number>();
for (const name of FLAGS) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) { consumed.add(i); consumed.add(i + 1); }
}

const location = flag('location');
const headcount = flag('headcount');
const industries = (flag('industry') ?? '').split(',').map((v) => v.trim()).filter(Boolean);

const queryText = argv.filter((_, i) => !consumed.has(i)).join(' ').trim();

if (!queryText) {
  console.error(USAGE);
  process.exit(1);
}

const industry = industryIds(industries);
const bounds = parseHeadcount(headcount);

const account = await assertApifyAccount();
const actorId = config.pinnedActorId();
// Two is enough to prove the wiring; a query EXPERIMENT needs a sample.
const limit = Math.max(1, Math.min(25, Number(flag('limit') ?? 2) || 2));
const call = buildActorCall(queryText, limit, {
  locations: location ? [location] : [],
  companySize: headcountBuckets(headcount),
  industryIds: industry.ids,
});

if (industry.unmatched.length) {
  console.log(`WARNING:  no LinkedIn industry matches ${industry.unmatched.join(', ')}. ` +
    'That part of the ICP is not being filtered on. Add an alias in lib/industries.ts.');
}

console.log(`account:  ${account}`);
console.log(`actor:    ${actorId}`);
console.log(`input:    ${JSON.stringify(call.input)}`);
console.log(`options:  ${JSON.stringify(call.options)}`);

const client = new ApifyClient({ token: config.apifyToken() });
const run = await client.actor(actorId).call(call.input, call.options);
const { items } = await client.dataset(run.defaultDatasetId).listItems();

console.log(`run id:   ${run.id}`);
console.log(`status:   ${run.status}`);
console.log(`items:    ${items.length} returned for maxItems ${call.options.maxItems}`);
/**
 * Reported and settled, side by side.
 *
 * `usageTotalUsd` reads low at the moment a run finishes because a
 * pay-per-event actor's charges are aggregated afterwards, so printing it
 * alone is how a run looks free. The settled figure is what the ledger holds,
 * and it is what the run and daily caps are measured against.
 */
const reported = (run as any).usageTotalUsd;
const settled = settlementUsd(reported, items.length);
console.log(`usage:    reported $${reported ?? 'none'}, settled $${settled.toFixed(4)}`);
if (typeof reported !== 'number' || reported < settled) {
  console.log(`          reported is below the priced cost of ${items.length} result(s) at ` +
    `$${config.limits.apifyPricePerResultUsd} plus $${config.limits.apifyActorStartUsd} to ` +
    'start. The ledger takes the higher of the two.');
}

/**
 * The worst case, not the best one.
 *
 * This previously priced a full run as `settlementUsd(candidateBudget)`, which
 * bakes in exactly ONE actor start. The run of 2026-09-25 made twenty-one
 * searches and cost $0.181 against a projection of $0.1610, so the number was
 * a floor wearing an estimate's label. A run may now start as many searches as
 * `RUN_DISCOVERY_CALLS` allows, and every one pays the start fee.
 */
const searches = config.limits.discoveryCalls;
const fullRun = settlementUsd(undefined, config.limits.candidateBudget)
  + (searches - 1) * config.limits.apifyActorStartUsd;
console.log(`projection: ${config.limits.candidateBudget} candidates over as many as ` +
  `${searches} searches prices at $${fullRun.toFixed(4)}, against a ` +
  `$${config.limits.runApifyCapUsd} run cap and a $${config.limits.dailyApifyCapUsd} ` +
  'daily cap' +
  (fullRun > config.limits.runApifyCapUsd ? '  <-- OVER THE RUN CAP' : ''));
/**
 * The raw shape, printed before anything tries to interpret it.
 *
 * A field name we guessed wrong does not raise an error, it silently drops
 * every row, so the only reliable way to write the parser is to look at what
 * the actor actually returned.
 */
const first = items[0] as Record<string, unknown> | undefined;
if (first) {
  console.log('\nfields on the first item:');
  console.log(`  ${Object.keys(first).join(', ')}`);

  const urlish = Object.entries(first).filter(([k, v]) =>
    typeof v === 'string' && (/url|site|domain|link/i.test(k) || /^https?:\/\//.test(v)));
  console.log('\nanything that looks like a URL:');
  for (const [k, v] of urlish) console.log(`  ${k}: ${v}`);

  console.log('\nfirst item in full:');
  console.log(JSON.stringify(first, null, 2).slice(0, 2000));
}

/**
 * The same drop rules `discover()` applies, so the smoke run shows what a real
 * run would actually keep rather than what the actor returned.
 */
console.log('\ncandidates parsed:');
for (const item of items as Record<string, unknown>[]) {
  const name = (item.name as string) ?? '(unnamed)';
  if (isShowcase(item)) {
    console.log(`  (dropped: showcase page, not a company)  ${name}`);
    continue;
  }
  const c = toCandidate(item);
  if (!c) {
    console.log(`  (dropped: no usable company domain)  ${name}`);
    continue;
  }
  if (!withinGeography(c.meta, location ? [location] : [])) {
    const hq = (c.meta.locations as any[])?.find((l) => l?.headquarter)
      ?? (c.meta.locations as any[])?.[0];
    console.log(`  (dropped: headquarters in ${hq?.parsed?.country ?? hq?.country ?? '?'})  ${name}`);
    continue;
  }
  if (!withinHeadcount(c.meta, bounds)) {
    const r = c.meta.employeeCountRange as { start?: number; end?: number } | undefined;
    console.log(`  (dropped: size ${r?.start ?? '?'}-${r?.end ?? '?'} is outside the ICP)  ${name}`);
    continue;
  }
  // Kept rows print what they were kept ON, so a leak in a filter is visible
  // here rather than only in a run that has already paid to judge them.
  const r = c.meta.employeeCountRange as { start?: number; end?: number } | undefined;
  const loc = (c.meta.locations as any[])?.find((l) => l?.headquarter)
    ?? (c.meta.locations as any[])?.[0];
  const size = r ? `${r.start ?? '?'}-${r.end ?? '?'}` : `count=${c.meta.employeeCount ?? 'none'}`;
  console.log(`  ${c.companyDomain.padEnd(24)} size=${String(size).padEnd(10)} ` +
    `hq=${loc?.parsed?.country ?? loc?.country ?? 'none'}  ${c.companyName}`);
}
console.log('\nOpen the run in the Apify Console and read the reported charge before pinning.');
