# FormaOps — report delle modifiche e passaggio di consegne

Aggiornato al 9 novembre 2026, commit `ebce1d1` su `main` (repo `Formafactory/FormaOps`).
Scopo del documento: dare a chi prende la regia del progetto (da ora ChatGPT) un quadro completo di cosa esiste,
cosa è stato deciso, cosa funziona davvero e cosa resta aperto.
Le regole operative vincolanti sono in [`CLAUDE.md`](../CLAUDE.md) e valgono anche per chi lavora sul repo con altri strumenti.

---

## 1. Cos'è FormaOps

App personale di Gianluca, che gestisce da solo Vir3D (B2C, oggetti personalizzati stampati in 3D, vir3d.it) e
De Artis Digitale (B2B, stampa e scansione 3D). Problema di partenza: clienti e richieste sparsi tra ordini del sito,
email, Messenger, Instagram e commenti, senza più riuscire a gestirli.

**Visione** (decisa da Gianluca): canali → Inbox unica → scheda cliente (Customer 360) → relazioni → motore delle decisioni →
AI controllata → marketing. Obiettivo finale: *l'AI gestisce il flusso delle conversazioni, Gianluca lo tiene d'occhio e risponde
solo a quelle indirizzate a lui*. Principi: deterministico prima dell'AI; l'AI non scrive mai per i contatti personali;
percorso Read → Suggest → Prepare → Approve → Execute, una fase alla volta e solo con autorizzazione esplicita.

**Forma tecnica scelta ("strada A", settembre 2026):** app locale unica sul PC del laboratorio (Windows), Node + Express + EJS +
SQLite su file (better-sqlite3), un solo processo, un solo file CSS, niente hosting, niente Docker/CI, costo infrastrutturale zero.
È una riscrittura da zero: il vecchio monorepo (multi-tenant, Docker, CI su GitHub Actions) era troppo grande e costoso ed è stato abbandonato.

## 2. Decisioni prese da Gianluca (da rispettare)

| Tema | Decisione |
|---|---|
| Dove gira | PC del laboratorio; dal telefono tramite Tailscale (`tailscale serve`), mai esposto a internet |
| Brand | Due **spazi separati** nella stessa app (Vir3D / De Artis), selettore nel menu |
| Interfaccia | Bozza **A "Regia"**: in alto *Per te* (chi aspetta una sua risposta, con il motivo), sotto *Il flusso* |
| Per te | Solo chi ha scritto negli **ultimi 7 giorni** (modificabile); il resto in "Arretrate" |
| Urgenza | DM e commenti dopo **4 ore**, email dopo **24 ore** (modificabili); in cima chi ha un ordine in corso |
| Relazioni | Cliente, Lead, B2B, Fornitore, Personale; automatiche + correzione manuale |
| Meta | Al primo collegamento solo gli ultimi 7 giorni |
| AI | Autorizzata il 9/11/2026 **solo per bozze** (OpenAI), che Gianluca legge, corregge e invia dal canale |
| Conoscenze AI | Prese da vir3d.it e modificabili in app |
| WhatsApp | Rimandato (vedi §6) |
| Lavoro | Commit diretti su `main`, un blocco alla volta, ogni blocco chiuso da prove reali; se un caso non è coperto si chiede |

Preferenze di lavoro di Gianluca: italiano, diretto, passaggi semplici e concreti (non è uno sviluppatore),
massimo 3 opzioni con una preferenza motivata, prove concrete prima di dichiarare "fatto", aggiornamenti chiari nei lavori lunghi.

## 3. Cronologia delle modifiche

