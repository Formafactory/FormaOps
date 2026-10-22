'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrate } = require('../lib/db');
const C = require('../lib/customers');
const M = require('../lib/messages');
const { syncMeta, testConnection } = require('../lib/sync-meta');
const { startFakeMeta } = require('../test-support/fake-meta');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, path.join(__dirname, '..', 'migrations'), () => {});
  return db;
}
const one = (db, sql, ...a) => db.prepare(sql).pluck().get(...a);

async function setup(t) {
  const fake = await startFakeMeta();
  t.after(() => fake.close());
  const db = freshDb();
  C.createCustomer(db, { name: 'Anna Verdi', brand: 'vir3d', email: 'anna@example.it' });
  C.addContact(db, 1, 'instagram', '@anna.verdi');
  return { fake, db };
}

test('chiave: elenca Pagine e Instagram collegati; chiave sbagliata con messaggio chiaro', async (t) => {
  const { fake } = await setup(t);
  const pages = await testConnection(fake.cfg);
  assert.deepEqual(pages.map((p) => [p.name, p.instagram]), [['Vir3D', 'vir3d.it'], ['De Artis Digitale', null]]);
  await assert.rejects(testConnection({ ...fake.cfg, token: 'sbagliata' }), /scaduta o non valida/);
});

test('prima sync: DM Messenger e Instagram, commenti a post e inserzioni, risposte riconosciute', async (t) => {
  const { fake, db } = await setup(t);
  const r = await syncMeta(db, { cfg: fake.cfg });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.bySource, { messenger: 4, instagram: 1, facebook_comment: 3, instagram_comment: 3 });
  assert.equal(r.nuovi, 11);
  assert.equal(r.warnings.length, 1, 'De Artis senza permesso sulle inserzioni: avviso, non errore');
  assert.match(r.warnings[0], /De Artis Digitale: commenti alle inserzioni/);

  // conversazione vecchia (60 giorni) esclusa, paginazione seguita (3 conversazioni, pagine da 2)
  assert.equal(one(db, `SELECT COUNT(*) FROM messages WHERE id = 'messenger:m5'`), 0);
  assert.equal(one(db, `SELECT COUNT(*) FROM messages WHERE source = 'messenger'`), 4);

  // DM Instagram collegato al cliente esistente per username
  assert.equal(one(db, `SELECT customer_id FROM messages WHERE id = 'instagram:im1'`), 1);

  // commenti della Pagina stessa e con autore nascosto saltati; risposta della Pagina = "out"
  assert.equal(one(db, `SELECT COUNT(*) FROM messages WHERE id IN ('fbcomment:fc3','fbcomment:fc4')`), 0);
  assert.equal(one(db, `SELECT direction FROM messages WHERE id = 'fbcomment:fc2'`), 'out');
  assert.equal(one(db, `SELECT direction FROM messages WHERE id = 'igcomment:ig2'`), 'out');
  assert.match(one(db, `SELECT subject FROM messages WHERE id = 'fbcomment:fc5'`), /^Commento all'inserzione: Il regalo perfetto/);
  assert.match(one(db, `SELECT subject FROM messages WHERE id = 'igcomment:ig3'`), /^Commento all'inserzione: Inserzione: ambigramma/);

  const toAnswer = M.conversations(db, { onlyToAnswer: true }).map((c) => c.counterpart_name || c.counterpart_address).sort();
  assert.deepEqual(toAnswer, ['Mario Rossi', 'Paolo Verde', 'anna.verdi', 'sara.m'],
    'Lucia (risposta della Pagina), Giulia e marco_b (risposti nei commenti) non sono da rispondere');
});

test('solo richieste GET, mai scritture verso Meta', async (t) => {
  const { fake, db } = await setup(t);
  await syncMeta(db, { cfg: fake.cfg });
  assert.ok(fake.state.requests.length > 5);
  assert.ok(fake.state.requests.every((r) => r.method === 'GET'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'meta.js'), 'utf8');
  assert.equal((src.match(/method: '(\w+)'/g) || []).join(), "method: 'GET'");
});

test('rieseguire non duplica; un nuovo messaggio arriva da solo', async (t) => {
  const { fake, db } = await setup(t);
  await syncMeta(db, { cfg: fake.cfg });
  const again = await syncMeta(db, { cfg: fake.cfg });
  assert.equal(again.ok, true);
  assert.equal(again.nuovi, 0);
  fake.state.data.conversations['P1:messenger'][1].updated_time = new Date().toISOString();
  fake.state.data.conversations['P1:messenger'][1].messages.data.unshift(
    { id: 'm9', created_time: new Date().toISOString(), from: { id: 'U2', name: 'Lucia Bianchi' }, message: 'Ricevuto, grazie!' });
  const inc = await syncMeta(db, { cfg: fake.cfg });
  assert.equal(inc.nuovi, 1);
  assert.ok(M.conversations(db, { onlyToAnswer: true }).some((c) => c.counterpart_name === 'Lucia Bianchi'));
});

test('collegare un profilo Facebook a un cliente; ignorare un profilo Instagram', async (t) => {
  const { fake, db } = await setup(t);
  await syncMeta(db, { cfg: fake.cfg });
  const before = M.unlinkedSenders(db).map((s) => `${s.type}:${s.name || s.address}`).sort();
  assert.deepEqual(before, ['facebook:Giulia Neri', 'facebook:Lucia Bianchi', 'facebook:Mario Rossi', 'facebook:Paolo Verde',
    'instagram:marco_b', 'instagram:sara.m']);

  const mario = C.createCustomer(db, { name: 'Mario Rossi', brand: 'vir3d', email: 'mario@example.it' });
  C.addContact(db, mario, 'facebook', 'fb:U1');
  M.linkUnmatched(db);
  assert.equal(one(db, `SELECT COUNT(*) FROM messages WHERE customer_id = ? AND source = 'messenger'`, mario), 2);

  M.ignoreSender(db, { type: 'instagram', value: 'sara.m' });
  assert.equal(one(db, `SELECT COUNT(*) FROM messages WHERE counterpart_address = 'sara.m'`), 0);
  assert.equal(M.isIgnored(db, 'sara.m', 'instagram'), true);
  await syncMeta(db, { cfg: fake.cfg });
  assert.equal(one(db, `SELECT COUNT(*) FROM messages WHERE counterpart_address = 'sara.m'`), 0, 'resta ignorata');
});
