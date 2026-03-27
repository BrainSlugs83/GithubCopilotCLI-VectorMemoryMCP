import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { filterUnindexed, dedup, postProcessResults, isOurServer, isIndexable, userPort, BASE_PORT, MIN_SCORE, createHandler } from "./lib.js";
import { createEmbedPool } from "./embed-pool.js";

// --- Mock helpers for handler tests ---

function mockReq(method, url, body = {}) {
  const data = JSON.stringify(body);
  const stream = Readable.from([Buffer.from(data)]);
  stream.method = method;
  stream.url = url;
  return stream;
}

function mockRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    writeHead(code, headers) { res.statusCode = code; res.headers = headers || {}; },
    end(data) { res.body = data ? JSON.parse(data) : null; res._ended = true; },
    _ended: false,
  };
  return res;
}

function makeDeps(overrides = {}) {
  let _isIndexing = false;
  const closedDbs = [];
  return {
    openVectorDb: () => ({
      close() { closedDbs.push("vec"); },
      exec() {},
      prepare: () => ({ all: () => [] }),
    }),
    openSessionStore: () => ({
      close() { closedDbs.push("session"); },
      prepare: () => ({ all: () => [] }),
    }),
    getUnindexedContent: () => [],
    indexContent: async () => 0,
    search: async (_db, _q, _l) => [{ score: "0.5000", session_id: "s1", source_type: "turn", snippet: "test" }],
    runMaintenance: () => {},
    getIsIndexing: () => _isIndexing,
    setIsIndexing: (v) => { _isIndexing = v; },
    _closedDbs: closedDbs,
    _setIsIndexing: (v) => { _isIndexing = v; },
    ...overrides,
  };
}

describe("userPort", () => {
  it("returns a number within the expected range", () => {
    const port = userPort("testuser");
    assert.ok(port >= BASE_PORT, `port ${port} should be >= ${BASE_PORT}`);
    assert.ok(port <= BASE_PORT + 0xFFF, `port ${port} should be <= ${BASE_PORT + 0xFFF}`);
  });

  it("is deterministic for the same username", () => {
    assert.equal(userPort("alice"), userPort("alice"));
  });

  it("is case-insensitive", () => {
    assert.equal(userPort("Alice"), userPort("alice"));
  });

  it("returns different ports for different usernames", () => {
    // Not guaranteed for all pairs, but statistically overwhelmingly likely
    assert.notEqual(userPort("alice"), userPort("bob"));
  });
});

describe("filterUnindexed", () => {
  it("returns items not in the existing index", () => {
    const all = [
      { session_id: "s1", source_type: "turn", source_id: "1", content: "hello" },
      { session_id: "s1", source_type: "turn", source_id: "2", content: "world" },
      { session_id: "s2", source_type: "checkpoint", source_id: "1", content: "foo" },
    ];
    const existing = [
      { session_id: "s1", source_type: "turn", source_id: "1" },
    ];
    const result = filterUnindexed(all, existing);
    assert.equal(result.length, 2);
    assert.equal(result[0].content, "world");
    assert.equal(result[1].content, "foo");
  });

  it("returns all items when index is empty", () => {
    const all = [
      { session_id: "s1", source_type: "turn", source_id: "1", content: "a" },
    ];
    const result = filterUnindexed(all, []);
    assert.equal(result.length, 1);
  });

  it("returns empty when everything is indexed", () => {
    const all = [
      { session_id: "s1", source_type: "turn", source_id: "1", content: "a" },
    ];
    const existing = [
      { session_id: "s1", source_type: "turn", source_id: "1" },
    ];
    const result = filterUnindexed(all, existing);
    assert.equal(result.length, 0);
  });

  it("handles null source_id correctly", () => {
    const all = [
      { session_id: "s1", source_type: "turn", source_id: null, content: "a" },
      { session_id: "s1", source_type: "turn", source_id: null, content: "b" },
    ];
    const existing = [
      { session_id: "s1", source_type: "turn", source_id: null },
    ];
    // Both map to same key, so both filtered
    const result = filterUnindexed(all, existing);
    assert.equal(result.length, 0);
  });
});

