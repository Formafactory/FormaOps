CREATE TABLE customers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  brand       TEXT NOT NULL CHECK (brand IN ('vir3d', 'deartis', 'entrambi')),
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE contacts (
  id                INTEGER PRIMARY KEY,
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('email', 'phone', 'instagram', 'facebook')),
  value_raw         TEXT NOT NULL,
  value_normalized  TEXT NOT NULL CHECK (value_normalized <> ''),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (type, value_normalized)
);

CREATE INDEX contacts_customer ON contacts(customer_id);
CREATE INDEX customers_name ON customers(name COLLATE NOCASE);
