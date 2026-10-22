'use strict';

// Messaggi di tutti i canali: abbinamento ai clienti, mittenti ignorati, conversazioni.
// Ogni messaggio ha contact_type (email | instagram | facebook) e counterpart_address (valore normalizzato):
// è la coppia usata per riconoscere il cliente tra i suoi contatti.
const { normalizeEmail, normalizeContact } = require('./normalize');

// Indirizzi email automatici che non sono mai clienti.
const AUTOMATIC = /^(no-?reply|do-?not-?reply|noreply|notifications?|notifiche|mailer-daemon|postmaster|bounces?|automated|alerts?)([+.\-_].*)?@/i;

const SOURCE_LABEL = {
  gmail: 'Email',
  messenger: 'Messenger',
  instagram: 'Instagram DM',
  facebook_comment: 'Commento Facebook',
  instagram_comment: 'Commento Instagram',
};

function patternFor(type, value) {
  return type === 'email' ? normalizeEmail(value) : `${type}:${value}`;
}

function isIgnored(db, address, type = 'email') {
  if (type !== 'email') {
    return Boolean(db.prepare('SELECT 1 FROM ignored_senders WHERE pattern = ?').get(patternFor(type, address)));
  }
  const a = normalizeEmail(address);
  if (!a || AUTOMATIC.test(a)) return true;
  const domain = a.slice(a.indexOf('@'));
  return Boolean(db.prepare('SELECT 1 FROM ignored_senders WHERE pattern IN (?, ?)').get(a, domain));
}

// Ignora un mittente. Per le email si può ignorare l'intero dominio (scope = 'dominio').
function ignoreSender(db, { type = 'email', value, scope } = {}) {
  let pattern;
  if (type === 'email') {
    const a = normalizeEmail(value);
    if (!a.includes('@')) throw new Error('Indirizzo non valido');
    pattern = scope === 'dominio' ? a.slice(a.indexOf('@')) : a;
  } else {
    if (!value) throw new Error('Mittente non valido');
    pattern = patternFor(type, value);
  }
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO ignored_senders (pattern) VALUES (?)').run(pattern);
    // Toglie i messaggi non collegati a nessun cliente che corrispondono.
    if (type === 'email' && pattern.startsWith('@')) {
      db.prepare(`DELETE FROM messages WHERE customer_id IS NULL AND contact_type = 'email' AND counterpart_address LIKE ?`).run(`%${pattern}`);
    } else {
      db.prepare('DELETE FROM messages WHERE customer_id IS NULL AND contact_type = ? AND counterpart_address = ?').run(type, value);
    }
  })();
  return pattern;
}

function customerForAddress(db, type, value) {
  if (value === undefined) { value = type; type = 'email'; }
  const normalized = normalizeContact(type, value);
  return db.prepare('SELECT customer_id FROM contacts WHERE type = ? AND value_normalized = ?')
    .pluck().get(type, normalized) ?? null;
}

// Collega ai clienti tutti i messaggi non collegati il cui mittente è ora tra i contatti.
function linkUnmatched(db) {
  return db.prepare(`
    UPDATE messages SET customer_id = (
      SELECT k.customer_id FROM contacts k
      WHERE k.type = messages.contact_type AND k.value_normalized = messages.counterpart_address)
    WHERE customer_id IS NULL AND EXISTS (
      SELECT 1 FROM contacts k
      WHERE k.type = messages.contact_type AND k.value_normalized = messages.counterpart_address)`).run().changes;
}

