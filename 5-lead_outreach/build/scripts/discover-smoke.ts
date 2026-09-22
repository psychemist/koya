import { ApifyClient } from 'apify-client';
import { config } from '../lib/config.ts';
import { buildActorCall, toCandidate, assertApifyAccount } from '../lib/providers/apify.ts';

/**
 * The required first step before any 10-lead run.
 *
 * Runs the pinned actor ONCE with maxItems: 2 and prints what it actually
 * cost, so the actor choice is made from the Console's reported usage rather
 * than from its pricing page.
 */
const queryText = process.argv.slice(2).join(' ').trim();
if (!queryText) {
  console.error('Usage: npm run discover:smoke -- "US B2B SaaS companies 10-100 employees"');
  process.exit(1);
}

const account = await assertApifyAccount();
const actorId = config.pinnedActorId();
const call = buildActorCall(queryText, 2);

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
console.log(`usage:    $${(run as any).usageTotalUsd ?? 'not reported'}`);
console.log('\ncandidates parsed:');
for (const item of items as Record<string, unknown>[]) {
  const c = toCandidate(item);
  console.log(c ? `  ${c.companyDomain}  ${c.companyName}` : '  (dropped: no usable domain)');
}
console.log('\nOpen the run in the Apify Console and read the reported charge before pinning.');
