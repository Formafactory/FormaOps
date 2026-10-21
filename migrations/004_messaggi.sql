-- Messaggi dai canali (per ora Gmail; poi Messenger, Instagram, commenti).
-- Chiave primaria stabile per canale: reimportare non crea doppioni.
CREATE TABLE messages (
  id                    TEXT PRIMARY KEY,
  source                TEXT NOT NULL,
  thread_key            TEXT NOT NULL,
  direction             TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  counterpart_address   TEXT NOT NULL,
  counterpart_name      TEXT,
  subject               TEXT,
  snippet               TEXT,
  sent_at               TEXT NOT NULL,
  link                  TEXT,
  customer_id           INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  imported_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX messages_thread ON messages(thread_key, sent_at);
CREATE INDEX messages_customer ON messages(customer_id, sent_at);
CREATE INDEX messages_counterpart ON messages(counterpart_address);
CREATE INDEX messages_sent ON messages(sent_at);

-- Mittenti da non mostrare (newsletter, notifiche, fornitori…). Una voce che inizia con "@" vale per tutto il dominio.
CREATE TABLE ignored_senders (
  pattern     TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
