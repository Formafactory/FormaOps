# Collegare Facebook e Instagram a FormaOps

Serve una volta sola, circa 15 minuti. FormaOps legge soltanto: messaggi di Messenger, DM di Instagram,
commenti ai post e alle inserzioni. Non risponde e non pubblica nulla.

## 1. Instagram: consenti l'accesso ai messaggi
Per ciascun account Instagram (Vir3D e De Artis), dall'app Instagram sul telefono:
Impostazioni → Messaggi e risposte alle storie → Strumenti collegati → attiva **Consenti l'accesso ai messaggi**.

## 2. Crea l'app "FormaOps" (privata)
1. Apri developers.facebook.com → **Le mie app** → **Crea app**.
2. Nome: **FormaOps**. Portfolio business: **DeArtisDigitale**.
3. Se chiede il caso d'uso, scegli **Altro**, poi tipo **Business**.
4. Nella dashboard dell'app aggiungi i prodotti **Messenger** e **Instagram** (pulsante "Configura"). Non serve configurare altro.

## 3. Crea l'utente di sistema
1. business.facebook.com → **Impostazioni** → **Utenti** → **Utenti di sistema** → **Aggiungi**.
2. Nome **FormaOps**, ruolo **Dipendente**.
3. **Assegna risorse**:
   - **App** → FormaOps → controllo completo.
   - **Pagine** → Vir3D e De Artis Digitale → attiva almeno *Messaggi* e *Attività della community / moderazione* (oppure controllo completo).
   - **Account Instagram** → entrambi → *Messaggi* e *Commenti*.
   - **Account pubblicitari** → *Visualizza prestazioni* (serve solo per i commenti alle inserzioni Instagram).

## 4. Genera la chiave
1. Sull'utente di sistema FormaOps → **Genera token**.
2. App: **FormaOps**. Scadenza: **Mai**.
3. Spunta i permessi:
   `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_messaging`, `pages_manage_metadata`,
   `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `business_management`, `ads_read`.
4. **Genera** e copia la chiave. Non incollarla in chat né in documenti.

## 5. Incollala in FormaOps
FormaOps → **Impostazioni** → Facebook e Instagram → incolla → **Salva e prova**.
Deve elencare le Pagine e gli account Instagram. Poi **Arrivi** → **Aggiorna**.

## Se qualcosa non va
- Gli errori di permesso compaiono in **Impostazioni** come avvisi: dicono quale permesso o risorsa manca.
- Se Meta dice che l'app deve essere "live", attivala dalla dashboard dell'app (serve l'indirizzo della privacy policy: https://vir3d.it/privacy o equivalente).
- Per revocare l'accesso: elimina il token o l'utente di sistema da business.facebook.com.
