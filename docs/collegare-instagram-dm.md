# Collegare i DM di Instagram a FormaOps

Serve perché la lettura dei DM Instagram attraverso la Pagina Facebook va in timeout. Questa strada usa
l'API di Instagram con login Instagram. Solo lettura: FormaOps non risponde e non invia nulla.
Si fa una volta sola, circa 10 minuti, dal profilo Facebook che gestisce il portfolio **vir3ditalia**.

## 1. Rendi l'account Instagram "tester" dell'app
1. developers.facebook.com → app **FormaOps** (ID 1434910818798137) → **Ruoli dell'app** → **Ruoli**.
2. **Aggiungi persone** → **Tester di Instagram** → scrivi **vir3ditalia** → invia.
3. Accetta l'invito: da computer apri **instagram.com** con @vir3ditalia → **Impostazioni** →
   **App e siti web** → scheda **Inviti dei tester** → **Accetta**.

## 2. Genera la chiave
1. Torna nell'app FormaOps → menu a sinistra **Instagram** → **Configurazione dell'API con login Instagram**.
2. Al punto **1. Genera token d'accesso** clicca **Aggiungi account** e accedi con @vir3ditalia, accetta.
3. Accanto all'account comparso clicca **Genera token**, accetta e **copia** la chiave (inizia con `IG`).
   Non incollarla in chat né in documenti.

Niente webhook: lasciali vuoti.

## 3. Incollala in FormaOps
**Impostazioni** → riquadro **DM Instagram** → incolla → **Salva e prova**. Deve comparire "@vir3ditalia".
Poi **Arrivi** → **Aggiorna**.

## Da sapere
- La chiave dura 60 giorni: FormaOps la rinnova da solo una volta a settimana. Se il PC resta spento
  più di 60 giorni, rigenerala dal punto 2.
- Meta mostra solo gli ultimi 20 messaggi di ogni conversazione: FormaOps legge le novità a ogni giro,
  quindi non si perde nulla finché resta acceso.
