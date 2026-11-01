-- Spazi separati Vir3D / De Artis: ogni messaggio appartiene al brand del canale da cui arriva
-- (casella Gmail, Pagina Facebook, account Instagram). Le regole sono in lib/messages.js (assignBrands).
ALTER TABLE messages ADD COLUMN brand TEXT CHECK (brand IS NULL OR brand IN ('vir3d', 'deartis'));
UPDATE messages SET brand = CASE WHEN lower(coalesce(account, '')) LIKE '%artis%' THEN 'deartis' ELSE 'vir3d' END;
CREATE INDEX messages_brand ON messages(brand, sent_at);
