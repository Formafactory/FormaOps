-- Ordini letti da vir3d.it (API FormaOps in sola lettura, schema v1).
-- Chiave primaria = ID ordine Vir3D: reimportare lo stesso ordine lo aggiorna, non lo duplica.
CREATE TABLE orders (
  id                    TEXT PRIMARY KEY,
  source                TEXT NOT NULL DEFAULT 'vir3d',
  order_number          TEXT NOT NULL,
  customer_id           INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  match_reason          TEXT,
  created_at            TEXT,
  updated_at            TEXT NOT NULL,
  status                TEXT NOT NULL,
  payment_status        TEXT,
  payment_method        TEXT,
  currency              TEXT NOT NULL,
  subtotal_minor        INTEGER NOT NULL,
  shipping_minor        INTEGER NOT NULL,
  discount_minor        INTEGER NOT NULL,
  total_minor           INTEGER NOT NULL,
  customer_name         TEXT,
  customer_email        TEXT,
  customer_phone        TEXT,
  remote_user_id        TEXT,
  tracking_number       TEXT,
  estimated_delivery    TEXT,
  delivered_at          TEXT,
  imported_at           TEXT NOT NULL DEFAULT (datetime('now')),
  refreshed_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX orders_customer ON orders(customer_id, created_at);
CREATE INDEX orders_number ON orders(order_number);

CREATE TABLE order_items (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id         TEXT,
  product_name       TEXT NOT NULL,
  quantity           INTEGER NOT NULL,
  unit_price_minor   INTEGER NOT NULL,
  total_price_minor  INTEGER NOT NULL,
  production_status  TEXT
);
CREATE INDEX order_items_order ON order_items(order_id);

-- Stato della sincronizzazione per sorgente: il cursore avanza solo insieme ai dati salvati.
CREATE TABLE sync_state (
  source          TEXT PRIMARY KEY,
  cursor          TEXT,
  last_run_at     TEXT,
  last_ok_at      TEXT,
  last_error      TEXT,
  last_imported   INTEGER NOT NULL DEFAULT 0
);

-- Casi che il sistema non decide da solo: li risolve Gianluca.
CREATE TABLE review_items (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  source       TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  customer_id  INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  detail       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT,
  UNIQUE (kind, source, ref_id, detail)
);
