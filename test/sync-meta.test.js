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
  assert.deepEqual(r.bySource, { messenger: 4, instagram: 1, facebook_comment: 4, instagram_comment: 3 });
  assert.equal(r.nuovi, 12);

  // conversazione vecchia (60 giorni) esclusa, paginazione seguita (3 conversazioni, pagine da 2)
  assert.equal(one(db, `SELECT COUNT(*) FROM messages WHERE id = 'messenger:m5'`), 0);
  assert.equal(one(db, `SELECT COUNT(*) FROM messages WHERE source = 'messenger'`), 4);

  // DM Instagram collegato al cliente esistente per username
  assert.equal(one(db, `SELECT customer_id FROM messages WHERE id = 'instagram:im1'`), 1);

  // commento della Pagina stessa saltato; autore nascosto da Meta: mostrato come "Utente Facebook"; risposta della Pagina = "out"
  assert.equal(one(db, `SELECT COUNT(*) FROM messages WHERE id = 'fbcomment:fc3'`), 0);
  assert.equal(one(db, `SELECT counterpart_name FROM messages WHERE id = 'fbcomment:fc4'`), 'Utente Facebook (nome nascosto da Meta)');
  assert.ok(r.warnings.some((w) => /pages_read_user_content/.test(w)), 'avviso sul permesso mancante');
  assert.equal(one(db, `SELECT direction FROM messages WHERE id = 'fbcomment:fc2'`), 'out');
  assert.equal(one(db, `SELECT direction FROM messages WHERE id = 'igcomment:ig2'`), 'out');
  assert.match(one(db, `SELECT subject FROM messages WHERE id = 'fbcomment:fc5'`), /^Commento all'inserzione: Il regalo perfetto/);
  assert.match(one(db, `SELECT subject FROM messages WHERE id = 'igcomment:ig3'`), /^Commento all'inserzione: Inserzione: ambigramma/);

  const toAnswer = M.conversations(db, { onlyToAnswer: true }).map((c) => c.counterpart_name || c.counterpart_address).sort();
  assert.deepEqual(toAnswer, ['Mario Rossi', 'Paolo Verde', 'Utente Facebook (nome nascosto da Meta)', 'anna.verdi', 'sara.m'],
    'Lucia (risposta della Pagina), Giulia e marco_b (risposti nei commenti) non sono da rispondere');
});

