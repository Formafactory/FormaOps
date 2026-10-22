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

In **Impostazioni** → Email: indirizzo Gmail e una *password per le app* di Google (non la password dell'account).
FormaOps apre la posta in sola lettura: non invia, non cancella, non sposta e non segna come lette le email.
Al primo collegamento importa gli ultimi 90 giorni (modificabile), escluse Promozioni, Social, Aggiornamenti e Forum.

## Collegare Facebook e Instagram (lettura)

Guida passo passo: [docs/collegare-meta.md](docs/collegare-meta.md). La chiave dell'utente di sistema si incolla in
**Impostazioni** → Facebook e Instagram. FormaOps legge Messenger, DM Instagram e commenti a post e inserzioni,
e non usa mai la chiave per rispondere o pubblicare.

## Le schermate

- **Arrivi**: conversazioni degli ultimi 30 giorni, con filtro "Da rispondere" (l'ultimo messaggio è del cliente), e ordini degli ultimi 7 giorni. Il pulsante **Aggiorna** legge ordini ed email.
- **Clienti**: anagrafica con ordini ed email di ciascuno.
- **Da collegare**: chi ti ha scritto ma non è ancora associato a un cliente. Lo colleghi una volta, poi viene riconosciuto da solo. Newsletter e fornitori si ignorano da qui.
- **Da verificare**: casi ambigui degli ordini (es. email di un cliente e telefono di un altro).

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
- Blocco 3 — Gmail in sola lettura e schermata Arrivi: fatto.
- Blocco 4 — Facebook e Instagram (DM e commenti, anche inserzioni), filtri email: fatto.
- Prossimo: sync automatica, backup, accesso dal telefono.
