'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrate } = require('../lib/db');
const C = require('../lib/customers');
const I = require('../lib/inbox');

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
function msg(db, { thread, source = 'gmail', dir = 'in', h, who = 'anna@example.it', type = 'email', customer = null }) {
  seq++;
  db.prepare(`INSERT INTO messages (id, source, kind, contact_type, thread_key, direction, counterpart_address, subject, snippet, sent_at, customer_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'Oggetto', 'testo', ?, ?)`)
    .run(`m${seq}`, source, source === 'gmail' ? 'email' : 'dm', type, thread, dir, who, ago(h), customer);
}
function order(db, customer, { status = 'confirmed', h = 48, n = 1 } = {}) {
  db.prepare(`INSERT INTO orders (id, order_number, customer_id, created_at, updated_at, status, currency, subtotal_minor, shipping_minor, discount_minor, total_minor)
              VALUES (?, ?, ?, ?, ?, ?, 'EUR', 4000, 990, 0, 4990)`)
    .run(`o${customer}-${n}`, `VIR3D-${customer}${n}`, customer, ago(h), ago(h), status);
}
const view = (db, v, extra = {}) => I.inbox(db, { view: v, now: NOW, ...extra });
const keys = (r) => r.threads.map((t) => t.thread_key);

test('relazione automatica: De Artis = B2B, con ordini = Cliente, solo annullati = Lead; la scelta manuale vince', () => {
  const db = freshDb();
  const a = C.createCustomer(db, { name: 'Anna', brand: 'vir3d' });
  const b = C.createCustomer(db, { name: 'Studio Rossi', brand: 'deartis' });
  const c = C.createCustomer(db, { name: 'Carlo', brand: 'vir3d' });
  const d = C.createCustomer(db, { name: 'Dario', brand: 'vir3d' });
  order(db, a, { status: 'delivered' });
  order(db, c, { status: 'cancelled' });
  assert.equal(I.relationship(db, a).value, 'cliente');
  assert.equal(I.relationship(db, b).value, 'b2b');
  assert.equal(I.relationship(db, c).value, 'lead');
  assert.equal(I.relationship(db, d).value, 'lead');
  I.setRelationship(db, a, 'personale');
  assert.deepEqual(I.relationship(db, a), { value: 'personale', manual: 'personale', auto: 'cliente' });
  I.setRelationship(db, a, '');
  assert.equal(I.relationship(db, a).value, 'cliente', 'vuoto = torna automatica');
  assert.throws(() => I.setRelationship(db, a, 'amico'), /non valida/);
});

test('stati automatici: ultimo messaggio del cliente = da rispondere, ultimo tuo = in attesa', () => {
  const db = freshDb();
  msg(db, { thread: 'T1', h: 3 });
  msg(db, { thread: 'T2', h: 5 });
  msg(db, { thread: 'T2', dir: 'out', h: 1 });
  assert.deepEqual(keys(view(db, 'rispondere')), ['T1']);
  assert.deepEqual(keys(view(db, 'attesa')), ['T2']);
});

test('chiusa resta chiusa finché il cliente non riscrive, poi torna da rispondere da sola', () => {
  const db = freshDb();
  msg(db, { thread: 'T1', h: 10 });
  I.setThreadState(db, 'T1', 'chiudi', { now: NOW });
  assert.deepEqual(keys(view(db, 'chiuse')), ['T1']);
  assert.equal(view(db, 'rispondere').threads.length, 0);
  msg(db, { thread: 'T1', h: 0.5 });
  assert.deepEqual(keys(view(db, 'rispondere')), ['T1']);
  assert.equal(view(db, 'chiuse').threads.length, 0);
});

test('un messaggio importato dopo la chiusura, anche se scritto prima, riapre la conversazione', () => {
  const db = freshDb();
  msg(db, { thread: 'T1', h: 10 });
  I.setThreadState(db, 'T1', 'chiudi', { now: NOW });
  msg(db, { thread: 'T1', h: 2 }); // scritto 2 ore fa, arrivato con la sync successiva
  assert.deepEqual(keys(view(db, 'rispondere')), ['T1']);
});

test('rimandata: sparisce fino alla data, poi torna; se il cliente riscrive torna subito', () => {
  const db = freshDb();
  msg(db, { thread: 'T1', h: 10 });
  msg(db, { thread: 'T2', h: 10, who: 'bea@example.it' });
  I.setThreadState(db, 'T1', 'rimanda', { days: 3, now: NOW });
  I.setThreadState(db, 'T2', 'rimanda', { days: 3, now: NOW });
  assert.deepEqual(keys(view(db, 'rimandate')).sort(), ['T1', 'T2']);
  assert.equal(view(db, 'rispondere').threads.length, 0);
  // passati 4 giorni: tornano tra le da rispondere
  assert.equal(I.inbox(db, { view: 'rispondere', now: NOW + 4 * 24 * H }).threads.length, 2);
  msg(db, { thread: 'T2', h: 1, who: 'bea@example.it' });
  assert.deepEqual(keys(view(db, 'rispondere')), ['T2']);
  assert.deepEqual(keys(view(db, 'rimandate')), ['T1']);
});

test('in attesa a mano (hai risposto per telefono) finché il cliente non riscrive', () => {
  const db = freshDb();
  msg(db, { thread: 'T1', h: 10 });
  I.setThreadState(db, 'T1', 'attesa', { now: NOW });
  assert.deepEqual(keys(view(db, 'attesa')), ['T1']);
  I.setThreadState(db, 'T1', 'riapri', { now: NOW });
  assert.deepEqual(keys(view(db, 'rispondere')), ['T1']);
});

