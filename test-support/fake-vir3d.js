'use strict';
// Server finto che replica il contratto di vir3d.it (server/lib/formaops-read-api.ts, schema v1):
// stesso ordinamento (updatedAt, id), stesso cursore base64url canonico, stessa paginazione limit+1,
// stessi codici 401/503. Usato solo dai test.
const http = require('node:http');

function encodeCursor(updatedAt, id) {
  return Buffer.from(JSON.stringify({ updatedAt, id }), 'utf8').toString('base64url');
}
function decodeCursor(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('bad');
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new Error('non canonical');
  const p = JSON.parse(decoded);
  if (Object.keys(p).join() !== 'updatedAt,id') throw new Error('bad keys');
  return { updatedAt: new Date(p.updatedAt).getTime(), id: p.id };
}

function order(id, n, { updatedAt, name, email, phone, status = 'confirmed', total = 4990, items } = {}) {
  return {
    orderId: id, orderNumber: `VIR3D-${n}`, createdAt: updatedAt, updatedAt, status,
    paymentStatus: 'paid', paymentMethod: 'stripe', currency: 'EUR',
    subtotalMinor: total, shippingCostMinor: 0, taxAmountMinor: 0, discountAmountMinor: 0, totalAmountMinor: total,
    customer: { userId: null, name: name ?? null, email: email ?? null, phone: phone ?? null },
    fulfillment: { trackingNumber: null, estimatedDelivery: null, deliveredAt: null },
    items: items ?? [{ orderItemId: `${id}-1`, productId: 'p1', productName: 'Ambigramma Premium', quantity: 1,
      unitPriceMinor: total, totalPriceMinor: total, productionStatus: null }],
  };
}

function startFake({ key = 'chiave-test', orders = [] } = {}) {
  const state = { orders, failOnRequest: 0, requests: 0, schemaVersion: '1', configured: true };
  const server = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') return send(405, { error: 'method' });
    const url = new URL(req.url, 'http://x');
    if (!state.configured) return send(503, { error: 'FormaOps read API is not configured' });
    if (req.headers['x-formaops-api-key'] !== key) return send(401, { error: 'Invalid or missing FormaOps API key' });
    if (url.pathname === '/api/integrations/formaops/v1/health') {
      return send(200, { ok: true, integration: 'formaops', schemaVersion: '1' });
    }
    if (url.pathname !== '/api/integrations/formaops/v1/orders') return send(404, { error: 'not found' });
    state.requests++;
    if (state.failOnRequest && state.requests === state.failOnRequest) return send(500, { error: 'Unable to read orders' });
    const limit = Number(url.searchParams.get('limit') ?? 50);
    let rows = [...state.orders].sort((a, b) =>
      (Date.parse(a.updatedAt) - Date.parse(b.updatedAt)) || (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0));
    const cursorParam = url.searchParams.get('cursor');
    if (cursorParam) {
      let c;
      try { c = decodeCursor(cursorParam); } catch { return send(400, { error: 'Invalid orders query' }); }
      rows = rows.filter((o) => Date.parse(o.updatedAt) > c.updatedAt
        || (Date.parse(o.updatedAt) === c.updatedAt && o.orderId > c.id));
    }
    const page = rows.slice(0, limit + 1);
    const hasNext = page.length > limit;
    const items = page.slice(0, limit);
    const last = items.at(-1);
    send(200, { schemaVersion: state.schemaVersion, items, nextCursor: hasNext ? encodeCursor(last.updatedAt, last.orderId) : null });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, key, state, close: () => new Promise((r) => server.close(r)) });
  }));
}

module.exports = { startFake, order };
