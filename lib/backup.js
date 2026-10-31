'use strict';

// Backup del database: copia coerente (API di backup di SQLite) in una cartella a scelta,
// per esempio una cartella di Google Drive sul PC. Tiene gli ultimi N file.
const fs = require('node:fs');
const path = require('node:path');

const PREFIX = 'formaops-';

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function listBackups(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith('.sqlite'))
    .map((f) => ({ file: f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

async function runBackup(db, dir, { keep = 30, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${PREFIX}${stamp(now)}.sqlite`);
  await db.backup(target);
  const size = fs.statSync(target).size;
  const old = listBackups(dir).slice(keep);
  for (const b of old) fs.unlinkSync(b.full);
  return { file: target, size, removed: old.length };
}

module.exports = { runBackup, listBackups, stamp };
