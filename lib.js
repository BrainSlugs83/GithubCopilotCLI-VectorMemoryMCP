// Pure functions extracted for testability

export const DIMS = 384;
export const MIN_SCORE = 0.25;
export const JITTER = 0.05;
export const BASE_PORT = 31337;

/** FNV-1a hash with ROR by length, truncated to 12 bits. Deterministic port per username. */
export function userPort(username) {
  const str = username.toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = h >>> 0;
  const rot = str.length % 32;
  h = ((h >>> rot) | (h << (32 - rot))) >>> 0;
  return BASE_PORT + (h & 0xFFF);
}

/** Filter out already-indexed items by comparing composite keys */
export function filterUnindexed(allContent, existingIndex) {
  const indexed = new Set();
  for (const row of existingIndex) {
    indexed.add(`${row.session_id}|${row.source_type}|${row.source_id ?? ""}`);
  }
  return allContent.filter(
    (row) => !indexed.has(`${row.session_id}|${row.source_type}|${row.source_id ?? ""}`)
  );
}

/** Deduplicate results by content */
export function dedup(results) {
  return results.filter(
    (r, i, arr) => arr.findIndex((x) => x.content === r.content) === i
  );
}

/** Apply score floor, jitter, sort, and trim to search results */
export function postProcessResults(results, limit) {
  const filtered = results.filter((r) => (1 - r.distance) >= MIN_SCORE);

  const jittered = filtered.map((r) => ({
    ...r,
    jitteredDistance: r.distance + (Math.random() * 2 - 1) * JITTER,
  }));
  jittered.sort((a, b) => a.jitteredDistance - b.jitteredDistance);

  return jittered.slice(0, limit).map((r) => ({
    score: (1 - r.distance).toFixed(4),
    session_id: r.session_id,
    source_type: r.source_type,
    snippet: r.content.length > 500 ? r.content.slice(0, 500) + "..." : r.content,
  }));
}

/** Check if a process info object looks like our server */
export function isOurServer(info) {
  if (!info?.CommandLine) return false;
  return info.Name === "node.exe" && info.CommandLine.includes("vector-memory-server.js");
}

/** Check if content is too short to index */
export function isIndexable(item) {
  return item.content && item.content.trim().length >= 10;
}

/**
 * Create an HTTP request handler with injected dependencies.
 * @param {object} deps
 * @param {() => object} deps.openVectorDb
 * @param {() => object|null} deps.openSessionStore
 * @param {(vecDb, sessionDb) => Array} deps.getUnindexedContent
 * @param {(vecDb, items) => Promise<number>} deps.indexContent
 * @param {(vecDb, query, limit) => Promise<Array>} deps.search
 * @param {(db) => void} deps.runMaintenance
 * @param {() => boolean} deps.getIsIndexing
 * @param {(v: boolean) => void} deps.setIsIndexing
 */
export function createHandler(deps) {
  return async function handleRequest(req, res) {
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    try {
      let result;
      if (req.url === "/search") {
        const vecDb = deps.openVectorDb();
        try {
          if (!deps.getIsIndexing()) {
            deps.setIsIndexing(true);
            try {
              const sessionDb = deps.openSessionStore();
              if (sessionDb) {
                const unindexed = deps.getUnindexedContent(vecDb, sessionDb);
                sessionDb.close();
                if (unindexed.length > 0) await deps.indexContent(vecDb, unindexed);
              }
            } finally {
              deps.setIsIndexing(false);
            }
          }
          result = await deps.search(vecDb, body.query, body.limit || 10);
        } finally {
          vecDb.close();
        }
      } else if (req.url === "/reindex") {
        if (deps.getIsIndexing()) {
          result = { error: "Indexing already in progress. Try again shortly." };
        } else {
          deps.setIsIndexing(true);
          const vecDb = deps.openVectorDb();
          try {
            vecDb.exec("DELETE FROM indexed_items");
            vecDb.exec("DROP TABLE IF EXISTS vec_items");
            vecDb.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(rowid INTEGER PRIMARY KEY, embedding float[${DIMS}])`);
            const sessionDb = deps.openSessionStore();
            if (!sessionDb) {
              result = { error: "Session store not found." };
            } else {
              const allContent = sessionDb
                .prepare("SELECT rowid, content, session_id, source_type, source_id FROM search_index")
                .all();
              sessionDb.close();
              const count = await deps.indexContent(vecDb, allContent);
              deps.runMaintenance(vecDb);
              result = { count };
            }
          } finally {
            vecDb.close();
            deps.setIsIndexing(false);
          }
        }
      } else if (req.url === "/ping") {
        const identity = deps.getIdentity ? deps.getIdentity() : {};
        result = { ok: true, ...identity };
      } else {
        res.writeHead(404);
        res.end();
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  };
}

/**
 * Share one in-flight async call between concurrent callers. A rejection clears the
 * memo so the next call retries. Prevents parallel model loads racing one download.
 */
export function memoizeAsync(fn) {
  let promise = null;
  return () => {
    if (!promise) {
      promise = fn().catch((err) => {
        promise = null;
        throw err;
      });
    }
    return promise;
  };
}

/**
 * Like memoizeAsync, but forgets the call once it settles: concurrent callers share one
 * run, and the next call after it finishes starts a fresh one.
 */
export function singleFlight(fn) {
  let promise = null;
  return () => {
    if (!promise) {
      promise = fn().finally(() => { promise = null; });
    }
    return promise;
  };
}

/**
 * The model library writes downloads straight to their final path and treats "file exists"
 * as cached, so an interrupted download leaves a truncated model forever. We record the
 * model's size in a marker after a successful load; a model without a matching marker is
 * incomplete and its directory is deleted so the next load re-downloads it.
 * @returns {boolean} true if the cache directory was deleted.
 */
export function purgeIncompleteModel({ modelPath, markerPath, modelDir }, fsOps) {
  let size;
  try {
    size = fsOps.statSync(modelPath).size;
  } catch {
    return false;
  }
  let recorded = NaN;
  try {
    recorded = parseInt(fsOps.readFileSync(markerPath, "utf-8"), 10);
  } catch { /* no marker: never completed */ }
  if (recorded === size) return false;
  fsOps.rmSync(modelDir, { recursive: true, force: true });
  return true;
}

/** Record that the model at modelPath loaded successfully (see purgeIncompleteModel). */
export function markModelComplete({ modelPath, markerPath }, fsOps) {
  fsOps.writeFileSync(markerPath, String(fsOps.statSync(modelPath).size));
}

/**
 * Stamp written to .server/.version after installing server deps. Includes the Node ABI
 * (process.versions.modules) because native deps such as better-sqlite3 are compiled for
 * one ABI: after a Node upgrade the old binaries fail to load and the server dies at start.
 */
export function serverDepsStamp(version, nodeAbi) {
  return `${version} node-abi-${nodeAbi}`;
}

/**
 * True if an existing .server install was built for a different (or unrecorded) Node ABI,
 * so `npm install` alone would keep incompatible native binaries and a rebuild is needed.
 * @param {string|null} previousStamp contents of .server/.version, or null if absent.
 */
export function needsNativeRebuild(previousStamp, nodeAbi) {
  if (previousStamp == null) return false;
  return !previousStamp.trim().endsWith(` node-abi-${nodeAbi}`);
}