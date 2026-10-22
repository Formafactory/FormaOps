-- Canali social e filtri email più stretti.
-- kind: email | dm | comment. contact_type: tipo di contatto usato per riconoscere il cliente
-- (email, instagram, facebook); counterpart_address contiene il valore normalizzato.
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'email';
ALTER TABLE messages ADD COLUMN contact_type TEXT NOT NULL DEFAULT 'email';
ALTER TABLE messages ADD COLUMN account TEXT;
CREATE INDEX messages_contact ON messages(contact_type, counterpart_address);

-- Le email non collegate importate finora vengono rilette con i nuovi filtri (newsletter e notifiche escluse).
-- Le email già collegate a un cliente restano.
DELETE FROM messages WHERE source = 'gmail' AND customer_id IS NULL;
UPDATE sync_state SET cursor = NULL WHERE source = 'gmail';
