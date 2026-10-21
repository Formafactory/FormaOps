-- Impostazioni salvate dall'app (es. chiave di lettura ordini Vir3D). Restano solo su questo PC.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
