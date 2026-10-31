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

module.exports = { createScheduler };
