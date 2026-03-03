import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { Worker } from "worker_threads";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { createServer, request as httpReq } from "http";
import { execSync } from "child_process";
import { filterUnindexed, dedup, postProcessResults, isOurServer, isIndexable, DIMS, createHandler } from "./lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COPILOT_DIR = join(homedir(), ".copilot");
const SESSION_STORE_PATH = join(COPILOT_DIR, "session-store.db");
const VECTOR_INDEX_PATH = join(COPILOT_DIR, "vector-index.db");
const INDEX_INTERVAL_MS = 15 * 60 * 1000;

let isIndexing = false;

// --- Embedding via Worker Thread ---

// Worker is started lazily after we win the singleton race
let worker;
let embedIdCounter = 0;
const pendingEmbeds = new Map();

function initWorker() {
  worker = new Worker(join(__dirname, "embed-worker.js"));
  worker.on("message", (msg) => {
    if (msg.type === "ready") return;
    if (msg.type === "error") {
      process.stderr.write(`[vector-memory] Embedding model error: ${msg.message}\n`);
      return;
    }
    const resolve = pendingEmbeds.get(msg.id);
    if (resolve) {
      pendingEmbeds.delete(msg.id);
      resolve(msg.embedding);
    }
  });
  worker.on("error", (err) => {
    process.stderr.write(`[vector-memory] Worker crashed: ${err.message}\n`);
  });
}

function embed(text) {
  return new Promise((resolve) => {
    const id = embedIdCounter++;
    pendingEmbeds.set(id, resolve);
    worker.postMessage({ id, text });
  });
}

function openVectorDb() {
  const db = new Database(VECTOR_INDEX_PATH);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS indexed_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      content TEXT NOT NULL,
      source_id TEXT,
      UNIQUE(session_id, source_type, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_indexed_session ON indexed_items(session_id);
  `);

  const hasVec = db
    .prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='vec_items'")
    .get().c;
  if (!hasVec) {
    db.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(rowid INTEGER PRIMARY KEY, embedding float[${DIMS}])`);
  }

  return db;
}

function openSessionStore() {
  if (!existsSync(SESSION_STORE_PATH)) return null;
  return new Database(SESSION_STORE_PATH, { readonly: true });
}

function runMaintenance(db) {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("ANALYZE");
  } catch {}
}

function getUnindexedContent(vecDb, sessionDb) {
  const allContent = sessionDb
    .prepare("SELECT rowid, content, session_id, source_type, source_id FROM search_index")
    .all();
  const existing = vecDb.prepare("SELECT session_id, source_type, source_id FROM indexed_items").all();
  return filterUnindexed(allContent, existing);
}

async function indexContent(vecDb, items) {
  const insertMeta = vecDb.prepare(
    "INSERT OR IGNORE INTO indexed_items (session_id, source_type, content, source_id) VALUES (?, ?, ?, ?)"
  );
  const insertVec = vecDb.prepare("INSERT INTO vec_items (rowid, embedding) VALUES (?, ?)");

  let count = 0;
  for (const item of items) {
    if (!isIndexable(item)) continue;

    const embedding = await embed(item.content);
    const result = insertMeta.run(item.session_id, item.source_type, item.content, item.source_id ?? null);
    if (result.changes > 0) {
      insertVec.run(BigInt(result.lastInsertRowid), embedding);
      count++;
    }
  }
  return count;
}

async function backgroundIndex() {
  if (isIndexing) return;
  isIndexing = true;
  try {
    const sessionDb = openSessionStore();
    if (!sessionDb) return;
    const vecDb = openVectorDb();
    try {
      const unindexed = getUnindexedContent(vecDb, sessionDb);
      sessionDb.close();
      if (unindexed.length > 0) {
        await indexContent(vecDb, unindexed);
      }
    } finally {
      vecDb.close();
    }
  } catch {
    // Silently handle errors in background indexing
  } finally {
    isIndexing = false;
  }
}

async function search(vecDb, query, limit = 10) {
  const queryEmbedding = await embed(query);

  const results = vecDb
    .prepare(
      `SELECT v.rowid, v.distance, i.session_id, i.source_type, i.content
       FROM vec_items v
       JOIN indexed_items i ON i.id = v.rowid
       WHERE v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`
    )
    .all(queryEmbedding, limit * 3);

  const unique = dedup(results);
  return postProcessResults(unique, limit);
}

// --- Startup (heavy init deferred until after singleton check) ---

// --- HTTP Server (singleton, port 31337) ---

