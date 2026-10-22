'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Carica .env se presente (Node >= 20.12), senza dipendenze.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const express = require('express');
const { openDatabase, resolveDataDir } = require('./lib/db');
const C = require('./lib/customers');
const { syncVir3d, getState } = require('./lib/sync-vir3d');
const vir3d = require('./lib/vir3d');
const { getSetting, setSetting, vir3dConfig } = require('./lib/settings');
const { syncGmail, gmailConfig, testConnection } = require('./lib/sync-gmail');
const { syncMeta, metaConfig, testConnection: testMeta } = require('./lib/sync-meta');
const M = require('./lib/messages');
const { normalizeEmail } = require('./lib/normalize');

const PORT = Number(process.env.PORT) || 3210;
const DATA_DIR = resolveDataDir(process.env.DATA_DIR);
const db = openDatabase(DATA_DIR);

const BRAND_LABEL = { vir3d: 'Vir3D', deartis: 'De Artis', entrambi: 'Entrambi' };
const TYPE_LABEL = { email: 'Email', phone: 'Telefono', instagram: 'Instagram', facebook: 'Facebook' };

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use('/static', express.static(path.join(__dirname, 'public')));
app.locals.BRAND_LABEL = BRAND_LABEL;
app.locals.TYPE_LABEL = TYPE_LABEL;
app.locals.BRANDS = C.BRANDS;
app.locals.CONTACT_TYPES = C.CONTACT_TYPES;
app.locals.STATUS_LABEL = {
  pending: 'In attesa', confirmed: 'Confermato', in_production: 'In produzione', quality_check: 'Controllo qualità',
  ready_to_ship: 'Pronto da spedire', shipped: 'Spedito', in_transit: 'In transito', delivered: 'Consegnato',
  cancelled: 'Annullato',
};
app.locals.money = (minor, currency = 'EUR') =>
  new Intl.NumberFormat('it-IT', { style: 'currency', currency }).format((minor || 0) / 100);
app.locals.when = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') || iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z');
  return isNaN(d) ? iso : d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short' });
};

app.locals.SOURCE_LABEL = M.SOURCE_LABEL;
app.locals.displayAddress = M.displayAddress;
app.locals.OPEN_LABEL = { gmail: 'Apri in Gmail', messenger: 'Apri in Meta', instagram: 'Apri in Meta',
  facebook_comment: 'Apri il commento', instagram_comment: 'Apri il post' };

function syncInfo() {
  const gstate = db.prepare(`SELECT * FROM sync_state WHERE source = 'gmail'`).get() || {};
  const mstate = db.prepare(`SELECT * FROM sync_state WHERE source = 'meta'`).get() || {};
  return {
    state: getState(db),
    gstate,
    configured: Boolean(vir3dConfig(db).key),
    gmailConfigured: Boolean(gmailConfig(db).user && gmailConfig(db).pass),
    mstate,
    metaConfigured: Boolean(metaConfig(db).token),
    reviewOpen: db.prepare('SELECT COUNT(*) FROM review_items WHERE resolved_at IS NULL').pluck().get(),
    unlinked: db.prepare(`SELECT COUNT(*) FROM (SELECT 1 FROM messages WHERE customer_id IS NULL AND direction = 'in'
                          GROUP BY contact_type, counterpart_address)`).pluck().get(),
  };
}
app.use((req, res, next) => { res.locals.nav = syncInfo(); next(); });

// ARRIVI: conversazioni recenti di tutti i canali + ordini recenti.
app.get('/', (req, res) => {
  const tab = req.query.tab === 'tutti' ? 'tutti' : 'rispondere';
  const sinceIso = new Date(Date.now() - 30 * 86400000).toISOString();
  const source = Object.keys(M.SOURCE_LABEL).includes(req.query.canale) ? req.query.canale : undefined;
  const threads = M.conversations(db, { sinceIso, onlyToAnswer: tab === 'rispondere', source });
  const toAnswer = M.conversations(db, { sinceIso, onlyToAnswer: true }).length;
  const recentOrders = db.prepare(`
    SELECT o.*, c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
    WHERE o.created_at >= ? ORDER BY o.created_at DESC LIMIT 20`).all(new Date(Date.now() - 7 * 86400000).toISOString());
  res.render('arrivals', { tab, source, threads, toAnswer, recentOrders, sync: syncInfo(), flash: req.query.sync ?? null });
});

