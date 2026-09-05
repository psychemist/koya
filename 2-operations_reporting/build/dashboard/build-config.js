#!/usr/bin/env node
/*
 * Writes dashboard/config.js — the one small file index.html reads for its
 * Supabase project URL, its publishable key, and (optionally) the n8n webhook.
 *
 * IT RUNS IN TWO PLACES, AND THAT IS THE WHOLE POINT.
 *
 *   locally   node harness/build-dashboard-config.js   (a wrapper for this)
 *             values come from the repo-root .env
 *
 *   on Vercel npm run build, from this directory
 *             values come from the project's Environment Variables, because
 *             there is no .env in a deployment — it is gitignored, correctly
 *
 * One implementation, so the key-shape guard below cannot exist in one path
 * and not the other. This file is deliberately self-contained and lives
 * inside dashboard/: a Vercel project whose Root Directory is this folder
 * does not necessarily receive files above it, so a build command reaching
 * up into ../harness is a build that works locally and fails on deploy.
 *
 * WHAT THIS DOES NOT DO: hide the key. config.js is served to the browser.
 * Anyone who opens the dashboard can read the publishable key out of
 * devtools, and that is fine — it is designed to be public. What keeps the
 * data safe is row level security in supabase/schema.sql, which grants the
 * anon role SELECT and nothing else, and grants nothing at all on
 * people_records. This script's job is to keep the key out of the repo and
 * make rotation a one-liner, not to make it a secret.
 *
 * It refuses outright to write a secret key into the page.
 *
 *   node build-config.js
 *   node build-config.js --check    # verify, write nothing
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const OUT = path.join(HERE, 'config.js');
const CHECK_ONLY = process.argv.includes('--check');

// The repo-root .env, three levels up from 2/build/dashboard. Absent on
// Vercel, which is not an error there — the environment carries the values.
const ENV_PATH = path.join(HERE, '..', '..', '..', '.env');

// ---- key shapes ---------------------------------------------
// New-style keys are opaque strings with a type prefix. Legacy keys are
// JWTs, which decode to a `role` claim — that is how a service_role key
// pasted into the wrong field is caught rather than published.
const PUBLISHABLE = /^sb_publishable_/;
const SECRET = /^sb_secret_/;
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./;

function jwtRole(key) {
  if (!JWT.test(key)) return null;
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString('utf8'));
    return typeof payload.role === 'string' ? payload.role : null;
  } catch (e) {
    return null; // not decodable; treated as unrecognised below
  }
}

// ---- .env ---------------------------------------------------
// A deliberately small parser: KEY=value, # comments, optional surrounding
// quotes. No interpolation, no multiline. Adding a dotenv dependency to a
// project that otherwise runs on a bare node install is not worth it.
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = fs.existsSync(ENV_PATH) ? parseEnv(fs.readFileSync(ENV_PATH, 'utf8')) : null;

/* Where each value comes from, in order:
 *
 *   1. the process environment, IKE_-prefixed   — Vercel, or an exported shell
 *   2. the process environment, unprefixed      — the obvious thing to type
 *                                                 into a hosting dashboard
 *   3. the repo-root .env, IKE_-prefixed        — the local default
 *   4. the repo-root .env, unprefixed           — older checkouts
 *
 * The IKE_ prefix exists because these same names live in a SHARED n8n
 * instance's environment, where SUPABASE_URL would collide with every other
 * tenant's. Nothing on Vercel collides, so both spellings are accepted there
 * and the source of each value is printed, so an unexpected one is visible
 * rather than mysterious.
 */
const SOURCES = [
  { env: process.env, prefix: 'IKE_', label: 'environment (IKE_)' },
  { env: process.env, prefix: '', label: 'environment' },
];
if (fileEnv) {
  SOURCES.push({ env: fileEnv, prefix: 'IKE_', label: '.env (IKE_)' });
  SOURCES.push({ env: fileEnv, prefix: '', label: '.env' });
}

function read(name) {
  for (const s of SOURCES) {
    const v = s.env[s.prefix + name];
    if (v !== undefined && String(v).trim() !== '') {
      return { value: String(v).trim(), from: s.label, name: s.prefix + name };
    }
  }
  return { value: '', from: null, name: name };
}

function die(message, hint) {
  console.error('\n  ✗ ' + message);
  if (hint) console.error('    ' + hint.split('\n').join('\n    '));
  console.error('');
  process.exit(1);
}

const WHERE = fileEnv
  ? 'Set it in the repo-root .env as IKE_SUPABASE_URL, or in the environment.'
  : 'No .env was found, so this is a hosted build: set it as an Environment Variable on the ' +
    'project (SUPABASE_URL or IKE_SUPABASE_URL) and redeploy.';

// ---- validate the URL ---------------------------------------
const urlRead = read('SUPABASE_URL');
const url = urlRead.value.replace(/\/+$/, '');

