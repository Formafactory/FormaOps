'use strict';
// Aggiornamento ADV a mano, dal terminale (come il pulsante "Aggiorna ora"):
//   npm run adv:sync
const path = require('node:path');
const fs = require('node:fs');
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const { openDatabase, resolveDataDir } = require('../lib/db');
const { syncAdv } = require('../lib/adv');

(async () => {
  const db = openDatabase(resolveDataDir(process.env.DATA_DIR), { log: () => {} });
  const count = () => db.prepare('SELECT COUNT(*) FROM adv_insights_daily').pluck().get();
  console.log(`[adv] righe in adv_insights_daily prima: ${count()}`);
  const r = await syncAdv(db, { trigger: 'manuale', log: console.log });
  console.log(`[adv] righe in adv_insights_daily dopo: ${count()}`);
  if (!r.ok) process.exitCode = 1;
  db.close();
})();
