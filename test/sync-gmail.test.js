'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ImapFlow } = require('imapflow');
const { migrate } = require('../lib/db');
const C = require('../lib/customers');
const M = require('../lib/messages');
const { syncGmail } = require('../lib/sync-gmail');
const { startFakeGmail, msg, OWN } = require('../test-support/fake-gmail');

const NOW = new Date('2026-10-21T12:00:00Z');
const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, path.join(__dirname, '..', 'migrations'), () => {});
  return db;
}
const one = (db, sql, ...a) => db.prepare(sql).pluck().get(...a);

function mailbox() {
  return [
    msg({ from: 'Anna Verdi <Anna@Example.it>', subject: 'Ambigramma per anniversario', id: 'a1@x', date: day(5),
      body: 'Ciao, vorrei un ambigramma con i nostri nomi, =C3=A8 possibile entro sabato?' }),
    msg({ from: `Vir3D <${OWN}>`, to: 'Anna Verdi <anna@example.it>', subject: 'Re: Ambigramma per anniversario', id: 'a2@x',
      inReplyTo: 'a1@x', date: day(4), body: 'Certo Anna, te lo spediamo gioved=C3=AC.\r\n\r\nIl giorno lun 13 ott Anna ha scritto:\r\n> Ciao, vorrei' }),
    msg({ from: 'Studio Rossi <info@studiorossi.it>', subject: 'Preventivo scansione 3D', id: 'b1@x', date: day(2),
      html: true, body: '<p>Buongiorno,<br>ci serve un <b>preventivo</b> per scansionare una statua.</p>' }),
    msg({ from: 'Stripe <no-reply@stripe.com>', subject: 'Pagamento ricevuto', id: 'c1@x', date: day(1), body: 'Notifica' }),
    msg({ from: 'Vecchio <old@example.it>', subject: 'Molto tempo fa', id: 'd1@x', date: day(60), body: 'Vecchio messaggio' }),
  ];
}

async function setup() {
  const fake = await startFakeGmail(mailbox());
  const db = freshDb();
  C.createCustomer(db, { name: 'Anna Verdi', brand: 'vir3d', email: 'anna@example.it' });
  return { fake, db };
}

test('prima sync: legge gli ultimi N giorni, abbina, salta notifiche, riconosce le risposte', async () => {
  const { fake, db } = await setup();
  const r = await syncGmail(db, { cfg: fake.cfg, now: NOW });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.letti, 4, 'il messaggio di 60 giorni fa è escluso');
  assert.equal(r.nuovi, 3, 'la notifica no-reply è saltata');

  const anna = db.prepare(`SELECT * FROM messages WHERE counterpart_address = 'anna@example.it' ORDER BY sent_at`).all();
  assert.equal(anna.length, 2);
  assert.deepEqual(anna.map((m) => m.direction), ['in', 'out']);
  assert.ok(anna.every((m) => m.customer_id === 1), 'collegati ad Anna');
  assert.equal(anna[0].thread_key, anna[1].thread_key, 'stessa conversazione');
  assert.match(anna[0].snippet, /entro sabato\?$/);
  assert.equal(anna[1].snippet, 'Certo Anna, te lo spediamo giovedì.', 'citazione rimossa');

  const studio = db.prepare(`SELECT * FROM messages WHERE counterpart_address = 'info@studiorossi.it'`).get();
  assert.equal(studio.customer_id, null, 'mittente sconosciuto: da collegare');
  assert.equal(studio.snippet, 'Buongiorno, ci serve un preventivo per scansionare una statua.');

  const convs = M.conversations(db, { onlyToAnswer: true });
  assert.deepEqual(convs.map((c) => c.counterpart_address), ['info@studiorossi.it'], 'Anna ha già avuto risposta');
  await fake.close();
});

test('sola lettura: nessun messaggio viene segnato come letto o modificato', async () => {
  const { fake, db } = await setup();
  await syncGmail(db, { cfg: fake.cfg, now: NOW });
  const c = new ImapFlow({ host: '127.0.0.1', port: fake.port, secure: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false });
  await c.connect();
  const lock = await c.getMailboxLock('[Gmail]/Tutti i messaggi', { readOnly: true });
  const all = await c.fetchAll('1:*', { flags: true, uid: true });
  lock.release();
  await c.logout();
  assert.equal(all.length, 5, 'nessun messaggio spostato o cancellato');
  assert.ok(all.every((m) => m.flags.size === 0), 'nessun flag cambiato (nemmeno "letto")');
  await fake.close();
});

