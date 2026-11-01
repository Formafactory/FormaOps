# FormaOps — regole del progetto

App personale di Gianluca: l'AI gestirà il flusso delle conversazioni di Vir3D e De Artis Digitale (due spazi separati),
lui lo tiene d'occhio e risponde solo a quelle indirizzate a lui.
Valgono per ogni sessione di lavoro su questo repository.

## Vincoli
- Utente unico, uso locale sul PC del laboratorio. Niente login, niente hosting, niente multi-utente.
- Un solo processo Node. Nessun worker, coda, container, Docker, CI, GitHub Actions.
- Stack fisso: Node, Express, better-sqlite3, EJS, un file CSS. Nessuna SPA, nessun bundler,
  nessun ORM, nessun TypeScript. Nuove librerie solo se autorizzate esplicitamente.
- Database SQLite in un solo file in `DATA_DIR` (default `~/formaops-data`), FUORI dal repo.
- Migrazioni: file SQL numerati in `migrations/`, applicati all'avvio, registrati in `schema_migrations`.
  Una migrazione già pubblicata non si modifica: se ne aggiunge una nuova.
- Query in SQL esplicito e leggibile.
- Nessuna scrittura verso sistemi esterni (Vir3D, Gmail, Meta, altro), mai. Solo lettura.
- La produzione Vir3D non si tocca senza autorizzazione esplicita di Gianluca.
- Niente AI, niente risposte automatiche, niente astrazioni "per il futuro".
- Commit direttamente su `main`. Niente branch, niente pull request.
- Segreti solo in `.env` (mai committato); `.env.example` documenta le variabili.

## Metodo
- Un blocco per sessione. Ogni blocco termina con la prova definita, eseguita e mostrata con il suo output reale.
  Nessun commit prima della prova. Nulla è "fatto" senza output.
- Se un caso non è coperto, chiedere: non assumere.
- Correzioni nella funzione responsabile, con un test che copre il caso.

## Piano
1. Anagrafica clienti — 2. Ordini Vir3D (sola lettura) — 3. Gmail IMAP + schermata Arrivi —
4. Meta: DM e commenti Facebook/Instagram, organici e inserzioni — 5. Sync automatica, backup, accesso remoto.
6. Relationship Intelligence (relazione automatica + manuale) e Inbox con stati, urgenza e priorità.
7. Spazi separati Vir3D / De Artis e interfaccia "Regia" (Per te + Il flusso), dalla bozza A scelta da Gianluca.

Visione complessiva (fasi successive, da autorizzare una alla volta): canali → Inbox unica → Customer 360 →
Relationship Intelligence → motore delle decisioni → AI controllata (Read → Suggest → Prepare → Approve → Execute) → marketing.
Le regole "niente AI" e "solo lettura" valgono finché Gianluca non autorizza esplicitamente la fase che le supera.
La qualità di UX e interfaccia è un requisito, non un extra.
