import { Pool } from 'pg';
import { hashPassword } from '../lib/auth.js';
import { assertPostgresUrl } from '../lib/config.js';

/**
 * Demo accounts and a small published-content index.
 *
 * All data here is SYNTHETIC. No real client data anywhere — not in seeds,
 * not in screenshots, not in the video.
 *
 * Three accounts. Two of them exist because separation of duties is on by
 * default: the requester cannot approve their own work, so demonstrating the
 * gate needs two people, not two roles on one person.
 *
 * The third is the demo admin. It raises nothing and approves nothing itself;
 * it can move its session into either of the other two and back, so one person
 * can walk through both sides of the gate without signing out. See
 * app/api/demo/switch/route.ts for why that is a switch of IDENTITY rather
 * than a switch of role.
 */
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }
try { assertPostgresUrl(url); } catch (e) { console.error((e as Error).message); process.exit(1); }
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

const PASSWORD = process.env.SEED_PASSWORD || 'desk-demo-2026';

const users = [
  { email: 'manager@koya.test', name: 'Ada Okafor', role: 'manager' },
  { email: 'editor@koya.test', name: 'Tomi Balogun', role: 'editor' },
  { email: 'admin@koya.test', name: 'Demo Admin', role: 'admin' },
];

for (const u of users) {
  await pool.query(
    `insert into public.users (email, name, role, password_hash)
     values ($1,$2,$3,$4)
     on conflict (email) do update set name=excluded.name, role=excluded.role,
                                        password_hash=excluded.password_hash`,
    [u.email, u.name, u.role, hashPassword(PASSWORD)]);
  console.log(`✓ ${u.role.padEnd(8)} ${u.email}`);
}

// A published-content index, so the cannibalisation check and internal-link
// suggestions have something to work against on a fresh install.
const published = [
  { url: 'https://koya.example/blog/hiring-signals-that-matter',
    title: 'The four hiring signals that actually predict performance',
    summary: 'Structured interviews, work samples, reference depth and time-to-decision.',
    keyword: 'hiring signals', cornerstone: true },
  { url: 'https://koya.example/blog/remote-onboarding-30-days',
    title: 'A 30-day remote onboarding plan that reduces early attrition',
    summary: 'What to do in week one, week two and the first month for distributed hires.',
    keyword: 'remote onboarding', cornerstone: false },
  { url: 'https://koya.example/blog/talent-pipeline-metrics',
    title: 'Talent pipeline metrics worth reporting to your board',
    summary: 'Pipeline conversion, source quality, offer acceptance and cost per hire.',
    keyword: 'talent pipeline metrics', cornerstone: true },
];

for (const p of published) {
  await pool.query(
    `insert into public.published_index (url, title, summary, primary_keyword, is_cornerstone, published_at)
     values ($1,$2,$3,$4,$5, now() - interval '45 days')
     on conflict (url) do update set title=excluded.title, summary=excluded.summary`,
    [p.url, p.title, p.summary, p.keyword, p.cornerstone]);
}
console.log(`✓ ${published.length} published articles indexed`);

console.log(`\nSign in with any of the three. Password: ${PASSWORD}`);
console.log('The manager raises requests; the editor approves them. That split is the point.');
console.log('admin@koya.test can switch into either of them from the masthead, and back.');
await pool.end();
