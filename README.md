# FormaOps

I clienti di Vir3D e De Artis Digitale in un posto solo. App locale: gira sul PC del laboratorio e si usa dal browser.

## Installazione (una volta sola)

1. Installa Node.js LTS da https://nodejs.org (versione 22 o successiva).
2. Scarica il progetto (da GitHub con `git clone`, oppure estrai l'archivio) in una cartella, ad esempio `C:\FormaOps`.
3. Apri il terminale in quella cartella ed esegui:

   ```
   npm install
   ```

## Avvio

Doppio clic su `avvia-formaops.bat`, oppure dal terminale:

```
npm start
```

Poi apri http://localhost:3210 nel browser. Per fermarla chiudi la finestra del terminale (o premi Ctrl+C).

## Dove sono i dati

Nel file `formaops.sqlite` dentro la cartella `formaops-data` della tua cartella utente
(ad esempio `C:\Users\<nome>\formaops-data`). Non sta nel progetto e non va su GitHub.
Per spostarla, copia `.env.example` in `.env` e imposta `DATA_DIR`.

## Collegare gli ordini Vir3D (sola lettura)

In **Impostazioni** → Ordini Vir3D incolla il valore del segreto `FORMAOPS_READ_API_KEY`
del progetto Replit di production (Vir3dDesign) e premi **Salva e prova**.

FormaOps legge soltanto: non può modificare nulla su vir3d.it. Gli ordini vengono abbinati ai clienti
per email, poi per telefono, mai per nome; i casi ambigui finiscono in **Da verificare**.
Rieseguire la sincronizzazione non crea doppioni e, se si interrompe, riparte da dove era arrivata.

## Collegare Gmail (sola lettura)

Una casella per brand. In **Impostazioni** → Email di Vir3D (e Email di De Artis): indirizzo Gmail e una *password per le app* di Google (non la password dell'account).
FormaOps apre la posta in sola lettura: non invia, non cancella, non sposta e non segna come lette le email.
Al primo collegamento importa gli ultimi 90 giorni (modificabile), escluse Promozioni, Social, Aggiornamenti e Forum.

## Collegare Facebook e Instagram (lettura)

Guida passo passo: [docs/collegare-meta.md](docs/collegare-meta.md). La chiave dell'utente di sistema si incolla in
**Impostazioni** → Facebook e Instagram. FormaOps legge Messenger, DM Instagram e commenti a post e inserzioni,
e non usa mai la chiave per rispondere o pubblicare.

## DM Instagram

In pausa: la pagina di Meta che genera la chiave dà errore sul portfolio vir3ditalia (novembre 2026). Il codice è pronto.
Si leggono con una chiave dell'account Instagram (API con login Instagram): guida in
[docs/collegare-instagram-dm.md](docs/collegare-instagram-dm.md). La chiave si rinnova da sola ogni settimana.

## Aggiornamento automatico, backup, avvio con Windows

- Mentre FormaOps è acceso aggiorna da solo ordini, email e messaggi (di base ogni 15 minuti, modificabile in Impostazioni). La Regia si ricarica da sola ogni 3 minuti.
- Un backup al giorno del database nella cartella scelta in Impostazioni (consigliata una cartella di Google Drive); si tengono gli ultimi 30. Per ripristinare: chiudi FormaOps e copia il backup al posto di `formaops-data\formaops.sqlite`.
- Doppio clic su `avvio-automatico-con-windows.bat` (una volta sola): FormaOps parte da solo, ridotto a icona, quando accendi il PC.

## Dal telefono

Con Tailscale (gratuito), senza aprire FormaOps a internet né al Wi-Fi del laboratorio: guida in
[docs/accesso-dal-telefono.md](docs/accesso-dal-telefono.md). Sul telefono il menu diventa una barra compatta in alto.

## Le schermate

Vir3D e De Artis sono due spazi separati: si passa dall'uno all'altro in alto nel menu. Ogni spazio ha i suoi canali,
i suoi clienti e la sua Regia. Le conversazioni prendono il brand dal canale da cui arrivano: casella Gmail di De Artis,
oppure Pagina / account Instagram con "artis" nel nome = De Artis; tutto il resto = Vir3D. Gli ordini vir3d.it sono di Vir3D.

- **Regia**: in alto **Per te**, cioè chi aspetta una tua risposta, ognuno con il motivo (contatto personale, possibile reclamo,
  cliente B2B, ordine in corso, ha scritto più volte, nuovo contatto…). In cima chi ha un ordine in corso, poi gli urgenti
  (DM e commenti dopo 4 ore, email dopo 24, modificabili in Impostazioni), poi chi aspetta da più tempo.
  "Rispondi" apre il canale originale; "Altro" permette di segnare "Ho già risposto altrove", chiudere o rimandare.
  Sotto **Il flusso**: tutto il resto che si è mosso nelle ultime 48 ore (risposte date, conversazioni chiuse, nuovi ordini),
  più le viste Rimandate e Chiuse. Se un cliente riscrive, la conversazione torna da sola in "Per te".
  Oggi, senza AI, in "Per te" c'è tutto quello che aspetta risposta; quando arriverà l'assistente AI resteranno lì solo
  i casi che le regole lasciano a te.
- **Conversazione**: i messaggi in ordine, la scheda del cliente in breve e il pulsante per rispondere nel canale.
- **Clienti**: i clienti dello spazio attivo, con relazione (Cliente, Lead, B2B, Fornitore, Personale), ordini, messaggi,
  totale speso e ordini in corso. La relazione è automatica (De Artis = B2B, con ordini = Cliente, altrimenti Lead) e si corregge a mano.
- **Da collegare**: chi ha scritto allo spazio attivo ma non è ancora associato a un cliente.
- **Da verificare**: casi ambigui degli ordini (compare nel menu solo quando c'è qualcosa).

## Aggiornare

Basta riavviare con `avvia-formaops.bat`: scarica da solo gli aggiornamenti e i componenti.
Le modifiche al database si applicano da sole all'avvio.

## Verifica

```
npm test
```

## Stato

- Blocco 1 — anagrafica clienti: fatto.
- Blocco 2 — ordini Vir3D in sola lettura: fatto.
- Blocco 3 — Gmail in sola lettura: fatto.
- Blocco 4 — Facebook e Instagram (DM e commenti, anche inserzioni), filtri email: fatto.
- Blocco 5 — aggiornamento automatico, backup giornaliero, avvio con Windows: fatto.
- DM Instagram via API con login Instagram: fatto.
- Blocco 6 — Relationship Intelligence e Inbox con stati e urgenza: fatto.
- Blocco 7 — spazi separati Vir3D / De Artis, Regia (Per te + Il flusso), nuova interfaccia: fatto.
- Accesso dal telefono con Tailscale (guida) e versione mobile compatta: fatto.
- In pausa: DM Instagram (errore della pagina Meta). Da collegare: Gmail e Pagina De Artis.
