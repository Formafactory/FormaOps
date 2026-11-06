-- Modulo ADV, blocco 1: dati Meta Ads in sola lettura.
-- Pensato per più account pubblicitari (Vir3D oggi, De Artis domani): ogni tabella porta l'account.

CREATE TABLE adv_accounts (
  id             TEXT PRIMARY KEY,              -- es. act_1095600805179325
  brand          TEXT NOT NULL CHECK (brand IN ('vir3d', 'deartis')),
  name           TEXT,
  currency       TEXT,
  timezone_name  TEXT,                          -- letto da Meta, mai dato per scontato
  account_status INTEGER,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Campagne, gruppi di inserzioni e inserzioni: aggiornati a ogni giro.
CREATE TABLE adv_entities (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES adv_accounts(id),
  level             TEXT NOT NULL CHECK (level IN ('campaign', 'adset', 'ad')),
  parent_id         TEXT,                       -- adset -> campagna, ad -> gruppo
  campaign_id       TEXT,
  name              TEXT,
  effective_status  TEXT,
  daily_budget      INTEGER,                    -- centesimi, come li dà Meta
  lifetime_budget   INTEGER,
  objective         TEXT,                       -- campagne
  optimization_goal TEXT,                       -- gruppi
  attribution_spec  TEXT,                       -- gruppi: JSON della finestra di attribuzione
  creative_id       TEXT,                       -- inserzioni
  link_url          TEXT,                       -- inserzioni: link di destinazione
  url_tags          TEXT,                       -- inserzioni: parametri URL
  created_time      TEXT,
  updated_time      TEXT,
  from_insights_only INTEGER NOT NULL DEFAULT 0, -- 1 = vista solo nelle statistiche (es. inserzione archiviata)
  fetched_at        TEXT NOT NULL
);
CREATE INDEX adv_entities_account ON adv_entities (account_id, level);

-- Statistiche giornaliere per inserzione. Le date sono nel fuso dell'account.
CREATE TABLE adv_insights_daily (
  date                 TEXT NOT NULL,           -- AAAA-MM-GG
  ad_id                TEXT NOT NULL,
  account_id           TEXT NOT NULL REFERENCES adv_accounts(id),
  campaign_id          TEXT,
  adset_id             TEXT,
  spend_minor          INTEGER NOT NULL DEFAULT 0,  -- centesimi nella valuta dell'account
  impressions          INTEGER NOT NULL DEFAULT 0,
  reach                INTEGER NOT NULL DEFAULT 0,
  clicks               INTEGER NOT NULL DEFAULT 0,
  link_clicks          INTEGER NOT NULL DEFAULT 0,
  landing_page_views   INTEGER NOT NULL DEFAULT 0,
  view_content         INTEGER NOT NULL DEFAULT 0,
  add_to_cart          INTEGER NOT NULL DEFAULT 0,
  initiate_checkout    INTEGER NOT NULL DEFAULT 0,
  purchases            INTEGER NOT NULL DEFAULT 0,
  purchase_value_minor INTEGER NOT NULL DEFAULT 0,
  purchase_action_type TEXT,                    -- quale azione Meta è stata contata come acquisto
  purchase_roas        REAL,                    -- come dichiarato da Meta
  attribution_setting  TEXT,
  fetched_at           TEXT NOT NULL,
  PRIMARY KEY (date, ad_id)
);
CREATE INDEX adv_insights_account_date ON adv_insights_daily (account_id, date);

-- Risposte JSON grezze, per verificare in seguito. Il token non viene mai salvato.
CREATE TABLE adv_raw_responses (
  id         INTEGER PRIMARY KEY,
  run_id     INTEGER REFERENCES adv_sync_runs(id),
  fetched_at TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  params     TEXT NOT NULL,                     -- JSON, senza access_token
  body       TEXT NOT NULL
);
CREATE INDEX adv_raw_run ON adv_raw_responses (run_id);

-- Storico delle esecuzioni.
CREATE TABLE adv_sync_runs (
  id           INTEGER PRIMARY KEY,
  account_id   TEXT,
  trigger      TEXT NOT NULL CHECK (trigger IN ('notte', 'manuale')),
  since_date   TEXT,
  until_date   TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  ok           INTEGER,                         -- NULL = in corso, 1 = riuscita, 0 = errore
  rows_written INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