| Data | Commit | Cosa |
|---|---|---|
| 21/10 | `ae395e6` | **Blocco 1** — scheletro Express/EJS/SQLite, anagrafica clienti con contatti (email, telefono, Instagram, Facebook), normalizzazione |
| 21/10 | `f632b59` | **Blocco 2** — ordini Vir3D in sola lettura dall'API FormaOps di vir3d.it; abbinamento ai clienti per email poi telefono, mai per nome; casi ambigui in "Da verificare" |
| 21/10 | `d870fe6` | Chiave Vir3D da Impostazioni; `avvia-formaops.bat` che si aggiorna da solo (git pull + npm install) |
| 21/10 | `e5cc87b` | **Blocco 3** — Gmail in sola lettura (IMAP, password per le app), schermata Arrivi |
| 22/10 | `eca5cbf` | **Blocco 4** — Facebook e Instagram in lettura (Messenger, commenti a post e inserzioni); filtri email (newsletter, notifiche) |
| 31/10 | `87acc87`…`6ecc8d4` | Meta più robusta: riduzione automatica dei dati richiesti, ritentativi su timeout ed errori di rete, commenti inserzioni dagli account pubblicitari, primo giro di 7 giorni |
| 31/10 | `617787e` | **Blocco 5** — aggiornamento automatico ogni 15 minuti, backup giornaliero (anche su Google Drive), avvio con Windows |
| 31/10 | `b7a27f8` | DM Instagram con l'API "login Instagram" (codice pronto, collegamento in pausa: §6) |
| 31/10 | `7fc5304` | **Blocco 6** — relazioni dei clienti, stati delle conversazioni (da rispondere, in attesa, rimandata, chiusa), urgenza e priorità |
| 01/11 | `9e1767e` | **Blocco 7** — spazi separati Vir3D/De Artis (brand dal canale di arrivo), interfaccia Regia, seconda casella Gmail per De Artis |
| 01/11 | `2882d0a` | Accesso dal telefono con Tailscale (guida), menu compatto su mobile |
| 01/11 | `c009840` | Per te limitato agli ultimi 7 giorni, vista "Arretrate" con chiusura in blocco |
| 01/11 | `7988e48` | Una scheda per persona in Per te, anteprime email senza la parte citata, inviti di calendario esclusi |
| 01/11 | `37d32ad`, `b223d5c` | Commenti Meta con autore nascosto non più scartati (mostrati come "Utente Facebook"), rilettura degli ultimi giorni, completamento quando l'autore diventa visibile |
| 05/11 | `b08d596` | Controllo dei permessi della chiave Meta in Impostazioni |
| 06/11 | `c214d3f` | **ADV blocco 1** — raccolta automatica dei dati Meta Ads (sola lettura), giro notturno alle 05:00, pagina ADV nello spazio Vir3D. Fatto in un'altra sessione: dettagli e prove nel messaggio del commit |
| 09/11 | `ebce1d1` | **Blocco 8** — assistente AI per le bozze di risposta (OpenAI), conoscenze per brand, pagina Assistente AI |

Test automatici: **87 su 87** superati al 9/11 (`npm test`), con server finti per vir3d.it, Gmail, Meta, Instagram e OpenAI.

## 4. Stato reale per area

**Funziona sul PC di Gianluca, verificato su dati veri**
- Anagrafica clienti, ordini Vir3D (sola lettura), Gmail info.vir3d@gmail.com.
- Messenger della Pagina "Vir3d Italia", commenti Instagram (@vir3ditalia) con nome dell'autore.
- Commenti Facebook e alle inserzioni: arrivano, ma **senza nome dell'autore** (§6).
- Regia, stati, urgenza, una scheda per persona, Arretrate; aggiornamento automatico; backup su Drive; avvio con Windows.
- Dati Meta Ads (ADV): verificati il 6/11 sui dati reali (spesa e acquisti coincidenti con Meta). Il giro notturno era da verificare dopo il 7/11.

**Pronto ma non ancora provato sui dati reali**
- **Assistente AI (bozze)**: provato solo con OpenAI finto. Serve la chiave OpenAI di Gianluca (Impostazioni → Assistente AI).
  Le conoscenze di Vir3D sono state lette da vir3d.it il 9/11; quelle di De Artis sono quasi vuote (nessun sito da cui prenderle).
