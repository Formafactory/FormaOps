'use strict';

const { normalizeContact, normalizeEmail, normalizePhone, normalizeHandle } = require('./normalize');

const BRANDS = ['vir3d', 'deartis', 'entrambi'];
const CONTACT_TYPES = ['email', 'phone', 'instagram', 'facebook'];

class UserError extends Error {}

function contactOwner(db, type, normalized) {
  return db.prepare(`
    SELECT c.id, c.name FROM contacts k JOIN customers c ON c.id = k.customer_id
    WHERE k.type = ? AND k.value_normalized = ?`).get(type, normalized);
}

function prepareContact(db, type, value) {
  if (!CONTACT_TYPES.includes(type)) throw new UserError('Tipo di contatto non valido.');
  const raw = String(value ?? '').trim();
  const normalized = normalizeContact(type, raw);
  if (!normalized) throw new UserError('Il contatto è vuoto o non valido.');
  const owner = contactOwner(db, type, normalized);
  if (owner) {
    throw new UserError(`Questo contatto (${normalized}) appartiene già al cliente "${owner.name}" (#${owner.id}).`);
  }
  return { raw, normalized };
}

function createCustomer(db, { name, brand, email, phone }) {
  name = String(name ?? '').trim();
  if (!name) throw new UserError('Il nome è obbligatorio.');
  if (!BRANDS.includes(brand)) throw new UserError('Brand non valido.');
  return db.transaction(() => {
    const pending = [];
    if (email && String(email).trim()) pending.push(['email', prepareContact(db, 'email', email)]);
    if (phone && String(phone).trim()) pending.push(['phone', prepareContact(db, 'phone', phone)]);
    const id = db.prepare('INSERT INTO customers (name, brand) VALUES (?, ?)').run(name, brand).lastInsertRowid;
    for (const [type, c] of pending) {
      db.prepare('INSERT INTO contacts (customer_id, type, value_raw, value_normalized) VALUES (?, ?, ?, ?)')
        .run(id, type, c.raw, c.normalized);
    }
    return Number(id);
  })();
}

function addContact(db, customerId, type, value) {
  return db.transaction(() => {
    if (!getCustomer(db, customerId)) throw new UserError('Cliente inesistente.');
    const c = prepareContact(db, type, value);
    db.prepare('INSERT INTO contacts (customer_id, type, value_raw, value_normalized) VALUES (?, ?, ?, ?)')
      .run(customerId, type, c.raw, c.normalized);
    touch(db, customerId);
  })();
}

function removeContact(db, customerId, contactId) {
  const r = db.prepare('DELETE FROM contacts WHERE id = ? AND customer_id = ?').run(contactId, customerId);
  if (r.changes) touch(db, customerId);
  return r.changes;
}

function updateCustomer(db, customerId, { name, brand, notes }) {
  name = String(name ?? '').trim();
  if (!name) throw new UserError('Il nome è obbligatorio.');
  if (!BRANDS.includes(brand)) throw new UserError('Brand non valido.');
  db.prepare(`UPDATE customers SET name = ?, brand = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name, brand, String(notes ?? ''), customerId);
}

function touch(db, customerId) {
  db.prepare(`UPDATE customers SET updated_at = datetime('now') WHERE id = ?`).run(customerId);
}

function getCustomer(db, id) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!customer) return null;
  customer.contacts = db.prepare(
    `SELECT * FROM contacts WHERE customer_id = ? ORDER BY CASE type WHEN 'email' THEN 1 WHEN 'phone' THEN 2 ELSE 3 END, id`
  ).all(id);
  return customer;
}

// Ricerca su nome (parziale), email, telefono, profili social.
// Il testo cercato passa dalle stesse funzioni di normalizzazione usate in salvataggio.
function searchCustomers(db, query, { brand } = {}) {
  const q = String(query ?? '').trim();
  const where = [];
  const params = {};
  if (q) {
    const ors = ['c.name LIKE @name'];
    params.name = `%${q}%`;
    ors.push(`EXISTS (SELECT 1 FROM contacts k WHERE k.customer_id = c.id AND k.type = 'email' AND k.value_normalized LIKE @email)`);
    params.email = `%${normalizeEmail(q)}%`;
    const handle = normalizeHandle(q);
    if (handle) {
      ors.push(`EXISTS (SELECT 1 FROM contacts k WHERE k.customer_id = c.id AND k.type IN ('instagram','facebook') AND k.value_normalized LIKE @handle)`);
      params.handle = `%${handle}%`;
    }
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 4) {
      // Confronto sulle cifre: trova "333 1234567", "+39 333…", "0039…" allo stesso modo.
      ors.push(`EXISTS (SELECT 1 FROM contacts k WHERE k.customer_id = c.id AND k.type = 'phone' AND k.value_normalized LIKE @phone)`);
      const full = normalizePhone(q);
      params.phone = digits.length >= 9 ? `%${full.replace('+', '')}%` : `%${digits}%`;
    }
    where.push(`(${ors.join(' OR ')})`);
  }
  if (brand && BRANDS.includes(brand)) {
    where.push('c.brand = @brand');
    params.brand = brand;
  }
  const sql = `SELECT c.* FROM customers c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY c.updated_at DESC, c.id DESC LIMIT 200`;
  const rows = db.prepare(sql).all(params);
  const contactsStmt = db.prepare('SELECT type, value_raw, value_normalized FROM contacts WHERE customer_id = ? ORDER BY id');
  for (const r of rows) r.contacts = contactsStmt.all(r.id);
  return rows;
}

module.exports = {
  BRANDS, CONTACT_TYPES, UserError,
  createCustomer, addContact, removeContact, updateCustomer, getCustomer, searchCustomers,
};
