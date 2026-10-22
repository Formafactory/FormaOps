'use strict';

// Funzioni pure: stesso input, stesso output. Usate per salvare e per cercare.

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Regole:
// - tiene solo le cifre (e il "+" iniziale)
// - "00" iniziale diventa "+"
// - nessuna cifra -> stringa vuota
// - 12 cifre che iniziano con 39 -> già italiano con prefisso, aggiunge solo "+"
// - senza prefisso -> aggiunge +39
function normalizePhone(value) {
  const raw = String(value ?? '').trim();
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (raw.startsWith('+')) return '+' + digits;
  if (digits.startsWith('00')) return '+' + digits.slice(2);
  if (digits.length === 12 && digits.startsWith('39')) return '+' + digits;
  return '+39' + digits;
}

// Profili social: accetta "@nome", "nome" o un link al profilo.
function normalizeHandle(value) {
  let v = String(value ?? '').trim().toLowerCase();
  v = v.replace(/^https?:\/\/(www\.|m\.)?(instagram\.com|facebook\.com|fb\.com)\//, '');
  v = v.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/^@/, '');
  return v;
}

function normalizeContact(type, value) {
  switch (type) {
    case 'email': return normalizeEmail(value);
    case 'phone': return normalizePhone(value);
    case 'instagram': return normalizeHandle(value);
    // "fb:<id>" = profilo riconosciuto da Messenger/commenti: l'ID va conservato così com'è.
    case 'facebook': return /^fb:/i.test(String(value ?? '').trim()) ? 'fb:' + String(value).trim().slice(3) : normalizeHandle(value);
    default: throw new Error(`Tipo di contatto sconosciuto: ${type}`);
  }
}

module.exports = { normalizeEmail, normalizePhone, normalizeHandle, normalizeContact };
