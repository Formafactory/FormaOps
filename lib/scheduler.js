'use strict';

// Aggiornamento automatico mentre FormaOps è acceso: un giro ogni N minuti, mai due insieme.
function createScheduler({ run, minutes, firstDelayMs = 60000, log = () => {} }) {
  let timer = null;
  let running = false;
  const state = { lastRunAt: null, lastResult: null, nextRunAt: null, minutes };

  async function tick() {
    if (running) return null;
    running = true;
    try {
      state.lastResult = await run();
      log(`[auto] ${state.lastResult}`);
    } catch (err) {
      state.lastResult = `Errore: ${err.message}`;
      log(`[auto] errore: ${err.message}`);
    } finally {
      state.lastRunAt = new Date().toISOString();
      running = false;
    }
    return state.lastResult;
  }

  function schedule(delayMs) {
    clearTimeout(timer);
    if (!state.minutes) { state.nextRunAt = null; return; }
    state.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    timer = setTimeout(async () => { await tick(); schedule(state.minutes * 60000); }, delayMs);
    if (timer.unref) timer.unref();
  }

  return {
    state,
    isRunning: () => running,
    start() { schedule(firstDelayMs); },
    setMinutes(m) { state.minutes = m; schedule(m ? m * 60000 : 0); },
    runNow: tick,
    stop() { clearTimeout(timer); state.nextRunAt = null; },
  };
}

// --- Appuntamento giornaliero a un'ora fissa (es. le 05:00 ora italiana) -------------------

// Data e ora "da orologio da muro" di un istante in un fuso orario.
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

// Istante corrispondente a una data e ora locali nel fuso indicato (gestisce ora legale e solare).
function zonedToUtc(y, m, d, h, mi, timeZone) {
  const wanted = Date.UTC(y, m - 1, d, h, mi);
  let t = wanted;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(t), timeZone);
    const diff = wanted - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    if (!diff) break;
    t += diff;
  }
  return new Date(t);
}

// Prossimo appuntamento alle hour:minute nel fuso indicato, strettamente dopo "now".
function nextDailyRun(now, hour, minute, timeZone) {
  const p = zonedParts(now, timeZone);
  let at = zonedToUtc(p.y, p.m, p.d, hour, minute, timeZone);
  if (at <= now) {
    const t = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
    at = zonedToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), hour, minute, timeZone);
  }
  return at;
}

// Un giro al giorno all'ora indicata, mai due insieme. Controlla l'orologio ogni minuto
// (più affidabile di un unico timer lungo se il PC va in sospensione).
function createDailyScheduler({ run, hour, minute = 0, timeZone = 'Europe/Rome', checkMs = 60000, log = () => {}, clock = () => new Date() }) {
  let timer = null;
  let running = false;
  const state = { lastRunAt: null, lastResult: null, nextRunAt: null, hour, minute, timeZone };

  async function tick() {
    if (running) return null;
    running = true;
    try {
      state.lastResult = await run();
      log(`[notte] ${state.lastResult}`);
    } catch (err) {
      state.lastResult = `Errore: ${err.message}`;
      log(`[notte] errore: ${err.message}`);
    } finally {
      state.lastRunAt = clock().toISOString();
      running = false;
    }
    return state.lastResult;
  }

  async function check() {
    if (!state.nextRunAt || clock() < new Date(state.nextRunAt)) return null;
    state.nextRunAt = nextDailyRun(clock(), hour, minute, timeZone).toISOString();
    return tick();
  }

  return {
    state,
    isRunning: () => running,
    check,
    start() {
      state.nextRunAt = nextDailyRun(clock(), hour, minute, timeZone).toISOString();
      clearInterval(timer);
      timer = setInterval(check, checkMs);
      if (timer.unref) timer.unref();
    },
    stop() { clearInterval(timer); state.nextRunAt = null; },
  };
}

module.exports = { createScheduler, createDailyScheduler, nextDailyRun, zonedParts };