app.get('/clienti', (req, res) => {
  const q = String(req.query.q ?? '');
  const brand = String(req.query.brand ?? '');
  const customers = C.searchCustomers(db, q, { brand });
  const total = db.prepare('SELECT COUNT(*) FROM customers').pluck().get();
  res.render('index', { q, brand, customers, total, sync: syncInfo(), flash: null });
});

// Aggiorna tutti i canali collegati, uno dopo l'altro.
async function syncAll() {
  const parts = [];
  if (vir3dConfig(db).key) {
    const r = await syncVir3d(db, { cfg: vir3dConfig(db), log: console.log });
    parts.push(r.skipped ? 'Ordini: già in corso' : r.ok ? `Ordini: ${r.nuovi} nuovi, ${r.aggiornati} aggiornati` : `Errore ordini: ${r.error}`);
  }
  M.linkUnmatched(db);
  const g = gmailConfig(db);
  if (g.user && g.pass) {
    const r = await syncGmail(db, { cfg: g, log: console.log });
    parts.push(r.skipped ? 'Email: già in corso' : r.ok ? `Email: ${r.nuovi} nuove` : `Errore email: ${r.error}`);
  }
  const mc = metaConfig(db);
  if (mc.token) {
    const r = await syncMeta(db, { cfg: mc, log: console.log });
    parts.push(r.skipped ? 'Facebook/Instagram: già in corso'
      : r.ok ? `Facebook/Instagram: ${r.nuovi} nuovi${r.warnings.length ? ` (${r.warnings.length} avvisi in Impostazioni)` : ''}`
        : `Errore Facebook/Instagram: ${r.error}`);
  }
  if (!parts.length) parts.push('Errore: nessun canale collegato. Vai in Impostazioni.');
  return parts.join(' · ');
}
for (const route of ['/sync', '/sync/vir3d']) {
  app.post(route, async (req, res) => res.redirect('/?sync=' + encodeURIComponent(await syncAll())));
}

// DA COLLEGARE: mittenti email non ancora abbinati a un cliente.
app.get('/da-collegare', (req, res) => {
  const customers = db.prepare(`
    SELECT c.id, c.name, (SELECT GROUP_CONCAT(value_normalized, ', ') FROM contacts k WHERE k.customer_id = c.id AND k.type = 'email') AS emails
    FROM customers c ORDER BY c.name COLLATE NOCASE`).all();
  res.render('unlinked', { senders: M.unlinkedSenders(db), customers, error: req.query.err ?? null, BRANDS: C.BRANDS });
});

const SENDER_TYPES = ['email', 'instagram', 'facebook'];
function senderFrom(body) {
  const type = SENDER_TYPES.includes(body.type) ? body.type : 'email';
  const value = type === 'email' ? normalizeEmail(body.address) : String(body.address ?? '').trim();
  return { type, value };
}

