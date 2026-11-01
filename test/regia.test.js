'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrate } = require('../lib/db');
const C = require('../lib/customers');
const I = require('../lib/inbox');
const M = require('../lib/messages');
const { setSetting } = require('../lib/settings');

const H = 3600000;
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const ago = (h) => new Date(NOW - h * H).toISOString();

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, path.join(__dirname, '..', 'migrations'), () => {});
  return db;
}
let seq = 0;
function msg(db, { thread, source = 'gmail', dir = 'in', h = 1, who = 'anna@example.it', type = 'email', customer = null,
  account = 'info.vir3d@gmail.com', subject = 'Oggetto', text = 'testo' }) {
  seq++;
  db.prepare(`INSERT INTO messages (id, source, kind, contact_type, account, thread_key, direction, counterpart_address, subject, snippet, sent_at, customer_id)
              VALUES (?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`r${seq}`, source, type, account, thread, dir, who, subject, text, ago(h), customer);
}

test('brand dal canale: casella De Artis e Pagine con "artis" nel nome = De Artis, il resto Vir3D', () => {
  const db = freshDb();
  setSetting(db, 'gmail_deartis_user', 'Studio.DeArtis@gmail.com');
  msg(db, { thread: 'A', account: 'info.vir3d@gmail.com' });
  msg(db, { thread: 'B', account: 'studio.deartis@gmail.com' });
  msg(db, { thread: 'C', source: 'messenger', type: 'facebook', who: 'fb:1', account: 'De Artis Digitale' });
  msg(db, { thread: 'D', source: 'instagram', type: 'instagram', who: 'x', account: '@vir3ditalia' });
  assert.equal(M.assignBrands(db), 4);
  const b = Object.fromEntries(db.prepare('SELECT thread_key, brand FROM messages').all().map((r) => [r.thread_key, r.brand]));
  assert.deepEqual(b, { A: 'vir3d', B: 'deartis', C: 'deartis', D: 'vir3d' });
  assert.equal(M.assignBrands(db), 0, 'già assegnati: non li ritocca');
});

test('spazi separati: la Regia di un brand non mostra le conversazioni dell\'altro', () => {
  const db = freshDb();
  setSetting(db, 'gmail_deartis_user', 'studio.deartis@gmail.com');
  msg(db, { thread: 'V', h: 2 });
  msg(db, { thread: 'D', h: 2, who: 'museo@example.it', account: 'studio.deartis@gmail.com' });
  M.assignBrands(db);
  assert.deepEqual(I.regia(db, { brand: 'vir3d', now: NOW }).perTe.map((t) => t.thread_key), ['V']);
  assert.deepEqual(I.regia(db, { brand: 'deartis', now: NOW }).perTe.map((t) => t.thread_key), ['D']);
  assert.deepEqual(I.perTeCount(db, 'deartis', NOW), { n: 1, urgent: 0 });
  assert.deepEqual(M.unlinkedSenders(db, { brand: 'deartis' }).map((s) => s.address), ['museo@example.it']);
});

test('Per te: il motivo è sempre indicato, con le regole in ordine', () => {
  const db = freshDb();
  const zia = C.createCustomer(db, { name: 'Zia', brand: 'vir3d' });
  I.setRelationship(db, zia, 'personale');
  const museo = C.createCustomer(db, { name: 'Museo', brand: 'deartis' });
  const anna = C.createCustomer(db, { name: 'Anna', brand: 'vir3d' });
  db.prepare(`INSERT INTO orders (id, order_number, customer_id, created_at, updated_at, status, currency, subtotal_minor, shipping_minor, discount_minor, total_minor)
              VALUES ('o1', 'VIR3D-1', ?, ?, ?, 'in_production', 'EUR', 1, 0, 0, 1)`).run(anna, ago(30), ago(30));
  msg(db, { thread: 'ZIA', h: 1, customer: zia, who: 'zia@example.it' });
  msg(db, { thread: 'ROTTO', h: 1, who: 'm@example.it', subject: 'Pacco', text: 'L\'ambigramma è arrivato rotto' });
  msg(db, { thread: 'MUSEO', h: 1, customer: museo, who: 'museo@example.it' });
  msg(db, { thread: 'ANNA', h: 1, customer: anna, who: 'anna@example.it' });
  msg(db, { thread: 'SOLL', h: 5, who: 's@example.it' });
  msg(db, { thread: 'SOLL', h: 1, who: 's@example.it' });
  msg(db, { thread: 'NUOVO', h: 1, who: 'n@example.it' });
  M.assignBrands(db);
  const r = Object.fromEntries(I.regia(db, { brand: 'vir3d', now: NOW }).perTe.map((t) => [t.thread_key, t.reason.kind]));
  assert.deepEqual(r, { ZIA: 'personale', ROTTO: 'reclamo', MUSEO: 'b2b', ANNA: 'ordine', SOLL: 'sollecito', NUOVO: 'nuovo' });
});

test('Il flusso: risposte, rimandate e chiuse delle ultime 48 ore, più i nuovi ordini; non quelle da rispondere', () => {
  const db = freshDb();
  msg(db, { thread: 'RISPOSTA', h: 5 });
  msg(db, { thread: 'RISPOSTA', dir: 'out', h: 3 });
  msg(db, { thread: 'ALTROVE', h: 4, who: 'b@example.it' });
  msg(db, { thread: 'APERTA', h: 1, who: 'c@example.it' });
  msg(db, { thread: 'VECCHIA', h: 100, who: 'd@example.it' });
  msg(db, { thread: 'VECCHIA', dir: 'out', h: 99, who: 'd@example.it' });
  M.assignBrands(db);
  I.setThreadState(db, 'ALTROVE', 'attesa', { now: NOW });
  db.prepare(`INSERT INTO orders (id, order_number, created_at, updated_at, status, currency, subtotal_minor, shipping_minor, discount_minor, total_minor, customer_name)
              VALUES ('o9', 'VIR3D-9', ?, ?, 'confirmed', 'EUR', 4990, 0, 0, 4990, 'Luca')`).run(ago(2), ago(2));
  const r = I.regia(db, { brand: 'vir3d', now: NOW });
  assert.deepEqual(r.flow.map((f) => f.type === 'ordine' ? f.order.order_number : `${f.thread.thread_key}:${f.state}`),
    ['VIR3D-9', 'RISPOSTA:in_attesa', 'ALTROVE:in_attesa_manuale']);
  assert.deepEqual(r.perTe.map((t) => t.thread_key), ['APERTA']);
  assert.equal(I.regia(db, { brand: 'deartis', now: NOW }).flow.length, 0, 'gli ordini Vir3D non entrano in De Artis');
  I.setThreadState(db, 'APERTA', 'rimanda', { days: 7, now: NOW });
  assert.deepEqual(I.regia(db, { brand: 'vir3d', show: 'rimandate', now: NOW }).flow.map((f) => f.thread.thread_key), ['APERTA']);
});

test('Per te: solo chi ha scritto negli ultimi 7 giorni; il resto in "Arretrate", chiudibile in blocco', () => {
  const db = freshDb();
  msg(db, { thread: 'RECENTE', h: 24 * 3 });
  msg(db, { thread: 'VECCHIA', h: 24 * 25, who: 'b@example.it' });
  msg(db, { thread: 'RISCRIVE', h: 24 * 30, who: 'c@example.it' });
  msg(db, { thread: 'RISCRIVE', h: 24 * 2, who: 'c@example.it' });
  M.assignBrands(db);
  const r = I.regia(db, { brand: 'vir3d', now: NOW });
  assert.deepEqual(r.perTe.map((t) => t.thread_key).sort(), ['RECENTE', 'RISCRIVE'], 'chi riscrive dopo 30 giorni torna dentro');
  assert.equal(r.stats.arretrate, 1);
  assert.deepEqual(I.regia(db, { brand: 'vir3d', show: 'arretrate', now: NOW }).flow.map((f) => f.thread.thread_key), ['VECCHIA']);
  assert.equal(I.perTeCount(db, 'vir3d', NOW).n, 2);
  setSetting(db, 'perte_days', '30');
  assert.equal(I.regia(db, { brand: 'vir3d', now: NOW }).perTe.length, 3, 'giorni modificabili');
  setSetting(db, 'perte_days', '7');
  assert.equal(I.closeArretrate(db, 'vir3d', NOW), 1);
  assert.equal(I.regia(db, { brand: 'vir3d', now: NOW }).stats.arretrate, 0);
  assert.deepEqual(I.regia(db, { brand: 'vir3d', show: 'chiuse', now: NOW }).flow.map((f) => f.thread.thread_key), ['VECCHIA']);
});

test('Per te: una scheda per persona, le azioni valgono per tutte le sue conversazioni', () => {
  const db = freshDb();
  const f = C.createCustomer(db, { name: 'Fabrizio', brand: 'vir3d', email: 'f@example.it' });
  msg(db, { thread: 'F1', h: 30, customer: f, who: 'f@example.it' });
  msg(db, { thread: 'F2', h: 5, customer: f, who: 'f@example.it' });
  msg(db, { thread: 'ALTRO', h: 2, who: 'x@example.it' });
  M.assignBrands(db);
  const r = I.regia(db, { brand: 'vir3d', now: NOW });
  assert.equal(r.perTe.length, 2);
  const fab = r.perTe.find((t) => t.customer_id === f);
  assert.deepEqual(fab.keys.sort(), ['F1', 'F2']);
  assert.equal(fab.others.length, 1);
  assert.equal(I.perTeCount(db, 'vir3d', NOW).n, 2, 'il contatore conta le persone');
});

test('anteprima email: taglia la parte citata della risposta, in italiano, inglese e tedesco', () => {
  const g = require('../lib/gmail');
  assert.equal(M.cutQuoted('Grazie! Se fosse possibile con la scritta "THE BOSS" grazie! Fabrizio Marzadri Vir3d <info.vir3d@gmail.com> schrieb am Mi. 21. Okt. 2026 um 17:31:'),
    'Grazie! Se fosse possibile con la scritta "THE BOSS" grazie! Fabrizio Marzadri');
  assert.equal(M.cutQuoted('Ok, grazie. Che vettore usate? Carlo Il Mar 4 Ago 2026, 19:07 Vir3d <info.vir3d@gmail.com> ha scritto: testo vecchio'),
    'Ok, grazie. Che vettore usate? Carlo');
  assert.equal(M.cutQuoted('Perfect, thanks! On Tue, Aug 4, 2026 at 7:07 PM Vir3d <info.vir3d@gmail.com> wrote: old'), 'Perfect, thanks!');
  assert.equal(M.cutQuoted('Va bene ----- Messaggio originale ----- Da: noi'), 'Va bene');
  assert.equal(M.cutQuoted('Nessuna citazione qui'), 'Nessuna citazione qui');
  assert.equal(g.cleanSnippet('Sì, grazie\nIl giorno mar 4 ago 2026 alle 19:07 Vir3d <\ninfo.vir3d@gmail.com> ha scritto:\n> vecchio', false), 'Sì, grazie');
});

test('inviti di calendario riconosciuti e scartati', () => {
  const g = require('../lib/gmail');
  assert.equal(M.isCalendarInvite({ subject: 'Invito: Vir3d - Allineamento @ mar 4 ago 2026', snippet: '' }), true);
  assert.equal(M.isCalendarInvite({ subject: 'Accepted: call', snippet: '' }), true);
  assert.equal(M.isCalendarInvite({ subject: 'Riunione', snippet: 'Partecipa con Google Meet https://meet.google.com/x' }), true);
  assert.equal(M.isCalendarInvite({ subject: 'Preventivo', snippet: 'Vorrei un invito per la laurea' }), false);
  assert.equal(g.hasCalendarPart({ childNodes: [{ type: 'text/plain' }, { type: 'text/calendar' }] }), true);
  assert.equal(g.hasCalendarPart({ childNodes: [{ type: 'text/plain' }] }), false);
});
