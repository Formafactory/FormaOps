'use strict';
// Server IMAP finto con le estensioni di Gmail (X-GM-EXT-1, SPECIAL-USE, OBJECTID). Solo per i test.
const hoodiecrow = require('hoodiecrow-imap');

const OWN = 'info.vir3d@gmail.com';

function raw({ from, to = OWN, subject, id, inReplyTo, body, date, html = false, extra = [] }) {
  const h = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${id}>`,
    `Date: ${new Date(date).toUTCString()}`,
  ];
  h.push(...extra);
  if (inReplyTo) h.push(`In-Reply-To: <${inReplyTo}>`, `References: <${inReplyTo}>`);
  h.push(`Content-Type: text/${html ? 'html' : 'plain'}; charset=utf-8`, 'Content-Transfer-Encoding: quoted-printable');
  return h.join('\r\n') + '\r\n\r\n' + body + '\r\n';
}

function msg(opts) {
  return { raw: raw(opts), internaldate: new Date(opts.date), flags: [] };
}

function startFakeGmail(messages) {
  const server = hoodiecrow({
    plugins: ['SPECIAL-USE', 'X-GM-EXT-1', 'OBJECTID'],
    storage: {
      INBOX: { messages: [] },
      '': { separator: '/', folders: { '[Gmail]': { flags: ['\\Noselect'], folders: {
        'Tutti i messaggi': { 'special-use': '\\All', messages },
        'Posta inviata': { 'special-use': '\\Sent', messages: [] },
      } } } },
    },
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({
      server, port,
      cfg: { user: OWN, login: 'testuser', pass: 'testpass', host: '127.0.0.1', port, secure: false, days: 30, skipCategories: false },
      close: () => new Promise((r) => server.close(r)),
    });
  }));
}

module.exports = { startFakeGmail, msg, OWN };
