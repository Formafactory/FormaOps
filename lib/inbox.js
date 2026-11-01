'use strict';

// Relationship Intelligence e Inbox con stati. Solo regole fisse, nessuna AI:
// - relazione: scelta a mano se c'è, altrimenti De Artis = B2B, con ordini = Cliente, altrimenti Lead;
// - stato: chiusa / rimandata / in attesa messi a mano valgono finché il cliente non riscrive;
//   altrimenti ultimo messaggio del cliente = da rispondere, ultimo messaggio tuo = in attesa;
// - urgenza: DM e commenti dopo 4 ore, email dopo 24 ore (modificabili in Impostazioni);
// - in cima chi ha un ordine in corso, poi gli urgenti, poi chi aspetta da più tempo.
const { getSetting, setSetting } = require('./settings');

const RELATIONSHIPS = ['cliente', 'lead', 'b2b', 'fornitore', 'personale'];
const RELATIONSHIP_LABEL = {
  cliente: 'Cliente', lead: 'Lead', b2b: 'B2B', fornitore: 'Fornitore', personale: 'Personale', sconosciuto: 'Non collegato',
};
const STATUS = ['da_rispondere', 'in_attesa', 'rimandata', 'chiusa'];
const STATUS_LABEL = { da_rispondere: 'Da rispondere', in_attesa: 'In attesa', rimandata: 'Rimandata', chiusa: 'Chiusa' };
const VIEWS = ['rispondere', 'attesa', 'rimandate', 'chiuse', 'tutte', 'personale'];

// Canali "chat": risposta attesa in poche ore. Le email hanno una soglia più lunga.
const CHAT_SOURCES = new Set(['messenger', 'instagram', 'facebook_comment', 'instagram_comment', 'whatsapp']);
// Ordine in corso: non consegnato né annullato, creato negli ultimi 90 giorni.
const CLOSED_ORDER = `('delivered', 'cancelled')`;
const OPEN_ORDER_DAYS = 90;
const WINDOW_DAYS = 30;
const HOUR = 3600000;

// Espressione SQL della relazione automatica (c = customers).
const AUTO_RELATIONSHIP_SQL = `CASE
  WHEN c.id IS NULL THEN 'sconosciuto'
  WHEN c.brand = 'deartis' THEN 'b2b'
  WHEN EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status <> 'cancelled') THEN 'cliente'
  ELSE 'lead' END`;

function urgencyHours(db) {
  const n = (k, d) => { const v = Number(getSetting(db, k)); return v > 0 ? v : d; };
  return { chat: n('urgent_hours_chat', 4), email: n('urgent_hours_email', 24) };
}

function setUrgencyHours(db, { chat, email }) {
  const clamp = (v, d) => String(Math.min(Math.max(Math.round(Number(v)) || d, 1), 720));
  setSetting(db, 'urgent_hours_chat', clamp(chat, 4));
  setSetting(db, 'urgent_hours_email', clamp(email, 24));
}

// --- Relazione --------------------------------------------------------------------------

function relationship(db, customerId) {
  const r = db.prepare(`SELECT c.relationship AS manual, ${AUTO_RELATIONSHIP_SQL} AS auto FROM customers c WHERE c.id = ?`).get(customerId);
  if (!r) return null;
  return { value: r.manual || r.auto, manual: r.manual, auto: r.auto };
}

// value vuoto = torna automatica.
function setRelationship(db, customerId, value) {
  const v = value ? String(value) : null;
  if (v && !RELATIONSHIPS.includes(v)) throw new Error('Relazione non valida');
  db.prepare(`UPDATE customers SET relationship = ?, updated_at = datetime('now') WHERE id = ?`).run(v, customerId);
}

// --- Conversazioni ----------------------------------------------------------------------

