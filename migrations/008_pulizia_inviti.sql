-- Gli inviti e le risposte di calendario (Google Calendar, Outlook) non sono conversazioni con i clienti:
-- da ora vengono scartati all'importazione (lib/messages.js, isCalendarInvite); qui si tolgono quelli già importati.
DELETE FROM messages WHERE source = 'gmail' AND (
  lower(subject) LIKE 'invito:%' OR lower(subject) LIKE 'invito aggiornato%' OR lower(subject) LIKE 'invitation:%'
  OR lower(subject) LIKE 'updated invitation%' OR lower(subject) LIKE 'accettato:%' OR lower(subject) LIKE 'accepted:%'
  OR lower(subject) LIKE 'rifiutato:%' OR lower(subject) LIKE 'declined:%' OR lower(subject) LIKE 'evento annullato%'
  OR lower(subject) LIKE 'canceled event%' OR lower(subject) LIKE 'cancelled event%'
  OR snippet LIKE '%Partecipa con Google Meet%' OR snippet LIKE '%Join with Google Meet%'
  OR snippet LIKE '%Invito da Google Calendar%' OR snippet LIKE '%Invitation from Google Calendar%'
);
