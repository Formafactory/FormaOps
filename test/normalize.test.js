'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEmail, normalizePhone, normalizeHandle } = require('../lib/normalize');

test('email: spazi e maiuscole', () => {
  assert.equal(normalizeEmail('  Mario.Rossi@Gmail.COM '), 'mario.rossi@gmail.com');
  assert.equal(normalizeEmail(''), '');
  assert.equal(normalizeEmail(undefined), '');
});

test('telefono: senza prefisso, con spazi e punti', () => {
  assert.equal(normalizePhone('333 123.45.67'), '+393331234567');
  assert.equal(normalizePhone('081-555 1234'), '+390815551234');
});

test('telefono: prefisso già presente', () => {
  assert.equal(normalizePhone('+39 333 1234567'), '+393331234567');
  assert.equal(normalizePhone('0039 333 1234567'), '+393331234567');
  assert.equal(normalizePhone('393331234567'), '+393331234567');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
});

test('telefono: vuoto o senza cifre restituisce stringa vuota', () => {
  assert.equal(normalizePhone(''), '');
  assert.equal(normalizePhone('   '), '');
  assert.equal(normalizePhone('rossi'), '');
  assert.equal(normalizePhone(null), '');
});

test('profili social: @, link, maiuscole', () => {
  assert.equal(normalizeHandle('@Vir3D.it'), 'vir3d.it');
  assert.equal(normalizeHandle('https://www.instagram.com/vir3d.it/?hl=it'), 'vir3d.it');
  assert.equal(normalizeHandle('https://facebook.com/Mario.Rossi'), 'mario.rossi');
});