describe("dedup", () => {
  it("removes duplicate content", () => {
    const results = [
      { content: "hello", distance: 0.1 },
      { content: "hello", distance: 0.2 },
      { content: "world", distance: 0.3 },
    ];
    const result = dedup(results);
    assert.equal(result.length, 2);
    assert.equal(result[0].distance, 0.1); // keeps first occurrence
  });

  it("preserves order of first occurrences", () => {
    const results = [
      { content: "a", distance: 0.1 },
      { content: "b", distance: 0.2 },
      { content: "a", distance: 0.3 },
      { content: "c", distance: 0.4 },
    ];
    const result = dedup(results);
    assert.deepEqual(result.map(r => r.content), ["a", "b", "c"]);
  });

  it("returns empty for empty input", () => {
    assert.equal(dedup([]).length, 0);
  });
});

describe("postProcessResults", () => {
  it("filters results below score floor", () => {
    const results = [
      { distance: 0.5, session_id: "s1", source_type: "turn", content: "good" },   // score 0.5 ✓
      { distance: 0.9, session_id: "s1", source_type: "turn", content: "bad" },     // score 0.1 ✗
    ];
    const processed = postProcessResults(results, 10);
    assert.equal(processed.length, 1);
    assert.equal(processed[0].score, "0.5000");
  });

  it("respects limit", () => {
    const results = Array.from({ length: 20 }, (_, i) => ({
      distance: 0.3 + i * 0.01,
      session_id: "s1",
      source_type: "turn",
      content: `item ${i}`,
    }));
    const processed = postProcessResults(results, 5);
    assert.equal(processed.length, 5);
  });

  it("truncates long content to 500 chars with ellipsis", () => {
    const longContent = "x".repeat(600);
    const results = [
      { distance: 0.3, session_id: "s1", source_type: "turn", content: longContent },
    ];
    const processed = postProcessResults(results, 10);
    assert.equal(processed[0].snippet.length, 503); // 500 + "..."
    assert.ok(processed[0].snippet.endsWith("..."));
  });

  it("reports true score, not jittered", () => {
    const results = [
      { distance: 0.4, session_id: "s1", source_type: "turn", content: "test" },
    ];
    const processed = postProcessResults(results, 10);
    assert.equal(processed[0].score, "0.6000");
  });

  it("returns empty for all-garbage input", () => {
    const results = [
      { distance: 0.95, session_id: "s1", source_type: "turn", content: "noise" },
    ];
    const processed = postProcessResults(results, 10);
    assert.equal(processed.length, 0);
  });

  it("score floor is exactly MIN_SCORE", () => {
    const exactlyAtFloor = [
      { distance: 1 - MIN_SCORE, session_id: "s1", source_type: "turn", content: "borderline" },
    ];
    const processed = postProcessResults(exactlyAtFloor, 10);
    assert.equal(processed.length, 1);
  });
});

describe("isOurServer", () => {
  it("matches our server", () => {
    assert.ok(isOurServer({
      Name: "node.exe",
      CommandLine: '"C:\\nvm4w\\nodejs\\node.exe" vector-memory-server.js',
    }));
  });

  it("rejects different process", () => {
    assert.ok(!isOurServer({
      Name: "python.exe",
      CommandLine: "python server.py",
    }));
  });

  it("rejects node running different script", () => {
    assert.ok(!isOurServer({
      Name: "node.exe",
      CommandLine: '"node" app.js',
    }));
  });

  it("rejects null/undefined info", () => {
    assert.ok(!isOurServer(null));
    assert.ok(!isOurServer(undefined));
    assert.ok(!isOurServer({}));
  });

  it("rejects missing CommandLine", () => {
    assert.ok(!isOurServer({ Name: "node.exe" }));
  });
});

describe("isIndexable", () => {
  it("accepts content >= 10 chars", () => {
    assert.ok(isIndexable({ content: "hello world" }));
  });

  it("rejects short content", () => {
    assert.ok(!isIndexable({ content: "hi" }));
  });

  it("rejects empty content", () => {
    assert.ok(!isIndexable({ content: "" }));
  });

  it("rejects null/undefined content", () => {
    assert.ok(!isIndexable({ content: null }));
    assert.ok(!isIndexable({}));
  });

  it("trims whitespace before checking length", () => {
    assert.ok(!isIndexable({ content: "   hi     " }));
    assert.ok(isIndexable({ content: "   hello world   " }));
  });
});

// --- Handler tests (DI) ---

