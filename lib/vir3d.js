'use strict';

// Client dell'API di sola lettura che vir3d.it espone per FormaOps.
// Contratto (schema v1): GET /api/integrations/formaops/v1/health
//                        GET /api/integrations/formaops/v1/orders?limit=&cursor=
// Header: X-FormaOps-Api-Key. Importi in centesimi (minor units).
// Questo modulo esegue solo richieste GET.

const SCHEMA_VERSION = '1';
const BASE_PATH = '/api/integrations/formaops/v1';

class Vir3dError extends Error {}

function config(env = process.env) {
  const base = String(env.VIR3D_API_BASE || 'https://vir3d.it').replace(/\/+$/, '');
  const key = env.VIR3D_API_KEY || '';
  return { base, key };
}

async function getJson({ base, key }, path, query = {}) {
  if (!key) throw new Vir3dError('Manca VIR3D_API_KEY nel file .env.');
  const url = new URL(base + BASE_PATH + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'X-FormaOps-Api-Key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new Vir3dError(`vir3d.it non raggiungibile: ${err.message}`);
  }
  if (res.status === 401) throw new Vir3dError('vir3d.it ha rifiutato la chiave (401): controlla VIR3D_API_KEY.');
  if (res.status === 503) throw new Vir3dError('Su vir3d.it l\'accesso FormaOps non è configurato (503).');
  if (!res.ok) throw new Vir3dError(`vir3d.it ha risposto ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new Vir3dError('vir3d.it ha risposto con un contenuto non valido.');
  }
}

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isStrOrNull = (v) => v === null || typeof v === 'string';
const isInt = (v) => Number.isSafeInteger(v);

// Valida l'intera pagina prima di scrivere qualsiasi cosa.
function validatePage(body) {
  if (!body || body.schemaVersion !== SCHEMA_VERSION) {
    throw new Vir3dError(`Versione dello schema inattesa: ${body && body.schemaVersion}. Atteso ${SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(body.items)) throw new Vir3dError('Risposta senza elenco ordini.');
  if (!isStrOrNull(body.nextCursor)) throw new Vir3dError('Cursore non valido.');
  body.items.forEach((o, i) => {
    const where = `ordine #${i + 1} della pagina`;
    const ok = isStr(o.orderId) && isStr(o.orderNumber) && isStr(o.updatedAt) && isStr(o.status) && isStr(o.currency)
      && [o.subtotalMinor, o.shippingCostMinor, o.discountAmountMinor, o.totalAmountMinor].every(isInt)
      && o.customer && typeof o.customer === 'object'
      && isStrOrNull(o.customer.email) && isStrOrNull(o.customer.phone) && isStrOrNull(o.customer.name)
      && Array.isArray(o.items);
    if (!ok) throw new Vir3dError(`Dati non validi nel ${where} (${o && o.orderNumber}).`);
    o.items.forEach((it) => {
      if (!(isStr(it.orderItemId) && typeof it.productName === 'string' && isInt(it.quantity)
        && isInt(it.unitPriceMinor) && isInt(it.totalPriceMinor))) {
        throw new Vir3dError(`Riga prodotto non valida nell'ordine ${o.orderNumber}.`);
      }
    });
  });
  return body;
}

// Stesso formato del cursore che vir3d.it produce: base64url di {"updatedAt","id"}.
function cursorAfter(order) {
  return Buffer.from(JSON.stringify({ updatedAt: order.updatedAt, id: order.orderId }), 'utf8').toString('base64url');
}

async function health(cfg) {
  const body = await getJson(cfg, '/health');
  if (!body.ok || body.schemaVersion !== SCHEMA_VERSION) throw new Vir3dError('Health check di vir3d.it non valido.');
  return body;
}

async function fetchOrdersPage(cfg, { cursor, limit = 100 }) {
  return validatePage(await getJson(cfg, '/orders', { limit, cursor: cursor || undefined }));
}

module.exports = { Vir3dError, config, health, fetchOrdersPage, validatePage, cursorAfter, SCHEMA_VERSION };