// Conversazioni (thread) con ultimo messaggio, ordinate per attività recente.
function conversations(db, { customerId, sinceIso, onlyToAnswer = false, source, limit = 200 } = {}) {
  const where = [];
  const params = {};
  if (customerId) { where.push('o.customer_id = @customerId'); params.customerId = customerId; }
  if (sinceIso) { where.push('last.sent_at >= @since'); params.since = sinceIso; }
  if (onlyToAnswer) where.push(`last.direction = 'in'`);
  if (source) { where.push('last.source = @source'); params.source = source; }
  params.limit = limit;
  return db.prepare(`
    WITH ranked AS (
      SELECT m.*, ROW_NUMBER() OVER (PARTITION BY thread_key ORDER BY sent_at DESC, id DESC) AS rn,
             COUNT(*) OVER (PARTITION BY thread_key) AS n
      FROM messages m
    ),
    last AS (SELECT * FROM ranked WHERE rn = 1),
    -- Il cliente della conversazione: quello di un qualsiasi messaggio collegato del thread.
    owner AS (SELECT thread_key, MAX(customer_id) AS customer_id FROM messages GROUP BY thread_key),
    -- Chi scrive: il mittente dell'ultimo messaggio ricevuto nel thread.
    who AS (
      SELECT thread_key, contact_type, counterpart_address, counterpart_name FROM (
        SELECT thread_key, contact_type, counterpart_address, counterpart_name,
               ROW_NUMBER() OVER (PARTITION BY thread_key ORDER BY direction = 'in' DESC, sent_at DESC) AS r
        FROM messages) WHERE r = 1
    )
    SELECT last.thread_key, last.source, last.kind, last.account, last.subject, last.snippet, last.sent_at,
           last.direction, last.link, last.n,
           w.contact_type, w.counterpart_address, w.counterpart_name,
           o.customer_id, c.name AS customer_name, c.brand AS customer_brand
    FROM last
    JOIN owner o ON o.thread_key = last.thread_key
    JOIN who w ON w.thread_key = last.thread_key
    LEFT JOIN customers c ON c.id = o.customer_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY last.sent_at DESC
    LIMIT @limit`).all(params);
}

// Mittenti con messaggi non collegati, raggruppati, con eventuale cliente omonimo suggerito.
function unlinkedSenders(db) {
  const rows = db.prepare(`
    SELECT contact_type AS type, counterpart_address AS address,
           MAX(counterpart_name) AS name, COUNT(*) AS n, MAX(sent_at) AS last_at,
           MAX(CASE WHEN lower(coalesce(account, '')) LIKE '%artis%' THEN 1 ELSE 0 END) AS deartis_hint,
           (SELECT source FROM messages m2 WHERE m2.contact_type = m.contact_type AND m2.counterpart_address = m.counterpart_address
              AND m2.customer_id IS NULL AND m2.direction = 'in' ORDER BY sent_at DESC LIMIT 1) AS last_source,
           (SELECT subject FROM messages m2 WHERE m2.contact_type = m.contact_type AND m2.counterpart_address = m.counterpart_address
              AND m2.customer_id IS NULL AND m2.direction = 'in' ORDER BY sent_at DESC LIMIT 1) AS last_subject,
           (SELECT snippet FROM messages m2 WHERE m2.contact_type = m.contact_type AND m2.counterpart_address = m.counterpart_address
              AND m2.customer_id IS NULL AND m2.direction = 'in' ORDER BY sent_at DESC LIMIT 1) AS last_snippet
    FROM messages m WHERE customer_id IS NULL AND direction = 'in'
    GROUP BY contact_type, counterpart_address ORDER BY last_at DESC`).all();
  const similar = db.prepare(`SELECT id, name FROM customers WHERE name LIKE ? COLLATE NOCASE LIMIT 3`);
  for (const r of rows) {
    const nm = String(r.name || '').trim();
    r.suggestions = nm.length >= 4 ? similar.all(`%${nm}%`) : [];
  }
  return rows;
}

// Etichetta leggibile di un mittente.
function displayAddress(type, value) {
  if (type === 'instagram') return '@' + value;
  if (type === 'facebook') return 'Facebook';
  return value;
}

module.exports = {
  isIgnored, ignoreSender, customerForAddress, linkUnmatched, conversations, unlinkedSenders,
  displayAddress, AUTOMATIC, SOURCE_LABEL,
};
