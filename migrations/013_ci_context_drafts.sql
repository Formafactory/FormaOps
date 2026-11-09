-- Le bozze Vir3D precedenti alla correzione non contenevano il contesto del post.
-- Non cancellarle: segnale solo che devono essere rigenerate prima dell'uso.
UPDATE ai_drafts SET based_on = ''
WHERE EXISTS (
  SELECT 1 FROM messages m
  WHERE m.thread_key = ai_drafts.thread_key AND m.brand = 'vir3d'
);