const PORT = parseInt(process.env.VECTOR_MEMORY_PORT || "31337", 10);

const handleRequest = createHandler({
  openVectorDb,
  openSessionStore,
  getUnindexedContent,
  indexContent,
  search,
  runMaintenance,
  getIsIndexing: () => isIndexing,
  setIsIndexing: (v) => { isIndexing = v; },
});

// --- Port conflict resolution ---

function getPortOwnerPid() {
  try {
    const out = execSync(`netstat -ano`, { encoding: "utf-8", windowsHide: true });
    for (const line of out.split("\n")) {
      if (line.includes(`:${PORT}`) && line.includes("LISTENING")) {
        const pid = parseInt(line.trim().split(/\s+/).pop());
        if (!isNaN(pid) && pid > 0) return pid;
      }
    }
  } catch {}
  return null;
}

function getProcessInfo(pid) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object Name,CommandLine | ConvertTo-Json -Compress)"`,
      { encoding: "utf-8", windowsHide: true, timeout: 5000 }
    );
    return JSON.parse(out.trim());
  } catch {}
  return null;
}



// More reliable than process name: check if the server speaks our protocol
async function isOurProtocol() {
  const result = await httpPost("/ping", {}, 3000);
  return result?.ok === true;
}

function httpPost(path, body, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = httpReq(`http://127.0.0.1:${PORT}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end(data);
  });
}

function tryListen(server) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener("listening", onOk); reject(err); };
    const onOk = () => { server.removeListener("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onOk);
    server.listen(PORT, "127.0.0.1");
  });
}

function killPid(pid) {
  try { process.kill(pid, "SIGTERM"); } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Startup ---

const httpServer = createServer(handleRequest);

try {
  await tryListen(httpServer);
  // We're the singleton
  const pidFile = join(COPILOT_DIR, "vector-memory.pid");
  writeFileSync(pidFile, process.pid.toString());
} catch (err) {
  if (err.code !== "EADDRINUSE") throw err;

  // Port conflict — investigate
  const ownerPid = getPortOwnerPid();
  const info = ownerPid ? getProcessInfo(ownerPid) : null;

  // First check: does whatever's on the port speak our protocol?
  if (await isOurProtocol()) {
    // It's a vector-memory server — deep health check with actual search
    const searchResult = await httpPost("/search", { query: "health check", limit: 1 }, 15000);
    if (Array.isArray(searchResult) || (searchResult && searchResult.error == null)) {
      // Singleton is alive and functional — no worker was started, just exit
      process.exit(0);
    }
    // Responds to ping but search is broken/hung — zombie
    process.stderr.write(
      `[vector-memory] Existing server (PID: ${ownerPid}) responds to ping but search is unresponsive. Taking over.\n`
    );
  } else if (isOurServer(info)) {
    // Process looks like ours but doesn't respond to ping — dead zombie
    process.stderr.write(
      `[vector-memory] Existing server (PID: ${ownerPid}) is not responding. Taking over.\n`
    );
  } else {
    // Foreign process — report and bail (no worker was started)
    const name = info?.Name ?? "unknown";
    const cmd = info?.CommandLine ?? "(no command line)";
    process.stderr.write(
      `[vector-memory] FATAL: Port ${PORT} already in use by ${name} (PID: ${ownerPid ?? "unknown"})\n` +
      `  Command: ${cmd}\n` +
      `  Cannot start vector-memory server. Free the port or change PORT.\n`
    );
    process.exit(1);
  }
  killPid(ownerPid);
  await sleep(3000);

  // Retry
  try {
    const retryServer = createServer(handleRequest);
    await tryListen(retryServer);
    const pidFile = join(COPILOT_DIR, "vector-memory.pid");
    writeFileSync(pidFile, process.pid.toString());
    retryServer.on("error", (e) => { throw e; });
  } catch (retryErr) {
    process.stderr.write(
      `[vector-memory] FATAL: Failed to bind port ${PORT} even after killing PID ${ownerPid}.\n` +
      `  ${retryErr.message}\n`
    );
    process.exit(1);
  }
}

// --- We won the singleton race — now do the heavy init ---
initWorker();

{
  const vecDb = openVectorDb();
  runMaintenance(vecDb);
  vecDb.close();
}
backgroundIndex();
setInterval(backgroundIndex, INDEX_INTERVAL_MS);

// Cleanup on exit
function cleanup() {
  try {
    const pidFile = join(COPILOT_DIR, "vector-memory.pid");
    if (existsSync(pidFile)) unlinkSync(pidFile);
  } catch {}
  if (worker) worker.terminate();
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
