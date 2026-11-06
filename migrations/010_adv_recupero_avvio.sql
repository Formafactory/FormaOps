-- Modulo ADV: adv_sync_runs accetta anche il giro "avvio" (recupero all'avvio se l'ultimo giro riuscito
-- ha più di 24 ore). SQLite non permette di cambiare un CHECK: si ricostruisce la tabella conservando i dati.
-- Tocca solo tabelle create dalla 009. Ordine pensato per non rompere mai il legame
-- adv_raw_responses.run_id -> adv_sync_runs.id (le chiavi esterne restano attive durante le migrazioni).

CREATE TABLE adv_sync_runs_new (
  id           INTEGER PRIMARY KEY,
  account_id   TEXT,
  trigger      TEXT NOT NULL CHECK (trigger IN ('notte', 'manuale', 'avvio')),
  since_date   TEXT,
  until_date   TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  ok           INTEGER,                         -- NULL = in corso, 1 = riuscita, 0 = errore
  rows_written INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
INSERT INTO adv_sync_runs_new (id, account_id, trigger, since_date, until_date, started_at, finished_at, ok, rows_written, error)
SELECT id, account_id, trigger, since_date, until_date, started_at, finished_at, ok, rows_written, error FROM adv_sync_runs;

-- le risposte grezze si mettono da parte mentre si sostituisce la tabella dei giri
CREATE TEMP TABLE adv_raw_responses_copy AS SELECT id, run_id, fetched_at, endpoint, params, body FROM adv_raw_responses;
DELETE FROM adv_raw_responses;

DROP TABLE adv_sync_runs;
ALTER TABLE adv_sync_runs_new RENAME TO adv_sync_runs;

INSERT INTO adv_raw_responses (id, run_id, fetched_at, endpoint, params, body)
SELECT id, run_id, fetched_at, endpoint, params, body FROM adv_raw_responses_copy;
DROP TABLE adv_raw_responses_copy;
