'use strict';
// Primo controllo del modulo ADV (sola lettura, non scrive nel database):
//   npm run adv:check
// Il token non viene mai stampato, nemmeno in parte.
// Vincoli: 1) ads_read tra i permessi della chiave (debug_token)
//          2) GET /me/adaccounts restituisce l'account con user_tasks esattamente ["ANALYZE"] (solo analisi)
const path = require('node:path');
const fs = require('node:fs');
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const meta = require('../lib/meta');
const { advConfig, configError, redact } = require('../lib/adv');

(async () => {
  const cfg = advConfig();
  const bad = configError(cfg);
  if (bad) { console.error(`[adv] ${bad}`); process.exit(1); }
  console.log(`[adv] chiave: [oscurata] · account atteso: ${cfg.accountId} · Graph API ${cfg.version}`);
  let failed = false;
  try {
    console.log('\nGET /debug_token?input_token=[oscurato]');
    const dbg = await meta.get(cfg, 'debug_token', { input_token: cfg.token }, cfg.token);
    const d = dbg.data || {};
    const scopes = d.scopes || [];
    console.log(redact(JSON.stringify({
      app_id: d.app_id, application: d.application, type: d.type, is_valid: d.is_valid,
      expires_at: d.expires_at, data_access_expires_at: d.data_access_expires_at, scopes,
    }, null, 2), cfg.token));
    if (!scopes.includes('ads_read')) { console.error('[adv] STOP: ads_read NON è tra i permessi della chiave.'); failed = true; }
    else console.log('[adv] OK: ads_read presente.');

    console.log('\nGET /me/adaccounts?fields=id,name,user_tasks');
    const me = await meta.get(cfg, 'me/adaccounts', { fields: 'id,name,user_tasks', limit: 100 }, cfg.token);
    console.log(redact(JSON.stringify(me, null, 2), cfg.token));
    const acc = (me.data || []).find((a) => a.id === cfg.accountId);
    if (!acc) {
      console.error(`[adv] STOP: ${cfg.accountId} NON compare tra gli account visibili alla chiave.`);
      failed = true;
    } else if (JSON.stringify(acc.user_tasks) !== JSON.stringify(['ANALYZE'])) {
      console.error(`[adv] STOP: user_tasks di ${cfg.accountId} = ${JSON.stringify(acc.user_tasks)}, atteso ["ANALYZE"].`);
      failed = true;
    } else {
      console.log(`[adv] OK: ${cfg.accountId} visibile con user_tasks ["ANALYZE"] (solo analisi).`);
    }
  } catch (err) {
    console.error(`[adv] ERRORE: ${redact(err.message, cfg.token)}`);
    failed = true;
  }
  process.exitCode = failed ? 1 : 0;
})();
