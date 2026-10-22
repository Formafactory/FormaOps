'use strict';
// Graph API finta (Facebook/Instagram) per i test. Registra ogni richiesta per verificare che siano solo GET.
const http = require('node:http');

const SYS = 'chiave-sistema';
const d = (now, n) => new Date(now - n * 86400000).toISOString();

function defaultData(now = Date.now()) {
  return {
    pages: [
      { id: 'P1', name: 'Vir3D', access_token: 'PT1', instagram_business_account: { id: 'IG1', username: 'Vir3D.it' } },
      { id: 'P2', name: 'De Artis Digitale', access_token: 'PT2' },
    ],
    conversations: {
      'P1:messenger': [
        { id: 'c1', updated_time: d(now, 1), link: '/vir3d/inbox/c1', participants: { data: [{ id: 'P1', name: 'Vir3D' }, { id: 'U1', name: 'Mario Rossi', email: 'U1@facebook.com' }] },
          messages: { data: [
            { id: 'm2', created_time: d(now, 1), from: { id: 'U1', name: 'Mario Rossi' }, message: 'Avete ancora l\'ambigramma oro?' },
            { id: 'm1', created_time: d(now, 2), from: { id: 'P1', name: 'Vir3D' }, message: 'Ciao Mario, come possiamo aiutarti?' },
          ] } },
        { id: 'c2', updated_time: d(now, 3), participants: { data: [{ id: 'U2', name: 'Lucia Bianchi' }, { id: 'P1', name: 'Vir3D' }] },
          messages: { data: [{ id: 'm3', created_time: d(now, 3), from: { id: 'P1' }, message: 'Spedito oggi!' },
            { id: 'm4', created_time: d(now, 3.1), from: { id: 'U2', name: 'Lucia Bianchi' }, message: 'Quando spedite?' }] } },
        { id: 'c3', updated_time: d(now, 60), participants: { data: [{ id: 'U3', name: 'Vecchio' }, { id: 'P1' }] },
          messages: { data: [{ id: 'm5', created_time: d(now, 60), from: { id: 'U3' }, message: 'vecchio' }] } },
      ],
      'P1:instagram': [
        { id: 'ic1', updated_time: d(now, 0.5), participants: { data: [{ id: 'IG1', username: 'vir3d.it' }, { id: 'IGU1', username: 'Anna.Verdi' }] },
          messages: { data: [{ id: 'im1', created_time: d(now, 0.5), from: { id: 'IGU1', username: 'anna.verdi' }, message: 'Fate anche mezzibusti?' }] } },
      ],
      'P2:messenger': [],
    },
    posts: {
      'P1:published_posts': [
        { id: 'P1_post1', created_time: d(now, 5), message: 'Nuovo ambigramma in resina oro', permalink_url: 'https://facebook.com/p1',
          comments: { data: [
            { id: 'fc1', created_time: d(now, 2), from: { id: 'U4', name: 'Giulia Neri' }, message: 'Prezzo?', permalink_url: 'https://facebook.com/c/fc1',
              comments: { data: [{ id: 'fc2', created_time: d(now, 1.5), from: { id: 'P1', name: 'Vir3D' }, message: 'Ti scriviamo in privato!' }] } },
            { id: 'fc3', created_time: d(now, 1), from: { id: 'P1', name: 'Vir3D' }, message: 'Grazie a tutti' },
            { id: 'fc4', created_time: d(now, 1), message: 'Autore nascosto' },
          ] } },
      ],
      'P1:ads_posts': [
        { id: 'P1_ad1', created_time: d(now, 10), message: 'Il regalo perfetto per San Valentino', permalink_url: 'https://facebook.com/ad1',
          comments: { data: [{ id: 'fc5', created_time: d(now, 1), from: { id: 'U5', name: 'Paolo Verde' }, message: 'Spedite in Svizzera?' }] } },
      ],
      'P2:published_posts': [],
      'P2:ads_posts': { error: { code: 200, message: 'Requires ads_read permission' } },
    },
    media: {
      IG1: [
        { id: 'M1', caption: 'Mezzobusto finitura bronzo', permalink: 'https://instagram.com/p/M1', timestamp: d(now, 4),
          comments: { data: [
            { id: 'ig1', text: 'Stupendo! Quanto costa?', timestamp: d(now, 1), username: 'marco_b',
              replies: { data: [{ id: 'ig2', text: 'Grazie! Ti scriviamo in DM', timestamp: d(now, 0.9), username: 'vir3d.it' }] } },
          ] } },
      ],
    },
    adaccounts: [{ id: 'act_1', name: 'Vir3D Ads' }],
    ads: { act_1: [{ id: 'ad1', creative: { effective_instagram_media_id: 'MAD1' } }, { id: 'ad2', creative: { effective_instagram_media_id: 'M1' } }] },
    adMedia: {
      MAD1: { id: 'MAD1', caption: 'Inserzione: ambigramma per la festa della mamma', permalink: 'https://instagram.com/p/MAD1',
        timestamp: d(now, 20), owner: { id: 'IG1' },
        comments: { data: [{ id: 'ig3', text: 'Si può personalizzare con 3 nomi?', timestamp: d(now, 2), username: 'sara.m' }] } },
    },
  };
}

