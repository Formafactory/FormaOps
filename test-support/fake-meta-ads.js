'use strict';
// Marketing API finta per i test del modulo ADV. Serve le fixture JSON di test-support/fixtures/meta-ads,
// registra ogni richiesta (per verificare che siano solo GET) e può simulare errori di Meta.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN = 'token-finto-solo-per-i-test-123';
const ACCOUNT = 'act_1095600805179325';
const DIR = path.join(__dirname, 'fixtures', 'meta-ads');

function loadFixtures() {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  return {
    adaccounts: read('adaccounts.json'), account: read('account.json'), campaigns: read('campaigns.json'),
    adsets: read('adsets.json'), ads: read('ads.json'), insights: read('insights.json'),
  };
}

function startFakeMetaAds(data = loadFixtures()) {
  // failNext: errori da restituire alle prossime richieste che corrispondono a "path" (una voce per richiesta).
  const state = { data, requests: [], pageSize: 3, failNext: [] };
  let base;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push({ method: req.method, url: req.url, path: url.pathname });
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') return send(405, { error: { code: 3, message: 'Solo GET nei test' } });
    if (url.searchParams.get('access_token') !== TOKEN) {
      return send(400, { error: { code: 190, type: 'OAuthException', message: 'Invalid OAuth access token - Cannot parse access token' } });
    }
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // senza la versione
    const route = parts.join('/');
    const fail = state.failNext.findIndex((f) => route.endsWith(f.path));
    if (fail >= 0) {
      const f = state.failNext.splice(fail, 1)[0];
      if (f.drop) { req.socket.destroy(); return; }
      return send(f.status || 400, { error: f.error });
    }

    const paged = (items) => {
      const after = Number(url.searchParams.get('after') || 0);
      const body = { data: items.slice(after, after + state.pageSize) };
      if (after + state.pageSize < items.length) {
        const next = new URL(base + url.pathname);
        for (const [k, v] of url.searchParams) next.searchParams.set(k, v); // come Meta: il link contiene il token
        next.searchParams.set('after', String(after + state.pageSize));
        body.paging = { cursors: { after: String(after + state.pageSize) }, next: next.href };
      }
      return send(200, body);
    };

    if (route === 'me/adaccounts') return send(200, data.adaccounts);
    if (route === 'debug_token') return send(200, { data: { is_valid: true, scopes: ['ads_read'] } });
    if (route === ACCOUNT) return send(200, data.account);
    if (route === `${ACCOUNT}/campaigns`) return paged(data.campaigns);
    if (route === `${ACCOUNT}/adsets`) return paged(data.adsets);
    if (route === `${ACCOUNT}/ads`) return paged(data.ads);
    if (route === `${ACCOUNT}/insights`) {
      if (url.searchParams.get('level') !== 'ad' || url.searchParams.get('time_increment') !== '1') {
        return send(400, { error: { code: 100, message: 'Il test si aspetta level=ad e time_increment=1' } });
      }
      const range = JSON.parse(url.searchParams.get('time_range'));
      return paged(data.insights.filter((r) => r.date_start >= range.since && r.date_start <= range.until));
    }
    return send(404, { error: { code: 803, message: `Percorso sconosciuto ${url.pathname}` } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve({
      base, state,
      cfg: { base, version: 'v23.0', token: TOKEN, accountId: ACCOUNT, brand: 'vir3d', retryDelayMs: 1 },
      close: () => new Promise((r) => server.close(r)),
    });
  }));
}

module.exports = { startFakeMetaAds, loadFixtures, TOKEN, ACCOUNT };
