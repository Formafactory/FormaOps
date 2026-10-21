'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrate } = require('../lib/db');
const C = require('../lib/customers');
const vir3d = require('../lib/vir3d');
const { syncVir3d } = require('../lib/sync-vir3d');
const { startFake, order } = require('../test-support/fake-vir3d');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, path.join(__dirname, '..', 'migrations'), () => {});
  return db;
}
const count = (db, sql, ...a) => db.prepare(sql).pluck().get(...a);

// Scenario: 6 ordini, con casi di abbinamento diversi.
function scenario() {
  return [
    order('o1', 1, { updatedAt: '2026-10-01T10:00:00.000Z', name: 'Anna Verdi', email: 'Anna@Example.it', phone: '333 1111111' }),
    order('o2', 2, { updatedAt: '2026-10-02T10:00:00.000Z', name: 'Anna V.', email: 'anna@example.it' }),           // stessa email -> stessa cliente
    order('o3', 3, { updatedAt: '2026-10-03T10:00:00.000Z', name: 'Luca', phone: '+39 333 2222222' }),             // telefono di cliente esistente
    order('o4', 4, { updatedAt: '2026-10-04T10:00:00.000Z', name: 'Conflitto', email: 'mario@example.it', phone: '3332222222' }), // email di Mario, tel di Luca
    order('o5', 5, { updatedAt: '2026-10-04T10:00:00.000Z', name: 'Ospite senza contatti' }),                     // stesso updatedAt di o4
    order('o6', 6, { updatedAt: '2026-10-05T10:00:00.000Z', name: 'Anna Verdi', email: 'anna@example.it' }),       // omonima? no: stessa email
  ];
}

async function setup() {
  const fake = await startFake({ orders: scenario() });
  const db = freshDb();
  // Clienti già inseriti a mano prima della sync
  C.createCustomer(db, { name: 'Luca Bianchi', brand: 'deartis', phone: '333 222 2222' });
  C.createCustomer(db, { name: 'Mario Rossi', brand: 'vir3d', email: 'mario@example.it' });
  const cfg = { base: fake.base, key: fake.key };
  return { fake, db, cfg };
}

test('chiave sbagliata: errore chiaro, niente scritto', async () => {
  const { fake, db } = await setup();
  await assert.rejects(vir3d.health({ base: fake.base, key: 'sbagliata' }), /rifiutato la chiave/);
  const r = await syncVir3d(db, { cfg: { base: fake.base, key: 'sbagliata' } });
  assert.equal(r.ok, false);
  assert.equal(count(db, 'SELECT COUNT(*) FROM orders'), 0);
  assert.match(count(db, 'SELECT last_error FROM sync_state'), /chiave/);
  await fake.close();
});