test('urgenza: chat dopo 4 ore, email dopo 24; si conta dal primo messaggio senza risposta', () => {
  const db = freshDb();
  msg(db, { thread: 'DM5', source: 'instagram', type: 'instagram', who: 'anna.v', h: 5 });
  msg(db, { thread: 'DM3', source: 'messenger', type: 'facebook', who: 'fb:1', h: 3 });
  msg(db, { thread: 'COM5', source: 'facebook_comment', type: 'facebook', who: 'fb:2', h: 5 });
  msg(db, { thread: 'MAIL5', h: 5 });
  msg(db, { thread: 'MAIL30', h: 30, who: 'b@example.it' });
  msg(db, { thread: 'MAIL30', h: 1, who: 'b@example.it' }); // sollecito: conta dal primo
  const r = view(db, 'rispondere');
  const urgent = Object.fromEntries(r.threads.map((t) => [t.thread_key, t.urgent]));
  assert.deepEqual(urgent, { DM5: true, DM3: false, COM5: true, MAIL5: false, MAIL30: true });
  assert.equal(r.counts.urgenti, 3);
  assert.equal(Math.round(r.threads.find((t) => t.thread_key === 'MAIL30').waited_hours), 30);
});

test('soglie di urgenza modificabili', () => {
  const db = freshDb();
  msg(db, { thread: 'MAIL5', h: 5 });
  I.setUrgencyHours(db, { chat: 2, email: 4 });
  assert.deepEqual(I.urgencyHours(db), { chat: 2, email: 4 });
  assert.equal(view(db, 'rispondere').threads[0].urgent, true);
});

test('ordine di priorità: ordine in corso, poi urgenti, poi chi aspetta da più tempo', () => {
  const db = freshDb();
  const withOrder = C.createCustomer(db, { name: 'Con ordine', brand: 'vir3d' });
  const delivered = C.createCustomer(db, { name: 'Consegnato', brand: 'vir3d' });
  order(db, withOrder, { status: 'in_production' });
  order(db, delivered, { status: 'delivered' });
  msg(db, { thread: 'NUOVO', h: 1, who: 'x@example.it' });
  msg(db, { thread: 'VECCHIO', h: 10, who: 'y@example.it' });
  msg(db, { thread: 'URGENTE', h: 30, who: 'z@example.it', customer: delivered });
  msg(db, { thread: 'ORDINE', h: 0.2, who: 'o@example.it', customer: withOrder });
  const r = view(db, 'rispondere');
  assert.deepEqual(keys(r), ['ORDINE', 'URGENTE', 'VECCHIO', 'NUOVO']);
  assert.equal(r.threads[0].open_order, `VIR3D-${withOrder}1`);
  assert.equal(r.threads[1].open_order, null, 'ordine consegnato = non in corso');
});

test('Personale: fuori dalla lista di lavoro, nella sua scheda', () => {
  const db = freshDb();
  const friend = C.createCustomer(db, { name: 'Amico', brand: 'vir3d' });
  I.setRelationship(db, friend, 'personale');
  msg(db, { thread: 'AMICO', h: 2, customer: friend, who: 'amico@example.it' });
  msg(db, { thread: 'LAVORO', h: 2 });
  const r = view(db, 'rispondere');
  assert.deepEqual(keys(r), ['LAVORO']);
  assert.equal(r.counts.personale, 1);
  assert.deepEqual(keys(view(db, 'personale')), ['AMICO']);
  assert.deepEqual(keys(view(db, 'tutte')), ['LAVORO']);
});

test('filtri per canale e per relazione; mittenti non collegati = "sconosciuto"', () => {
  const db = freshDb();
  const b2b = C.createCustomer(db, { name: 'Museo', brand: 'deartis' });
  msg(db, { thread: 'B2B', h: 2, customer: b2b, who: 'museo@example.it' });
  msg(db, { thread: 'IG', source: 'instagram', type: 'instagram', who: 'sara', h: 2 });
  assert.deepEqual(keys(view(db, 'rispondere', { relationship: 'b2b' })), ['B2B']);
  assert.deepEqual(keys(view(db, 'rispondere', { source: 'instagram' })), ['IG']);
  assert.equal(view(db, 'rispondere', { source: 'instagram' }).threads[0].relationship, 'sconosciuto');
});

test('scheda cliente: totale speso senza annullati, ordini in corso, canali usati', () => {
  const db = freshDb();
  const a = C.createCustomer(db, { name: 'Anna', brand: 'vir3d' });
  order(db, a, { status: 'delivered', n: 1, h: 500 });
  order(db, a, { status: 'shipped', n: 2, h: 24 });
  order(db, a, { status: 'cancelled', n: 3, h: 10 });
  msg(db, { thread: 'T1', h: 3, customer: a });
  msg(db, { thread: 'T2', source: 'instagram', type: 'instagram', who: 'anna', h: 2, customer: a });
  const s = I.customerSummary(db, a);
  assert.equal(s.orders, 2);
  assert.equal(s.spent_minor, 9980);
  assert.deepEqual(s.open_orders.map((o) => o.status), ['shipped']);
  assert.deepEqual(s.sources.sort(), ['gmail', 'instagram']);
  assert.equal(s.relationship.value, 'cliente');
});
