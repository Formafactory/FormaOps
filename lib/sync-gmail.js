'use strict';

// Sincronizzazione Gmail -> FormaOps, in sola lettura.
// Cursore = ultimo UID salvato nella cartella "Tutti i messaggi" (+ UIDVALIDITY).
// Ogni gruppo di messaggi viene salvato in UNA transazione insieme al cursore.

const gmail = require('./gmail');
const { normalizeEmail } = require('./normalize');
const { isIgnored, customerForAddress, linkUnmatched } = require('./messages');
const { getSetting } = require('./settings');

const SOURCE = 'gmail';
const BATCH = 25;
let running = false;

function gmailConfig(db, env = process.env) {
  return {
    user: getSetting(db, 'gmail_user') || env.GMAIL_USER || '',
    pass: getSetting(db, 'gmail_app_password') || env.GMAIL_APP_PASSWORD || '',
    days: Number(getSetting(db, 'gmail_days') || env.GMAIL_DAYS || 90),
    login: env.GMAIL_IMAP_LOGIN || undefined,
    host: env.GMAIL_IMAP_HOST || undefined,
    port: env.GMAIL_IMAP_PORT ? Number(env.GMAIL_IMAP_PORT) : undefined,
    secure: env.GMAIL_IMAP_SECURE === 'false' ? false : undefined,
    skipCategories: env.GMAIL_SKIP_CATEGORIES !== 'false',
  };
}

function readCursor(db) {
  const raw = db.prepare('SELECT cursor FROM sync_state WHERE source = ?').pluck().get(SOURCE);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function gmailLink(user, m) {
  const auth = `authuser=${encodeURIComponent(user)}`;
  if (m.threadId && /^\d+$/.test(m.threadId)) return `https://mail.google.com/mail/?${auth}#all/${BigInt(m.threadId).toString(16)}`;
  if (m.messageId) return `https://mail.google.com/mail/?${auth}#search/${encodeURIComponent('rfc822msgid:' + m.messageId.replace(/[<>]/g, ''))}`;
  return null;
}

// Trasforma un messaggio IMAP in una riga di "messages", o null se va saltato.
function toRow(db, cfg, uidValidity, m) {
  const own = normalizeEmail(cfg.user);
  const from = normalizeEmail(m.from[0]?.address);
  let direction;
  let other;
  if (from && from === own) {
    direction = 'out';
    other = m.to.find((a) => normalizeEmail(a.address) && normalizeEmail(a.address) !== own);
  } else {
    direction = 'in';
    other = m.from[0];
  }
  const address = normalizeEmail(other?.address);
  if (!address || isIgnored(db, address)) return null;
  const id = `${SOURCE}:${m.emailId || m.messageId || `${uidValidity}:${m.uid}`}`;
  return {
    id,
    source: SOURCE,
    thread_key: `${SOURCE}:${m.threadId || id}`,
    direction,
    counterpart_address: address,
    counterpart_name: other?.name || null,
    subject: m.subject,
    snippet: m.snippet,
    sent_at: m.date,
    link: gmailLink(cfg.user, m),
    customer_id: customerForAddress(db, address),
  };
}

function saveBatch(db, rows, cursor) {
  const insert = db.prepare(`
    INSERT INTO messages (id, source, thread_key, direction, counterpart_address, counterpart_name, subject, snippet, sent_at, link, customer_id)
    VALUES (@id, @source, @thread_key, @direction, @counterpart_address, @counterpart_name, @subject, @snippet, @sent_at, @link, @customer_id)
    ON CONFLICT(id) DO NOTHING`);
  const touch = db.prepare(`UPDATE customers SET updated_at = datetime('now') WHERE id = ?`);
  let added = 0;
  db.transaction(() => {
    for (const r of rows) {
      const ch = insert.run(r).changes;
      added += ch;
      if (ch && r.customer_id) touch.run(r.customer_id);
    }
    db.prepare(`INSERT INTO sync_state (source, cursor) VALUES (?, ?)
                ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor`).run(SOURCE, JSON.stringify(cursor));
  })();
  return added;
}

async function testConnection(cfg) {
  const s = await gmail.openAllMail(cfg);
  const info = { path: s.path, exists: s.client.mailbox.exists };
  await gmail.close(s);
  return info;
}

async function syncGmail(db, { cfg = gmailConfig(db), log = () => {}, now = new Date() } = {}) {
  if (running) return { skipped: true, reason: 'Sincronizzazione Gmail già in corso' };
  running = true;
  db.prepare(`INSERT INTO sync_state (source, last_run_at) VALUES (?, ?)
              ON CONFLICT(source) DO UPDATE SET last_run_at = excluded.last_run_at`).run(SOURCE, now.toISOString());
  const totals = { letti: 0, nuovi: 0, saltati: 0 };
  let session;
  try {
    session = await gmail.openAllMail(cfg);
    let cursor = readCursor(db);
    if (!cursor || cursor.uidValidity !== session.uidValidity) {
      cursor = { uidValidity: session.uidValidity, lastUid: 0 };
    }
    const since = new Date(now.getTime() - cfg.days * 86400000);
    const uids = await gmail.findUids(session, { afterUid: cursor.lastUid, since, skipCategories: cfg.skipCategories });
    log(`[gmail] messaggi da leggere: ${uids.length}`);
    for (let i = 0; i < uids.length; i += BATCH) {
      const chunk = uids.slice(i, i + BATCH);
      const msgs = await gmail.readMessages(session, chunk);
      const rows = msgs.map((m) => toRow(db, cfg, session.uidValidity, m)).filter(Boolean);
      totals.letti += msgs.length;
      totals.saltati += msgs.length - rows.length;
      totals.nuovi += saveBatch(db, rows, { uidValidity: session.uidValidity, lastUid: chunk.at(-1) });
      log(`[gmail] ${Math.min(i + BATCH, uids.length)}/${uids.length}`);
    }
    if (!uids.length) saveBatch(db, [], cursor);
    linkUnmatched(db);
    db.prepare(`UPDATE sync_state SET last_ok_at = ?, last_error = NULL, last_imported = ? WHERE source = ?`)
      .run(new Date().toISOString(), totals.nuovi, SOURCE);
    return { ok: true, ...totals };
  } catch (err) {
    const msg = err instanceof gmail.GmailError ? err.message : `Errore Gmail: ${err.message}`;
    db.prepare('UPDATE sync_state SET last_error = ? WHERE source = ?').run(msg, SOURCE);
    return { ok: false, error: msg, ...totals };
  } finally {
    if (session) await gmail.close(session);
    running = false;
  }
}

module.exports = { syncGmail, gmailConfig, testConnection, SOURCE };