app.post('/da-collegare/collega', (req, res) => {
  const { type, value } = senderFrom(req.body);
  const raw = String(req.body.customer_id ?? '');
  const target = Number((raw.match(/#(\d+)\)?\s*$/) || raw.match(/^\s*(\d+)\s*$/) || [])[1]);
  try {
    if (!C.getCustomer(db, target)) throw new C.UserError(`Scegli un cliente dall'elenco (non trovato: "${raw}").`);
    C.addContact(db, target, type, value);
    M.linkUnmatched(db);
    res.redirect('/da-collegare');
  } catch (err) {
    if (!(err instanceof C.UserError)) throw err;
    res.redirect('/da-collegare?err=' + encodeURIComponent(err.message));
  }
});

app.post('/da-collegare/crea', (req, res) => {
  const { type, value } = senderFrom(req.body);
  try {
    const name = String(req.body.name || '').trim() || M.displayAddress(type, value);
    const id = db.transaction(() => {
      const newId = C.createCustomer(db, { name, brand: req.body.brand, email: type === 'email' ? value : '' });
      if (type !== 'email') C.addContact(db, newId, type, value);
      return newId;
    })();
    M.linkUnmatched(db);
    res.redirect(req.body.open ? `/customers/${id}` : '/da-collegare');
  } catch (err) {
    if (!(err instanceof C.UserError)) throw err;
    res.redirect('/da-collegare?err=' + encodeURIComponent(err.message));
  }
});

app.post('/da-collegare/ignora', (req, res) => {
  const { type, value } = senderFrom(req.body);
  M.ignoreSender(db, { type, value, scope: req.body.scope });
  res.redirect('/da-collegare');
});

app.get('/impostazioni', (req, res) => {
  const cfg = vir3dConfig(db);
  const g = gmailConfig(db);
  const ignored = db.prepare('SELECT pattern FROM ignored_senders ORDER BY pattern').pluck().all();
  res.render('settings', {
    hasKey: Boolean(cfg.key), keyTail: cfg.key ? cfg.key.slice(-4) : '',
    gmailUser: g.user, gmailHasPass: Boolean(g.pass), gmailDays: g.days, ignored,
    metaHasToken: Boolean(metaConfig(db).token),
    metaPages: JSON.parse(getSetting(db, 'meta_pages') || '[]'),
    metaWarnings: JSON.parse(getSetting(db, 'meta_warnings') || '[]'),
    msg: req.query.msg ?? null, ok: req.query.ok === '1',
  });
});

app.post('/impostazioni/vir3d', async (req, res) => {
  const key = String(req.body.key ?? '').trim();
  if (key) setSetting(db, 'vir3d_api_key', key);
  try {
    await vir3d.health(vir3dConfig(db));
    res.redirect('/impostazioni?ok=1&msg=' + encodeURIComponent('Collegamento a vir3d.it riuscito. Ora vai su Arrivi e premi "Aggiorna".'));
  } catch (err) {
    res.redirect('/impostazioni?msg=' + encodeURIComponent(err.message));
  }
});

app.post('/impostazioni/gmail', async (req, res) => {
  const user = normalizeEmail(req.body.user);
  const pass = String(req.body.pass ?? '').replace(/\s+/g, '');
  const days = Math.min(Math.max(Number(req.body.days) || 90, 7), 730);
  if (user) setSetting(db, 'gmail_user', user);
  if (pass) setSetting(db, 'gmail_app_password', pass);
  setSetting(db, 'gmail_days', String(days));
  try {
    const info = await testConnection(gmailConfig(db));
    res.redirect('/impostazioni?ok=1&msg=' + encodeURIComponent(
      `Gmail collegato in sola lettura (${info.exists} messaggi in "${info.path}"). Ora vai su Arrivi e premi "Aggiorna": la prima volta può richiedere qualche minuto.`));
  } catch (err) {
    res.redirect('/impostazioni?msg=' + encodeURIComponent(err.message));
  }
});

app.post('/impostazioni/meta', async (req, res) => {
  const token = String(req.body.token ?? '').replace(/\s+/g, '');
  if (token) setSetting(db, 'meta_token', token);
  try {
    const pages = await testMeta(metaConfig(db));
    setSetting(db, 'meta_pages', JSON.stringify(pages));
    const names = pages.map((p) => p.name + (p.instagram ? ` (Instagram @${p.instagram})` : ' (senza Instagram)')).join(', ');
    res.redirect('/impostazioni?ok=1&msg=' + encodeURIComponent(
      `Facebook e Instagram collegati in lettura: ${names}. Ora vai su Arrivi e premi "Aggiorna".`));
  } catch (err) {
    res.redirect('/impostazioni?msg=' + encodeURIComponent(err.message));
  }
});

app.post('/impostazioni/ignorati/rimuovi', (req, res) => {
  db.prepare('DELETE FROM ignored_senders WHERE pattern = ?').run(String(req.body.pattern ?? ''));
  res.redirect('/impostazioni');
});

app.get('/verifica', (req, res) => {
  const items = db.prepare(`
    SELECT r.*, c.name AS customer_name FROM review_items r LEFT JOIN customers c ON c.id = r.customer_id
    WHERE r.resolved_at IS NULL ORDER BY r.created_at DESC`).all();
  res.render('review', { items });
});

app.post('/verifica/:id/risolto', (req, res) => {
  db.prepare(`UPDATE review_items SET resolved_at = datetime('now') WHERE id = ?`).run(Number(req.params.id));
  res.redirect('/verifica');
});

app.get('/customers/new', (req, res) => {
  res.render('new', { error: null, form: { brand: 'vir3d' } });
});

app.post('/customers', (req, res) => {
  try {
    const id = C.createCustomer(db, req.body);
    M.linkUnmatched(db);
    res.redirect(`/customers/${id}`);
  } catch (err) {
    if (!(err instanceof C.UserError)) throw err;
    res.status(400).render('new', { error: err.message, form: req.body });
  }
});

function renderCustomer(res, id, extra = {}) {
  const customer = C.getCustomer(db, id);
  if (!customer) return res.status(404).render('notfound');
  const orders = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC').all(id);
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid');
  for (const o of orders) o.items = itemsStmt.all(o.id);
  const reviews = db.prepare('SELECT * FROM review_items WHERE customer_id = ? AND resolved_at IS NULL').all(id);
  const threads = M.conversations(db, { customerId: id, limit: 100 });
  res.status(extra.error ? 400 : 200).render('customer', {
    customer, orders, reviews, threads, error: null, saved: false, contactForm: { type: 'email', value: '' }, ...extra,
  });
}

// Sposta un ordine su un altro cliente (correzione manuale di un abbinamento).
app.post('/orders/:id/move', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).render('notfound');
  const target = Number(String(req.body.customer_id ?? '').replace('#', ''));
  if (!C.getCustomer(db, target)) {
    return renderCustomer(res, order.customer_id, { error: `Cliente #${req.body.customer_id} inesistente.` });
  }
  db.prepare(`UPDATE orders SET customer_id = ?, match_reason = 'manuale' WHERE id = ?`).run(target, order.id);
  res.redirect(`/customers/${target}`);
});

app.get('/customers/:id', (req, res) => renderCustomer(res, Number(req.params.id), { saved: req.query.saved === '1' }));

app.post('/customers/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!C.getCustomer(db, id)) return res.status(404).render('notfound');
  try {
    C.updateCustomer(db, id, req.body);
    res.redirect(`/customers/${id}?saved=1`);
  } catch (err) {
    if (!(err instanceof C.UserError)) throw err;
    renderCustomer(res, id, { error: err.message });
  }
});

app.post('/customers/:id/contacts', (req, res) => {
  const id = Number(req.params.id);
  try {
    C.addContact(db, id, req.body.type, req.body.value);
    M.linkUnmatched(db);
    res.redirect(`/customers/${id}`);
  } catch (err) {
    if (!(err instanceof C.UserError)) throw err;
    renderCustomer(res, id, { error: err.message, contactForm: req.body });
  }
});

app.post('/customers/:id/contacts/:contactId/delete', (req, res) => {
  const id = Number(req.params.id);
  C.removeContact(db, id, Number(req.params.contactId));
  res.redirect(`/customers/${id}`);
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).send('Errore interno: controlla il terminale dove gira FormaOps.');
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[app] FormaOps pronto su http://localhost:${PORT}`);
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
