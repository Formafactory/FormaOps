'use strict';
// Server OpenAI finto: /v1/models e /v1/chat/completions. Solo per i test.
const http = require('node:http');

function startFakeOpenAI({ key = 'sk-test' } = {}) {
  const state = { requests: [], reply: 'Ciao! Ecco la bozza.', status: 200, error: null };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      state.requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: { message: 'Incorrect API key provided' } });
      if (state.status !== 200) return send(state.status, { error: { message: state.error || 'errore' } });
      if (req.url === '/v1/models') {
        return send(200, { data: [{ id: 'gpt-big' }, { id: 'gpt-small-mini' }, { id: 'whisper-1' }, { id: 'gpt-realtime-mini' }, { id: 'text-embedding-3-small' }] });
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        return send(200, { choices: [{ message: { role: 'assistant', content: state.reply } }], usage: { prompt_tokens: 1200, completion_tokens: 80 } });
      }
      return send(404, { error: { message: 'not found' } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}/v1`;
    resolve({ state, base, close: () => new Promise((r) => server.close(r)) });
  }));
}

module.exports = { startFakeOpenAI };