if (!url || url.includes('YOUR-PROJECT-REF')) {
  die('SUPABASE_URL is not set.',
      WHERE + '\nSupabase → Project Settings → Data API → Project URL.');
}
if (!/^https:\/\//.test(url)) {
  die('SUPABASE_URL must start with https:// — got "' + url + '".',
      'The dashboard sends the key on every request; over http it would go in clear text.');
}

// ---- validate the key ---------------------------------------
const keyRead = read('SUPABASE_PUBLISHABLE_KEY');
const key = keyRead.value;
const warnings = [];

if (!key || key.includes('YOUR_PUBLISHABLE_KEY')) {
  die('SUPABASE_PUBLISHABLE_KEY is not set.',
      WHERE.replace('IKE_SUPABASE_URL', 'IKE_SUPABASE_PUBLISHABLE_KEY').replace('SUPABASE_URL or', 'SUPABASE_PUBLISHABLE_KEY or') +
      '\nSupabase → Project Settings → API Keys → publishable key (sb_publishable_…).');
}

// The one failure that must never reach a deploy. A secret key in the page
// bypasses RLS for every visitor, so this is a hard stop, not a warning.
if (SECRET.test(key) || jwtRole(key) === 'service_role') {
  die('SUPABASE_PUBLISHABLE_KEY holds a SECRET key. Refusing to write it into the dashboard.',
      'Secret keys (sb_secret_… / service_role) bypass row level security entirely.\n' +
      'Publishing one gives every visitor read and write access to the whole database.\n' +
      'It belongs in n8n\'s credential store. Use the publishable key here.');
}

if (PUBLISHABLE.test(key)) {
  // The expected case.
} else if (jwtRole(key) === 'anon') {
  warnings.push(
    'The publishable key is a legacy `anon` JWT. It still works, but it is deprecated —\n' +
    'replace it with the sb_publishable_… key from Project Settings → API Keys. No schema\n' +
    'change is needed: the publishable key resolves to the same `anon` Postgres role your\n' +
    'RLS policies already target.');
} else {
  die('SUPABASE_PUBLISHABLE_KEY is not a recognised Supabase key.',
      'Expected sb_publishable_… (or a legacy anon JWT beginning eyJ…).\n' +
      'Got: ' + key.slice(0, 12) + '…');
}

const webhookRead = read('N8N_WEBHOOK_URL');
const webhook = webhookRead.value;
if (webhook) {
  warnings.push(
    'N8N_WEBHOOK_URL is set, so the dashboard\'s Run now button can start a workflow run.\n' +
    'That publishes the webhook URL to everyone who opens the page. Only do this behind an\n' +
    'authenticated host, or with Header Auth on the webhook node.');
}

// ---- write --------------------------------------------------
const banner = [
  '/* GENERATED FILE — do not edit, and do not commit.',
  ' *',
  ' * Written by dashboard/build-config.js:',
  ' *   locally   node harness/build-dashboard-config.js   (reads the repo-root .env)',
  ' *   on Vercel npm run build                            (reads the project environment)',
  ' *',
  ' * The key below is the PUBLISHABLE key and is served to the browser by',
  ' * design. Row level security is what protects the data — see',
  ' * supabase/schema.sql. Never put a secret key here.',
  ' */',
].join('\n');

// The inputs are IKE_-prefixed so they cannot collide with anything else in a
// shared n8n instance's environment. The KOYA_CONFIG keys the BROWSER reads
// are deliberately not renamed: nothing about a window global on a single
// static page can collide, and index.html has one stable contract to honour.
// This mapping is the only place the two naming schemes meet.
const body = 'window.KOYA_CONFIG = ' + JSON.stringify({
  SUPABASE_URL: url,
  SUPABASE_PUBLISHABLE_KEY: key,
  N8N_WEBHOOK_URL: webhook,
}, null, 2) + ';\n';

const contents = banner + '\n\n' + body;

for (const w of warnings) console.warn('\n  ! ' + w.split('\n').join('\n    '));

if (CHECK_ONLY) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (current !== contents) {
    console.error('\n  ✗ dashboard/config.js is missing or stale. Run:' +
                  '\n    node harness/build-dashboard-config.js\n');
    process.exit(1);
  }
  console.log('\n  ✓ dashboard/config.js is up to date\n');
  process.exit(0);
}

fs.writeFileSync(OUT, contents);

const keyKind = PUBLISHABLE.test(key) ? 'publishable' : 'legacy anon (deprecated)';
console.log('\n  ✓ wrote ' + path.relative(process.cwd(), OUT));
console.log('    project : ' + url + '   (from ' + urlRead.from + ' as ' + urlRead.name + ')');
console.log('    key     : ' + key.slice(0, 18) + '… (' + keyKind + ', from ' + keyRead.from + ')');
console.log('    trigger : ' + (webhook ? 'enabled — Run now can start a workflow run' : 'disabled — read-only dashboard'));
console.log('');
