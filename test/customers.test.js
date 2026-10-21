'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrate } = require('../lib/db');
const C = require('../lib/customers');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, path.join(__dirname, '..', 'migrations'), () => {});
  return db;
}

test('crea cliente con email e telefono normalizzati', () => {
  const db = freshDb();
  const id = C.createCustomer(db, { name: 'Mario Rossi', brand: 'vir3d', email: ' Mario@Example.it', phone: '333 123.45.67' });
  const c = C.getCustomer(db, id);
  assert.deepEqual(c.contacts.map((k) => k.value_normalized), ['mario@example.it', '+393331234567']);
});

test('contatto duplicato su altro cliente: rifiutato con il nome del proprietario, niente inserito', () => {
  const db = freshDb();
  C.createCustomer(db, { name: 'Mario Rossi', brand: 'vir3d', email: 'mario@example.it' });
  const b = C.createCustomer(db, { name: 'Anna Verdi', brand: 'deartis' });
  assert.throws(() => C.addContact(db, b, 'email', 'MARIO@example.it '), /Mario Rossi/);
  assert.equal(C.getCustomer(db, b).contacts.length, 0);
});

test('creazione con contatto duplicato: nessun cliente creato', () => {
  const db = freshDb();
  C.createCustomer(db, { name: 'Mario Rossi', brand: 'vir3d', phone: '3331234567' });
  assert.throws(() => C.createCustomer(db, { name: 'Copia', brand: 'vir3d', phone: '+39 333 123 4567' }), /Mario Rossi/);
  assert.equal(db.prepare('SELECT COUNT(*) FROM customers').pluck().get(), 1);
});

test('ricerca: nome parziale, telefono in ogni formato, email, profilo; nessun falso positivo', () => {
  const db = freshDb();
  C.createCustomer(db, { name: 'Mario Rossi', brand: 'vir3d', email: 'mario@example.it' });
  const luca = C.createCustomer(db, { name: 'Luca Bianchi', brand: 'deartis', phone: '333 123.45.67' });
  C.addContact(db, luca, 'instagram', '@luca.b');
  const names = (q, o) => C.searchCustomers(db, q, o).map((c) => c.name);
  assert.deepEqual(names('ross'), ['Mario Rossi']);
  assert.deepEqual(names('+393331234567'), ['Luca Bianchi']);
  assert.deepEqual(names('333 1234567'), ['Luca Bianchi']);
  assert.deepEqual(names('0039 333 123 4567'), ['Luca Bianchi']);
  assert.deepEqual(names('MARIO@EXAMPLE'), ['Mario Rossi']);
  assert.deepEqual(names('@luca.b'), ['Luca Bianchi']);
  assert.deepEqual(names('', { brand: 'deartis' }), ['Luca Bianchi']);
  assert.deepEqual(names('nessuno'), []);
});

test('rimozione cliente elimina anche i contatti (foreign key)', () => {
  const db = freshDb();
  const id = C.createCustomer(db, { name: 'X', brand: 'vir3d', email: 'x@x.it' });
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) FROM contacts').pluck().get(), 0);
});

test('brand e nome validati', () => {
  const db = freshDb();
  assert.throws(() => C.createCustomer(db, { name: '', brand: 'vir3d' }), /nome/);
  assert.throws(() => C.createCustomer(db, { name: 'A', brand: 'altro' }), /Brand/);
});
