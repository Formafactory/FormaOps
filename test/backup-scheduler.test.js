'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrate } = require('../lib/db');
const C = require('../lib/customers');
const { runBackup, listBackups } = require('../lib/backup');
const { createScheduler } = require('../lib/scheduler');

test('backup: copia leggibile del database, tiene solo gli ultimi N', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const db = new Database(path.join(tmp, 'live.sqlite'));
  migrate(db, path.join(__dirname, '..', 'migrations'), () => {});
  C.createCustomer(db, { name: 'Anna Verdi', brand: 'vir3d', email: 'anna@example.it' });
  const dir = path.join(tmp, 'backup');
  for (let i = 0; i < 4; i++) {
    await runBackup(db, dir, { keep: 3, now: new Date(2026, 9, 1 + i, 3, 0) });
    fs.utimesSync(listBackups(dir)[0].full, new Date(), new Date(Date.now() + i * 1000));
  }
  const files = listBackups(dir);
  assert.equal(files.length, 3);
  const copy = new Database(files[0].full, { readonly: true });
  assert.equal(copy.prepare('SELECT name FROM customers').pluck().get(), 'Anna Verdi');
  copy.close();
  db.close();
});

test('aggiornamento automatico: mai due giri insieme, si ferma a 0 minuti', async () => {
  let calls = 0;
  let release;
  const s = createScheduler({ minutes: 5, run: () => { calls++; return new Promise((r) => { release = r; }); } });
  const first = s.runNow();
  assert.equal(s.isRunning(), true);
  assert.equal(await s.runNow(), null, 'il secondo giro non parte');
  release('fatto');
  assert.equal(await first, 'fatto');
  assert.equal(calls, 1);
  s.start();
  assert.ok(s.state.nextRunAt);
  s.setMinutes(0);
  assert.equal(s.state.nextRunAt, null);
  s.stop();
});
