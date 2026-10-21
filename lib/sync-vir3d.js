'use strict';

// Sincronizzazione ordini Vir3D -> FormaOps.
// - Ogni pagina viene validata per intero, poi salvata in UNA transazione insieme al cursore:
//   se qualcosa si interrompe, la prossima esecuzione riparte dall'ultima pagina salvata.
// - Upsert sull'ID ordine Vir3D: rieseguire non crea doppioni.
// - Sola lettura verso vir3d.it.

const vir3d = require('./vir3d');
const { resolveCustomer } = require('./identity');

const SOURCE = 'vir3d';
let running = false;

function getState(db) {
  return db.prepare('SELECT * FROM sync_state WHERE source = ?').get(SOURCE)
    ?? { source: SOURCE, cursor: null, last_run_at: null, last_ok_at: null, last_error: null, last_imported: 0 };
}

function savePage(db, page) {
  const findOrder = db.prepare('SELECT customer_id FROM orders WHERE id = ?');
  const upsertOrder = db.prepare(`
    INSERT INTO orders (id, order_number, customer_id, match_reason, created_at, updated_at, status,
      payment_status, payment_method, currency, subtotal_minor, shipping_minor, discount_minor, total_minor,
      customer_name, customer_email, customer_phone, remote_user_id, tracking_number, estimated_delivery, delivered_at)
    VALUES (@id, @order_number, @customer_id, @match_reason, @created_at, @updated_at, @status,
      @payment_status, @payment_method, @currency, @subtotal_minor, @shipping_minor, @discount_minor, @total_minor,
      @customer_name, @customer_email, @customer_phone, @remote_user_id, @tracking_number, @estimated_delivery, @delivered_at)
    ON CONFLICT(id) DO UPDATE SET
      order_number = excluded.order_number, updated_at = excluded.updated_at, status = excluded.status,
      payment_status = excluded.payment_status, payment_method = excluded.payment_method,
      currency = excluded.currency, subtotal_minor = excluded.subtotal_minor, shipping_minor = excluded.shipping_minor,
      discount_minor = excluded.discount_minor, total_minor = excluded.total_minor,
      customer_name = excluded.customer_name, customer_email = excluded.customer_email,
      customer_phone = excluded.customer_phone, remote_user_id = excluded.remote_user_id,
      tracking_number = excluded.tracking_number, estimated_delivery = excluded.estimated_delivery,
      delivered_at = excluded.delivered_at, refreshed_at = datetime('now')`);
  const deleteItems = db.prepare('DELETE FROM order_items WHERE order_id = ?');
  const insertItem = db.prepare(`INSERT INTO order_items
    (id, order_id, product_id, product_name, quantity, unit_price_minor, total_price_minor, production_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const touchCustomer = db.prepare(`UPDATE customers SET updated_at = datetime('now') WHERE id = ?`);
  const saveCursor = db.prepare(`
    INSERT INTO sync_state (source, cursor) VALUES (?, ?)
    ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor`);

  const stats = { nuovi: 0, aggiornati: 0, clientiNuovi: 0 };
  db.transaction(() => {
    for (const o of page.items) {
      const existing = findOrder.get(o.orderId);
      let customerId = existing ? existing.customer_id : null;
      let matchReason = null;
      // Un ordine già abbinato resta dov'è (anche se lo hai spostato a mano).
      if (!customerId) {
        const r = resolveCustomer(db, {
          name: o.customer.name, email: o.customer.email, phone: o.customer.phone,
          brand: 'vir3d', source: SOURCE, refId: o.orderNumber,
        });
        customerId = r.customerId;
        matchReason = r.reason;
        if (r.reason === 'nuovo') stats.clientiNuovi++;
      }
      upsertOrder.run({
        id: o.orderId, order_number: o.orderNumber, customer_id: customerId, match_reason: matchReason,
        created_at: o.createdAt ?? null, updated_at: o.updatedAt, status: o.status,
        payment_status: o.paymentStatus ?? null, payment_method: o.paymentMethod ?? null, currency: o.currency,
        subtotal_minor: o.subtotalMinor, shipping_minor: o.shippingCostMinor, discount_minor: o.discountAmountMinor,
        total_minor: o.totalAmountMinor, customer_name: o.customer.name, customer_email: o.customer.email,
        customer_phone: o.customer.phone, remote_user_id: o.customer.userId ?? null,
        tracking_number: o.fulfillment?.trackingNumber ?? null,
        estimated_delivery: o.fulfillment?.estimatedDelivery ?? null,
        delivered_at: o.fulfillment?.deliveredAt ?? null,
      });
      deleteItems.run(o.orderId);
      for (const it of o.items) {
        insertItem.run(it.orderItemId, o.orderId, it.productId ?? null, it.productName, it.quantity,
          it.unitPriceMinor, it.totalPriceMinor, it.productionStatus ?? null);
      }
      touchCustomer.run(customerId);
      if (existing) stats.aggiornati++; else stats.nuovi++;
    }
    if (page.items.length > 0) saveCursor.run(SOURCE, vir3d.cursorAfter(page.items.at(-1)));
  })();
  return stats;
}

async function syncVir3d(db, { cfg = vir3d.config(), pageSize = 100, maxPages = 1000, log = () => {} } = {}) {
  if (running) return { skipped: true, reason: 'Sincronizzazione già in corso' };
  running = true;
  const startedAt = new Date().toISOString();
  db.prepare(`INSERT INTO sync_state (source, last_run_at) VALUES (?, ?)
              ON CONFLICT(source) DO UPDATE SET last_run_at = excluded.last_run_at`).run(SOURCE, startedAt);
  const totals = { pagine: 0, nuovi: 0, aggiornati: 0, clientiNuovi: 0 };
  try {
    for (let i = 0; i < maxPages; i++) {
      const { cursor } = getState(db);
      const page = await vir3d.fetchOrdersPage(cfg, { cursor, limit: pageSize });
      if (page.items.length === 0) break;
      const s = savePage(db, page);
      totals.pagine++;
      totals.nuovi += s.nuovi;
      totals.aggiornati += s.aggiornati;
      totals.clientiNuovi += s.clientiNuovi;
      log(`[vir3d] pagina ${totals.pagine}: ${page.items.length} ordini (${s.nuovi} nuovi, ${s.aggiornati} aggiornati)`);
      if (!page.nextCursor) break;
    }
    db.prepare(`UPDATE sync_state SET last_ok_at = ?, last_error = NULL, last_imported = ? WHERE source = ?`)
      .run(new Date().toISOString(), totals.nuovi + totals.aggiornati, SOURCE);
    return { ok: true, ...totals };
  } catch (err) {
    db.prepare('UPDATE sync_state SET last_error = ? WHERE source = ?').run(err.message, SOURCE);
    return { ok: false, error: err.message, ...totals };
  } finally {
    running = false;
  }
}

module.exports = { syncVir3d, getState, savePage, SOURCE };
