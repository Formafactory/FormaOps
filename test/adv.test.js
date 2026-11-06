'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const Database = require('better-sqlite3');
const { migrate } = require('../lib/db');
const adv = require('../lib/adv');
const { nextDailyRun, createDailyScheduler } = require('../lib/scheduler');
const { startFakeMetaAds, loadFixtures, TOKEN, ACCOUNT } = require('../test-support/fake-meta-ads');

const NOW = new Date('2026-11-05T09:00:00.000Z'); // 10:00 a Roma
const clockAt = (d) => () => new Date(d);

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, path.join(__dirname, '..', 'migrations'), () => {});
  return db;
}
const one = (db, sql, ...a) => db.prepare(sql).pluck().get(...a);
const row = (db, sql, ...a) => db.prepare(sql).get(...a);

async function setup(t, data) {
  const fake = await startFakeMetaAds(data);
  t.after(() => fake.close());
  const logs = [];
  const run = (db, opts = {}) => adv.syncAdv(db, { cfg: fake.cfg, now: clockAt(NOW), log: (l) => logs.push(l), sleep: async () => {}, ...opts });
  return { fake, db: freshDb(), logs, run };
}

// --- Mappatura actions / action_values -------------------------------------------------

test('mappatura: actions e action_values in colonne leggibili, importi in centesimi, omni_* preferito', () => {
  const [r] = loadFixtures().insights;
  const m = adv.mapInsightRow(r, ACCOUNT, '2026-11-05T09:00:00.000Z');
  assert.deepEqual(m, {
    date: '2026-10-29', ad_id: 'ad1', account_id: ACCOUNT, campaign_id: 'c1', adset_id: 's1',
    spend_minor: 4061, impressions: 5210, reach: 4102, clicks: 88, link_clicks: 61, landing_page_views: 44,
    view_content: 39, add_to_cart: 6, initiate_checkout: 4,
    purchases: 3, purchase_value_minor: 17970, purchase_action_type: 'omni_purchase', purchase_roas: 4.425018,
    attribution_setting: '7d_click_1d_view', fetched_at: '2026-11-05T09:00:00.000Z',
  });
});

test('mappatura: solo il pixel -> si usa offsite_conversion.fb_pixel_purchase; senza azioni -> zeri', () => {
  const rows = loadFixtures().insights;
  const pixel = adv.mapInsightRow(rows[1], ACCOUNT, 'x');
  assert.equal(pixel.purchases, 1);
  assert.equal(pixel.purchase_value_minor, 5990);
  assert.equal(pixel.purchase_action_type, 'offsite_conversion.fb_pixel_purchase');
  assert.equal(pixel.purchase_roas, null);
  const none = adv.mapInsightRow(rows[2], ACCOUNT, 'x');
  assert.deepEqual([none.purchases, none.add_to_cart, none.initiate_checkout, none.purchase_value_minor, none.purchase_action_type],
    [0, 0, 0, 0, null]);
  assert.equal(none.spend_minor, 3800);
});

test('link di destinazione: link_data, video con pulsante, asset_feed_spec', () => {
  const [a1, a2, a4] = loadFixtures().ads;
  assert.equal(adv.creativeLink(a1.creative), 'https://vir3d.it/ambigrammi');
  assert.equal(adv.creativeLink(a2.creative), 'https://vir3d.it/?utm_source=meta');
  assert.equal(adv.creativeLink(a4.creative), 'https://vir3d.it/mezzibusti');
  assert.equal(adv.creativeLink({ id: 'x' }), null);
});

test('finestra di attribuzione in italiano', () => {
  assert.equal(adv.attributionLabel('7d_click_1d_view'), '7 giorni dal clic, 1 giorno dalla visualizzazione');
  assert.equal(adv.attributionLabel(adv.specToSetting(JSON.stringify(loadFixtures().adsets[0].attribution_spec))),
    '7 giorni dal clic, 1 giorno dalla visualizzazione, 1 giorno dalla visualizzazione coinvolta');
  // formato reale restituito da Meta per l'account (letto il 06/11/2026)
  assert.equal(adv.attributionLabel('1d_view_7d_click_1d_ev'),
    '7 giorni dal clic, 1 giorno dalla visualizzazione, 1 giorno dalla visualizzazione coinvolta');
  assert.equal(adv.attributionLabel('formato_nuovo'), 'formato_nuovo', 'formato sconosciuto: mostrato com\'è');
});

