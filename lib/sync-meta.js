'use strict';

// Sincronizzazione Meta -> FormaOps (sola lettura):
// - Messenger e DM Instagram di ogni Pagina collegata
// - commenti ai post e alle inserzioni, su Facebook e su Instagram
// Ogni messaggio ha un ID stabile: rieseguire non crea doppioni.

const meta = require('./meta');
const { normalizeHandle } = require('./normalize');
const { isIgnored, customerForAddress, linkUnmatched } = require('./messages');
const { getSetting, setSetting } = require('./settings');

const SOURCE = 'meta';
const OVERLAP_MS = 2 * 3600 * 1000;
const POSTS_WINDOW_DAYS = 90;
let running = false;

function metaConfig(db, env = process.env) {
  return {
    ...meta.config(env),
    token: getSetting(db, 'meta_token') || env.META_TOKEN || '',
    days: Number(getSetting(db, 'meta_days') || env.META_DAYS || 30),
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

async function readMessenger(cfg, page, sinceMs, rows, db) {
  const convs = await meta.list(cfg, `${page.id}/conversations`, {
    platform: 'messenger', limit: 25,
    fields: 'id,updated_time,link,participants,messages.limit(25){id,created_time,from,to,message}',
  }, page.token, { stop: (c) => Date.parse(c.updated_time) < sinceMs });
  for (const conv of convs) {
    const other = (conv.participants?.data || []).find((p) => String(p.id) !== page.id);
    if (!other) continue;
    for (const m of conv.messages?.data || []) {
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
}

async function readInstagramDm(cfg, page, sinceMs, rows, db) {
  if (!page.ig) return;
  const convs = await meta.list(cfg, `${page.id}/conversations`, {
    platform: 'instagram', limit: 25,
    fields: 'id,updated_time,participants,messages.limit(25){id,created_time,from,to,message}',
  }, page.token, { stop: (c) => Date.parse(c.updated_time) < sinceMs });
  for (const conv of convs) {
    const other = (conv.participants?.data || []).find((p) => String(p.id) !== page.ig.id
      && normalizeHandle(p.username) !== page.ig.username);
    const username = normalizeHandle(other?.username);
    if (!username) continue;
    for (const m of conv.messages?.data || []) {
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
}

// --- Commenti ------------------------------------------------------------------------

const FB_COMMENT_FIELDS = 'id,created_time,from,message,permalink_url,comments.limit(10){id,created_time,from,message}';

function fbCommentRows(db, page, post, isAd, rows, sinceMs) {
  const subject = `${isAd ? 'Commento all\'inserzione' : 'Commento al post'}: ${short(post.message, 50) || '(senza testo)'}`;
  for (const c of post.comments?.data || []) {
    if (!c.from || String(c.from.id) === page.id) continue; // commento della Pagina stessa o autore nascosto
    const author = { address: `fb:${c.from.id}`, name: c.from.name || null };
    const replies = c.comments?.data || [];
    const lastActivity = Math.max(Date.parse(c.created_time), ...replies.map((r) => Date.parse(r.created_time)));
    if (lastActivity < sinceMs) continue;
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

async function readFacebookComments(cfg, page, sinceMs, rows, db, warnings) {
  const postsSince = Math.floor((Date.now() - POSTS_WINDOW_DAYS * 86400000) / 1000);
  for (const [edge, isAd] of [['published_posts', false], ['ads_posts', true]]) {
    try {
      const posts = await meta.list(cfg, `${page.id}/${edge}`, {
        since: postsSince, limit: 25,
        fields: `id,created_time,message,permalink_url,comments.order(reverse_chronological).limit(25){${FB_COMMENT_FIELDS}}`,
      }, page.token, { maxPages: 8 });
      for (const post of posts) fbCommentRows(db, page, post, isAd, rows, sinceMs);
    } catch (err) {
      if (!(err instanceof meta.MetaError) || !err.permission) throw err;
      warnings.push(`${page.name}: commenti ${isAd ? 'alle inserzioni' : 'ai post'} non leggibili (${err.message})`);
    }
  }
}

const IG_COMMENT_FIELDS = 'id,text,timestamp,username,from{id,username},replies.limit(10){id,text,timestamp,username,from{id,username}}';

function igCommentRows(db, page, media, isAd, rows, sinceMs) {
  const subject = `${isAd ? 'Commento all\'inserzione' : 'Commento al post'}: ${short(media.caption, 50) || '(senza testo)'}`;
  for (const c of media.comments?.data || []) {
    const author = normalizeHandle(c.username || c.from?.username);
    if (!author || author === page.ig.username) continue;
    const replies = c.replies?.data || [];
    const lastActivity = Math.max(Date.parse(c.timestamp), ...replies.map((r) => Date.parse(r.timestamp)));
    if (lastActivity < sinceMs) continue;
    const base = { source: 'instagram_comment', kind: 'comment', contact_type: 'instagram', account: '@' + page.ig.username,
      thread_key: `igcomment:${c.id}`, subject, link: media.permalink || null };
    const top = makeRow(db, { ...base, id: `igcomment:${c.id}`, direction: 'in', counterpart_address: author,
      counterpart_name: null, snippet: short(c.text, 400), sent_at: iso(c.timestamp) });
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

async function readInstagramComments(cfg, page, sinceMs, rows, db) {
  if (!page.ig) return new Set();
  const windowMs = Date.now() - POSTS_WINDOW_DAYS * 86400000;
  const media = await meta.list(cfg, `${page.ig.id}/media`, {
    limit: 25, fields: `id,caption,permalink,timestamp,comments.limit(25){${IG_COMMENT_FIELDS}}`,
  }, page.token, { maxPages: 8, stop: (m) => Date.parse(m.timestamp) < windowMs });
  for (const m of media) igCommentRows(db, page, m, false, rows, sinceMs);
  return new Set(media.map((m) => String(m.id)));
}

// Inserzioni Instagram: i loro contenuti non compaiono tra i post, si trovano dagli account pubblicitari.
async function readInstagramAdComments(cfg, token, pages, seenMedia, sinceMs, rows, db, warnings) {
  const withIg = pages.filter((p) => p.ig);
  if (!withIg.length) return;
  let accounts;
  try {
    accounts = await meta.list(cfg, 'me/adaccounts', { fields: 'id,name', limit: 50 }, token);
  } catch (err) {
    if (!(err instanceof meta.MetaError) || !err.permission) throw err;
    warnings.push(`Commenti alle inserzioni Instagram non leggibili: l'utente di sistema non ha accesso all'account pubblicitario (${err.message})`);
    return;
  }
  const mediaIds = new Set();
  for (const acc of accounts) {
    try {
      const ads = await meta.list(cfg, `${acc.id}/ads`, {
        fields: 'id,creative{effective_instagram_media_id}', limit: 100,
        effective_status: JSON.stringify(['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED']),
      }, token, { maxPages: 5 });
      for (const ad of ads) {
        const id = ad.creative?.effective_instagram_media_id;
        if (id && !seenMedia.has(String(id))) mediaIds.add(String(id));
      }
    } catch (err) {
      if (!(err instanceof meta.MetaError) || !err.permission) throw err;
      warnings.push(`${acc.name || acc.id}: inserzioni non leggibili (${err.message})`);
    }
  }
  const ids = [...mediaIds];
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    const body = await meta.get(cfg, '', {
      ids: chunk.join(','), fields: `id,caption,permalink,timestamp,owner{id},comments.limit(25){${IG_COMMENT_FIELDS}}`,
    }, token);
    for (const id of chunk) {
      const media = body[id];
      if (!media) continue;
      const page = withIg.find((p) => p.ig.id === String(media.owner?.id)) || withIg[0];
      igCommentRows(db, page, media, true, rows, sinceMs);
    }
  }
}

// --- Salvataggio -------------------------------------------------------------------------

function saveRows(db, rows, cursor) {
  const insert = db.prepare(`
    INSERT INTO messages (id, source, kind, contact_type, account, thread_key, direction, counterpart_address,
      counterpart_name, subject, snippet, sent_at, link, customer_id)
    VALUES (@id, @source, @kind, @contact_type, @account, @thread_key, @direction, @counterpart_address,
      @counterpart_name, @subject, @snippet, @sent_at, @link, @customer_id)
    ON CONFLICT(id) DO NOTHING`);
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
    const pages = await meta.discoverPages(cfg, cfg.token);
    const rows = [];
    const seenMedia = new Set();
    for (const page of pages) {
      log(`[meta] ${page.name}${page.ig ? ' + @' + page.ig.username : ''}`);
      for (const [label, fn] of [['Messenger', readMessenger], ['DM Instagram', readInstagramDm]]) {
        try {
          await fn(cfg, page, sinceMs, rows, db);
        } catch (err) {
          if (!(err instanceof meta.MetaError) || !err.permission) throw err;
          warnings.push(`${page.name}: ${label} non leggibile (${err.message})`);
        }
      }
      await readFacebookComments(cfg, page, sinceMs, rows, db, warnings);
      try {
        for (const id of await readInstagramComments(cfg, page, sinceMs, rows, db)) seenMedia.add(id);
      } catch (err) {
        if (!(err instanceof meta.MetaError) || !err.permission) throw err;
        warnings.push(`${page.name}: commenti Instagram non leggibili (${err.message})`);
      }
    }
    await readInstagramAdComments(cfg, cfg.token, pages, seenMedia, sinceMs, rows, db, warnings);
    const { added, bySource } = saveRows(db, rows, { lastRunAt: now.toISOString() });
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

module.exports = { syncMeta, metaConfig, testConnection, SOURCE };
