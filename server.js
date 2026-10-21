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

function syncInfo() {
  return {
    state: getState(db),
    configured: Boolean(vir3d.config().key),
    reviewOpen: db.prepare('SELECT COUNT(*) FROM review_items WHERE resolved_at IS NULL').pluck().get(),
  };
}

app.get('/', (req, res) => {
  const q = String(req.query.q ?? '');
  const brand = String(req.query.brand ?? '');
  const customers = C.searchCustomers(db, q, { brand });
  const total = db.prepare('SELECT COUNT(*) FROM customers').pluck().get();
  res.render('index', { q, brand, customers, total, sync: syncInfo(), flash: req.query.sync ?? null });
});

app.post('/sync/vir3d', async (req, res) => {
  const r = await syncVir3d(db, { log: console.log });
  const msg = r.skipped ? 'Sincronizzazione già in corso.'
    : r.ok ? `Ordini Vir3D aggiornati: ${r.nuovi} nuovi, ${r.aggiornati} aggiornati, ${r.clientiNuovi} clienti nuovi.`
      : `Errore: ${r.error}`;
  res.redirect('/?sync=' + encodeURIComponent(msg));
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
  res.status(extra.error ? 400 : 200).render('customer', {
    customer, orders, reviews, error: null, saved: false, contactForm: { type: 'email', value: '' }, ...extra,
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
