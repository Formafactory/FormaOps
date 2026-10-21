'use strict';
// Impostazioni locali: prima quelle salvate dall'app, poi il file .env.
function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) ?? null;
}
function setSetting(db, key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(key, value);
}
function vir3dConfig(db, env = process.env) {
  const base = String(getSetting(db, 'vir3d_api_base') || env.VIR3D_API_BASE || 'https://vir3d.it').replace(/\/+$/, '');
  const key = getSetting(db, 'vir3d_api_key') || env.VIR3D_API_KEY || '';
  return { base, key };
}
module.exports = { getSetting, setSetting, vir3dConfig };
