/* Committed example of the file harness/build-dashboard-config.js generates.
 *
 * Do not fill this in and rename it — put the real values in the repo-root
 * .env and run the generator, so there is one place to rotate a key:
 *
 *   cp .env.example .env          # then edit .env
 *   node harness/build-dashboard-config.js
 *
 * config.js is gitignored. This file is not, and must never hold a real key.
 */

window.KOYA_CONFIG = {
  // Supabase → Project Settings → Data API
  "SUPABASE_URL": "https://YOUR-PROJECT-REF.supabase.co",

  // Supabase → Project Settings → API Keys → publishable key.
  // Public by design; RLS is what protects the data. Never a secret key.
  "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_YOUR_PUBLISHABLE_KEY",

  // Empty keeps the dashboard strictly read-only.
  "N8N_WEBHOOK_URL": ""
};
