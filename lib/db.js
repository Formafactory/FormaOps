'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

function resolveDataDir(value) {
  if (!value) return path.join(os.homedir(), 'formaops-data');
  if (value.startsWith('~')) return path.join(os.homedir(), value.slice(1));
  return path.resolve(value);
}

function migrate(db, migrationsDir, log = console.log) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').pluck().all());
  const files = fs.readdirSync(migrationsDir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    if (applied.has(id)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(id);
    })();
    log(`[db] migrazione applicata: ${id}`);
  }
}

function openDatabase(dataDir, { log = console.log } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'formaops.sqlite');
  const isNew = !fs.existsSync(file);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  log(`[db] ${isNew ? 'creato' : 'aperto'}: ${file}`);
  migrate(db, path.join(__dirname, '..', 'migrations'), log);
  return db;
}

module.exports = { openDatabase, resolveDataDir, migrate };