test('solo richieste GET, mai scritture verso Meta', async (t) => {
  const { fake, db } = await setup(t);
  await syncMeta(db, { cfg: fake.cfg });
  assert.ok(fake.state.requests.length > 5);
  assert.ok(fake.state.requests.every((r) => r.method === 'GET'));
  assert.ok(!fake.state.requests.some((r) => /ads_posts|[?&]ids=/.test(r.url)), 'niente ads_posts né parametro ids');
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
  assert.deepEqual(before, ['facebook:Giulia Neri', 'facebook:Lucia Bianchi', 'facebook:Mario Rossi', 'facebook:Paolo Verde', 'facebook:Utente Facebook (nome nascosto da Meta)',
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

test('Meta chiede meno dati: la richiesta viene ripetuta con limiti ridotti', async (t) => {
  const { fake, db } = await setup(t);
  fake.state.maxLimit = 3;
  const r = await syncMeta(db, { cfg: fake.cfg });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.nuovi, 12);
  const limits = fake.state.requests.filter((q) => q.url.includes('/conversations')).map((q) => new URL(q.url, 'http://x').searchParams.get('limit'));
  assert.ok(limits.includes('25') && limits.includes('3'), `limiti usati: ${limits}`);
});

test('Meta lenta a rispondere: si riprova con meno dati invece di fallire', async (t) => {
  const { fake, db } = await setup(t);
  fake.state.slowAbove = 3;
  const r = await syncMeta(db, { cfg: { ...fake.cfg, timeoutMs: 400 } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.nuovi, 12);
});

test('un errore temporaneo su una sezione non blocca le altre', async (t) => {
  const { fake, db } = await setup(t);
  fake.state.data.media.IG1 = { error: { code: 2, message: 'Service temporarily unavailable' } };
  const r = await syncMeta(db, { cfg: fake.cfg });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.bySource.messenger, 4);
  assert.equal(r.bySource.facebook_comment, 4);
  assert.ok(r.warnings.some((w) => /Vir3D: commenti Instagram/.test(w)), r.warnings.join(' | '));
});

test('connessione che cade ogni tanto: le richieste vengono ripetute', async (t) => {
  const { fake, db } = await setup(t);
  fake.state.dropEvery = 4;
  const r = await syncMeta(db, { cfg: { ...fake.cfg, retryDelayMs: 10 } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.nuovi, 12, r.warnings.join(' | '));
});

test('DM Instagram con la chiave Instagram: letti, abbinati, rinnovo settimanale della chiave', async (t) => {
  const { fake, db } = await setup(t);
  const { startFakeInstagram } = require('../test-support/fake-instagram');
  const ig = await startFakeInstagram();
  t.after(() => ig.close());
  process.env.IG_GRAPH_BASE = ig.base;
  t.after(() => { delete process.env.IG_GRAPH_BASE; });
  const { setSetting, getSetting } = require('../lib/settings');
  setSetting(db, 'ig_token', 'IGtoken');
  setSetting(db, 'ig_token_refreshed_at', new Date(Date.now() - 8 * 86400000).toISOString());
  const r = await syncMeta(db, { cfg: { ...fake.cfg, igToken: 'IGtoken' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(ig.state.refreshed, 1, 'chiave più vecchia di 7 giorni: rinnovata');
  assert.equal(getSetting(db, 'ig_token'), 'IGtoken-r1');
  const igRows = db.prepare(`SELECT id, direction, counterpart_address, customer_id FROM messages WHERE source = 'instagram' ORDER BY id`).all();
  assert.deepEqual(igRows.map((x) => x.id), ['instagram:imA1', 'instagram:imA2', 'instagram:imB1'], 'conversazione di 40 giorni fa esclusa');
  assert.equal(igRows.find((x) => x.id === 'instagram:imA1').direction, 'out');
  assert.equal(igRows.find((x) => x.id === 'instagram:imA2').customer_id, 1, 'anna.verdi riconosciuta');
  assert.equal(igRows.find((x) => x.id === 'instagram:imB1').counterpart_address, 'marco_b');
  assert.ok(ig.state.requests.every((q) => q.method === 'GET'));
  assert.ok(!fake.state.requests.some((q) => /platform=instagram/.test(q.url)), 'con la chiave Instagram non usa la vecchia strada');
});

test('commenti: a ogni giro si rileggono gli ultimi giorni, così un commento sfuggito al giro prima non si perde', async (t) => {
  const { fake, db } = await setup(t);
  await syncMeta(db, { cfg: fake.cfg });
  // commento di 3 giorni fa che il giro precedente non aveva visto (es. comparso in ritardo su Meta)
  fake.state.data.posts['P1:published_posts'][0].comments.data.push(
    { id: 'fc9', created_time: new Date(Date.now() - 3 * 86400000).toISOString(), from: { id: 'U9', name: 'Rita Blu' }, message: 'Fate spedizioni a Malta?' });
  const r = await syncMeta(db, { cfg: fake.cfg });
  assert.equal(r.nuovi, 1);
  assert.equal(one(db, `SELECT counterpart_name FROM messages WHERE id = 'fbcomment:fc9'`), 'Rita Blu');
  const stats = JSON.parse(one(db, `SELECT value FROM settings WHERE key = 'meta_comment_stats'`));
  assert.ok(stats.fbComments >= 4 && stats.fbHidden === 1, JSON.stringify(stats));
});

test('commento salvato senza autore: quando Meta mostra il nome, viene completato', async (t) => {
  const { fake, db } = await setup(t);
  await syncMeta(db, { cfg: fake.cfg });
  assert.equal(one(db, `SELECT counterpart_address FROM messages WHERE id = 'fbcomment:fc4'`), 'fb:anonimo-fc4');
  const fc4 = fake.state.data.posts['P1:published_posts'][0].comments.data.find((c) => c.id === 'fc4');
  fc4.from = { id: 'U7', name: 'Teresa Gialli' };
  await syncMeta(db, { cfg: fake.cfg });
  assert.deepEqual(db.prepare(`SELECT counterpart_address, counterpart_name FROM messages WHERE id = 'fbcomment:fc4'`).get(),
    { counterpart_address: 'fb:U7', counterpart_name: 'Teresa Gialli' });
  assert.equal(one(db, `SELECT COUNT(*) FROM messages WHERE id = 'fbcomment:fc4'`), 1);
});

test('controllo dei permessi della chiave: dice quali mancano', async (t) => {
  const { fake } = await setup(t);
  const { tokenScopes, WANTED_SCOPES } = require('../lib/sync-meta');
  const r = await tokenScopes(fake.cfg);
  assert.ok(r.missing.includes('pages_read_user_content'));
  fake.state.scopes = WANTED_SCOPES;
  assert.deepEqual((await tokenScopes(fake.cfg)).missing, []);
  assert.ok(fake.state.requests.every((q) => q.method === 'GET'));
});


test('il testo esteso del post aggiorna anche commenti esistenti, senza duplicarli', async (t) => {
  const { fake, db } = await setup(t);
  const first = await syncMeta(db, { cfg: fake.cfg });
  assert.equal(first.ok, true, first.error);
  const key = 'fbcomment:fc4';
  const previous = one(db, 'SELECT MAX(sent_at) FROM messages WHERE thread_key = ?', key);
  db.prepare('INSERT INTO ai_drafts (thread_key, draft, model, based_on, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(key, 'Risposta con vecchio contesto', 'test', previous, new Date().toISOString());
  const newCaption = 'Ambigramma personalizzato con due nomi: scegli la combinazione e il colore. '
    + 'Questo contenuto e volutamente piu lungo di cinquanta caratteri.';
  fake.state.data.posts['P1:published_posts'][0].message = newCaption;
  const again = await syncMeta(db, { cfg: fake.cfg });
  assert.equal(again.ok, true, again.error);
  assert.equal(again.nuovi, 0, 'il contesto aggiornato non conta come nuovo messaggio');
  assert.equal(one(db, 'SELECT subject FROM messages WHERE id = ?', 'fbcomment:fc4'),
    'Commento al post: ' + newCaption);
  assert.equal(one(db, 'SELECT based_on FROM ai_drafts WHERE thread_key = ?', key), '',
    'la vecchia bozza rimane conservata ma va rigenerata');
});


test('inserzione con landing verificata: la pagina prodotto entra nel contesto del commento', async (t) => {
  const { fake, db } = await setup(t);
  db.prepare("INSERT INTO adv_accounts (id, brand, name) VALUES ('act_1', 'vir3d', 'Vir3D Ads')").run();
  db.prepare("INSERT INTO adv_entities (id, account_id, level, creative_id, link_url, fetched_at) VALUES ('ad3', 'act_1', 'ad', 'creative3', ?, ?)")
    .run('https://vir3d.it/products/ambigramma-premium?utm_source=meta', new Date().toISOString());
  fake.state.data.ads.act_1[2].creative.id = 'creative3';
  const r = await syncMeta(db, { cfg: fake.cfg });
  assert.equal(r.ok, true, r.error);
  const context = one(db, 'SELECT subject FROM messages WHERE id = ?', 'fbcomment:fc5');
  assert.match(context, /https:\/\/vir3d\.it\/products\/ambigramma-premium/);
  assert.doesNotMatch(context, /utm_source=/, 'la destinazione è ripulita dai parametri traccianti');
});