test('il codice Gmail non usa comandi che modificano la posta', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gmail.js'), 'utf8');
  for (const forbidden of ['messageFlagsAdd', 'messageFlagsSet', 'messageFlagsRemove', 'messageDelete', 'messageMove',
    'messageCopy', 'append(', 'mailboxCreate', 'mailboxDelete', 'mailboxRename', 'setFlagColor', 'expunge']) {
    assert.ok(!src.includes(forbidden), `trovato ${forbidden}`);
  }
  assert.match(src, /readOnly: true/);
});

test('rieseguire non duplica; un nuovo messaggio arriva da solo', async () => {
  const { fake, db } = await setup();
  await syncGmail(db, { cfg: fake.cfg, now: NOW });
  const again = await syncGmail(db, { cfg: fake.cfg, now: NOW });
  assert.equal(again.ok, true);
  assert.equal(again.letti, 0);
  assert.equal(one(db, 'SELECT COUNT(*) FROM messages'), 3);

  // Arriva una nuova risposta di Anna
  const c = new ImapFlow({ host: '127.0.0.1', port: fake.port, secure: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false });
  await c.connect();
  await c.append('[Gmail]/Tutti i messaggi', [
    'From: Anna <anna@example.it>', `To: ${OWN}`, 'Subject: Re: Ambigramma per anniversario', 'Message-ID: <a3@x>',
    'In-Reply-To: <a2@x>', 'References: <a1@x> <a2@x>', 'Content-Type: text/plain; charset=utf-8', '', 'Perfetto, grazie!',
  ].join('\r\n'), [], new Date(day(0)));
  await c.logout();

  const inc = await syncGmail(db, { cfg: fake.cfg, now: NOW });
  assert.equal(inc.letti, 1);
  assert.equal(inc.nuovi, 1);
  const convs = M.conversations(db, { onlyToAnswer: true }).map((x) => x.counterpart_address).sort();
  assert.deepEqual(convs, ['anna@example.it', 'info@studiorossi.it'], 'Anna ha riscritto: torna da rispondere');
  await fake.close();
});

test('collegare un mittente: i suoi messaggi passano al cliente; ignorare un dominio li toglie', async () => {
  const { fake, db } = await setup();
  await syncGmail(db, { cfg: fake.cfg, now: NOW });
  assert.deepEqual(M.unlinkedSenders(db).map((s) => s.address), ['info@studiorossi.it']);

  const id = C.createCustomer(db, { name: 'Studio Rossi', brand: 'deartis', email: 'info@studiorossi.it' });
  M.linkUnmatched(db);
  assert.equal(one(db, `SELECT customer_id FROM messages WHERE counterpart_address = 'info@studiorossi.it'`), id);
  assert.equal(M.unlinkedSenders(db).length, 0);
  assert.equal(M.conversations(db, { customerId: id }).length, 1);

  // Un nuovo mittente sconosciuto, poi ignorato per dominio
  db.prepare(`INSERT INTO messages (id, source, thread_key, direction, counterpart_address, sent_at)
              VALUES ('x', 'gmail', 'gmail:x', 'in', 'promo@fornitore.it', ?)`).run(day(0));
  M.ignoreSender(db, '@fornitore.it');
  assert.equal(one(db, `SELECT COUNT(*) FROM messages WHERE counterpart_address = 'promo@fornitore.it'`), 0);
  assert.equal(M.isIgnored(db, 'altro@fornitore.it'), true);
  await fake.close();
});

test('credenziali sbagliate o server irraggiungibile: errore chiaro', async () => {
  const db = freshDb();
  const r = await syncGmail(db, { cfg: { user: OWN, pass: 'x', host: '127.0.0.1', port: 1, secure: false, days: 30 }, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /Gmail/);
  const r2 = await syncGmail(db, { cfg: { user: '', pass: '', days: 30 }, now: NOW });
  assert.match(r2.error, /Impostazioni/);
});