// --- Giro completo ----------------------------------------------------------------------

test('primo giro: 90 giorni nel fuso dell\'account, anagrafica, statistiche, risposte grezze, solo GET', async (t) => {
  const { fake, db, run } = await setup(t);
  const r = await run(db);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.since, r.until], ['2026-08-07', '2026-11-05']);
  assert.equal(r.rows, 7, 'la riga di luglio è fuori dai 90 giorni');
  assert.equal(one(db, 'SELECT COUNT(*) FROM adv_insights_daily'), 7);

  assert.ok(fake.state.requests.every((q) => q.method === 'GET'), 'solo richieste GET');
  assert.ok(fake.state.requests.some((q) => q.url.includes('use_unified_attribution_setting=true')));

  const acc = row(db, 'SELECT * FROM adv_accounts');
  assert.deepEqual([acc.id, acc.brand, acc.currency, acc.timezone_name], [ACCOUNT, 'vir3d', 'EUR', 'Europe/Rome']);

  // spesa e acquisti dal 29/10 al 04/11
  const sum = row(db, `SELECT SUM(spend_minor) AS spend, SUM(purchases) AS purchases FROM adv_insights_daily
                       WHERE date BETWEEN '2026-10-29' AND '2026-11-04'`);
  assert.deepEqual({ ...sum }, { spend: 17220, purchases: 7 });
  assert.equal(one(db, `SELECT attribution_setting FROM adv_insights_daily WHERE ad_id = 'ad1' AND date = '2026-10-29'`), '7d_click_1d_view');

  // anagrafica (paginata), con link e url_tags; l'inserzione archiviata arriva dalle statistiche
  assert.equal(one(db, 'SELECT COUNT(*) FROM adv_entities'), 9);
  const ad1 = row(db, `SELECT * FROM adv_entities WHERE id = 'ad1'`);
  assert.equal(ad1.link_url, 'https://vir3d.it/ambigrammi');
  assert.match(ad1.url_tags, /utm_content=\{\{ad\.id\}\}/);
  assert.deepEqual([ad1.parent_id, ad1.campaign_id, ad1.creative_id, ad1.from_insights_only], ['s1', 'c1', 'cr1', 0]);
  const ad3 = row(db, `SELECT * FROM adv_entities WHERE id = 'ad3'`);
  assert.deepEqual([ad3.name, ad3.parent_id, ad3.from_insights_only], ['Vecchia inserzione archiviata', 's3', 1]);
  assert.equal(one(db, `SELECT daily_budget FROM adv_entities WHERE id = 'c1'`), 3000);
  assert.match(one(db, `SELECT attribution_spec FROM adv_entities WHERE id = 's1'`), /ENGAGED_VIDEO_VIEW/);

  // risposte grezze salvate con endpoint e parametri
  const raws = db.prepare('SELECT endpoint, params FROM adv_raw_responses').all();
  assert.ok(raws.length >= 10);
  assert.ok(raws.some((x) => x.endpoint.endsWith(`${ACCOUNT}/insights`) && JSON.parse(x.params).level === 'ad'));

  const runRow = row(db, 'SELECT * FROM adv_sync_runs');
  assert.deepEqual([runRow.ok, runRow.rows_written, runRow.trigger, runRow.error], [1, 7, 'manuale', null]);
  assert.ok(runRow.finished_at);
});

test('il fuso è quello dell\'account: alle 03:00 UTC a Los Angeles è ancora il giorno prima', async (t) => {
  const data = loadFixtures();
  data.account.timezone_name = 'America/Los_Angeles';
  const { db, run } = await setup(t, data);
  const r = await run(db, { now: clockAt('2026-11-05T03:00:00.000Z') });
  assert.equal(r.until, '2026-11-04');
  assert.equal(one(db, 'SELECT timezone_name FROM adv_accounts'), 'America/Los_Angeles');
});

