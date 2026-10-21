'use strict';
// Uso: npm run sync:vir3d            (sincronizza)
//      npm run sync:vir3d -- --check (verifica solo collegamento e chiave)
const path = require('node:path');
const fs = require('node:fs');
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const { openDatabase, resolveDataDir } = require('../lib/db');
const vir3d = require('../lib/vir3d');
const { syncVir3d } = require('../lib/sync-vir3d');

(async () => {
  const cfg = vir3d.config();
  console.log(`[vir3d] collegamento a ${cfg.base}`);
  try {
    const h = await vir3d.health(cfg);
    console.log(`[vir3d] collegamento OK (integrazione ${h.integration}, schema ${h.schemaVersion})`);
  } catch (err) {
    console.error(`[vir3d] ERRORE: ${err.message}`);
    process.exit(1);
  }
  if (process.argv.includes('--check')) return;

  const db = openDatabase(resolveDataDir(process.env.DATA_DIR));
  const r = await syncVir3d(db, { cfg, log: console.log });
  if (!r.ok) {
    console.error(`[vir3d] ERRORE: ${r.error}`);
    process.exitCode = 1;
  }
  const n = db.prepare('SELECT COUNT(*) FROM orders').pluck().get();
  const c = db.prepare('SELECT COUNT(*) FROM customers').pluck().get();
  const rv = db.prepare('SELECT COUNT(*) FROM review_items WHERE resolved_at IS NULL').pluck().get();
  console.log(`[vir3d] fatto: ${r.nuovi} ordini nuovi, ${r.aggiornati} aggiornati, ${r.clientiNuovi} clienti creati`);
  console.log(`[vir3d] totale in FormaOps: ${n} ordini, ${c} clienti, ${rv} casi da verificare`);
  db.close();
})();
