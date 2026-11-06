'use strict';

// Modulo ADV, blocco 1: raccolta dei dati Meta Ads in SOLA LETTURA.
// Solo richieste GET con il permesso ads_read: nessuna campagna, inserzione o impostazione viene
// creata, modificata o attivata. Il token sta solo in .env e non finisce mai in log, database o pagine.

const meta = require('./meta');
const { zonedParts } = require('./scheduler');

const MAX_ATTEMPTS = 3;                 // massimo 3 tentativi, poi l'errore si registra e ci si ferma
const FIRST_RUN_DAYS = 90;              // primo avvio: ultimi 90 giorni
const NIGHTLY_DAYS = 7;                 // poi: ultimi 7 giorni (Meta aggiorna le conversioni a posteriori)
const CHUNK_DAYS = 7;                   // statistiche chieste a blocchi di 7 giorni: risposte piccole
const ACCOUNT_BRAND = 'vir3d';          // l'account di META_AD_ACCOUNT_ID appartiene allo spazio Vir3D

// Azioni Meta lette da "actions"/"action_values": la prima presente nell'elenco vince.
// omni_* è il totale che mostra Gestione inserzioni (sito + app + offline); gli altri sono di riserva.
const ACTIONS = {
  landing_page_views: ['landing_page_view', 'omni_landing_page_view'],
  view_content: ['omni_view_content', 'view_content', 'offsite_conversion.fb_pixel_view_content'],
  add_to_cart: ['omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'],
  initiate_checkout: ['omni_initiated_checkout', 'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'],
  purchases: ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'],
};

const INSIGHT_FIELDS = [
  'date_start', 'date_stop', 'account_id', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
  'spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks', 'actions', 'action_values', 'purchase_roas',
  'attribution_setting', 'account_currency',
].join(',');

let running = false;

function normalizeAccountId(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.startsWith('act_') ? s : `act_${s}`;
}

function advConfig(env = process.env) {
  return {
    ...meta.config(env),
    token: String(env.META_ADS_TOKEN || '').trim(),
    accountId: normalizeAccountId(env.META_AD_ACCOUNT_ID),
    brand: ACCOUNT_BRAND,
    retryDelayMs: 5000,
  };
}

// --- Segreti: il token non deve comparire da nessuna parte -----------------------------

