'use strict';

// DM Instagram tramite "Instagram API con login Instagram" (graph.instagram.com), SOLO LETTURA.
// Usa la chiave dell'account Instagram (dura 60 giorni): viene rinnovata da sola ogni settimana.
const meta = require('./meta');
const { normalizeHandle } = require('./normalize');

function igConfig(base) {
  return {
    base: String(process.env.IG_GRAPH_BASE || 'https://graph.instagram.com').replace(/\/+$/, ''),
    version: process.env.IG_GRAPH_VERSION || base.version || 'v26.0',
    timeoutMs: base.timeoutMs,
    retryDelayMs: base.retryDelayMs,
  };
}

function toMs(t) {
  if (t === undefined || t === null) return NaN;
  if (typeof t === 'number' || /^\d+$/.test(String(t))) return Number(t) * (String(t).length <= 10 ? 1000 : 1);
  return Date.parse(t);
}

async function whoAmI(cfg, token) {
  const me = await meta.getAdaptive(cfg, 'me', { fields: 'user_id,username' }, token);
  return { id: String(me.user_id || me.id), username: normalizeHandle(me.username) };
}

// Rinnovo: Meta lo permette su chiavi con almeno 24 ore; restituisce una chiave valida altri 60 giorni.
async function refreshToken(cfg, token) {
  const url = `${cfg.base}/refresh_access_token?grant_type=ig_refresh_token`;
  const body = await meta.get({ ...cfg, base: cfg.base }, url, {}, token);
  if (!body.access_token) throw new meta.MetaError('Rinnovo della chiave Instagram non riuscito.');
  return body.access_token;
}

async function readDms(cfg, token, sinceMs, { log = () => {} } = {}) {
  const me = await whoAmI(cfg, token);
  log(`[instagram] DM di @${me.username}`);
  const convs = await meta.list(cfg, 'me/conversations', { platform: 'instagram', fields: 'id,updated_time', limit: 20 },
    token, { maxPages: 10, stop: (c) => toMs(c.updated_time) < sinceMs });
  const out = [];
  let failed = 0;
  for (const conv of convs) {
    try {
      const body = await meta.getAdaptive(cfg, String(conv.id),
        { fields: 'messages.limit(10){id,created_time,from,to,message}' }, token);
      out.push({ conv, me, messages: body.messages?.data || [] });
    } catch (err) {
      if (!(err instanceof meta.MetaError) || err.fatal) throw err;
      failed++;
    }
  }
  return { me, threads: out, failed };
}

module.exports = { igConfig, whoAmI, refreshToken, readDms, toMs };