test('prima sync: tutti gli ordini, abbinamenti corretti, conflitto segnalato', async () => {
  const { fake, db, cfg } = await setup();
  const r = await syncVir3d(db, { cfg, pageSize: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.pagine, 3);
  assert.equal(r.nuovi, 6);
  assert.equal(count(db, 'SELECT COUNT(*) FROM orders'), 6);
  assert.equal(count(db, 'SELECT COUNT(*) FROM order_items'), 6);

  const anna = count(db, `SELECT customer_id FROM orders WHERE id = 'o1'`);
  assert.equal(count(db, `SELECT customer_id FROM orders WHERE id = 'o2'`), anna, 'o2 stessa email di o1');
  assert.equal(count(db, `SELECT customer_id FROM orders WHERE id = 'o6'`), anna, 'o6 stessa email di o1');
  assert.equal(count(db, `SELECT name FROM customers WHERE id = ?`, anna), 'Anna Verdi');

  assert.equal(count(db, `SELECT customer_id FROM orders WHERE id = 'o3'`), 1, 'o3 al Luca esistente via telefono');
  assert.equal(count(db, `SELECT brand FROM customers WHERE id = 1`), 'entrambi', 'Luca era De Artis, ora ha ordini Vir3D');

  assert.equal(count(db, `SELECT customer_id FROM orders WHERE id = 'o4'`), 2, 'o4 a Mario via email');
  assert.equal(count(db, `SELECT COUNT(*) FROM review_items WHERE ref_id = 'VIR3D-4'`), 1, 'conflitto da verificare');
  assert.equal(count(db, `SELECT COUNT(*) FROM contacts WHERE customer_id = 2 AND type = 'phone'`), 0, 'telefono di Luca NON copiato su Mario');

  const ospite = count(db, `SELECT customer_id FROM orders WHERE id = 'o5'`);
  assert.equal(count(db, `SELECT name FROM customers WHERE id = ?`, ospite), 'Ospite senza contatti');

  assert.equal(count(db, 'SELECT COUNT(*) FROM customers'), 4, '2 esistenti + Anna + ospite');
  await fake.close();
});

test('rieseguire non duplica; un ordine modificato viene aggiornato', async () => {
  const { fake, db, cfg } = await setup();
  await syncVir3d(db, { cfg, pageSize: 2 });
  const again = await syncVir3d(db, { cfg, pageSize: 2 });
  assert.equal(again.ok, true);
  assert.equal(again.nuovi + again.aggiornati, 0);
  assert.equal(count(db, 'SELECT COUNT(*) FROM orders'), 6);

  const o1 = fake.state.orders.find((o) => o.orderId === 'o1');
  Object.assign(o1, { status: 'shipped', updatedAt: '2026-10-10T08:00:00.000Z' });
  o1.fulfillment.trackingNumber = 'TRK123';
  const upd = await syncVir3d(db, { cfg, pageSize: 2 });
  assert.equal(upd.aggiornati, 1);
  assert.equal(upd.nuovi, 0);
  assert.equal(count(db, `SELECT status FROM orders WHERE id = 'o1'`), 'shipped');
  assert.equal(count(db, `SELECT tracking_number FROM orders WHERE id = 'o1'`), 'TRK123');
  assert.equal(count(db, 'SELECT COUNT(*) FROM orders'), 6);
  assert.equal(count(db, 'SELECT COUNT(*) FROM order_items'), 6);
  await fake.close();
});

test('interruzione a metà: riprende dal cursore senza perdite né doppioni', async () => {
  const { fake, db, cfg } = await setup();
  fake.state.failOnRequest = 2;
  const broken = await syncVir3d(db, { cfg, pageSize: 2 });
  assert.equal(broken.ok, false);
  assert.equal(count(db, 'SELECT COUNT(*) FROM orders'), 2, 'salvata solo la prima pagina');
  const resumed = await syncVir3d(db, { cfg, pageSize: 2 });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.nuovi, 4);
  assert.equal(count(db, 'SELECT COUNT(*) FROM orders'), 6);
  assert.equal(count(db, 'SELECT last_error FROM sync_state'), null);
  await fake.close();
});

test('schema inatteso: niente scritto', async () => {
  const { fake, db, cfg } = await setup();
  fake.state.schemaVersion = '2';
  const r = await syncVir3d(db, { cfg });
  assert.equal(r.ok, false);
  assert.match(r.error, /schema/);
  assert.equal(count(db, 'SELECT COUNT(*) FROM orders'), 0);
  await fake.close();
});

test('un ordine spostato a mano resta dove lo hai messo dopo una nuova sync', async () => {
  const { fake, db, cfg } = await setup();
  await syncVir3d(db, { cfg });
  db.prepare(`UPDATE orders SET customer_id = 1, match_reason = 'manuale' WHERE id = 'o4'`).run();
  const o4 = fake.state.orders.find((o) => o.orderId === 'o4');
  Object.assign(o4, { status: 'delivered', updatedAt: '2026-10-11T08:00:00.000Z' });
  await syncVir3d(db, { cfg });
  assert.equal(count(db, `SELECT customer_id FROM orders WHERE id = 'o4'`), 1);
  assert.equal(count(db, `SELECT status FROM orders WHERE id = 'o4'`), 'delivered');
  await fake.close();
});

test('la ricerca trova un cliente dal numero d\'ordine', async () => {
  const { fake, db, cfg } = await setup();
  await syncVir3d(db, { cfg });
  assert.deepEqual(C.searchCustomers(db, 'VIR3D-3').map((c) => c.name), ['Luca Bianchi']);
  await fake.close();
});