function redact(text, token) {
  let s = String(text ?? '');
  if (token) s = s.split(token).join('[oscurato]');
  return s.replace(/access_token=[^&"'\s\\]+/g, 'access_token=[oscurato]');
}

// --- Numeri -----------------------------------------------------------------------------

const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const toMinor = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

function pick(list, types) {
  const byType = new Map((list || []).map((a) => [a.action_type, a.value]));
  for (const t of types) if (byType.has(t)) return { type: t, value: byType.get(t) };
  return null;
}

// Una riga di /insights (livello inserzione, un giorno) -> colonne leggibili di adv_insights_daily.
function mapInsightRow(r, accountId, fetchedAt) {
  const count = (key) => toInt(pick(r.actions, ACTIONS[key])?.value);
  const purchase = pick(r.actions, ACTIONS.purchases);
  const value = purchase ? pick(r.action_values, [purchase.type]) || pick(r.action_values, ACTIONS.purchases) : pick(r.action_values, ACTIONS.purchases);
  const roas = purchase ? pick(r.purchase_roas, [purchase.type]) || pick(r.purchase_roas, ACTIONS.purchases) : pick(r.purchase_roas, ACTIONS.purchases);
  return {
    date: r.date_start,
    ad_id: String(r.ad_id),
    account_id: accountId,
    campaign_id: r.campaign_id ? String(r.campaign_id) : null,
    adset_id: r.adset_id ? String(r.adset_id) : null,
    spend_minor: toMinor(r.spend),
    impressions: toInt(r.impressions),
    reach: toInt(r.reach),
    clicks: toInt(r.clicks),
    link_clicks: toInt(r.inline_link_clicks),
    landing_page_views: count('landing_page_views'),
    view_content: count('view_content'),
    add_to_cart: count('add_to_cart'),
    initiate_checkout: count('initiate_checkout'),
    purchases: purchase ? toInt(purchase.value) : 0,
    purchase_value_minor: value ? toMinor(value.value) : 0,
    purchase_action_type: purchase ? purchase.type : null,
    purchase_roas: roas ? Number(roas.value) : null,
    attribution_setting: r.attribution_setting || null,
    fetched_at: fetchedAt,
  };
}

// Link di destinazione della creatività: dove porta il clic sull'inserzione.
function creativeLink(c) {
  if (!c) return null;
  const s = c.object_story_spec || {};
  return s.link_data?.link
    || s.link_data?.call_to_action?.value?.link
    || s.video_data?.call_to_action?.value?.link
    || s.template_data?.link
    || c.asset_feed_spec?.link_urls?.[0]?.website_url
    || c.link_url
    || c.object_url
    || null;
}

// --- Date nel fuso dell'account ---------------------------------------------------------

function todayIn(timeZone, now = new Date()) {
  const p = zonedParts(now, timeZone);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function chunks(since, until, size = CHUNK_DAYS) {
  const out = [];
  for (let s = since; s <= until; s = addDays(s, size)) {
    const e = addDays(s, size - 1);
    out.push({ since: s, until: e < until ? e : until });
  }
  return out;
}

// --- Chiamate a Meta: 3 tentativi al massimo, attesa crescente, risposta grezza salvata ----

const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80003, 80004, 80001, 80006]);
function retryable(err) {
  if (!(err instanceof meta.MetaError) || err.fatal || err.permission) return false;
  return err.network || err.tooMuch || RATE_CODES.has(err.code);
}

function createClient({ cfg, db, runId, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const insertRaw = db.prepare(`INSERT INTO adv_raw_responses (run_id, fetched_at, endpoint, params, body)
                                VALUES (?, ?, ?, ?, ?)`);

  function describe(pathOrUrl, params) {
    if (/^https?:\/\//.test(pathOrUrl)) {
      const u = new URL(pathOrUrl);
      const p = Object.fromEntries([...u.searchParams].filter(([k]) => k !== 'access_token'));
      return { endpoint: u.pathname, params: p };
    }
    return { endpoint: '/' + pathOrUrl.replace(/^\/+/, ''), params: { ...params } };
  }

  async function get(pathOrUrl, params = {}) {
    const { endpoint, params: shown } = describe(pathOrUrl, params);
    for (let attempt = 1; ; attempt++) {
      try {
        const body = await meta.get(cfg, pathOrUrl, params, cfg.token);
        insertRaw.run(runId, new Date().toISOString(), redact(endpoint, cfg.token),
          redact(JSON.stringify(shown), cfg.token), redact(JSON.stringify(body), cfg.token));
        return body;
      } catch (err) {
        if (err instanceof Error) err.message = redact(err.message, cfg.token);
        if (!retryable(err) || attempt >= MAX_ATTEMPTS) throw err;
        const wait = cfg.retryDelayMs * attempt;
        log(`[adv] ${endpoint}: ${err.message} (tentativo ${attempt} di ${MAX_ATTEMPTS}, riprovo tra ${Math.round(wait / 1000)} s)`);
        await sleep(wait);
      }
    }
  }

  async function list(path, params) {
    const out = [];
    let body = await get(path, params);
    for (let page = 0; page < 200; page++) {
      out.push(...(body.data || []));
      const next = body.paging && body.paging.next;
      if (!next || !(body.data || []).length) break;
      body = await get(next);
    }
    return out;
  }

  return { get, list };
}

// --- Salvataggio ------------------------------------------------------------------------

function upsertInsights(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO adv_insights_daily (date, ad_id, account_id, campaign_id, adset_id, spend_minor, impressions, reach, clicks,
      link_clicks, landing_page_views, view_content, add_to_cart, initiate_checkout, purchases, purchase_value_minor,
      purchase_action_type, purchase_roas, attribution_setting, fetched_at)
    VALUES (@date, @ad_id, @account_id, @campaign_id, @adset_id, @spend_minor, @impressions, @reach, @clicks,
      @link_clicks, @landing_page_views, @view_content, @add_to_cart, @initiate_checkout, @purchases, @purchase_value_minor,
      @purchase_action_type, @purchase_roas, @attribution_setting, @fetched_at)
    ON CONFLICT (date, ad_id) DO UPDATE SET
      account_id = excluded.account_id, campaign_id = excluded.campaign_id, adset_id = excluded.adset_id,
      spend_minor = excluded.spend_minor, impressions = excluded.impressions, reach = excluded.reach, clicks = excluded.clicks,
      link_clicks = excluded.link_clicks, landing_page_views = excluded.landing_page_views, view_content = excluded.view_content,
      add_to_cart = excluded.add_to_cart, initiate_checkout = excluded.initiate_checkout, purchases = excluded.purchases,
      purchase_value_minor = excluded.purchase_value_minor, purchase_action_type = excluded.purchase_action_type,
      purchase_roas = excluded.purchase_roas, attribution_setting = excluded.attribution_setting, fetched_at = excluded.fetched_at`);
  db.transaction(() => { for (const r of rows) stmt.run(r); })();
  return rows.length;
}

const ENTITY_COLS = ['id', 'account_id', 'level', 'parent_id', 'campaign_id', 'name', 'effective_status', 'daily_budget',
  'lifetime_budget', 'objective', 'optimization_goal', 'attribution_spec', 'creative_id', 'link_url', 'url_tags',
  'created_time', 'updated_time', 'from_insights_only', 'fetched_at'];

function upsertEntities(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO adv_entities (${ENTITY_COLS.join(', ')}) VALUES (${ENTITY_COLS.map((c) => '@' + c).join(', ')})
    ON CONFLICT (id) DO UPDATE SET ${ENTITY_COLS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`);
  db.transaction(() => { for (const r of rows) stmt.run(r); })();
}

function entityRow(o) {
  const base = Object.fromEntries(ENTITY_COLS.map((c) => [c, null]));
  return { ...base, from_insights_only: 0, ...o };
}

// Le inserzioni archiviate o eliminate non compaiono negli elenchi ma possono avere statistiche:
// si registrano con i nomi presi dalle statistiche, senza sovrascrivere dati più completi.
function fillFromInsights(db, accountId, raw, fetchedAt) {
  const stmt = db.prepare(`
    INSERT INTO adv_entities (id, account_id, level, parent_id, campaign_id, name, from_insights_only, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT (id) DO NOTHING`);
  db.transaction(() => {
    for (const r of raw) {
      if (r.campaign_id) stmt.run(String(r.campaign_id), accountId, 'campaign', null, String(r.campaign_id), r.campaign_name || null, fetchedAt);
      if (r.adset_id) stmt.run(String(r.adset_id), accountId, 'adset', r.campaign_id ? String(r.campaign_id) : null, r.campaign_id ? String(r.campaign_id) : null, r.adset_name || null, fetchedAt);
      if (r.ad_id) stmt.run(String(r.ad_id), accountId, 'ad', r.adset_id ? String(r.adset_id) : null, r.campaign_id ? String(r.campaign_id) : null, r.ad_name || null, fetchedAt);
    }
  })();
}

async function readEntities(client, accountId, fetchedAt) {
  const campaigns = await client.list(`${accountId}/campaigns`, {
    fields: 'id,name,effective_status,daily_budget,lifetime_budget,objective,created_time,updated_time', limit: 200,
  });
  const adsets = await client.list(`${accountId}/adsets`, {
    fields: 'id,name,campaign_id,effective_status,daily_budget,lifetime_budget,optimization_goal,attribution_spec,created_time,updated_time', limit: 200,
  });
  const ads = await client.list(`${accountId}/ads`, {
    fields: 'id,name,adset_id,campaign_id,effective_status,created_time,updated_time,'
      + 'creative{id,url_tags,link_url,object_url,object_story_spec,asset_feed_spec}',
    limit: 100,
  });
  const budget = (v) => (v === undefined || v === null || v === '' ? null : toInt(v));
  return [
    ...campaigns.map((c) => entityRow({
      id: String(c.id), account_id: accountId, level: 'campaign', campaign_id: String(c.id), name: c.name,
      effective_status: c.effective_status, daily_budget: budget(c.daily_budget), lifetime_budget: budget(c.lifetime_budget),
      objective: c.objective || null, created_time: c.created_time || null, updated_time: c.updated_time || null, fetched_at: fetchedAt,
    })),
    ...adsets.map((s) => entityRow({
      id: String(s.id), account_id: accountId, level: 'adset', parent_id: String(s.campaign_id), campaign_id: String(s.campaign_id),
      name: s.name, effective_status: s.effective_status, daily_budget: budget(s.daily_budget), lifetime_budget: budget(s.lifetime_budget),
      optimization_goal: s.optimization_goal || null, attribution_spec: s.attribution_spec ? JSON.stringify(s.attribution_spec) : null,
      created_time: s.created_time || null, updated_time: s.updated_time || null, fetched_at: fetchedAt,
    })),
    ...ads.map((a) => entityRow({
      id: String(a.id), account_id: accountId, level: 'ad', parent_id: String(a.adset_id), campaign_id: String(a.campaign_id),
      name: a.name, effective_status: a.effective_status, creative_id: a.creative?.id ? String(a.creative.id) : null,
      link_url: creativeLink(a.creative), url_tags: a.creative?.url_tags || null,
      created_time: a.created_time || null, updated_time: a.updated_time || null, fetched_at: fetchedAt,
    })),
  ];
}

// --- Giro completo ----------------------------------------------------------------------

function hasSuccessfulRun(db, accountId) {
  return Boolean(db.prepare('SELECT 1 FROM adv_sync_runs WHERE account_id = ? AND ok = 1 LIMIT 1').get(accountId));
}

function configError(cfg) {
  if (!cfg.token) return 'Manca la chiave Meta Ads: aggiungi META_ADS_TOKEN nel file .env di FormaOps e riavvia.';
  if (!/^act_\d+$/.test(cfg.accountId)) return 'Manca l\'account pubblicitario: aggiungi META_AD_ACCOUNT_ID (es. act_1095600805179325) nel file .env e riavvia.';
  return null;
}

// Non lancia mai eccezioni: l'esito (anche l'errore) finisce in adv_sync_runs.
async function syncAdv(db, { cfg = advConfig(), trigger = 'manuale', log = () => {}, now = () => new Date(), sleep } = {}) {
  if (running) return { ok: false, skipped: true, summary: 'ADV: aggiornamento già in corso' };
  running = true;
  const startedAt = now().toISOString();
  let runId;
  try {
    runId = db.prepare(`INSERT INTO adv_sync_runs (account_id, trigger, started_at) VALUES (?, ?, ?)`)
      .run(cfg.accountId || null, trigger, startedAt).lastInsertRowid;
  } catch (err) {
    running = false;
    const msg = `ADV: impossibile registrare il giro (${err.message})`;
    log(`[adv] ${msg}`);
    return { ok: false, error: msg, summary: msg };
  }
  const finish = (ok, rows, error, since = null, until = null) => {
    db.prepare(`UPDATE adv_sync_runs SET finished_at = ?, ok = ?, rows_written = ?, error = ?, since_date = COALESCE(?, since_date),
                until_date = COALESCE(?, until_date) WHERE id = ?`)
      .run(now().toISOString(), ok ? 1 : 0, rows, error, since, until, runId);
  };
  let rows = 0;
  try {
    const bad = configError(cfg);
    if (bad) {
      finish(false, 0, bad);
      log(`[adv] ${bad}`);
      return { ok: false, runId, rows: 0, error: bad, summary: `ADV: ${bad}` };
    }
    const client = createClient({ cfg, db, runId, log, sleep });
    const fetchedAt = now().toISOString();

    const acc = await client.get(cfg.accountId, { fields: 'id,name,currency,timezone_name,account_status' });
    if (!acc.timezone_name) throw new Error('Meta non ha indicato il fuso orario dell\'account (timezone_name): mi fermo.');
    db.prepare(`INSERT INTO adv_accounts (id, brand, name, currency, timezone_name, account_status, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET name = excluded.name, currency = excluded.currency,
                  timezone_name = excluded.timezone_name, account_status = excluded.account_status, updated_at = excluded.updated_at`)
      .run(cfg.accountId, cfg.brand, acc.name || null, acc.currency || null, acc.timezone_name, acc.account_status ?? null, fetchedAt);

    const days = hasSuccessfulRun(db, cfg.accountId) ? NIGHTLY_DAYS : FIRST_RUN_DAYS;
    const until = todayIn(acc.timezone_name, now());
    const since = addDays(until, -days);
    db.prepare('UPDATE adv_sync_runs SET since_date = ?, until_date = ? WHERE id = ?').run(since, until, runId);
    log(`[adv] ${cfg.accountId}: statistiche dal ${since} al ${until} (fuso ${acc.timezone_name})`);

    const allRaw = [];
    for (const w of chunks(since, until)) {
      const raw = await client.list(`${cfg.accountId}/insights`, {
        level: 'ad', time_increment: 1, time_range: JSON.stringify(w), fields: INSIGHT_FIELDS,
        use_unified_attribution_setting: 'true', limit: 500,
      });
      rows += upsertInsights(db, raw.map((r) => mapInsightRow(r, cfg.accountId, fetchedAt)));
      allRaw.push(...raw);
    }

    upsertEntities(db, await readEntities(client, cfg.accountId, fetchedAt));
    fillFromInsights(db, cfg.accountId, allRaw, fetchedAt);

    finish(true, rows, null, since, until);
    const summary = `ADV: ${rows} righe giornaliere dal ${since} al ${until}`;
    log(`[adv] ${summary}`);
    return { ok: true, runId, rows, since, until, summary };
  } catch (err) {
    const msg = redact(err && err.message ? err.message : String(err), cfg.token);
    finish(false, rows, msg);
    log(`[adv] errore: ${msg}`);
    return { ok: false, runId, rows, error: msg, summary: `ADV: errore — ${msg}` };
  } finally {
    running = false;
  }
}

const isRunning = () => running;

// Recupero all'avvio: se l'ultimo giro riuscito ha più di 24 ore (per esempio il PC era spento alle 05:00)
// si aggiorna subito. Se non c'è mai stato un giro riuscito, questo è il primo avvio (90 giorni).
const CATCH_UP_MS = 24 * 3600 * 1000;
function catchUpDue(db, accountId, now = new Date()) {
  const last = db.prepare('SELECT MAX(finished_at) FROM adv_sync_runs WHERE account_id = ? AND ok = 1').pluck().get(accountId);
  return !last || now.getTime() - Date.parse(last) > CATCH_UP_MS;
}
async function startupCatchUp(db, { cfg = advConfig(), now = () => new Date(), ...opts } = {}) {
  if (configError(cfg) || !catchUpDue(db, cfg.accountId, now())) return null;
  return syncAdv(db, { cfg, now, trigger: 'avvio', ...opts });
}

// --- Lettura per la pagina ADV ----------------------------------------------------------

const WINDOW_LABEL = { click: 'dal clic', view: 'dalla visualizzazione', ev: 'dalla visualizzazione coinvolta',
  engaged_view: 'dalla visualizzazione coinvolta', engaged_video_view: 'dalla visualizzazione coinvolta' };
const SPEC_LABEL = { CLICK_THROUGH: 'click', VIEW_THROUGH: 'view', ENGAGED_VIDEO_VIEW: 'ev' };

// "7d_click_1d_view_1d_ev" -> "7 giorni dal clic, 1 giorno dalla visualizzazione, 1 giorno dalla visualizzazione coinvolta".
// Se il formato non è riconosciuto si mostra il valore di Meta così com'è.
function attributionLabel(setting) {
  if (!setting) return null;
  const re = /(\d+)d_(engaged_video_view|engaged_view|click|view|ev)/g;
  const parts = [...setting.matchAll(re)];
  if (!parts.length || setting.replace(re, '').replace(/[_,\s]/g, '') !== '') return setting;
  const order = (kind) => (kind === 'click' ? 0 : kind === 'view' ? 1 : 2); // Meta scrive "1d_view_7d_click_1d_ev"
  parts.sort((a, b) => order(a[2]) - order(b[2]));
  return parts.map((m) => {
    const n = Number(m[1]);
    return `${n} ${n === 1 ? 'giorno' : 'giorni'} ${WINDOW_LABEL[m[2]]}`;
  }).join(', ');
}

function specToSetting(specJson) {
  try {
    const spec = JSON.parse(specJson);
    return spec.map((s) => `${s.window_days}d_${SPEC_LABEL[s.event_type] || s.event_type}`).join('_');
  } catch { return null; }
}

function advPage(db, { brand, campaign = '', ad = '', now = new Date() } = {}) {
  const account = db.prepare('SELECT * FROM adv_accounts WHERE brand = ? ORDER BY id LIMIT 1').get(brand) || null;
  const lastRun = account
    ? db.prepare('SELECT * FROM adv_sync_runs WHERE account_id = ? OR account_id IS NULL ORDER BY id DESC LIMIT 1').get(account.id)
    : (brand === ACCOUNT_BRAND ? db.prepare('SELECT * FROM adv_sync_runs ORDER BY id DESC LIMIT 1').get() : null);
  const lastOk = account
    ? db.prepare('SELECT * FROM adv_sync_runs WHERE account_id = ? AND ok = 1 ORDER BY id DESC LIMIT 1').get(account.id) : null;
  if (!account) return { account: null, lastRun: lastRun || null, lastOk: null, days: [], totals: null, campaigns: [], ads: [], activeAds: [], attribution: [], specs: [] };

  const until = todayIn(account.timezone_name, now);
  const since = addDays(until, -29);
  const filter = [];
  const args = { acc: account.id, since, until };
  if (campaign) { filter.push('AND i.campaign_id = @campaign'); args.campaign = campaign; }
  if (ad) { filter.push('AND i.ad_id = @ad'); args.ad = ad; }

  const byDate = new Map(db.prepare(`
    SELECT i.date, SUM(i.spend_minor) AS spend, SUM(i.link_clicks) AS link_clicks, SUM(i.add_to_cart) AS add_to_cart,
           SUM(i.initiate_checkout) AS initiate_checkout, SUM(i.purchases) AS purchases, SUM(i.purchase_value_minor) AS value
    FROM adv_insights_daily i
    WHERE i.account_id = @acc AND i.date BETWEEN @since AND @until ${filter.join(' ')}
    GROUP BY i.date`).all(args).map((r) => [r.date, r]));

  const empty = { spend: 0, link_clicks: 0, add_to_cart: 0, initiate_checkout: 0, purchases: 0, value: 0 };
  const withRatios = (r) => ({ ...r, cpa: r.purchases ? Math.round(r.spend / r.purchases) : null, roas: r.spend ? r.value / r.spend : null });
  const days = [];
  for (let d = until; d >= since; d = addDays(d, -1)) days.push(withRatios({ date: d, ...empty, ...(byDate.get(d) || {}) }));
  const totals = withRatios(days.reduce((t, r) => {
    for (const k of Object.keys(empty)) t[k] += r[k];
    return t;
  }, { ...empty }));

  const campaigns = db.prepare(`
    SELECT e.id, e.name, e.effective_status FROM adv_entities e
    WHERE e.account_id = ? AND e.level = 'campaign'
      AND EXISTS (SELECT 1 FROM adv_insights_daily i WHERE i.campaign_id = e.id AND i.date BETWEEN ? AND ?)
    ORDER BY e.name COLLATE NOCASE`).all(account.id, since, until);
  const ads = db.prepare(`
    SELECT e.id, e.name, e.effective_status FROM adv_entities e
    WHERE e.account_id = @acc AND e.level = 'ad' ${campaign ? 'AND e.campaign_id = @campaign' : ''}
      AND EXISTS (SELECT 1 FROM adv_insights_daily i WHERE i.ad_id = e.id AND i.date BETWEEN @since AND @until)
    ORDER BY e.name COLLATE NOCASE`).all(args);

  const activeAds = listActiveAds(db, account.id);

  const attribution = db.prepare(`
    SELECT attribution_setting AS setting, COUNT(*) AS n FROM adv_insights_daily
    WHERE account_id = ? AND date BETWEEN ? AND ? AND attribution_setting IS NOT NULL
    GROUP BY attribution_setting ORDER BY n DESC`).all(account.id, since, until)
    .map((r) => ({ ...r, label: attributionLabel(r.setting) }));

  // Finestra impostata sui gruppi di inserzioni (attribution_spec), per confronto.
  const specs = db.prepare(`
    SELECT attribution_spec AS spec, COUNT(*) AS n FROM adv_entities
    WHERE account_id = ? AND level = 'adset' AND attribution_spec IS NOT NULL
    GROUP BY attribution_spec ORDER BY n DESC`).all(account.id)
    .map((r) => ({ ...r, label: attributionLabel(specToSetting(r.spec)) || r.spec }));

  return { account, lastRun, lastOk, since, until, days, totals, campaigns, ads, activeAds, attribution, specs };
}

// Inserzioni attive con link di destinazione e parametri URL (prova 8, base del Blocco 2).
function listActiveAds(db, accountId) {
  return db.prepare(`
    SELECT a.id, a.name, a.link_url, a.url_tags, a.creative_id, c.name AS campaign_name
    FROM adv_entities a LEFT JOIN adv_entities c ON c.id = a.campaign_id
    WHERE a.account_id = ? AND a.level = 'ad' AND a.effective_status = 'ACTIVE'
    ORDER BY c.name COLLATE NOCASE, a.name COLLATE NOCASE`).all(accountId)
    .map((a) => {
      const all = `${a.link_url || ''} ${a.url_tags || ''}`;
      return { ...a, hasUtm: /utm_[a-z]+=/i.test(all), hasAdId: /\{\{\s*ad\.id\s*\}\}/i.test(all) || all.includes(a.id) };
    });
}

module.exports = {
  advConfig, syncAdv, isRunning, catchUpDue, startupCatchUp, advPage, listActiveAds, mapInsightRow, creativeLink, attributionLabel, specToSetting,
  redact, todayIn, addDays, chunks, configError, ACTIONS, MAX_ATTEMPTS,
};
