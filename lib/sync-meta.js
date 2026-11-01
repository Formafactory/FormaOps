'use strict';

// Sincronizzazione Meta -> FormaOps (sola lettura):
// - Messenger e DM Instagram di ogni Pagina collegata
// - commenti ai post e alle inserzioni, su Facebook e su Instagram
// Ogni messaggio ha un ID stabile: rieseguire non crea doppioni.

const meta = require('./meta');
const igLogin = require('./instagram-login');
const { normalizeHandle } = require('./normalize');
const { isIgnored, customerForAddress, linkUnmatched, assignBrands } = require('./messages');
const { getSetting, setSetting } = require('./settings');

const SOURCE = 'meta';
const OVERLAP_MS = 2 * 3600 * 1000;
const POSTS_WINDOW_DAYS = 30;
let running = false;

function metaConfig(db, env = process.env) {
  return {
    ...meta.config(env),
    token: getSetting(db, 'meta_token') || env.META_TOKEN || '',
    days: Number(getSetting(db, 'meta_days') || env.META_DAYS || 7),
    igDm: (getSetting(db, 'meta_ig_dm') ?? env.META_IG_DM ?? '0') === '1',
    igToken: getSetting(db, 'ig_token') || env.IG_TOKEN || '',
  };
}

const iso = (t) => new Date(t).toISOString();
const short = (t, n = 60) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function readCursor(db) {
  const raw = db.prepare('SELECT cursor FROM sync_state WHERE source = ?').pluck().get(SOURCE);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function makeRow(db, r) {
  if (!r.counterpart_address || isIgnored(db, r.counterpart_address, r.contact_type)) return null;
  return { ...r, customer_id: customerForAddress(db, r.contact_type, r.counterpart_address) };
}

// --- Messaggi diretti ----------------------------------------------------------------
// Prima l'elenco leggero delle conversazioni, poi i messaggi di ciascuna: richieste piccole,
// che Meta serve senza andare in timeout.

const MSG_FIELDS = 'messages.limit(10){id,created_time,from,to,message}';

async function conversationMessages(cfg, conv, token, withParticipants = false) {
  const fields = withParticipants ? `participants,${MSG_FIELDS}` : MSG_FIELDS;
  const body = await meta.getAdaptive(cfg, String(conv.id), { fields }, token);
  if (withParticipants) conv.participants = body.participants;
  return body.messages?.data || [];
}

async function readMessenger(cfg, page, sinceMs, rows, db, warnings) {
  const convs = await meta.list(cfg, `${page.id}/conversations`, {
    platform: 'messenger', limit: 25, fields: 'id,updated_time,link,participants',
  }, page.token, { stop: (c) => Date.parse(c.updated_time) < sinceMs });
  let failed = 0;
  for (const conv of convs) {
    const other = (conv.participants?.data || []).find((p) => String(p.id) !== page.id);
    if (!other) continue;
    let messages;
    try { messages = await conversationMessages(cfg, conv, page.token); } catch (err) {
      if (!(err instanceof meta.MetaError) || err.fatal) throw err;
      failed++; continue;
    }
    for (const m of messages) {
      const out = String(m.from?.id) === page.id;
      const row = makeRow(db, {
        id: `messenger:${m.id}`, source: 'messenger', kind: 'dm', contact_type: 'facebook', account: page.name,
        thread_key: `messenger:${conv.id}`, direction: out ? 'out' : 'in',
        counterpart_address: `fb:${other.id}`, counterpart_name: other.name || null,
        subject: 'Messaggio Messenger', snippet: short(m.message, 400) || '(allegato)',
        sent_at: iso(m.created_time),
        link: conv.link ? new URL(conv.link, 'https://www.facebook.com').href
          : `https://business.facebook.com/latest/inbox/messenger?asset_id=${page.id}`,
      });
      if (row) rows.push(row);
    }
  }
  if (failed) warnings.push(`${page.name}: ${failed} conversazioni Messenger non lette (Meta non ha risposto), riprovo al prossimo aggiornamento`);
}

async function readInstagramDm(cfg, page, sinceMs, rows, db, warnings) {
  if (!page.ig) return;
  // Per Instagram l'elenco chiede solo id e data: i partecipanti rallentano molto la risposta di Meta.
  const convs = await meta.list(cfg, `${page.id}/conversations`, {
    platform: 'instagram', limit: 10, fields: 'id,updated_time',
  }, page.token, { stop: (c) => Date.parse(c.updated_time) < sinceMs });
  let failed = 0;
  for (const conv of convs) {
    let messages;
    try { messages = await conversationMessages(cfg, conv, page.token, true); } catch (err) {
      if (!(err instanceof meta.MetaError) || err.fatal) throw err;
      failed++; continue;
    }
    const other = (conv.participants?.data || []).find((p) => String(p.id) !== page.ig.id
      && normalizeHandle(p.username) !== page.ig.username);
    const username = normalizeHandle(other?.username);
    if (!username) continue;
    for (const m of messages) {
      const out = String(m.from?.id) === page.ig.id || normalizeHandle(m.from?.username) === page.ig.username;
      const row = makeRow(db, {
        id: `instagram:${m.id}`, source: 'instagram', kind: 'dm', contact_type: 'instagram', account: '@' + page.ig.username,
        thread_key: `instagram:${conv.id}`, direction: out ? 'out' : 'in',
        counterpart_address: username, counterpart_name: other.name || null,
        subject: 'Messaggio Instagram', snippet: short(m.message, 400) || '(allegato)',
        sent_at: iso(m.created_time),
        link: `https://business.facebook.com/latest/inbox/instagram_direct?asset_id=${page.id}`,
      });
      if (row) rows.push(row);
    }
  }
  if (failed) warnings.push(`${page.name}: ${failed} conversazioni Instagram non lette (Meta non ha risposto), riprovo al prossimo aggiornamento`);
}

// --- Commenti ------------------------------------------------------------------------

const FB_COMMENT_FIELDS = 'id,created_time,from,message,permalink_url,comments.limit(10){id,created_time,from,message}';

// Contatori per capire cosa succede ai commenti (salvati in Impostazioni → avvisi e nel terminale).
function newStats() { return { fbPosts: 0, fbComments: 0, fbHidden: 0, igMedia: 0, igComments: 0, igHidden: 0, old: 0 }; }

function fbCommentRows(db, page, post, isAd, rows, sinceMs, stats = newStats()) {
  const subject = `${isAd ? 'Commento all\'inserzione' : 'Commento al post'}: ${short(post.message, 50) || '(senza testo)'}`;
  stats.fbPosts++;
  for (const c of post.comments?.data || []) {
    if (c.from && String(c.from.id) === page.id) continue; // commento della Pagina stessa
    stats.fbComments++;
    // Meta a volte non dice chi ha commentato (manca il permesso pages_read_user_content):
    // il commento si mostra lo stesso, come "Utente Facebook".
    if (!c.from) stats.fbHidden++;
    const author = c.from
      ? { address: `fb:${c.from.id}`, name: c.from.name || null }
      : { address: `fb:anonimo-${c.id}`, name: 'Utente Facebook (nome nascosto da Meta)' };
    const replies = c.comments?.data || [];
    const lastActivity = Math.max(Date.parse(c.created_time), ...replies.map((r) => Date.parse(r.created_time)));
    if (lastActivity < sinceMs) { stats.old++; continue; }
    const thread = `fbcomment:${c.id}`;
    const link = c.permalink_url || post.permalink_url || null;
    const base = { source: 'facebook_comment', kind: 'comment', contact_type: 'facebook', account: page.name, thread_key: thread, subject, link };
    const top = makeRow(db, { ...base, id: `fbcomment:${c.id}`, direction: 'in', counterpart_address: author.address,
      counterpart_name: author.name, snippet: short(c.message, 400), sent_at: iso(c.created_time) });
    if (!top) continue;
    rows.push(top);
    for (const r of replies) {
      const fromPage = String(r.from?.id) === page.id;
      if (!fromPage && !r.from) continue;
      const row = makeRow(db, { ...base, id: `fbcomment:${r.id}`, direction: fromPage ? 'out' : 'in',
        counterpart_address: fromPage ? author.address : `fb:${r.from.id}`,
        counterpart_name: fromPage ? author.name : (r.from.name || null),
        snippet: short(r.message, 400), sent_at: iso(r.created_time) });
      if (row) rows.push(row);
    }
  }
}

const FB_POST_FIELDS = `id,created_time,message,permalink_url,comments.order(reverse_chronological).limit(20){${FB_COMMENT_FIELDS}}`;

async function readFacebookComments(cfg, page, sinceMs, rows, db, stats) {
  const postsSince = Math.floor((Date.now() - POSTS_WINDOW_DAYS * 86400000) / 1000);
  const posts = await meta.list(cfg, `${page.id}/published_posts`, {
    since: postsSince, limit: 10, fields: FB_POST_FIELDS,
  }, page.token, { maxPages: 20 });
  for (const post of posts) fbCommentRows(db, page, post, false, rows, sinceMs, stats);
  return new Set(posts.map((p) => String(p.id)));
}

const IG_COMMENT_FIELDS = 'id,text,timestamp,username,from{id,username},replies.limit(10){id,text,timestamp,username,from{id,username}}';

function igCommentRows(db, page, media, isAd, rows, sinceMs, stats = newStats()) {
  const subject = `${isAd ? 'Commento all\'inserzione' : 'Commento al post'}: ${short(media.caption, 50) || '(senza testo)'}`;
  stats.igMedia++;
  for (const c of media.comments?.data || []) {
    const handle = normalizeHandle(c.username || c.from?.username);
    if (handle && handle === page.ig.username) continue; // commento dell'account stesso
    stats.igComments++;
    if (!handle) stats.igHidden++;
    const author = handle || `anonimo-${c.id}`;
    const replies = c.replies?.data || [];
    const lastActivity = Math.max(Date.parse(c.timestamp), ...replies.map((r) => Date.parse(r.timestamp)));
    if (lastActivity < sinceMs) { stats.old++; continue; }
    const base = { source: 'instagram_comment', kind: 'comment', contact_type: 'instagram', account: '@' + page.ig.username,
      thread_key: `igcomment:${c.id}`, subject, link: media.permalink || null };
    const top = makeRow(db, { ...base, id: `igcomment:${c.id}`, direction: 'in', counterpart_address: author,
      counterpart_name: handle ? null : 'Utente Instagram (nome nascosto da Meta)', snippet: short(c.text, 400), sent_at: iso(c.timestamp) });
    if (!top) continue;
    rows.push(top);
    for (const r of replies) {
      const who = normalizeHandle(r.username || r.from?.username);
      if (!who) continue;
      const fromUs = who === page.ig.username;
      const row = makeRow(db, { ...base, id: `igcomment:${r.id}`, direction: fromUs ? 'out' : 'in',
        counterpart_address: fromUs ? author : who, counterpart_name: null,
        snippet: short(r.text, 400), sent_at: iso(r.timestamp) });
      if (row) rows.push(row);
    }
  }
}

async function readInstagramComments(cfg, page, sinceMs, rows, db, stats) {
  if (!page.ig) return new Set();
  const windowMs = Date.now() - POSTS_WINDOW_DAYS * 86400000;
  const media = await meta.list(cfg, `${page.ig.id}/media`, {
    limit: 10, fields: `id,caption,permalink,timestamp,comments.limit(20){${IG_COMMENT_FIELDS}}`,
  }, page.token, { maxPages: 20, stop: (m) => Date.parse(m.timestamp) < windowMs });
  for (const m of media) igCommentRows(db, page, m, false, rows, sinceMs, stats);
  return new Set(media.map((m) => String(m.id)));
}

// Inserzioni (Facebook e Instagram): i contenuti sponsorizzati non sempre compaiono tra i post,
// si trovano dagli account pubblicitari (permesso ads_read). Ogni contenuto si legge con una richiesta propria.
async function readAdComments(cfg, token, pages, seenPosts, seenMedia, sinceMs, rows, db, warnings, stats) {
  let accounts;
  try {
    accounts = await meta.list(cfg, 'me/adaccounts', { fields: 'id,name', limit: 50 }, token);
  } catch (err) {
    if (!(err instanceof meta.MetaError) || err.fatal) throw err;
    warnings.push(`Commenti alle inserzioni non leggibili: l'utente di sistema non ha accesso all'account pubblicitario (${err.message})`);
    return;
  }
  const storyIds = new Set();
  const mediaIds = new Set();
  for (const acc of accounts) {
    try {
      const ads = await meta.list(cfg, `${acc.id}/ads`, {
        fields: 'id,creative{effective_object_story_id,effective_instagram_media_id}', limit: 50,
        effective_status: JSON.stringify(['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED']),
      }, token, { maxPages: 5 });
      for (const ad of ads) {
        const story = ad.creative?.effective_object_story_id;
        const media = ad.creative?.effective_instagram_media_id;
        if (story && !seenPosts.has(String(story))) storyIds.add(String(story));
        if (media && !seenMedia.has(String(media))) mediaIds.add(String(media));
      }
    } catch (err) {
      if (!(err instanceof meta.MetaError) || err.fatal) throw err;
      warnings.push(`${acc.name || acc.id}: inserzioni non leggibili (${err.message})`);
    }
  }
  let failed = 0;
  for (const id of storyIds) {
    const page = pages.find((p) => id.startsWith(p.id + '_'));
    if (!page) continue;
    try {
      const post = await meta.getAdaptive(cfg, id, { fields: FB_POST_FIELDS }, page.token);
      fbCommentRows(db, page, post, true, rows, sinceMs, stats);
    } catch (err) {
      if (!(err instanceof meta.MetaError) || err.fatal) throw err;
      failed++;
    }
  }
  const withIg = pages.filter((p) => p.ig);
  for (const id of mediaIds) {
    if (!withIg.length) break;
    try {
      const media = await meta.getAdaptive(cfg, id, {
        fields: `id,caption,permalink,timestamp,owner{id},comments.limit(20){${IG_COMMENT_FIELDS}}`,
      }, token);
      const page = withIg.find((p) => p.ig.id === String(media.owner?.id)) || withIg[0];
      igCommentRows(db, page, media, true, rows, sinceMs, stats);
    } catch (err) {
      if (!(err instanceof meta.MetaError) || err.fatal) throw err;
      failed++;
    }
  }
  if (failed) warnings.push(`${failed} inserzioni non lette (${failed === 1 ? 'Meta non ha risposto' : 'Meta non ha risposto o mancano permessi'})`);
}

// --- DM Instagram con la chiave dell'account Instagram ------------------------------

async function maybeRefreshIgToken(db, cfg, igCfg, log) {
  const last = getSetting(db, 'ig_token_refreshed_at');
  if (last && Date.now() - Date.parse(last) < 7 * 86400000) return cfg.igToken;
  if (!last) { setSetting(db, 'ig_token_refreshed_at', new Date().toISOString()); return cfg.igToken; }
  try {
    const fresh = await igLogin.refreshToken(igCfg, cfg.igToken);
    setSetting(db, 'ig_token', fresh);
    setSetting(db, 'ig_token_refreshed_at', new Date().toISOString());
    log('[instagram] chiave rinnovata per altri 60 giorni');
    return fresh;
  } catch (err) {
    log(`[instagram] rinnovo chiave non riuscito: ${err.message}`);
    return cfg.igToken;
  }
}

async function readInstagramDmLogin(db, cfg, sinceMs, rows, warnings, log) {
  const igCfg = igLogin.igConfig(cfg);
  const token = await maybeRefreshIgToken(db, cfg, igCfg, log);
  const { me, threads, failed } = await igLogin.readDms(igCfg, token, sinceMs, { log });
  for (const { conv, messages } of threads) {
    const other = messages.map((m) => (normalizeHandle(m.from?.username) !== me.username ? m.from
      : (m.to?.data || []).find((t) => normalizeHandle(t.username) !== me.username))).find((x) => x && x.username);
    const username = normalizeHandle(other?.username);
    if (!username) continue;
    for (const m of messages) {
      const out = String(m.from?.id) === me.id || normalizeHandle(m.from?.username) === me.username;
      const row = makeRow(db, {
        id: `instagram:${m.id}`, source: 'instagram', kind: 'dm', contact_type: 'instagram', account: '@' + me.username,
        thread_key: `instagram:${conv.id}`, direction: out ? 'out' : 'in',
        counterpart_address: username, counterpart_name: null,
        subject: 'Messaggio Instagram', snippet: short(m.message, 400) || '(allegato)',
        sent_at: iso(igLogin.toMs(m.created_time) || m.created_time),
        link: 'https://www.instagram.com/direct/inbox/',
      });
      if (row) rows.push(row);
    }
  }
  if (failed) warnings.push(`Instagram: ${failed} conversazioni non lette (Meta non ha risposto), riprovo al prossimo aggiornamento`);
}

async function testInstagramToken(cfg) {
  return igLogin.whoAmI(igLogin.igConfig(cfg), cfg.igToken);
}

// --- Salvataggio -------------------------------------------------------------------------

function saveRows(db, rows, cursor) {
  const insert = db.prepare(`
    INSERT INTO messages (id, source, kind, contact_type, account, thread_key, direction, counterpart_address,
      counterpart_name, subject, snippet, sent_at, link, customer_id)
    VALUES (@id, @source, @kind, @contact_type, @account, @thread_key, @direction, @counterpart_address,
      @counterpart_name, @subject, @snippet, @sent_at, @link, @customer_id)
    ON CONFLICT(id) DO UPDATE SET counterpart_address = excluded.counterpart_address,
      counterpart_name = excluded.counterpart_name, customer_id = excluded.customer_id
    -- Solo per i commenti salvati senza autore: quando Meta comincia a mostrarlo, si completa.
    WHERE (messages.counterpart_address LIKE 'fb:anonimo-%' OR messages.counterpart_address LIKE 'anonimo-%')
      AND excluded.counterpart_address NOT LIKE '%anonimo-%'`);
  const touch = db.prepare(`UPDATE customers SET updated_at = datetime('now') WHERE id = ?`);
  let added = 0;
  const bySource = {};
  db.transaction(() => {
    for (const r of rows) {
      const ch = insert.run(r).changes;
      if (!ch) continue;
      added++;
      bySource[r.source] = (bySource[r.source] || 0) + 1;
      if (r.customer_id) touch.run(r.customer_id);
    }
    db.prepare(`INSERT INTO sync_state (source, cursor) VALUES (?, ?)
                ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor`).run(SOURCE, JSON.stringify(cursor));
  })();
  return { added, bySource };
}

async function testConnection(cfg) {
  const pages = await meta.discoverPages(cfg, cfg.token);
  if (!pages.length) throw new meta.MetaError('La chiave funziona ma non ha accesso a nessuna Pagina: assegna le Pagine all\'utente di sistema.');
  return pages.map((p) => ({ id: p.id, name: p.name, instagram: p.ig ? p.ig.username : null }));
}

async function syncMeta(db, { cfg = metaConfig(db), log = () => {}, now = new Date() } = {}) {
  if (running) return { skipped: true, reason: 'Sincronizzazione Meta già in corso' };
  running = true;
  db.prepare(`INSERT INTO sync_state (source, last_run_at) VALUES (?, ?)
              ON CONFLICT(source) DO UPDATE SET last_run_at = excluded.last_run_at`).run(SOURCE, now.toISOString());
  const warnings = [];
  try {
    const cursor = readCursor(db);
    const sinceMs = cursor?.lastRunAt ? Date.parse(cursor.lastRunAt) - OVERLAP_MS : now.getTime() - cfg.days * 86400000;
    let pages;
    try {
      pages = await meta.discoverPages(cfg, cfg.token);
    } catch (err) {
      if (err instanceof meta.MetaError) err.message = `Elenco delle Pagine: ${err.message}`;
      throw err;
    }
    // I commenti si rileggono sempre sugli ultimi N giorni (i doppioni vengono scartati): così un commento
    // saltato una volta, o arrivato su un post vecchio, non si perde.
    const commentSinceMs = Math.min(sinceMs, now.getTime() - cfg.days * 86400000);
    const stats = newStats();
    const rows = [];
    const seenMedia = new Set();
    const seenPosts = new Set();
    const section = async (label, fn) => {
      try { return await fn(); } catch (err) {
        if (!(err instanceof meta.MetaError) || err.fatal) throw err;
        warnings.push(`${label} non leggibile (${err.message})`);
        return null;
      }
    };
    for (const page of pages) {
      log(`[meta] ${page.name}${page.ig ? ' + @' + page.ig.username : ''}`);
      await section(`${page.name}: Messenger`, () => readMessenger(cfg, page, sinceMs, rows, db, warnings));
      if (page.ig && cfg.igDm !== false && !cfg.igToken) await section(`${page.name}: DM Instagram`, () => readInstagramDm(cfg, page, sinceMs, rows, db, warnings));
      const posts = await section(`${page.name}: commenti ai post Facebook`, () => readFacebookComments(cfg, page, commentSinceMs, rows, db, stats));
      for (const id of posts || []) seenPosts.add(id);
      const media = await section(`${page.name}: commenti Instagram`, () => readInstagramComments(cfg, page, commentSinceMs, rows, db, stats));
      for (const id of media || []) seenMedia.add(id);
    }
    if (cfg.igToken) await section('DM Instagram', () => readInstagramDmLogin(db, cfg, sinceMs, rows, warnings, log));
    log('[meta] inserzioni');
    await section('Commenti alle inserzioni', () => readAdComments(cfg, cfg.token, pages, seenPosts, seenMedia, commentSinceMs, rows, db, warnings, stats));
    log(`[meta] commenti: post FB ${stats.fbPosts}, commenti FB ${stats.fbComments} (autore nascosto ${stats.fbHidden}), `
      + `media IG ${stats.igMedia}, commenti IG ${stats.igComments} (autore nascosto ${stats.igHidden}), più vecchi di ${cfg.days} giorni ${stats.old}`);
    setSetting(db, 'meta_comment_stats', JSON.stringify({ at: now.toISOString(), ...stats }));
    if (stats.fbHidden) warnings.push(`${stats.fbHidden} commenti Facebook senza nome dell'autore: Meta lo nasconde finché l'app non ha il permesso "pages_read_user_content". I commenti si vedono lo stesso, come "Utente Facebook".`);
    if (stats.igHidden) warnings.push(`${stats.igHidden} commenti Instagram senza nome dell'autore: serve il permesso "instagram_manage_comments". I commenti si vedono lo stesso, come "Utente Instagram".`);
    const { added, bySource } = saveRows(db, rows, { lastRunAt: now.toISOString() });
    assignBrands(db);
    linkUnmatched(db);
    setSetting(db, 'meta_warnings', JSON.stringify(warnings));
    db.prepare(`UPDATE sync_state SET last_ok_at = ?, last_error = NULL, last_imported = ? WHERE source = ?`)
      .run(new Date().toISOString(), added, SOURCE);
    log(`[meta] nuovi: ${added}${warnings.length ? ` · avvisi: ${warnings.length}` : ''}`);
    return { ok: true, nuovi: added, bySource, warnings };
  } catch (err) {
    const msg = err instanceof meta.MetaError ? err.message : `Errore Meta: ${err.message}`;
    db.prepare('UPDATE sync_state SET last_error = ? WHERE source = ?').run(msg, SOURCE);
    return { ok: false, error: msg, nuovi: 0, warnings };
  } finally {
    running = false;
  }
}

module.exports = { syncMeta, metaConfig, testConnection, testInstagramToken, SOURCE };
