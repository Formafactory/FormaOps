-- Bozze di risposta scritte dall'AI (OpenAI). Solo bozze: niente viene inviato ai canali.
-- Conoscenze per brand: cosa l'AI può dire (prezzi, tempi, politiche) e con che voce.
CREATE TABLE knowledge (
  brand       TEXT PRIMARY KEY CHECK (brand IN ('vir3d', 'deartis')),
  content     TEXT NOT NULL DEFAULT '',
  voice       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT
);

-- Una bozza per conversazione (l'ultima). based_on = ultimo messaggio del cliente quando è stata scritta:
-- se il cliente riscrive, la bozza è superata e se ne prepara un'altra.
CREATE TABLE ai_drafts (
  thread_key   TEXT PRIMARY KEY,
  draft        TEXT NOT NULL,
  model        TEXT,
  based_on     TEXT,
  instruction  TEXT,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

-- Registro delle chiamate (anche quelle fallite), per costi e problemi.
CREATE TABLE ai_calls (
  id          INTEGER PRIMARY KEY,
  thread_key  TEXT,
  model       TEXT,
  ok          INTEGER NOT NULL,
  error       TEXT,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  at          TEXT NOT NULL
);
CREATE INDEX ai_calls_at ON ai_calls(at);