function loadThreads(db, { customerId, threadKey, now = Date.now() } = {}) {
  const where = [];
  const params = {};
  if (customerId) { where.push('t.customer_id = @customerId'); params.customerId = customerId; }
  if (threadKey) { where.push('t.thread_key = @threadKey'); params.threadKey = threadKey; }
  params.openSince = new Date(now - OPEN_ORDER_DAYS * 86400000).toISOString();
  return db.prepare(`
    WITH t AS (
      SELECT thread_key, MAX(sent_at) AS last_at,
             MAX(CASE WHEN direction = 'out' THEN sent_at END) AS last_out,
             MAX(CASE WHEN direction = 'in' THEN sent_at END) AS last_in,
             MAX(customer_id) AS customer_id, COUNT(*) AS n
      FROM messages GROUP BY thread_key
    ),
    w AS (
      SELECT m.thread_key, MIN(m.sent_at) AS waiting_since, COUNT(*) AS unanswered
      FROM messages m JOIN t ON t.thread_key = m.thread_key
      WHERE m.direction = 'in' AND m.sent_at > COALESCE(t.last_out, '')
      GROUP BY m.thread_key
    ),
    last AS (
      SELECT * FROM (SELECT m.*, ROW_NUMBER() OVER (PARTITION BY thread_key ORDER BY sent_at DESC, id DESC) AS rn FROM messages m)
      WHERE rn = 1
    ),
    who AS (
      SELECT thread_key, contact_type, counterpart_address, counterpart_name FROM (
        SELECT thread_key, contact_type, counterpart_address, counterpart_name,
               ROW_NUMBER() OVER (PARTITION BY thread_key ORDER BY direction = 'in' DESC, sent_at DESC) AS r
        FROM messages) WHERE r = 1
    )
    SELECT t.thread_key, t.last_at, t.last_in, t.last_out, t.n, t.customer_id,
           w.waiting_since, COALESCE(w.unanswered, 0) AS unanswered,
           last.source, last.kind, last.account, last.subject, last.snippet, last.direction, last.link, last.brand,
           who.contact_type, who.counterpart_address, who.counterpart_name,
           c.name AS customer_name, c.brand AS customer_brand,
           COALESCE(c.relationship, ${AUTO_RELATIONSHIP_SQL}) AS relationship,
           s.status AS manual_status, s.snooze_until, s.seen_last_in,
           (SELECT o.order_number FROM orders o WHERE o.customer_id = c.id AND o.status NOT IN ${CLOSED_ORDER}
              AND COALESCE(o.created_at, o.updated_at) >= @openSince ORDER BY o.created_at DESC LIMIT 1) AS open_order,
           (SELECT o.status FROM orders o WHERE o.customer_id = c.id AND o.status NOT IN ${CLOSED_ORDER}
              AND COALESCE(o.created_at, o.updated_at) >= @openSince ORDER BY o.created_at DESC LIMIT 1) AS open_order_status
    FROM t
    JOIN last ON last.thread_key = t.thread_key
    JOIN who ON who.thread_key = t.thread_key
    LEFT JOIN w ON w.thread_key = t.thread_key
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN thread_state s ON s.thread_key = t.thread_key
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).all(params);
}

// Stato effettivo e urgenza di una conversazione (funzione pura: facile da testare).
function evaluate(t, { now = Date.now(), hours = { chat: 4, email: 24 } } = {}) {
  let status = t.direction === 'in' ? 'da_rispondere' : 'in_attesa';
  const customerWroteAgain = (t.last_in || '') > (t.seen_last_in || '');
  if (t.manual_status && !customerWroteAgain) {
    const snoozeOver = t.manual_status === 'rimandata' && (!t.snooze_until || Date.parse(t.snooze_until) <= now);
    if (!snoozeOver) status = t.manual_status;
  }
  const chat = CHAT_SOURCES.has(t.source);
  const limit = chat ? hours.chat : hours.email;
  const waitedHours = status === 'da_rispondere' && t.waiting_since ? (now - Date.parse(t.waiting_since)) / HOUR : 0;
  const urgent = status === 'da_rispondere' && waitedHours >= limit;
  return { ...t, status, chat, limit, waited_hours: waitedHours, urgent, has_open_order: Boolean(t.open_order) };
}

// Priorità per "Da rispondere": ordine in corso, poi urgenti, poi chi aspetta da più tempo.
function byPriority(a, b) {
  if (a.has_open_order !== b.has_open_order) return a.has_open_order ? -1 : 1;
  if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
  return String(a.waiting_since || a.last_at).localeCompare(String(b.waiting_since || b.last_at));
}
const byRecent = (a, b) => String(b.last_at).localeCompare(String(a.last_at));

function inbox(db, { view = 'rispondere', source, relationship: rel, brand, now = Date.now() } = {}) {
  const hours = urgencyHours(db);
  const since = new Date(now - WINDOW_DAYS * 86400000).toISOString();
  const all = loadThreads(db, { now })
    .filter((t) => !brand || t.brand === brand)
    .map((t) => evaluate(t, { now, hours }))
    // Le rimandate restano visibili anche oltre la finestra dei 30 giorni.
    .filter((t) => t.last_at >= since || t.status === 'rimandata');
  const work = all.filter((t) => t.relationship !== 'personale');
  const counts = {
    rispondere: work.filter((t) => t.status === 'da_rispondere').length,
    urgenti: work.filter((t) => t.urgent).length,
    attesa: work.filter((t) => t.status === 'in_attesa').length,
    rimandate: work.filter((t) => t.status === 'rimandata').length,
    chiuse: work.filter((t) => t.status === 'chiusa').length,
    tutte: work.length,
    personale: all.filter((t) => t.relationship === 'personale').length,
    personale_rispondere: all.filter((t) => t.relationship === 'personale' && t.status === 'da_rispondere').length,
  };
  let list;
  switch (view) {
    case 'attesa': list = work.filter((t) => t.status === 'in_attesa').sort(byRecent); break;
    case 'rimandate': list = work.filter((t) => t.status === 'rimandata')
      .sort((a, b) => String(a.snooze_until).localeCompare(String(b.snooze_until))); break;
    case 'chiuse': list = work.filter((t) => t.status === 'chiusa').sort(byRecent); break;
    case 'tutte': list = work.slice().sort(byRecent); break;
    case 'personale': list = all.filter((t) => t.relationship === 'personale').sort(byRecent); break;
    default: list = work.filter((t) => t.status === 'da_rispondere').sort(byPriority);
  }
  if (source) list = list.filter((t) => t.source === source);
  if (rel) list = list.filter((t) => t.relationship === rel);
  return { threads: list.slice(0, 300), counts, hours };
}

// --- Regia ---------------------------------------------------------------------------
// "Per te": tutte le conversazioni che aspettano una tua risposta, ognuna con il motivo.
// Oggi, senza AI, sono tutte le da rispondere; quando l'AI gestirà i casi semplici resteranno qui
// solo quelle che le regole lasciano a te.
// "Il flusso": tutto il resto che si è mosso nelle ultime 48 ore (risposte, attese, chiusure) e i nuovi ordini.

const COMPLAINT = /\b(rott[oaie]|danneggiat[oaie]|rovinat[oaie]|reclamo|rimborso|difettos[oaie]|sbagliat[oaie]|non (è |e' |mi è )?(ancora )?arrivat[oaie]|mai arrivat[oaie]|in ritardo)\b/i;

function reasonFor(t) {
  const text = `${t.subject || ''} ${t.snippet || ''}`;
  if (t.relationship === 'personale') return { kind: 'personale', label: 'Contatto personale' };
  if (t.direction === 'in' && COMPLAINT.test(text)) return { kind: 'reclamo', label: 'Possibile reclamo' };
  if (t.relationship === 'b2b') return { kind: 'b2b', label: 'Cliente B2B' };
  if (t.open_order) return { kind: 'ordine', label: `Ordine in corso: ${t.open_order}` };
  if (t.unanswered >= 2) return { kind: 'sollecito', label: `Ha scritto ${t.unanswered} volte senza risposta` };
  if (t.relationship === 'fornitore') return { kind: 'fornitore', label: 'Fornitore' };
  if (t.relationship === 'sconosciuto') return { kind: 'nuovo', label: 'Nuovo contatto' };
  if (t.relationship === 'cliente') return { kind: 'cliente', label: 'Cliente' };
  return { kind: 'lead', label: 'Richiesta di informazioni' };
}

const FLOW_HOURS = 48;
const FLOW_LABEL = {
  in_attesa: 'Hai risposto', in_attesa_manuale: 'Risposto altrove', rimandata: 'Rimandata', chiusa: 'Chiusa', ordine: 'Nuovo ordine',
};

function regia(db, { brand = 'vir3d', show = 'recenti', now = Date.now() } = {}) {
  const hours = urgencyHours(db);
  const threads = loadThreads(db, { now })
    .filter((t) => t.brand === brand)
    .map((t) => evaluate(t, { now, hours }));
  const perTe = threads.filter((t) => t.status === 'da_rispondere')
    .map((t) => ({ ...t, reason: reasonFor(t) }))
    .sort(byPriority);

  const flowSince = new Date(now - FLOW_HOURS * 3600000).toISOString();
  let flowThreads;
  if (show === 'rimandate') flowThreads = threads.filter((t) => t.status === 'rimandata');
  else if (show === 'chiuse') flowThreads = threads.filter((t) => t.status === 'chiusa');
  else flowThreads = threads.filter((t) => t.status !== 'da_rispondere' && t.last_at >= flowSince);
  const flow = flowThreads.map((t) => ({
    type: 'conversazione', at: t.last_at, thread: t,
    state: t.status === 'in_attesa' && t.manual_status === 'in_attesa' ? 'in_attesa_manuale' : t.status,
  }));
  // Nuovi ordini: solo nello spazio Vir3D (gli ordini arrivano da vir3d.it).
  if (brand === 'vir3d' && show === 'recenti') {
    const orders = db.prepare(`
      SELECT o.id, o.order_number, o.created_at, o.status, o.total_minor, o.currency, o.customer_id,
             COALESCE(c.name, o.customer_name) AS name
      FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.created_at >= ? ORDER BY o.created_at DESC`).all(flowSince);
    for (const o of orders) flow.push({ type: 'ordine', at: o.created_at, order: o, state: 'ordine' });
  }
  flow.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const todayIso = dayStart.toISOString();
  const stats = {
    today: threads.filter((t) => (t.last_in || '') >= todayIso).length,
    perTe: perTe.length,
    urgent: perTe.filter((t) => t.urgent).length,
    rimandate: threads.filter((t) => t.status === 'rimandata').length,
    chiuse: threads.filter((t) => t.status === 'chiusa').length,
  };
  return { perTe, flow: flow.slice(0, 60), stats, hours };
}

function perTeCount(db, brand, now = Date.now()) {
  const hours = urgencyHours(db);
  const list = loadThreads(db, { now }).filter((t) => t.brand === brand).map((t) => evaluate(t, { now, hours }))
    .filter((t) => t.status === 'da_rispondere');
  return { n: list.length, urgent: list.filter((t) => t.urgent).length };
}

function customerThreads(db, customerId, { now = Date.now() } = {}) {
  const hours = urgencyHours(db);
  return loadThreads(db, { customerId, now }).map((t) => evaluate(t, { now, hours })).sort(byRecent);
}

function thread(db, threadKey, { now = Date.now() } = {}) {
  const t = loadThreads(db, { threadKey, now })[0];
  if (!t) return null;
  const out = evaluate(t, { now, hours: urgencyHours(db) });
  out.messages = db.prepare(`SELECT * FROM messages WHERE thread_key = ? ORDER BY sent_at, id`).all(threadKey);
  return out;
}

// Azioni manuali: chiudi, rimanda (giorni), attesa (risposto altrove), riapri.
function setThreadState(db, threadKey, action, { days = 1, now = Date.now() } = {}) {
  const lastIn = db.prepare(`SELECT MAX(sent_at) FROM messages WHERE thread_key = ? AND direction = 'in'`).pluck().get(threadKey);
  if (!db.prepare('SELECT 1 FROM messages WHERE thread_key = ?').get(threadKey)) throw new Error('Conversazione inesistente');
  if (action === 'riapri') {
    db.prepare('DELETE FROM thread_state WHERE thread_key = ?').run(threadKey);
    return null;
  }
  const status = { chiudi: 'chiusa', rimanda: 'rimandata', attesa: 'in_attesa' }[action];
  if (!status) throw new Error('Azione non valida');
  let until = null;
  if (status === 'rimandata') {
    const d = Math.min(Math.max(Number(days) || 1, 1), 60);
    // Torna alle 8:00 (ora di Roma, circa) del giorno scelto.
    const target = new Date(now + d * 86400000);
    target.setUTCHours(7, 0, 0, 0);
    until = target.toISOString();
  }
  db.prepare(`INSERT INTO thread_state (thread_key, status, snooze_until, seen_last_in, set_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(thread_key) DO UPDATE SET status = excluded.status, snooze_until = excluded.snooze_until,
                seen_last_in = excluded.seen_last_in, set_at = excluded.set_at`)
    .run(threadKey, status, until, lastIn, new Date(now).toISOString());
  return status;
}

// --- Customer 360 -----------------------------------------------------------------------

function customerSummary(db, customerId) {
  const openSince = new Date(Date.now() - OPEN_ORDER_DAYS * 86400000).toISOString();
  const s = db.prepare(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total_minor), 0) AS spent_minor, MAX(currency) AS currency,
           MIN(created_at) AS first_order, MAX(created_at) AS last_order
    FROM orders WHERE customer_id = ? AND status <> 'cancelled'`).get(customerId);
  s.open_orders = db.prepare(`
    SELECT order_number, status, created_at FROM orders
    WHERE customer_id = ? AND status NOT IN ${CLOSED_ORDER} AND COALESCE(created_at, updated_at) >= ?
    ORDER BY created_at DESC`).all(customerId, openSince);
  const m = db.prepare(`SELECT MIN(sent_at) AS first_msg, MAX(sent_at) AS last_msg, GROUP_CONCAT(DISTINCT source) AS sources
                        FROM messages WHERE customer_id = ?`).get(customerId);
  s.first_contact = [m.first_msg, s.first_order].filter(Boolean).sort()[0] || null;
  s.last_contact = [m.last_msg, s.last_order].filter(Boolean).sort().pop() || null;
  s.sources = m.sources ? m.sources.split(',') : [];
  s.relationship = relationship(db, customerId);
  return s;
}

module.exports = {
  RELATIONSHIPS, RELATIONSHIP_LABEL, STATUS, STATUS_LABEL, VIEWS, CHAT_SOURCES,
  urgencyHours, setUrgencyHours, relationship, setRelationship,
  evaluate, inbox, regia, reasonFor, perTeCount, FLOW_LABEL, customerThreads, thread, setThreadState, customerSummary,
};
