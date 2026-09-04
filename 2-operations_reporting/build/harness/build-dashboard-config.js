#!/usr/bin/env node
/*
 * Generates dashboard/config.js from the repo-root .env.
 *
 *   node harness/build-dashboard-config.js
 *   node harness/build-dashboard-config.js --check   # verify, write nothing
 *
 * THIS IS A WRAPPER, ON PURPOSE. The generator itself lives in
 * dashboard/build-config.js, because the same file has to run in two places:
 * here, against the repo-root .env, and on Vercel, against the project's
 * Environment Variables — where there is no .env, because .env is gitignored.
 *
 * Two copies of that logic would mean two copies of the guard that refuses to
 * write a Supabase SECRET key into a page every visitor can read, and the
 * copy that eventually drifts is the one that ships. So there is one file,
 * it sits inside dashboard/ where a Vercel build whose Root Directory is that
 * folder can definitely reach it, and this keeps the documented command
 * working from the build root.
 */
const path = require('path');
require(path.join(__dirname, '..', 'dashboard', 'build-config.js'));