describe("handleRequest - /ping", () => {
  it("returns { ok: true }", async () => {
    const handler = createHandler(makeDeps());
    const res = mockRes();
    await handler(mockReq("POST", "/ping"), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it("includes identity when getIdentity is provided", async () => {
    const deps = makeDeps({
      getIdentity: () => ({ user: "testuser", version: "1.0.0" }),
    });
    const handler = createHandler(deps);
    const res = mockRes();
    await handler(mockReq("POST", "/ping"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.user, "testuser");
    assert.equal(res.body.version, "1.0.0");
  });
});

describe("handleRequest - routing", () => {
  it("returns 404 for GET requests", async () => {
    const handler = createHandler(makeDeps());
    const res = mockRes();
    await handler(mockReq("GET", "/ping"), res);
    assert.equal(res.statusCode, 404);
  });

  it("returns 404 for unknown POST paths", async () => {
    const handler = createHandler(makeDeps());
    const res = mockRes();
    await handler(mockReq("POST", "/unknown"), res);
    assert.equal(res.statusCode, 404);
  });
});

describe("handleRequest - /search", () => {
  it("returns search results", async () => {
    const deps = makeDeps();
    const handler = createHandler(deps);
    const res = mockRes();
    await handler(mockReq("POST", "/search", { query: "test", limit: 5 }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body[0].score, "0.5000");
  });

  it("defaults limit to 10", async () => {
    let capturedLimit;
    const deps = makeDeps({
      search: async (_db, _q, limit) => { capturedLimit = limit; return []; },
    });
    const handler = createHandler(deps);
    await handler(mockReq("POST", "/search", { query: "test" }), mockRes());
    assert.equal(capturedLimit, 10);
  });

  it("skips inline indexing when isIndexing is true", async () => {
    let indexCalled = false;
    const deps = makeDeps({
      indexContent: async () => { indexCalled = true; return 1; },
      getUnindexedContent: () => [{ content: "something here!" }],
    });
    deps._setIsIndexing(true);
    const handler = createHandler(deps);
    await handler(mockReq("POST", "/search", { query: "test" }), mockRes());
    assert.ok(!indexCalled, "indexContent should not be called when isIndexing is true");
  });

  it("does inline indexing when isIndexing is false and there is unindexed content", async () => {
    let indexCalled = false;
    const deps = makeDeps({
      indexContent: async () => { indexCalled = true; return 1; },
      getUnindexedContent: () => [{ content: "something here!" }],
    });
    const handler = createHandler(deps);
    await handler(mockReq("POST", "/search", { query: "test" }), mockRes());
    assert.ok(indexCalled);
  });

  it("resets isIndexing after inline indexing completes", async () => {
    const deps = makeDeps({
      getUnindexedContent: () => [{ content: "something here!" }],
      indexContent: async () => 1,
    });
    const handler = createHandler(deps);
    await handler(mockReq("POST", "/search", { query: "test" }), mockRes());
    assert.equal(deps.getIsIndexing(), false);
  });

  it("resets isIndexing even if indexContent throws", async () => {
    const deps = makeDeps({
      getUnindexedContent: () => [{ content: "something here!" }],
      indexContent: async () => { throw new Error("boom"); },
    });
    const handler = createHandler(deps);
    const res = mockRes();
    await handler(mockReq("POST", "/search", { query: "test" }), res);
    assert.equal(deps.getIsIndexing(), false);
    assert.equal(res.statusCode, 500);
  });

  it("closes vecDb even on error", async () => {
    const deps = makeDeps({
      search: async () => { throw new Error("search failed"); },
    });
    const handler = createHandler(deps);
    await handler(mockReq("POST", "/search", { query: "test" }), mockRes());
    assert.ok(deps._closedDbs.includes("vec"));
  });

  it("skips indexing when sessionStore is null", async () => {
    let indexCalled = false;
    const deps = makeDeps({
      openSessionStore: () => null,
      indexContent: async () => { indexCalled = true; return 1; },
    });
    const handler = createHandler(deps);
    const res = mockRes();
    await handler(mockReq("POST", "/search", { query: "test" }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(!indexCalled, "indexContent should not be called when sessionStore is null");
  });
});

describe("handleRequest - /reindex", () => {
  it("rejects when isIndexing is true", async () => {
    const deps = makeDeps();
    deps._setIsIndexing(true);
    const handler = createHandler(deps);
    const res = mockRes();
    await handler(mockReq("POST", "/reindex"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.error, "Indexing already in progress. Try again shortly.");
  });

  it("returns count on success", async () => {
    const deps = makeDeps({
      openSessionStore: () => ({
        close() {},
        prepare: () => ({ all: () => [{ content: "x", session_id: "s", source_type: "t", source_id: "1" }] }),
      }),
      indexContent: async () => 42,
    });
    const handler = createHandler(deps);
    const res = mockRes();
    await handler(mockReq("POST", "/reindex"), res);
    assert.equal(res.body.count, 42);
  });

  it("returns error when session store not found", async () => {
    const deps = makeDeps({ openSessionStore: () => null });
    const handler = createHandler(deps);
    const res = mockRes();
    await handler(mockReq("POST", "/reindex"), res);
    assert.equal(res.body.error, "Session store not found.");
  });

  it("resets isIndexing after reindex completes", async () => {
    const deps = makeDeps();
    const handler = createHandler(deps);
    await handler(mockReq("POST", "/reindex"), mockRes());
    assert.equal(deps.getIsIndexing(), false);
  });

  it("resets isIndexing even on error", async () => {
    const deps = makeDeps({
      openVectorDb: () => ({
        close() {},
        exec() { throw new Error("db exploded"); },
      }),
    });
    const handler = createHandler(deps);
    const res = mockRes();
    await handler(mockReq("POST", "/reindex"), res);
    assert.equal(deps.getIsIndexing(), false);
    assert.equal(res.statusCode, 500);
  });
});

// --- MockWorker for embed pool tests ---

class MockWorker extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.terminated = false;
  }
  postMessage(msg) {
    this.messages.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
}

function mockWorkerFactory() {
  const workers = [];
  const factory = () => {
    const w = new MockWorker();
    workers.push(w);
    return w;
  };
  factory.workers = workers;
  return factory;
}

// --- Embed pool tests ---

describe("createEmbedPool", () => {
  it("embeds text through the worker (happy path)", async () => {
    const factory = mockWorkerFactory();
    const pool = createEmbedPool(factory);
    pool.initWorker();

    const p = pool.embed("hello");
    const msg = factory.workers[0].messages[0];
    factory.workers[0].emit("message", { id: msg.id, embedding: Buffer.from([1, 2, 3]) });

    const result = await p;
    assert.deepEqual(result, Buffer.from([1, 2, 3]));
    pool.shutdown();
  });

  it("rejects embed when worker was never started", async () => {
    const pool = createEmbedPool(() => new MockWorker());
    await assert.rejects(() => pool.embed("hello"), /Embed worker is not running/);
  });

  it("rejects pending embeds on worker error", async () => {
    const factory = mockWorkerFactory();
    const pool = createEmbedPool(factory);
    pool.initWorker();

    const p = pool.embed("hello");
    factory.workers[0].emit("error", new Error("segfault"));

    await assert.rejects(() => p, /Worker crashed/);
    pool.shutdown();
  });

  it("restarts worker on non-zero exit", async () => {
    const factory = mockWorkerFactory();
    const pool = createEmbedPool(factory, { restartDelay: 50 });
    pool.initWorker();

    factory.workers[0].emit("exit", 1);
    await new Promise(r => setTimeout(r, 100));

    assert.equal(factory.workers.length, 2, "worker should have been recreated");
    assert.equal(pool.isAlive(), true);
    pool.shutdown();
  });

  // === BUG TESTS: these demonstrate the issues we're fixing ===

  it("restarts worker on code-0 exit (bug: currently does not)", async () => {
    const factory = mockWorkerFactory();
    const pool = createEmbedPool(factory, { restartDelay: 50 });
    pool.initWorker();

    factory.workers[0].emit("exit", 0);
    await new Promise(r => setTimeout(r, 100));

    assert.equal(factory.workers.length, 2, "worker should restart even on clean exit");
    assert.equal(pool.isAlive(), true, "pool should be alive after code-0 restart");
    pool.shutdown();
  });

  it("waits for worker restart instead of rejecting immediately (bug: currently rejects)", async () => {
    const factory = mockWorkerFactory();
    const pool = createEmbedPool(factory, { restartDelay: 50, workerReadyTimeout: 5000 });
    pool.initWorker();

    // Crash the worker
    factory.workers[0].emit("exit", 1);

    // Immediately try to embed — should wait for restart, not reject
    let rejected = false;
    let error = null;
    const embedPromise = pool.embed("test text")
      .catch(e => { rejected = true; error = e; });

    // Give microtasks a chance to settle (synchronous rejection would be caught here)
    await new Promise(r => setTimeout(r, 10));

    assert.equal(rejected, false,
      `embed() rejected immediately with "${error?.message}" instead of waiting for worker restart`);

    // Let restart happen
    await new Promise(r => setTimeout(r, 100));

    // Respond from new worker
    assert.equal(factory.workers.length, 2, "worker should have restarted");
    const msg = factory.workers[1].messages[0];
    factory.workers[1].emit("message", { id: msg.id, embedding: Buffer.from([4, 5, 6]) });

    await embedPromise;
    assert.equal(rejected, false);
    pool.shutdown();
  });

  it("does not restart after explicit shutdown", async () => {
    const factory = mockWorkerFactory();
    const pool = createEmbedPool(factory, { restartDelay: 50 });
    pool.initWorker();
    pool.shutdown();

    factory.workers[0].emit("exit", 1);
    await new Promise(r => setTimeout(r, 100));

    assert.equal(factory.workers.length, 1, "should not restart after shutdown");
  });

  it("times out if worker restart takes too long", async () => {
    const factory = mockWorkerFactory();
    const pool = createEmbedPool(factory, { restartDelay: 10000, workerReadyTimeout: 50 });
    pool.initWorker();

    factory.workers[0].emit("exit", 1);

    await assert.rejects(() => pool.embed("test"), /restart timed out/i);
    pool.shutdown();
  });

  it("handles worker 'error' message type (model error)", async () => {
    const factory = mockWorkerFactory();
    const pool = createEmbedPool(factory);
    pool.initWorker();

    // Send an error-type message (model failed to load, etc.)
    factory.workers[0].emit("message", { type: "error", message: "ONNX load failed" });

    // Pool should still be alive — this is a non-fatal model error, not a crash
    assert.equal(pool.isAlive(), true);
    pool.shutdown();
  });

  it("times out embed when worker never responds", async () => {
    const factory = mockWorkerFactory();
    const pool = createEmbedPool(factory, { embedTimeout: 50 });
    pool.initWorker();

    // Send an embed but never respond from the mock worker
    await assert.rejects(() => pool.embed("hello"), /timed out after 50ms/);
    pool.shutdown();
  });

  it("rejects embed when postMessage throws", async () => {
    const factory = mockWorkerFactory();
    const pool = createEmbedPool(factory);
    pool.initWorker();

    // Make postMessage throw (simulates worker in bad state)
    factory.workers[0].postMessage = () => { throw new Error("DataCloneError"); };

    await assert.rejects(() => pool.embed("hello"), /DataCloneError/);
    pool.shutdown();
  });

  it("ignores 'ready' message type without affecting pending embeds", async () => {
    const factory = mockWorkerFactory();
    const pool = createEmbedPool(factory);
    pool.initWorker();

    const p = pool.embed("hello");
    // Send a ready message — should be ignored, embed still pending
    factory.workers[0].emit("message", { type: "ready" });

    // Now send the real response
    const msg = factory.workers[0].messages[0];
    factory.workers[0].emit("message", { id: msg.id, embedding: Buffer.from([9]) });

    const result = await p;
    assert.deepEqual(result, Buffer.from([9]));
    pool.shutdown();
  });

  it("ignores response for unknown embed id", async () => {
    const factory = mockWorkerFactory();
    const pool = createEmbedPool(factory);
    pool.initWorker();

    // Send a response for an ID that was never requested — should not throw
    factory.workers[0].emit("message", { id: 99999, embedding: Buffer.from([1]) });
    pool.shutdown();
  });

  it("shutdown is idempotent when no worker was started", () => {
    const pool = createEmbedPool(() => new MockWorker());
    // Should not throw
    pool.shutdown();
    pool.shutdown();
  });

  it("shutdown resolves pending restart waiters", async () => {
    const factory = mockWorkerFactory();
    const pool = createEmbedPool(factory, { restartDelay: 10000, workerReadyTimeout: 5000 });
    pool.initWorker();

    // Trigger exit — restart is scheduled but slow
    factory.workers[0].emit("exit", 1);

    // Start an embed — it will wait for the restart
    const embedPromise = pool.embed("hello").catch(e => e);

    // Shutdown while it's waiting
    pool.shutdown();

    const result = await embedPromise;
    assert.ok(result instanceof Error);
    assert.match(result.message, /not running|shutting down/i);
  });
});
