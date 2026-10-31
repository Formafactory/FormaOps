-- Relationship Intelligence e stati dell'Inbox.

-- Relazione scelta a mano da Gianluca. NULL = automatica (calcolata da regole fisse in lib/inbox.js).
ALTER TABLE customers ADD COLUMN relationship TEXT
  CHECK (relationship IS NULL OR relationship IN ('cliente', 'lead', 'b2b', 'fornitore', 'personale'));

-- Stato messo a mano su una conversazione. Senza riga lo stato è automatico:
-- ultimo messaggio del cliente = da rispondere, ultimo messaggio tuo = in attesa.
-- seen_last_in = ultimo messaggio ricevuto quando lo stato è stato messo: se ne arriva uno più recente
-- la conversazione torna da sola "da rispondere".
CREATE TABLE thread_state (
  thread_key    TEXT PRIMARY KEY,
  status        TEXT NOT NULL CHECK (status IN ('in_attesa', 'rimandata', 'chiusa')),
  snooze_until  TEXT,
  seen_last_in  TEXT,
  set_at        TEXT NOT NULL
);
