'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Carica .env se presente (Node >= 20.12), senza dipendenze.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const express = require('express');
const { openDatabase, resolveDataDir } = require('./lib/db');
const C = require('./lib/customers');

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

app.get('/', (req, res) => {
  const q = String(req.query.q ?? '');
  const brand = String(req.query.brand ?? '');
  const customers = C.searchCustomers(db, q, { brand });
  const total = db.prepare('SELECT COUNT(*) FROM customers').pluck().get();
  res.render('index', { q, brand, customers, total });
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
  res.status(extra.error ? 400 : 200).render('customer', {
    customer, error: null, saved: false, contactForm: { type: 'email', value: '' }, ...extra,
  });
}

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
