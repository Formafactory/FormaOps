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

1. Copia `.env.example` in `.env` (se non l'hai già fatto).
2. In `VIR3D_API_KEY=` incolla il valore del segreto `FORMAOPS_READ_API_KEY` del progetto Replit di production (Vir3dDesign).
3. Verifica il collegamento: `npm run sync:vir3d -- --check`
4. Importa gli ordini: `npm run sync:vir3d`, oppure il pulsante **Aggiorna ordini** nella pagina Clienti.

FormaOps legge soltanto: non può modificare nulla su vir3d.it. Gli ordini vengono abbinati ai clienti
per email, poi per telefono, mai per nome; i casi ambigui finiscono in **Da verificare**.
Rieseguire la sincronizzazione non crea doppioni e, se si interrompe, riparte da dove era arrivata.

## Aggiornare

```
git pull
npm install
```

Poi riavvia. Le modifiche al database si applicano da sole all'avvio.

## Verifica

```
npm test
```

## Stato

- Blocco 1 — anagrafica clienti: fatto.
- Blocco 2 — ordini Vir3D in sola lettura: fatto.
- Prossimi: Gmail + schermata Arrivi, Meta (DM e commenti), sync automatica e backup.
