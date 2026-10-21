'use strict';

// Messaggi dei canali: abbinamento ai clienti, mittenti ignorati, conversazioni.
const { normalizeEmail } = require('./normalize');

// Indirizzi automatici che non sono mai clienti.
const AUTOMATIC = /^(no-?reply|do-?not-?reply|noreply|notifications?|notifiche|mailer-daemon|postmaster|bounces?|automated|alerts?)([+.\-_].*)?@/i;

function isIgnored(db, address) {
  const a = normalizeEmail(address);
  if (!a || AUTOMATIC.test(a)) return true;
  const domain = a.slice(a.indexOf('@'));
  return Boolean(db.prepare('SELECT 1 FROM ignored_senders WHERE pattern IN (?, ?)').get(a, domain));
}

function ignoreSender(db, pattern) {
  const p = normalizeEmail(pattern);
  if (!p || !p.includes('@')) throw new Error('Indirizzo non valido');
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO ignored_senders (pattern) VALUES (?)').run(p);
    // Toglie i messaggi non collegati a nessun cliente che corrispondono.
    if (p.startsWith('@')) {
      db.prepare(`DELETE FROM messages WHERE customer_id IS NULL AND counterpart_address LIKE ?`).run(`%${p}`);
    } else {
      db.prepare('DELETE FROM messages WHERE customer_id IS NULL AND counterpart_address = ?').run(p);
    }
  })();
}

function customerForAddress(db, address) {
  return db.prepare(`SELECT customer_id FROM contacts WHERE type = 'email' AND value_normalized = ?`)
    .pluck().get(normalizeEmail(address)) ?? null;
}

// Collega ai clienti tutti i messaggi non collegati il cui indirizzo è ora tra i contatti.
function linkUnmatched(db) {
  return db.prepare(`
    UPDATE messages SET customer_id = (
      SELECT k.customer_id FROM contacts k WHERE k.type = 'email' AND k.value_normalized = messages.counterpart_address)
    WHERE customer_id IS NULL AND EXISTS (
      SELECT 1 FROM contacts k WHERE k.type = 'email' AND k.value_normalized = messages.counterpart_address)`).run().changes;
}

// Conversazioni (thread) con ultimo messaggio, ordinate per attività recente.
function conversations(db, { customerId, sinceIso, onlyToAnswer = false, limit = 200 } = {}) {
  const where = [];
  const params = {};
  if (customerId) { where.push('o.customer_id = @customerId'); params.customerId = customerId; }
  if (sinceIso) { where.push('last.sent_at >= @since'); params.since = sinceIso; }
  if (onlyToAnswer) where.push(`last.direction = 'in'`);
  params.limit = limit;
  return db.prepare(`
    WITH ranked AS (
      SELECT m.*, ROW_NUMBER() OVER (PARTITION BY thread_key ORDER BY sent_at DESC, id DESC) AS rn,
             COUNT(*) OVER (PARTITION BY thread_key) AS n
      FROM messages m
    ),
    last AS (SELECT * FROM ranked WHERE rn = 1),
    -- Il cliente della conversazione: quello di un qualsiasi messaggio collegato del thread.
    owner AS (SELECT thread_key, MAX(customer_id) AS customer_id FROM messages GROUP BY thread_key)
    SELECT last.thread_key, last.source, last.subject, last.snippet, last.sent_at, last.direction, last.link,
           last.counterpart_address, last.counterpart_name, last.n,
           o.customer_id, c.name AS customer_name, c.brand AS customer_brand
    FROM last
    JOIN owner o ON o.thread_key = last.thread_key
    LEFT JOIN customers c ON c.id = o.customer_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY last.sent_at DESC
    LIMIT @limit`).all(params);
}

// Indirizzi con messaggi non collegati, raggruppati, con eventuale cliente omonimo suggerito.
function unlinkedSenders(db) {
  const rows = db.prepare(`
    SELECT counterpart_address AS address,
           MAX(counterpart_name) AS name,
           COUNT(*) AS n,
           MAX(sent_at) AS last_at,
           (SELECT subject FROM messages m2 WHERE m2.counterpart_address = m.counterpart_address AND m2.customer_id IS NULL
              ORDER BY sent_at DESC LIMIT 1) AS last_subject,
           (SELECT snippet FROM messages m2 WHERE m2.counterpart_address = m.counterpart_address AND m2.customer_id IS NULL
              ORDER BY sent_at DESC LIMIT 1) AS last_snippet
    FROM messages m WHERE customer_id IS NULL
    GROUP BY counterpart_address ORDER BY last_at DESC`).all();
  const similar = db.prepare(`SELECT id, name FROM customers WHERE name LIKE ? COLLATE NOCASE LIMIT 3`);
  for (const r of rows) {
    const nm = String(r.name || '').trim();
    r.suggestions = nm.length >= 4 ? similar.all(`%${nm}%`) : [];
  }
  return rows;
}

module.exports = { isIgnored, ignoreSender, customerForAddress, linkUnmatched, conversations, unlinkedSenders, AUTOMATIC };
