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
- Prossimi: ordini Vir3D (sola lettura), Gmail + schermata Arrivi, Meta (DM e commenti), sync automatica e backup.
