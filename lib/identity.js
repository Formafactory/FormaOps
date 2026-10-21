'use strict';

// Abbinamento conservativo di una persona a un cliente:
// 1) email normalizzata, 2) telefono normalizzato, 3) altrimenti nuovo cliente.
// Mai per nome. Se email e telefono puntano a due clienti diversi, vince l'email
// e il caso finisce in review_items per una decisione manuale.

const { normalizeEmail, normalizePhone } = require('./normalize');

function ownerOf(db, type, normalized) {
  if (!normalized) return null;
  return db.prepare('SELECT customer_id FROM contacts WHERE type = ? AND value_normalized = ?')
    .pluck().get(type, normalized) ?? null;
}

function addContactIfFree(db, customerId, type, raw, normalized) {
  if (!normalized) return;
  db.prepare(`INSERT OR IGNORE INTO contacts (customer_id, type, value_raw, value_normalized)
              VALUES (?, ?, ?, ?)`).run(customerId, type, String(raw).trim(), normalized);
}

function markBrand(db, customerId, brand) {
  const current = db.prepare('SELECT brand FROM customers WHERE id = ?').pluck().get(customerId);
  if (current && current !== brand && current !== 'entrambi') {
    db.prepare(`UPDATE customers SET brand = 'entrambi', updated_at = datetime('now') WHERE id = ?`).run(customerId);
  }
}

// Da chiamare dentro una transazione.
function resolveCustomer(db, { name, email, phone, brand = 'vir3d', source, refId }) {
  const emailN = normalizeEmail(email);
  const phoneN = normalizePhone(phone);
  const byEmail = ownerOf(db, 'email', emailN);
  const byPhone = ownerOf(db, 'phone', phoneN);

  let customerId;
  let reason;
  if (byEmail) {
    customerId = byEmail;
    reason = 'email';
    if (byPhone && byPhone !== byEmail) {
      db.prepare(`INSERT OR IGNORE INTO review_items (kind, source, ref_id, customer_id, detail)
                  VALUES ('conflitto_contatti', ?, ?, ?, ?)`)
        .run(source, refId, byEmail,
          `Email ${emailN} appartiene al cliente #${byEmail}, telefono ${phoneN} al cliente #${byPhone}`);
    } else if (!byPhone) {
      addContactIfFree(db, customerId, 'phone', phone, phoneN);
    }
  } else if (byPhone) {
    customerId = byPhone;
    reason = 'telefono';
    addContactIfFree(db, customerId, 'email', email, emailN);
  } else {
    const displayName = String(name ?? '').trim() || emailN || phoneN || 'Cliente senza nome';
    customerId = Number(db.prepare('INSERT INTO customers (name, brand) VALUES (?, ?)').run(displayName, brand).lastInsertRowid);
    addContactIfFree(db, customerId, 'email', email, emailN);
    addContactIfFree(db, customerId, 'phone', phone, phoneN);
    reason = 'nuovo';
  }
  if (reason !== 'nuovo') markBrand(db, customerId, brand);
  return { customerId, reason };
}

module.exports = { resolveCustomer };
