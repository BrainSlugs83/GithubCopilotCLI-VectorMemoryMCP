// Pure functions extracted for testability

export const DIMS = 384;
export const MIN_SCORE = 0.25;
export const JITTER = 0.05;

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
