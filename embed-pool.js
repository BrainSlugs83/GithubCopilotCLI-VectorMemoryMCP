/**
 * Encapsulates embed-worker lifecycle management.
 *
 * @param {() => import("node:events").EventEmitter} workerFactory  Creates a worker-like object.
 * @param {object} [opts]
 * @param {number} [opts.embedTimeout=60000]       Per-embed timeout in ms.
 * @param {number} [opts.restartDelay=2000]        Delay before restarting a crashed worker.
 * @param {number} [opts.workerReadyTimeout=30000] Max time to wait for a restarting worker.
 */
export function createEmbedPool(workerFactory, opts = {}) {
  const EMBED_TIMEOUT_MS = opts.embedTimeout ?? 60_000;
  const RESTART_DELAY_MS = opts.restartDelay ?? 2000;
  const WORKER_READY_TIMEOUT_MS = opts.workerReadyTimeout ?? 30_000;

  let worker = null;
  let workerAlive = false;
  let shuttingDown = false;
  let embedIdCounter = 0;
  const pendingEmbeds = new Map();

  let workerReadyResolve = null;
  let workerReadyPromise = null;

  function rejectAllPending(reason) {
    for (const [, { reject, timer }] of pendingEmbeds) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    pendingEmbeds.clear();
  }

  function scheduleRestart(code) {
    if (shuttingDown) return;
    process.stderr.write(`[vector-memory] Worker exited (code ${code}) — restarting in ${RESTART_DELAY_MS}ms\n`);
    workerReadyPromise = new Promise(resolve => { workerReadyResolve = resolve; });
    setTimeout(() => {
      initWorker();
      if (workerReadyResolve) {
        workerReadyResolve();
        workerReadyResolve = null;
      }
    }, RESTART_DELAY_MS);
  }

  function initWorker() {
    worker = workerFactory();
    workerAlive = true;
    workerReadyPromise = null;

    worker.on("message", (msg) => {
      if (msg.type === "ready") return;
      if (msg.type === "error") {
        process.stderr.write(`[vector-memory] Embedding model error: ${msg.message}\n`);
        return;
      }
      const pending = pendingEmbeds.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingEmbeds.delete(msg.id);
        pending.resolve(msg.embedding);
      }
    });

    worker.on("error", (err) => {
      process.stderr.write(`[vector-memory] Worker crashed: ${err.message}\n`);
      workerAlive = false;
      rejectAllPending("Worker crashed: " + err.message);
    });

    worker.on("exit", (code) => {
      workerAlive = false;
      if (code !== 0) {
        rejectAllPending("Worker exited with code " + code);
      }
      scheduleRestart(code);
    });
  }

  async function embed(text) {
    // If the worker is down but a restart is pending, wait for it
    if (!workerAlive && workerReadyPromise) {
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Embed worker restart timed out")),
          WORKER_READY_TIMEOUT_MS
        );
      });
      try {
        await Promise.race([workerReadyPromise, timeout]);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    if (!workerAlive) {
      throw new Error("Embed worker is not running");
    }

    return new Promise((resolve, reject) => {
      const id = embedIdCounter++;
      const timer = setTimeout(() => {
        pendingEmbeds.delete(id);
        reject(new Error("Embedding timed out after " + EMBED_TIMEOUT_MS + "ms"));
      }, EMBED_TIMEOUT_MS);
      pendingEmbeds.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, text });
      } catch (err) {
        clearTimeout(timer);
        pendingEmbeds.delete(id);
        reject(err);
      }
    });
  }

  function shutdown() {
    shuttingDown = true;
    rejectAllPending("Pool shutting down");
    if (worker) {
      worker.terminate();
      worker = null;
      workerAlive = false;
    }
    if (workerReadyResolve) {
      workerReadyResolve();
      workerReadyResolve = null;
    }
  }

  return { embed, initWorker, shutdown, isAlive: () => workerAlive };
}