- **Spazio De Artis**: vuoto finché non si collega la sua casella Gmail (password per le app dell'account Google di De Artis).
- **Accesso dal telefono**: guida pronta (`docs/accesso-dal-telefono.md`), Tailscale da installare.

## 5. Architettura in breve

- `server.js` — tutte le route, menu, scheduler, `syncAll` (ordini → collegamento clienti → Gmail Vir3D e De Artis → Meta → bozze AI).
- `lib/` — `customers`, `identity` (abbinamento email → telefono), `normalize`, `vir3d`/`sync-vir3d`, `gmail`/`sync-gmail`,
  `meta`/`sync-meta`/`instagram-login`, `messages` (canali, brand, filtri, citazioni, inviti), `inbox` (stati, urgenza, Regia, Per te),
  `ai` (bozze), `adv` (Meta Ads), `scheduler`, `backup`, `settings`, `db` (migrazioni).
- `migrations/001…011` — schema SQLite; una migrazione pubblicata non si modifica, se ne aggiunge una nuova.
- `views/` — EJS (Regia, conversazione, clienti, da collegare, da verificare, ADV, assistente, impostazioni). `public/style.css` unico foglio di stile.
- `conoscenze/*.md` — testo di partenza delle conoscenze AI per brand (sovrascrivibile dall'app).
- Dati: `C:\Users\deart\formaops-data\formaops.sqlite` (fuori dal repo). **Le chiavi** (vir3d, Gmail, Meta, OpenAI) sono salvate in tabella `settings`
  di quel database, mai nel repo.
- Avvio: `avvia-formaops.bat` (aggiorna e avvia), `avvio-automatico-con-windows.bat` (una tantum). Porta 3210, solo `localhost`.

## 6. Limiti scoperti e motivi (da non riscoprire)

- **Nomi dei commenti Facebook nascosti**: la chiave ha `pages_read_user_content`, ma con l'app Meta in modalità Sviluppo/accesso standard Meta
  nasconde l'autore (341 commenti su 342). Serve la revisione dell'app Meta (accesso avanzato, verifica aziendale, app Live). Rimandata a quando
  servirà comunque per l'invio delle risposte.
- **DM Instagram**: la pagina di Meta che genera la chiave ("API setup with Instagram/Unified login") dà errore su app nel portfolio vir3ditalia;
  un'app senza portfolio la apre ma chiede un portfolio obbligatorio; il portfolio DeArtisDigitale non è accessibile dall'account usato.
  Il codice è pronto. La vecchia strada via Pagina Facebook va in timeout. Per ora i DM Instagram si guardano da Meta Business Suite.
- **WhatsApp**: Gianluca usava il numero personale (non Business) per entrambi i marchi; ha preso un'eSIM ho. Mobile dedicata (6/11).
  L'API ufficiale riceve i messaggi solo via webhook (serve un indirizzo pubblico: tunnel autorizzato in linea di principio da Gianluca).
  Tenere l'app WhatsApp Business sul telefono **e** collegare FormaOps ("coexistence") è possibile solo tramite Solution Partner/Tech Provider:
  opzione individuata 360dialog, 49 €/mese (piano Regular). Alternativa gratuita: numero solo-API, ma senza app (a PC spento niente WhatsApp).
  **Decisione al 9/11: WhatsApp rimandato.** Sul nuovo numero non va installata nessuna app finché non si sceglie la strada.
- **Pagina e Instagram di De Artis**: non collegati all'utente di sistema Meta.
- **Repo**: da rendere privato (azione di Gianluca su GitHub). Vecchia app Meta 1692307895931178 da cancellare; le app di prova "FormaOps Inst" e
  "FormaOps DM" si possono eliminare.

## 7. Assistente AI (blocco 8) — come funziona

- Dopo ogni aggiornamento, per ogni conversazione in Per te (entrambi gli spazi) prepara una bozza se manca o se il cliente ha riscritto;
  tetto giornaliero (default 40); il primo errore ferma il giro e si vede nella pagina Assistente AI.
- Prompt: conoscenze e voce del brand + dati e ultimi 5 ordini del cliente + ultimi 15 messaggi + regole del canale (email completa,
  chat breve, commento pubblico brevissimo). Niente invenzioni: le informazioni mancanti diventano `[DA COMPLETARE: …]`.
  I messaggi dei clienti sono trattati come dati (difesa da prompt injection).
- Mai bozze per i contatti "Personale". Nessun invio: "Copia e apri in Gmail/Meta", poi Gianluca invia.
- Voce di partenza: Vir3D in prima persona come Gianluca, con il "tu"; De Artis con il "Lei", firma "Gianluca – De Artis Digitale". Modificabili.
- Chiamata OpenAI Chat Completions via `fetch` (nessuna libreria nuova); modello scelto in Impostazioni (in cima i più economici).

## 8. Prossimi passi suggeriti (in ordine)

1. Gianluca: chiave OpenAI in Impostazioni, poi valutare 1–2 giorni di bozze vere e correggere conoscenze/voce.
2. Gianluca: collegare la casella Gmail di De Artis e scrivere le conoscenze di De Artis.
3. Gianluca: Tailscale per il telefono; rendere privato il repo.
4. Decidere WhatsApp (360dialog con coexistence, oppure numero solo-API).
5. Revisione dell'app Meta (accesso avanzato) quando si vorrà inviare risposte dai canali o vedere i nomi dei commenti Facebook:
   è il prerequisito della fase "Execute".
6. Solo dopo un periodo d'uso: risposte automatiche sui casi semplici (tracking, prezzi di listino), da autorizzare esplicitamente.

## 9. Come lavorare sul repo

- `npm install`, `npm test` (deve restare tutto verde), `npm start` (porta 3210). Dati di sviluppo con `DATA_DIR` in una cartella di prova.
- Server finti in `test-support/` per ogni sistema esterno: nei test non si chiama mai la rete vera.
- Ogni blocco: codice + test + prova reale mostrata + commit su `main` con messaggio che descrive le prove.
- Chiamate verso i sistemi esterni: solo lettura (GET/IMAP readOnly). L'unica eccezione autorizzata è l'invio a OpenAI per le bozze.
