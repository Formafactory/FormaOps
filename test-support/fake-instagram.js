'use strict';
// Finta graph.instagram.com (API con login Instagram) per i test: solo GET.
const http = require('node:http');

function startFakeInstagram({ token = 'IGtoken', now = Date.now() } = {}) {
  const d = (n) => new Date(now - n * 86400000).toISOString().replace('Z', '+0000');
  const unix = (n) => Math.floor((now - n * 86400000) / 1000);
  const state = {
    token, requests: [], refreshed: 0,
    convs: [
      { id: 'icA', updated_time: unix(0.5), messages: [
        { id: 'imA2', created_time: d(0.5), from: { id: '17', username: 'anna.verdi' }, to: { data: [{ id: '99', username: 'vir3ditalia' }] }, message: 'Fate anche mezzibusti?' },
        { id: 'imA1', created_time: d(1), from: { id: '99', username: 'vir3ditalia' }, to: { data: [{ id: '17', username: 'anna.verdi' }] }, message: 'Ciao Anna!' },
      ] },
      { id: 'icB', updated_time: unix(2), messages: [
        { id: 'imB1', created_time: d(2), from: { id: '18', username: 'Marco_B' }, to: { data: [{ id: '99', username: 'vir3ditalia' }] }, message: 'Prezzo del ritratto 3D?' },
      ] },
      { id: 'icOld', updated_time: unix(40), messages: [
        { id: 'imOld', created_time: d(40), from: { id: '19', username: 'vecchio' }, message: 'vecchio' },
      ] },
    ],
  };
  const server = http.createServer((req, res) => {
    state.requests.push({ method: req.method, url: req.url });
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') return send(405, { error: { code: 1, message: 'only GET' } });
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('access_token') !== state.token) return send(400, { error: { code: 190, message: 'Invalid OAuth access token' } });
    if (url.pathname === '/refresh_access_token') {
      state.refreshed++;
      state.token = `IGtoken-r${state.refreshed}`;
      return send(200, { access_token: state.token, token_type: 'bearer', expires_in: 5184000 });
    }
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    if (parts.join('/') === 'me') return send(200, { user_id: '99', username: 'vir3ditalia' });
    if (parts.join('/') === 'me/conversations') {
      const list = [...state.convs].sort((a, b) => b.updated_time - a.updated_time).map((c) => ({ id: c.id, updated_time: c.updated_time }));
      return send(200, { data: list });
    }
    const conv = state.convs.find((c) => c.id === parts[0]);
    if (conv) return send(200, { id: conv.id, messages: { data: conv.messages } });
    return send(404, { error: { code: 803, message: 'not found' } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, state, close: () => new Promise((r) => server.close(r)) });
  }));
}

module.exports = { startFakeInstagram };
