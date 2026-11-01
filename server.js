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
const { syncMeta, metaConfig, testConnection: testMeta, testInstagramToken } = require('./lib/sync-meta');
const M = require('./lib/messages');
const I = require('./lib/inbox');
const { normalizeEmail } = require('./lib/normalize');
const { runBackup, listBackups } = require('./lib/backup');
const { createScheduler } = require('./lib/scheduler');

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
app.locals.RELATIONSHIPS = I.RELATIONSHIPS;
app.locals.RELATIONSHIP_LABEL = I.RELATIONSHIP_LABEL;
app.locals.THREAD_STATUS_LABEL = I.STATUS_LABEL;
// Tempo di attesa leggibile: 35 min, 5 h, 3 g.
app.locals.waited = (hours) => {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.floor(hours)} h`;
  return `${Math.floor(hours / 24)} g`;
};
app.locals.SPACES = { vir3d: { label: 'Vir3D', color: '#b8892e' }, deartis: { label: 'De Artis', color: '#2d6f6a' } };
app.locals.FLOW_LABEL = I.FLOW_LABEL;
// "da 35 minuti", "da 5 ore", "da 3 giorni"
app.locals.waitedLong = (hours) => {
  if (hours < 1) { const m = Math.max(1, Math.round(hours * 60)); return `da ${m} ${m === 1 ? 'minuto' : 'minuti'}`; }
  if (hours < 48) { const h = Math.floor(hours); return `da ${h} ${h === 1 ? 'ora' : 'ore'}`; }
  return `da ${Math.floor(hours / 24)} giorni`;
};
// Ora se è oggi, altrimenti giorno e ora.
app.locals.clock = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const opt = { timeZone: 'Europe/Rome' };
  const same = d.toLocaleDateString('it-IT', opt) === new Date().toLocaleDateString('it-IT', opt);
  return same ? d.toLocaleTimeString('it-IT', { ...opt, hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('it-IT', { ...opt, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
app.locals.day = (iso) => (iso ? app.locals.when(iso).split(',')[0] : '—');

function syncInfo() {
  const state = (k) => db.prepare('SELECT * FROM sync_state WHERE source = ?').get(k) || {};
  return {
    state: getState(db),
    gstate: state('gmail'),
    gdstate: state('gmail_deartis'),
    mstate: state('meta'),
    configured: Boolean(vir3dConfig(db).key),
    gmailConfigured: Boolean(gmailConfig(db).user && gmailConfig(db).pass),
    gmailDeartisConfigured: Boolean(gmailConfig(db, process.env, 'deartis').user && gmailConfig(db, process.env, 'deartis').pass),
    metaConfigured: Boolean(metaConfig(db).token),
    reviewOpen: db.prepare('SELECT COUNT(*) FROM review_items WHERE resolved_at IS NULL').pluck().get(),
  };
}

// Canali di uno spazio, per l'elenco in fondo al menu.
function channelsFor(brand, si) {
  const st = (configured, s) => ({ state: !configured ? 'off' : s && s.last_error ? 'bad' : '', error: s && s.last_error });
  const pages = JSON.parse(getSetting(db, 'meta_pages') || '[]')
    .filter((p) => (/artis/i.test(p.name) ? 'deartis' : 'vir3d') === brand);
  const out = [];
  if (brand === 'vir3d') out.push({ label: si.configured ? 'Ordini vir3d.it' : 'Ordini vir3d.it, da collegare', ...st(si.configured, si.state) });
  const g = gmailConfig(db, process.env, brand);
  const gOk = brand === 'deartis' ? si.gmailDeartisConfigured : si.gmailConfigured;
  out.push({ label: gOk ? g.user : 'Email, da collegare', ...st(gOk, brand === 'deartis' ? si.gdstate : si.gstate) });
  if (pages.length) {
    for (const p of pages) {
      out.push({ label: `Facebook ${p.name}`, ...st(si.metaConfigured, si.mstate) });
      if (p.instagram) out.push({ label: `Instagram @${p.instagram}`, ...st(si.metaConfigured, si.mstate) });
    }
  } else {
    out.push({ label: 'Facebook e Instagram, da collegare', state: 'off' });
  }
  if (brand === 'vir3d') {
    const ig = Boolean(metaConfig(db).igToken);
    out.push({ label: ig ? 'DM Instagram' : 'DM Instagram, da collegare', state: ig ? '' : 'off' });
  }
  return out;
}

// Spazio attivo (Vir3D o De Artis), ricordato in un cookie.
function readBrand(req) {
  const m = /(?:^|;\s*)formaops_brand=(vir3d|deartis)/.exec(req.headers.cookie || '');
  return m ? m[1] : 'vir3d';
}
app.use((req, res, next) => {
  const brand = readBrand(req);
  const si = syncInfo();
  res.locals.brand = brand;
  res.locals.nav = {
    perTe: { vir3d: I.perTeCount(db, 'vir3d'), deartis: I.perTeCount(db, 'deartis') },
    unlinked: db.prepare(`SELECT COUNT(*) FROM (SELECT 1 FROM messages WHERE customer_id IS NULL AND direction = 'in' AND brand = ?
                          GROUP BY contact_type, counterpart_address)`).pluck().get(brand),
    reviewOpen: si.reviewOpen,
    channels: channelsFor(brand, si),
  };
  next();
});

app.get('/spazio/:brand', (req, res) => {
  const b = req.params.brand === 'deartis' ? 'deartis' : 'vir3d';
  res.setHeader('Set-Cookie', `formaops_brand=${b}; Path=/; Max-Age=31536000; SameSite=Lax`);
  res.redirect('/');
});

// REGIA: "Per te" (chi aspetta una tua risposta, con il motivo) e "Il flusso" (tutto il resto che si muove).
app.get('/', (req, res) => {
  const brand = res.locals.brand;
  const show = ['rimandate', 'chiuse', 'arretrate'].includes(req.query.mostra) ? req.query.mostra : 'recenti';
  const r = I.regia(db, { brand, show });
  const si = syncInfo();
  const errors = [];
  if (brand === 'vir3d' && si.state.last_error) errors.push(`Ordini: ${si.state.last_error}`);
  const gs = brand === 'deartis' ? si.gdstate : si.gstate;
  if (gs.last_error) errors.push(`Email: ${gs.last_error}`);
  if (si.mstate.last_error) errors.push(`Facebook e Instagram: ${si.mstate.last_error}`);
  const last = [brand === 'vir3d' ? si.state.last_ok_at : null, gs.last_ok_at, si.mstate.last_ok_at].filter(Boolean).sort().pop();
  const today = new Date().toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long' });
  res.render('regia', {
    ...r, show, errors, lastSync: last, today: today.charAt(0).toUpperCase() + today.slice(1),
    here: '/' + (show !== 'recenti' ? `?mostra=${show}` : ''),
    flash: req.query.sync ?? null, ok: req.query.ok ?? null,
  });
});

// Una conversazione: messaggi in ordine, scheda cliente in breve, azioni.
app.get('/conversazione', (req, res) => {
  const t = I.thread(db, String(req.query.k ?? ''));
  if (!t) return res.status(404).render('notfound');
  const summary = t.customer_id ? I.customerSummary(db, t.customer_id) : null;
  const back = safeBack(req.query.da, '/');
  const here = '/conversazione?k=' + encodeURIComponent(t.thread_key) + '&da=' + encodeURIComponent(back);
  res.render('thread', { t, summary, back, here, flash: req.query.ok ?? null });
});

function safeBack(url, fallback) {
  const u = String(url ?? '');
  return u.startsWith('/') && !u.startsWith('//') ? u : fallback;
}

const ACTION_DONE = { chiudi: 'Conversazione chiusa.', rimanda: 'Conversazione rimandata.', attesa: 'Segnata come risposta: in attesa del cliente.', riapri: 'Conversazione riaperta.' };
app.post('/conversazioni/chiudi-arretrate', (req, res) => {
  const n = I.closeArretrate(db, res.locals.brand);
  res.redirect('/?mostra=chiuse&ok=' + encodeURIComponent(`${n} conversazioni arretrate chiuse. Se qualcuno riscrive, torna in "Per te".`));
});

app.post('/conversazioni/stato', (req, res) => {
  // Una scheda di "Per te" può raggruppare più conversazioni della stessa persona: l'azione vale per tutte.
  const keys = [].concat(req.body.k ?? []).map(String).filter(Boolean);
  const action = String(req.body.azione ?? '');
  try {
    if (!keys.length) throw new Error('Conversazione mancante');
    db.transaction(() => { for (const key of keys) I.setThreadState(db, key, action, { days: req.body.giorni }); })();
  } catch (err) {
    return res.status(400).send(err.message);
  }
  const back = safeBack(req.body.da, '/');
  const sep = back.includes('?') ? '&' : '?';
  res.redirect(back + sep + 'ok=' + encodeURIComponent(ACTION_DONE[action] || 'Fatto.'));
});

app.get('/clienti', (req, res) => {
  const q = String(req.query.q ?? '');
  const brand = res.locals.brand;
  const rel = I.RELATIONSHIPS.includes(req.query.relazione) ? req.query.relazione : '';
  // Clienti dello spazio attivo (quelli segnati "entrambi" compaiono in tutti e due).
  let customers = C.searchCustomers(db, q).filter((c) => c.brand === brand || c.brand === 'entrambi');
  for (const c of customers) c.relationship = I.relationship(db, c.id).value;
  if (rel) customers = customers.filter((c) => c.relationship === rel);
  const total = db.prepare(`SELECT COUNT(*) FROM customers WHERE brand IN (?, 'entrambi')`).pluck().get(brand);
  res.render('index', { q, rel, customers, total });
});

// Aggiorna tutti i canali collegati, uno dopo l'altro.
async function syncAll() {
  const parts = [];
  if (vir3dConfig(db).key) {
    const r = await syncVir3d(db, { cfg: vir3dConfig(db), log: console.log });
    parts.push(r.skipped ? 'Ordini: già in corso' : r.ok ? `Ordini: ${r.nuovi} nuovi, ${r.aggiornati} aggiornati` : `Errore ordini: ${r.error}`);
  }
  M.linkUnmatched(db);
  for (const b of ['vir3d', 'deartis']) {
    const g = gmailConfig(db, process.env, b);
    if (!g.user || !g.pass) continue;
    const label = b === 'deartis' ? 'Email De Artis' : 'Email Vir3D';
    const r = await syncGmail(db, { cfg: g, log: console.log });
    parts.push(r.skipped ? `${label}: già in corso` : r.ok ? `${label}: ${r.nuovi} nuove` : `Errore ${label.toLowerCase()}: ${r.error}`);
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
// Backup: cartella scelta in Impostazioni (es. Google Drive), altrimenti DATA_DIR/backup. Uno al giorno.
function backupDir() { return getSetting(db, 'backup_dir') || path.join(DATA_DIR, 'backup'); }
async function backupIfDue(force = false) {
  const last = getSetting(db, 'backup_last_at');
  if (!force && last && Date.now() - Date.parse(last) < 20 * 3600 * 1000) return null;
  try {
    const r = await runBackup(db, backupDir());
    setSetting(db, 'backup_last_at', new Date().toISOString());
    setSetting(db, 'backup_last_error', '');
    console.log(`[backup] ${r.file}`);
    return r;
  } catch (err) {
    setSetting(db, 'backup_last_error', err.message);
    console.error(`[backup] errore: ${err.message}`);
    return null;
  }
}

// Aggiornamento automatico: ogni N minuti (Impostazioni), più il backup quotidiano.
const scheduler = createScheduler({
  minutes: Number(getSetting(db, 'auto_minutes') ?? 15),
  firstDelayMs: 30000,
  log: console.log,
  run: async () => { const r = await syncAll(); await backupIfDue(); return r; },
});
app.locals.scheduler = scheduler.state;

for (const route of ['/sync', '/sync/vir3d']) {
  app.post(route, async (req, res) => {
    if (scheduler.isRunning()) return res.redirect('/?sync=' + encodeURIComponent('Aggiornamento automatico già in corso: ricarica tra qualche minuto.'));
    res.redirect('/?sync=' + encodeURIComponent(await scheduler.runNow()));
  });
}

app.post('/impostazioni/automatico', (req, res) => {
  const m = Math.min(Math.max(Number(req.body.minutes) || 0, 0), 240);
  setSetting(db, 'auto_minutes', String(m));
  scheduler.setMinutes(m);
  const dir = String(req.body.backup_dir ?? '').trim();
  setSetting(db, 'backup_dir', dir);
  setSetting(db, 'meta_ig_dm', req.body.ig_dm ? '1' : '0');
  res.redirect('/impostazioni?ok=1&msg=' + encodeURIComponent(m ? `Aggiornamento automatico ogni ${m} minuti.` : 'Aggiornamento automatico spento.'));
});

app.post('/impostazioni/backup', async (req, res) => {
  const r = await backupIfDue(true);
  res.redirect('/impostazioni?' + (r ? 'ok=1&msg=' + encodeURIComponent(`Backup salvato: ${r.file}`)
    : 'msg=' + encodeURIComponent(`Backup non riuscito: ${getSetting(db, 'backup_last_error')}`)));
});

// DA COLLEGARE: mittenti email non ancora abbinati a un cliente.
app.get('/da-collegare', (req, res) => {
  const customers = db.prepare(`
    SELECT c.id, c.name, (SELECT GROUP_CONCAT(value_normalized, ', ') FROM contacts k WHERE k.customer_id = c.id AND k.type = 'email') AS emails
    FROM customers c ORDER BY c.name COLLATE NOCASE`).all();
  res.render('unlinked', { senders: M.unlinkedSenders(db, { brand: res.locals.brand }), customers, error: req.query.err ?? null, BRANDS: C.BRANDS });
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
  const gd = gmailConfig(db, process.env, 'deartis');
  const ignored = db.prepare('SELECT pattern FROM ignored_senders ORDER BY pattern').pluck().all();
  res.render('settings', {
    hasKey: Boolean(cfg.key), keyTail: cfg.key ? cfg.key.slice(-4) : '',
    gmailUser: g.user, gmailHasPass: Boolean(g.pass), gmailDays: g.days, ignored,
    gdUser: gd.user, gdHasPass: Boolean(gd.pass), gdDays: gd.days,
    metaHasToken: Boolean(metaConfig(db).token),
    metaDays: metaConfig(db).days,
    igDm: metaConfig(db).igDm,
    igHasToken: Boolean(metaConfig(db).igToken),
    igUsername: getSetting(db, 'ig_username') || '',
    igRefreshed: getSetting(db, 'ig_token_refreshed_at'),
    autoMinutes: scheduler.state.minutes,
    backupDirSetting: getSetting(db, 'backup_dir') || '',
    backupDirEffective: backupDir(),
    backupLast: getSetting(db, 'backup_last_at'),
    backupError: getSetting(db, 'backup_last_error'),
    backupCount: listBackups(backupDir()).length,
    metaPages: JSON.parse(getSetting(db, 'meta_pages') || '[]'),
    metaWarnings: JSON.parse(getSetting(db, 'meta_warnings') || '[]'),
    urgency: I.urgencyHours(db),
    perTeDays: I.perTeDays(db),
    msg: req.query.msg ?? null, ok: req.query.ok === '1',
  });
});

app.post('/impostazioni/vir3d', async (req, res) => {
  const key = String(req.body.key ?? '').trim();
  if (key) setSetting(db, 'vir3d_api_key', key);
  try {
    await vir3d.health(vir3dConfig(db));
    res.redirect('/impostazioni?ok=1&msg=' + encodeURIComponent('Collegamento a vir3d.it riuscito. Ora vai sulla Regia e premi "Aggiorna".'));
  } catch (err) {
    res.redirect('/impostazioni?msg=' + encodeURIComponent(err.message));
  }
});

app.post('/impostazioni/gmail', async (req, res) => {
  const brand = req.body.brand === 'deartis' ? 'deartis' : 'vir3d';
  const k = brand === 'deartis' ? 'gmail_deartis' : 'gmail';
  const user = normalizeEmail(req.body.user);
  const pass = String(req.body.pass ?? '').replace(/\s+/g, '');
  const days = Math.min(Math.max(Number(req.body.days) || 90, 7), 730);
  if (brand === 'deartis' && user && user === normalizeEmail(getSetting(db, 'gmail_user') || '')) {
    return res.redirect('/impostazioni?msg=' + encodeURIComponent('Questa è già la casella di Vir3D: per De Artis serve un indirizzo diverso.'));
  }
  if (user) setSetting(db, `${k}_user`, user);
  if (pass) setSetting(db, `${k}_app_password`, pass);
  setSetting(db, `${k}_days`, String(days));
  try {
    const info = await testConnection(gmailConfig(db, process.env, brand));
    res.redirect('/impostazioni?ok=1&msg=' + encodeURIComponent(
      `Gmail collegato in sola lettura (${info.exists} messaggi in "${info.path}"). Ora vai sulla Regia e premi "Aggiorna": la prima volta può richiedere qualche minuto.`));
  } catch (err) {
    res.redirect('/impostazioni?msg=' + encodeURIComponent(err.message));
  }
});

app.post('/impostazioni/meta', async (req, res) => {
  const token = String(req.body.token ?? '').replace(/\s+/g, '');
  if (token) setSetting(db, 'meta_token', token);
  if (req.body.days) setSetting(db, 'meta_days', String(Math.min(Math.max(Number(req.body.days) || 7, 1), 90)));
  try {
    const pages = await testMeta(metaConfig(db));
    setSetting(db, 'meta_pages', JSON.stringify(pages));
    const names = pages.map((p) => p.name + (p.instagram ? ` (Instagram @${p.instagram})` : ' (senza Instagram)')).join(', ');
    res.redirect('/impostazioni?ok=1&msg=' + encodeURIComponent(
      `Facebook e Instagram collegati in lettura: ${names}. Ora vai sulla Regia e premi "Aggiorna".`));
  } catch (err) {
    res.redirect('/impostazioni?msg=' + encodeURIComponent(err.message));
  }
});

app.post('/impostazioni/instagram', async (req, res) => {
  const token = String(req.body.token ?? '').replace(/\s+/g, '');
  if (req.body.remove) {
    setSetting(db, 'ig_token', '');
    return res.redirect('/impostazioni?ok=1&msg=' + encodeURIComponent('Chiave Instagram rimossa.'));
  }
  if (token) { setSetting(db, 'ig_token', token); setSetting(db, 'ig_token_refreshed_at', new Date().toISOString()); }
  try {
    const me = await testInstagramToken(metaConfig(db));
    setSetting(db, 'ig_username', me.username);
    res.redirect('/impostazioni?ok=1&msg=' + encodeURIComponent(
      `DM Instagram collegati in lettura: @${me.username}. Arriveranno al prossimo aggiornamento.`));
  } catch (err) {
    const msg = err.fatal ? 'Instagram ha rifiutato la chiave: è scaduta o non valida. Rigenerala (guida, passo 2).' : `Instagram: ${err.message}`;
    res.redirect('/impostazioni?msg=' + encodeURIComponent(msg));
  }
});

app.post('/impostazioni/urgenza', (req, res) => {
  I.setUrgencyHours(db, { chat: req.body.chat, email: req.body.email });
  if (req.body.giorni) I.setPerTeDays(db, req.body.giorni);
  const h = I.urgencyHours(db);
  res.redirect('/impostazioni?ok=1&msg=' + encodeURIComponent(
    `"Per te" mostra gli ultimi ${I.perTeDays(db)} giorni. Urgenza: messaggi e commenti dopo ${h.chat} ore, email dopo ${h.email} ore.`));
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
  res.render('new', { error: null, form: { brand: res.locals.brand } });
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
  const threads = I.customerThreads(db, id);
  const summary = I.customerSummary(db, id);
  res.status(extra.error ? 400 : 200).render('customer', {
    customer, orders, reviews, threads, summary, error: null, saved: false, contactForm: { type: 'email', value: '' }, ...extra,
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

app.post('/customers/:id/relazione', (req, res) => {
  const id = Number(req.params.id);
  if (!C.getCustomer(db, id)) return res.status(404).render('notfound');
  const v = String(req.body.relazione ?? '');
  if (v && !I.RELATIONSHIPS.includes(v)) return res.status(400).send('Relazione non valida');
  I.setRelationship(db, id, v);
  res.redirect(safeBack(req.body.da, `/customers/${id}?saved=1`));
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
  const m = scheduler.state.minutes;
  console.log(m ? `[auto] aggiornamento automatico ogni ${m} minuti (il primo tra 30 secondi)` : '[auto] aggiornamento automatico spento');
  scheduler.start();
});

function shutdown() {
  scheduler.stop();
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
