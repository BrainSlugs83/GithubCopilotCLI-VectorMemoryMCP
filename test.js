import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { filterUnindexed, dedup, postProcessResults, isOurServer, isIndexable, userPort, BASE_PORT, MIN_SCORE, createHandler } from "./lib.js";

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
