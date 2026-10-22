'use strict';

// Lettura della posta Gmail via IMAP, SOLO LETTURA.
// - La cartella "Tutti i messaggi" viene aperta in modalità readOnly (comando EXAMINE):
//   il server non permette di cambiare nulla, nemmeno lo stato "letto".
// - Questo modulo usa solo: connect, list, getMailboxLock(readOnly), search, fetchAll, download, logout.
//   Nessuna funzione che modifichi, sposti, cancelli o invii messaggi.

const { ImapFlow } = require('imapflow');

class GmailError extends Error {}

const SKIP_CATEGORIES = '-category:promotions -category:social -category:updates -category:forums';

function gmailDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}

function friendlyError(err) {
  const text = `${err.responseText || ''} ${err.message || ''}`;
  if (err.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|authentication failed/i.test(text)) {
    return new GmailError('Gmail ha rifiutato l\'accesso: controlla indirizzo e password per le app.');
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo/i.test(text)) {
    return new GmailError('Gmail non raggiungibile: controlla la connessione a internet.');
  }
  return new GmailError(`Errore Gmail: ${err.message}`);
}

function textPartOf(node) {
  // Primo testo leggibile: preferisce text/plain, ripiega su text/html. Salta gli allegati.
  let html = null;
  const walk = (n) => {
    if (!n) return null;
    if (n.childNodes) {
      for (const c of n.childNodes) { const r = walk(c); if (r) return r; }
      return null;
    }
    if (n.disposition === 'attachment') return null;
    if (n.type === 'text/plain') return n.part || '1';
    if (n.type === 'text/html' && !html) html = n.part || '1';
    return null;
  };
  return walk(node) || html;
}

function cleanSnippet(text, isHtml) {
  let t = String(text || '');
  if (isHtml) {
    t = t.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  const lines = [];
  for (const line of t.split(/\r?\n/)) {
    const l = line.trim();
    if (/^(Il giorno|On) .+(ha scritto|wrote):?$/i.test(l) || /^-{2,}\s*(Messaggio originale|Original Message)/i.test(l)) break;
    if (l.startsWith('>')) continue;
    lines.push(l);
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

// Email inviate in massa o in automatico: newsletter, notifiche, conferme d'ordine di altri siti.
function isBulk(headers) {
  const h = String(headers || '').toLowerCase();
  if (!h) return false;
  if (/^(list-unsubscribe|list-id|feedback-id):/m.test(h)) return true;
  if (/^precedence:\s*(bulk|list|junk|auto_reply)/m.test(h)) return true;
  const auto = h.match(/^auto-submitted:\s*([^\r\n]+)/m);
  if (auto && !/^no\b/.test(auto[1].trim())) return true;
  if (/^x-auto-response-suppress:\s*(all|oof|autoreply)/m.test(h)) return true;
  return false;
}

async function readStream(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

// Apre la connessione e la cartella "Tutti i messaggi" in sola lettura.
async function openAllMail(cfg) {
  if (!cfg.user || !cfg.pass) throw new GmailError('Mancano indirizzo Gmail o password per le app: inseriscili in Impostazioni.');
  const client = new ImapFlow({
    host: cfg.host || 'imap.gmail.com',
    port: cfg.port || 993,
    secure: cfg.secure !== false,
    auth: { user: cfg.login || cfg.user, pass: cfg.pass },
    logger: false,
    connectionTimeout: 20000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const boxes = await client.list();
    const all = boxes.find((b) => b.specialUse === '\\All');
    if (!all) throw new GmailError('Cartella "Tutti i messaggi" non trovata: in Gmail, Impostazioni → Inoltro e POP/IMAP, deve essere visibile in IMAP.');
    const lock = await client.getMailboxLock(all.path, { readOnly: true });
    if (!client.mailbox.readOnly) {
      lock.release();
      throw new GmailError('Impossibile aprire la posta in sola lettura: mi fermo.');
    }
    return { client, lock, path: all.path, uidValidity: String(client.mailbox.uidValidity) };
  } catch (err) {
    await client.logout().catch(() => {});
    throw err instanceof GmailError ? err : friendlyError(err);
  }
}

async function close(session) {
  try { session.lock.release(); } catch { /* già rilasciato */ }
  await session.client.logout().catch(() => {});
}

// UID da importare, in ordine crescente.
async function findUids(session, { afterUid, since, skipCategories = true }) {
  const parts = [];
  if (since) parts.push(`after:${gmailDate(since)}`);
  if (skipCategories) parts.push(SKIP_CATEGORIES);
  const query = {};
  if (parts.length) query.gmraw = parts.join(' ');
  if (afterUid) query.uid = `${afterUid + 1}:*`;
  if (!query.gmraw && !query.uid) query.all = true;
  let uids;
  try {
    uids = await session.client.search(query, { uid: true });
  } catch (err) {
    throw friendlyError(err);
  }
  return (uids || []).filter((u) => !afterUid || u > afterUid).sort((a, b) => a - b);
}

// Legge intestazioni e anteprima di un gruppo di messaggi.
async function readMessages(session, uids) {
  if (!uids.length) return [];
  const { client } = session;
  let fetched;
  try {
    fetched = await client.fetchAll(uids.join(','), {
      uid: true, envelope: true, internalDate: true, threadId: true, bodyStructure: true,
      headers: ['list-unsubscribe', 'list-id', 'precedence', 'auto-submitted', 'x-auto-response-suppress', 'feedback-id'],
    }, { uid: true });
  } catch (err) {
    throw friendlyError(err);
  }
  const out = [];
  for (const m of fetched) {
    const part = textPartOf(m.bodyStructure);
    let snippet = '';
    if (part) {
      try {
        const d = await client.download(String(m.uid), part, { uid: true, maxBytes: 8000 });
        if (d.content) {
          const isHtml = /html/i.test(d.meta?.contentType || '');
          snippet = cleanSnippet(await readStream(d.content), isHtml);
        }
      } catch { /* anteprima non essenziale */ }
    }
    const env = m.envelope || {};
    out.push({
      uid: m.uid,
      emailId: m.emailId ? String(m.emailId) : null,
      threadId: m.threadId ? String(m.threadId) : null,
      messageId: env.messageId || null,
      date: new Date(m.internalDate || env.date || Date.now()).toISOString(),
      subject: env.subject || '',
      from: (env.from || []).map((a) => ({ name: a.name || '', address: a.address || '' })),
      to: [...(env.to || []), ...(env.cc || [])].map((a) => ({ name: a.name || '', address: a.address || '' })),
      snippet,
      bulk: isBulk(m.headers),
    });
  }
  return out.sort((a, b) => a.uid - b.uid);
}

module.exports = { isBulk, GmailError, openAllMail, close, findUids, readMessages, cleanSnippet, textPartOf, gmailDate };