test('idempotenza: due giri di fila non cambiano il numero di righe; i giri successivi rileggono 7 giorni', async (t) => {
  const { fake, db, run } = await setup(t);
  await run(db);
  const before = one(db, 'SELECT COUNT(*) FROM adv_insights_daily');
  const r2 = await run(db);
  assert.equal(r2.ok, true, r2.error);
  assert.deepEqual([r2.since, r2.until], ['2026-10-29', '2026-11-05']);
  assert.equal(one(db, 'SELECT COUNT(*) FROM adv_insights_daily'), before);

  // Meta aggiorna una conversione a posteriori: la riga si aggiorna, non si duplica
  fake.state.data.insights[4].actions = [{ action_type: 'omni_purchase', value: '3' }];
  const r3 = await run(db);
  assert.equal(r3.ok, true);
  assert.equal(one(db, 'SELECT COUNT(*) FROM adv_insights_daily'), before);
  assert.equal(one(db, `SELECT purchases FROM adv_insights_daily WHERE ad_id = 'ad1' AND date = '2026-11-04'`), 3);
  assert.equal(one(db, 'SELECT COUNT(*) FROM adv_entities'), 9);
});

// --- Errori della chiave ----------------------------------------------------------------

test('chiave sbagliata: errore comprensibile registrato, nessun nuovo tentativo, nessuna eccezione', async (t) => {
  const { fake, db, run } = await setup(t);
  const r = await run(db, { cfg: { ...fake.cfg, token: 'chiave-finta-sbagliata-999' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /scaduta o non valida/);
  assert.equal(fake.state.requests.length, 1, 'errore definitivo: niente retry');
  const runRow = row(db, 'SELECT * FROM adv_sync_runs');
  assert.deepEqual([runRow.ok, runRow.rows_written], [0, 0]);
  assert.match(runRow.error, /scaduta o non valida/);
});

test('chiave vuota: nessuna chiamata a Meta, messaggio che dice cosa fare', async (t) => {
  const { fake, db, run } = await setup(t);
  const r = await run(db, { cfg: { ...fake.cfg, token: '' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /META_ADS_TOKEN/);
  assert.equal(fake.state.requests.length, 0);
  assert.equal(one(db, 'SELECT ok FROM adv_sync_runs'), 0);
  assert.match(adv.configError(adv.advConfig({ META_ADS_TOKEN: 'x', META_AD_ACCOUNT_ID: '' })), /META_AD_ACCOUNT_ID/);
  assert.equal(adv.advConfig({ META_ADS_TOKEN: 'x', META_AD_ACCOUNT_ID: '1095600805179325' }).accountId, ACCOUNT);
});

// --- Retry: massimo 3 tentativi -----------------------------------------------------------

test('retry: errore temporaneo due volte poi risposta -> riuscito, con attesa crescente', async (t) => {
  const { fake, db, run } = await setup(t);
  fake.state.failNext.push({ path: 'insights', error: { code: 17, message: 'User request limit reached' } }, { path: 'insights', drop: true });
  const waits = [];
  const r = await run(db, { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(waits, [1, 2]);
  assert.equal(one(db, 'SELECT COUNT(*) FROM adv_insights_daily'), 7);
});

test('retry: tre errori di fila -> si ferma dopo il terzo tentativo e registra l\'errore', async (t) => {
  const { fake, db, run } = await setup(t);
  const err = { code: 2, message: 'An unexpected error has occurred. Please retry your request later.' };
  fake.state.failNext.push({ path: 'insights', error: err }, { path: 'insights', error: err }, { path: 'insights', error: err }, { path: 'insights', error: err });
  const r = await run(db);
  assert.equal(r.ok, false);
  assert.match(r.error, /Meta non ha risposto/);
  assert.equal(fake.state.requests.filter((q) => q.path.endsWith('/insights')).length, 3);
  assert.equal(fake.state.requests.filter((q) => q.path.endsWith('/ads')).length, 0, 'dopo l\'errore si ferma');
  assert.equal(fake.state.failNext.length, 1);
  assert.equal(one(db, 'SELECT ok FROM adv_sync_runs'), 0);
});

// --- Segreti ------------------------------------------------------------------------------

test('il token non finisce mai in adv_raw_responses, adv_sync_runs o nei log (anche nei link di paginazione)', async (t) => {
  const { fake, db, run, logs } = await setup(t);
  fake.state.pageSize = 1; // tante pagine: ogni risposta ha un link "next" con il token dentro
  await run(db);
  fake.state.failNext.push({ path: 'insights', error: { code: 100, message: `Invalid parameter (access_token=${TOKEN})` } });
  const bad = await run(db);
  assert.equal(bad.ok, false);

  const raws = db.prepare('SELECT endpoint, params, body FROM adv_raw_responses').all();
  const paged = raws.filter((x) => x.body.includes('"next"'));
  assert.ok(paged.length > 0, 'ci sono risposte con link di paginazione');
  assert.ok(paged.every((x) => x.body.includes('access_token=[oscurato]')));
  const everything = [
    ...raws.flatMap((x) => [x.endpoint, x.params, x.body]),
    ...db.prepare('SELECT error FROM adv_sync_runs').pluck().all().map(String),
    ...logs, bad.error, bad.summary,
  ].join('\n');
  assert.equal(everything.includes(TOKEN), false);
  assert.match(bad.error, /access_token=\[oscurato\]/);
});

// --- Esecuzione notturna --------------------------------------------------------------------

test('orario notturno: le 05:00 di Roma con ora solare e legale', () => {
  const at = (iso) => nextDailyRun(new Date(iso), 5, 0, 'Europe/Rome').toISOString();
  assert.equal(at('2026-11-05T03:59:00Z'), '2026-11-05T04:00:00.000Z'); // CET: 05:00 = 04:00 UTC
  assert.equal(at('2026-11-05T04:00:00Z'), '2026-11-06T04:00:00.000Z'); // appena passato: il giorno dopo
  assert.equal(at('2026-07-01T02:00:00Z'), '2026-07-01T03:00:00.000Z'); // CEST: 05:00 = 03:00 UTC
  assert.equal(at('2026-10-24T12:00:00Z'), '2026-10-25T04:00:00.000Z'); // notte del cambio d'ora
  assert.equal(at('2026-03-28T12:00:00Z'), '2026-03-29T03:00:00.000Z');
});

test('giro notturno: lo scheduler scrive in adv_sync_runs un giro "notte" riuscito', async (t) => {
  const { db, run } = await setup(t);
  let now = new Date(NOW);
  const sched = createDailyScheduler({ hour: 5, minute: 0, timeZone: 'Europe/Rome', clock: () => now,
    run: async () => (await run(db, { trigger: 'notte', now: () => now })).summary });
  sched.start();
  t.after(() => sched.stop());
  assert.equal(sched.state.nextRunAt, '2026-11-06T04:00:00.000Z');
  assert.equal(await sched.check(), null, 'prima delle 05:00 non parte');
  now = new Date('2026-11-06T04:00:30.000Z');
  assert.match(await sched.check(), /righe giornaliere/);
  assert.equal(sched.state.nextRunAt, '2026-11-07T04:00:00.000Z');
  const r = row(db, 'SELECT trigger, ok FROM adv_sync_runs ORDER BY id DESC LIMIT 1');
  assert.deepEqual({ ...r }, { trigger: 'notte', ok: 1 });
});

// --- Pagina ADV -------------------------------------------------------------------------------

test('pagina: 30 giorni, totali, costo per acquisto, ROAS, filtri e inserzioni attive con UTM', async (t) => {
  const { db, run } = await setup(t);
  await run(db);
  const p = adv.advPage(db, { brand: 'vir3d', now: NOW });
  assert.equal(p.days.length, 30);
  assert.deepEqual([p.since, p.until], ['2026-10-07', '2026-11-05']);
  assert.equal(p.totals.spend, 17220 + 2500); // + inserzione archiviata del 10/10
  assert.equal(p.totals.purchases, 7);
  assert.equal(p.totals.value, 17970 + 5990 + 5990 + 11980);
  assert.equal(p.totals.cpa, Math.round(19720 / 7));
  assert.equal(p.days.find((d) => d.date === '2026-10-30').cpa, null);

  const onlyAd2 = adv.advPage(db, { brand: 'vir3d', ad: 'ad2', now: NOW });
  assert.deepEqual([onlyAd2.totals.spend, onlyAd2.totals.purchases], [1240, 1]);
  const c2 = adv.advPage(db, { brand: 'vir3d', campaign: 'c2', now: NOW });
  assert.equal(c2.totals.spend, 2500);
  assert.deepEqual(c2.ads.map((a) => a.id), ['ad3']);

  assert.deepEqual(p.activeAds.map((a) => [a.id, a.hasUtm, a.hasAdId]), [['ad1', true, true], ['ad2', true, false]]);
  assert.equal(p.attribution[0].label, '7 giorni dal clic, 1 giorno dalla visualizzazione');
  assert.equal(adv.advPage(db, { brand: 'deartis', now: NOW }).account, null, 'De Artis non ha ancora un account');
});

function renderAdv(locals) {
  const base = {
    brand: 'vir3d', SPACES: { vir3d: { label: 'Vir3D', color: '#000' }, deartis: { label: 'De Artis', color: '#000' } },
    nav: { perTe: { vir3d: { n: 0 }, deartis: { n: 0 } }, unlinked: 0, reviewOpen: 0, channels: [], advError: false },
    clock: (iso) => String(iso), when: (iso) => String(iso),
    money: (m, c = 'EUR') => new Intl.NumberFormat('it-IT', { style: 'currency', currency: c }).format((m || 0) / 100),
    campaign: '', ad: '', running: false, nextRunAt: '2026-11-06T04:00:00.000Z', configError: null,
  };
  return ejs.renderFile(path.join(__dirname, '..', 'views', 'adv.ejs'), { ...base, ...locals });
}

test('pagina con chiave sbagliata: mostra l\'errore in chiaro, senza bloccarsi', async (t) => {
  const { fake, db, run } = await setup(t);
  await run(db, { cfg: { ...fake.cfg, token: 'chiave-finta-sbagliata-999' } });
  const html = await renderAdv({ ...adv.advPage(db, { brand: 'vir3d', now: NOW }), nav: { perTe: { vir3d: { n: 0 }, deartis: { n: 0 } }, channels: [], advError: true } });
  assert.match(html, /Non riuscito/);
  assert.match(html, /scaduta o non valida/);
  assert.equal(html.includes('chiave-finta-sbagliata-999'), false);
});

test('pagina con dati: intestazione con la finestra di attribuzione e tabella', async (t) => {
  const { db, run } = await setup(t);
  await run(db);
  const html = await renderAdv(adv.advPage(db, { brand: 'vir3d', now: NOW }));
  assert.match(html, /Dati dichiarati da Meta \(finestra di attribuzione: 7 giorni dal clic, 1 giorno dalla visualizzazione\)/);
  assert.match(html, /Costo per acquisto/);
  assert.match(html, /utm_content=\{\{ad\.id\}\}/);
  assert.equal(html.includes(TOKEN), false);
});

// --- Solo GET ---------------------------------------------------------------------------------

test('lib/adv.js fa solo GET: nessun fetch diretto, nessun metodo di scrittura, solo meta.get', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'adv.js'), 'utf8')
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); // senza commenti
  assert.doesNotMatch(src, /\bfetch\s*\(/, 'nessuna chiamata HTTP diretta');
  assert.doesNotMatch(src, /\b(POST|PUT|PATCH|DELETE)\b/, 'nessun metodo di scrittura');
  assert.doesNotMatch(src, /method\s*:/, 'nessun metodo HTTP impostato a mano');
  assert.doesNotMatch(src, /require\(['"]node:(http|https|net)['"]\)/, 'nessun client HTTP alternativo');
  const used = [...src.matchAll(/\bmeta\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ['MetaError', 'config', 'get'], 'verso Meta si usa solo meta.get');
  // e meta.get, a sua volta, invia solo GET
  const metaSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'meta.js'), 'utf8');
  assert.deepEqual([...metaSrc.matchAll(/method:\s*'(\w+)'/g)].map((m) => m[1]), ['GET']);
});

// --- Recupero all'avvio ---------------------------------------------------------------------------

test('recupero all\'avvio: parte se l\'ultimo giro riuscito ha più di 24 ore, non parte se è recente', async (t) => {
  const { fake, db, run } = await setup(t);
  const opts = { cfg: fake.cfg, log: () => {}, sleep: async () => {} };

  // mai un giro riuscito: è il primo avvio (90 giorni)
  const first = await adv.startupCatchUp(db, { ...opts, now: clockAt(NOW) });
  assert.equal(first.ok, true, first && first.error);
  assert.equal(first.since, '2026-08-07');

  // 23 ore dopo: niente
  assert.equal(await adv.startupCatchUp(db, { ...opts, now: clockAt(new Date(NOW.getTime() + 23 * 3600000)) }), null);
  // un giro fallito non conta come riuscito
  await run(db, { cfg: { ...fake.cfg, token: 'chiave-finta-sbagliata-999' }, now: clockAt(new Date(NOW.getTime() + 30 * 3600000)) });
  // 30 ore dopo l'ultimo riuscito: recupero degli ultimi 7 giorni
  const later = new Date(NOW.getTime() + 30 * 3600000);
  const r = await adv.startupCatchUp(db, { ...opts, now: clockAt(later) });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.since, r.until], ['2026-10-30', '2026-11-06']);
  assert.deepEqual(db.prepare('SELECT trigger, ok FROM adv_sync_runs ORDER BY id').all().map((x) => `${x.trigger}:${x.ok}`),
    ['avvio:1', 'manuale:0', 'avvio:1']);

  // senza chiave non parte nulla
  assert.equal(await adv.startupCatchUp(db, { ...opts, cfg: { ...fake.cfg, token: '' }, now: clockAt(new Date(later.getTime() + 48 * 3600000)) }), null);
});

// --- Migrazione 010 su un database che ha già la 009 --------------------------------------------

test('migrazione 010: su un database con la 009 già applicata conserva i giri, accetta "avvio" e i legami', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const all = path.join(__dirname, '..', 'migrations');
  const upTo009 = fs.mkdtempSync(path.join(os.tmpdir(), 'formaops-mig-'));
  for (const f of fs.readdirSync(all).filter((x) => x <= '009_adv.sql')) fs.copyFileSync(path.join(all, f), path.join(upTo009, f));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, upTo009, () => {});
  db.prepare(`INSERT INTO adv_sync_runs (id, trigger, started_at, ok, error) VALUES (1, 'manuale', '2026-11-06T08:27:09.498Z', 0, 'Manca la chiave')`).run();
  db.prepare(`INSERT INTO adv_raw_responses (run_id, fetched_at, endpoint, params, body) VALUES (1, 'x', '/e', '{}', '{}')`).run();
  assert.throws(() => db.prepare(`INSERT INTO adv_sync_runs (trigger, started_at) VALUES ('avvio', 'x')`).run(), /CHECK/);

  migrate(db, all, () => {});
  assert.equal(one(db, `SELECT COUNT(*) FROM schema_migrations WHERE id = '010_adv_recupero_avvio'`), 1);
  assert.deepEqual({ ...row(db, 'SELECT id, trigger, ok, error FROM adv_sync_runs') }, { id: 1, trigger: 'manuale', ok: 0, error: 'Manca la chiave' });
  db.prepare(`INSERT INTO adv_sync_runs (trigger, started_at) VALUES ('avvio', 'x')`).run();
  assert.throws(() => db.prepare(`INSERT INTO adv_sync_runs (trigger, started_at) VALUES ('altro', 'x')`).run(), /CHECK/);
  assert.throws(() => db.prepare(`INSERT INTO adv_raw_responses (run_id, fetched_at, endpoint, params, body) VALUES (99, 'x', '/e', '{}', '{}')`).run(), /FOREIGN KEY/);
  assert.equal(one(db, 'SELECT COUNT(*) FROM adv_raw_responses'), 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  fs.rmSync(upTo009, { recursive: true, force: true });
});
