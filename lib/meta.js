'use strict';

// Client della Graph API di Meta (Facebook e Instagram), SOLO LETTURA.
// Esegue esclusivamente richieste GET: nessuna risposta, nessun invio, nessuna modifica.

class MetaError extends Error {
  constructor(message, { code, permission = false, tooMuch = false } = {}) {
    super(message);
    this.code = code;
    this.permission = permission;
    this.tooMuch = tooMuch;
  }
}

function friendly(err) {
  const code = err.code;
  const msg = err.message || '';
  if (/reduce the amount of data/i.test(msg)) return new MetaError('Meta chiede di richiedere meno dati per volta.', { code, tooMuch: true });
  if (code === 190 || code === 102) return new MetaError('Meta ha rifiutato la chiave: è scaduta o non valida. Rigenerala dall\'utente di sistema.', { code });
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80001 || code === 80006) {
    return new MetaError('Meta chiede di rallentare (troppe richieste): riprova tra qualche minuto.', { code });
  }
  if (code === 10 || code === 200 || (code >= 200 && code < 300) || /permission/i.test(msg)) {
    return new MetaError(`Permesso mancante su Meta: ${msg}`, { code, permission: true });
  }
  return new MetaError(`Errore Meta: ${msg || 'risposta inattesa'}`, { code });
}

function config(env = process.env) {
  return {
    base: String(env.META_GRAPH_BASE || 'https://graph.facebook.com').replace(/\/+$/, ''),
    version: env.META_GRAPH_VERSION || 'v23.0',
  };
}

async function get(cfg, pathOrUrl, params = {}, token) {
  let url;
  if (/^https?:\/\//.test(pathOrUrl)) {
    url = new URL(pathOrUrl); // link "next" della paginazione: contiene già i parametri
    const base = new URL(cfg.base);
    if (url.host !== base.host) throw new MetaError('Link di paginazione inatteso.');
  } else {
    url = new URL(`${cfg.base}/${cfg.version}/${pathOrUrl.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  if (token) url.searchParams.set('access_token', token);
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(cfg.timeoutMs || 60000) });
  } catch (err) {
    // Una risposta che non arriva in tempo di solito vuol dire "troppi dati in una volta": si riprova con meno.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new MetaError('Meta non ha risposto in tempo.', { tooMuch: true });
    }
    throw new MetaError(`Meta non raggiungibile: ${err.message}`);
  }
  let body;
  try { body = await res.json(); } catch { throw new MetaError(`Meta ha risposto ${res.status} con un contenuto non valido.`); }
  if (body && body.error) throw friendly(body.error);
  if (!res.ok) throw new MetaError(`Meta ha risposto ${res.status}.`);
  return body;
}

// Riduce i limiti di una richiesta: "limit" della pagina e i ".limit(N)" dei campi annidati.
function shrink(params) {
  const out = { ...params };
  if (out.limit) out.limit = Math.max(1, Math.floor(Number(out.limit) / 2));
  if (out.fields) out.fields = String(out.fields).replace(/\.limit\((\d+)\)/g, (_, n) => `.limit(${Math.max(1, Math.floor(n / 2))})`);
  return out;
}

function shrinkUrl(next) {
  const u = new URL(next);
  const p = Object.fromEntries(u.searchParams);
  for (const [k, v] of Object.entries(shrink(p))) u.searchParams.set(k, v);
  return u.href;
}

// Se Meta risponde "richiedi meno dati", riprova dimezzando i limiti (fino a 5 volte).
async function getAdaptive(cfg, pathOrUrl, params, token) {
  let p = params;
  let u = pathOrUrl;
  for (let attempt = 0; ; attempt++) {
    try {
      return await get(cfg, u, p, token);
    } catch (err) {
      if (!(err instanceof MetaError) || !err.tooMuch || attempt >= 5) throw err;
      if (/^https?:\/\//.test(u)) u = shrinkUrl(u); else p = shrink(p);
    }
  }
}

// Scorre le pagine di un elenco. stop(item) === true interrompe (elementi ordinati dal più recente).
async function list(cfg, path, params, token, { maxPages = 10, stop } = {}) {
  const out = [];
  let body = await getAdaptive(cfg, path, params, token);
  for (let page = 0; page < maxPages; page++) {
    for (const item of body.data || []) {
      if (stop && stop(item)) return out;
      out.push(item);
    }
    const next = body.paging && body.paging.next;
    if (!next || !(body.data || []).length) break;
    body = await getAdaptive(cfg, next, {}, token);
  }
  return out;
}

// Pagine Facebook (e account Instagram collegati) a cui la chiave dell'utente di sistema ha accesso.
async function discoverPages(cfg, token) {
  if (!token) throw new MetaError('Manca la chiave Meta: inseriscila in Impostazioni.');
  const pages = await list(cfg, 'me/accounts', {
    fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100,
  }, token);
  return pages.map((p) => ({
    id: String(p.id),
    name: p.name,
    token: p.access_token,
    ig: p.instagram_business_account
      ? { id: String(p.instagram_business_account.id), username: String(p.instagram_business_account.username || '').toLowerCase() }
      : null,
  }));
}

module.exports = { MetaError, config, get, getAdaptive, list, discoverPages, shrink };