function startFakeMeta(data = defaultData()) {
  const state = { data, requests: [], pageSize: 2 };
  let base;
  const server = http.createServer((req, res) => {
    state.requests.push({ method: req.method, url: req.url });
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') return send(405, { error: { code: 1, message: 'only GET in tests' } });
    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('access_token');
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // senza la versione
    const pageTokens = Object.fromEntries(data.pages.map((p) => [p.access_token, p.id]));
    if (token !== SYS && !pageTokens[token]) return send(400, { error: { code: 190, message: 'Invalid OAuth access token.' } });

    const paged = (items, key) => {
      if (items && items.error) return send(400, items);
      const after = Number(url.searchParams.get('after') || 0);
      const slice = (items || []).slice(after, after + state.pageSize);
      const body = { data: slice };
      if (after + state.pageSize < (items || []).length) {
        const next = new URL(base + url.pathname);
        for (const [k, v] of url.searchParams) next.searchParams.set(k, v);
        next.searchParams.set('after', String(after + state.pageSize));
        body.paging = { next: next.href };
      }
      return send(200, body);
    };

    if (parts.join('/') === 'me/accounts') {
      if (token !== SYS) return send(400, { error: { code: 190, message: 'Invalid OAuth access token.' } });
      return paged(data.pages);
    }
    if (parts.join('/') === 'me/adaccounts') return paged(data.adaccounts);
    if (parts.length === 0 && url.searchParams.get('ids')) {
      const out = {};
      for (const id of url.searchParams.get('ids').split(',')) if (data.adMedia[id]) out[id] = data.adMedia[id];
      return send(200, out);
    }
    const [id, edge] = parts;
    if (edge === 'conversations') {
      if (pageTokens[token] !== id) return send(400, { error: { code: 190, message: 'Page token required' } });
      const convs = [...(data.conversations[`${id}:${url.searchParams.get('platform')}`] || [])]
        .sort((a, b) => Date.parse(b.updated_time) - Date.parse(a.updated_time));
      return paged(convs);
    }
    if (edge === 'published_posts' || edge === 'ads_posts') {
      if (pageTokens[token] !== id) return send(400, { error: { code: 190, message: 'Page token required' } });
      return paged(data.posts[`${id}:${edge}`] || []);
    }
    if (edge === 'media') return paged(data.media[id] || []);
    if (edge === 'ads') return paged(data.ads[id] || []);
    return send(404, { error: { code: 803, message: `Unknown path ${url.pathname}` } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, state, cfg: { base, version: 'v23.0', token: SYS, days: 30 }, close: () => new Promise((r) => server.close(r)) });
  }));
}

module.exports = { startFakeMeta, defaultData, SYS };
