# Usare FormaOps dal telefono

FormaOps gira sul PC del laboratorio e resta raggiungibile **solo da questo PC**. Per aprirlo anche dal telefono
si usa **Tailscale**: una rete privata gratuita tra i tuoi dispositivi. Nessuno fuori dalla tua rete Tailscale può aprirlo,
nemmeno chi è collegato al Wi-Fi del laboratorio.

## Una volta sola

1. **Sul PC**: scarica Tailscale da https://tailscale.com/download/windows, installalo e accedi
   (va bene il tuo account Google).
2. **Sul telefono**: installa l'app **Tailscale** dal Play Store o dall'App Store e accedi **con lo stesso account**.
3. **Sul PC**: apri **PowerShell** e scrivi:

   ```
   tailscale serve --bg 3210
   ```

   Se compare un link che chiede di attivare HTTPS, aprilo, premi **Enable** e ripeti il comando.
   Alla fine stampa un indirizzo del tipo `https://nome-del-pc.qualcosa.ts.net`: è l'indirizzo di FormaOps.
   L'impostazione resta salvata anche dopo il riavvio del PC.

## Ogni volta

- Sul telefono tieni **Tailscale acceso** (interruttore nell'app).
- Apri l'indirizzo `https://nome-del-pc....ts.net` nel browser. Consiglio: aggiungilo alla schermata Home.
- Il PC deve essere acceso con FormaOps avviato (con l'avvio automatico di Windows parte da solo).

## Per spegnere l'accesso dal telefono

In PowerShell sul PC: `tailscale serve --https=443 off`
