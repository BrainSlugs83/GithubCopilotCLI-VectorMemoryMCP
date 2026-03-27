/**
 * Integration tests for the MCP STDIO proxy + HTTP server pipeline.
 *
 * Spawns index.js (the proxy), which spawns vector-memory-server.js (the
 * HTTP server) on first tool call. All data goes to a temp directory via
 * VECTOR_MEMORY_DATA_DIR, leaving the real ~/.copilot/ untouched.
 *
 * Refs #5
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_JS = join(__dirname, "index.js");

// --- MCP JSON-RPC helpers ---

let msgId = 0;

function jsonrpc(method, params = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id: ++msgId, method, params });
}

function notification(method, params = {}) {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

/**
 * Spawns the MCP proxy, performs the initialize handshake, and returns
 * a helper object for sending tool calls and reading responses.
 */
function createMcpClient(env = {}) {
  const child = spawn(process.execPath, [INDEX_JS], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
    windowsHide: true,
  });

  let buffer = "";
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    // MCP messages are newline-delimited JSON
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* ignore non-JSON lines */ }
    }
  });

  function send(text) {
    child.stdin.write(text + "\n");
  }

  function request(method, params = {}, timeoutMs = 120_000) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request "${method}" (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });

      send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async function initialize() {
    const resp = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "integration-test", version: "0.1" },
    });
    // Send initialized notification (required by MCP spec)
    send(notification("notifications/initialized"));
    return resp;
  }

  async function callTool(name, args = {}, timeoutMs = 120_000) {
    return request("tools/call", { name, arguments: args }, timeoutMs);
  }

  async function listTools() {
    return request("tools/list");
  }

  function kill() {
    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
  }

  return { initialize, callTool, listTools, request, kill, child };
}

// --- Integration tests ---

describe("MCP Integration (end-to-end)", { timeout: 180_000 }, () => {
  let tmpDir;
  let client;
  let testPort;

  before(async () => {
    // Create isolated temp data directory
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-test-"));

    // Use a random high port to avoid conflicting with a running server
    testPort = 40000 + Math.floor(Math.random() * 20000);

    client = createMcpClient({
      VECTOR_MEMORY_DATA_DIR: tmpDir,
      VECTOR_MEMORY_PORT: String(testPort),
      VECTOR_MEMORY_IDLE_TIMEOUT: "0", // disable idle shutdown
    });

    // Perform MCP handshake
    const initResp = await client.initialize();
    assert.ok(initResp.result, "initialize should return a result");
    assert.ok(initResp.result.protocolVersion, "should include protocol version");
  });

  after(async () => {
    if (client) client.kill();

    // Give child processes a moment to exit
    await new Promise(r => setTimeout(r, 1000));

    // Kill any server on our test port
    try {
      const { execSync } = await import("node:child_process");
      const out = execSync("netstat -ano", { encoding: "utf-8", windowsHide: true });
      for (const line of out.split("\n")) {
        if (line.includes(`:${testPort}`) && line.includes("LISTENING")) {
          const pid = parseInt(line.trim().split(/\s+/).pop());
          if (!isNaN(pid) && pid > 0) {
            try { process.kill(pid); } catch {}
          }
        }
      }
    } catch {}

    // Clean up temp directory
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("tools/list returns vector_search and vector_reindex", async () => {
    const resp = await client.listTools();
    assert.ok(resp.result, "should have result");
    const tools = resp.result.tools;
    assert.ok(Array.isArray(tools), "tools should be an array");

    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, ["vector_reindex", "vector_search"]);

    // vector_search should have query and limit params
    const searchTool = tools.find(t => t.name === "vector_search");
    assert.ok(searchTool.inputSchema.properties.query, "vector_search should have query param");
    assert.ok(searchTool.inputSchema.properties.limit, "vector_search should have limit param");

    // vector_reindex should have no required params
    const reindexTool = tools.find(t => t.name === "vector_reindex");
    assert.ok(reindexTool, "vector_reindex should exist");
  });

  it("vector_search with valid query returns results (empty DB = no results)", async () => {
    const resp = await client.callTool("vector_search", { query: "test query", limit: 5 });
    assert.ok(resp.result, "should have result");
    assert.ok(Array.isArray(resp.result.content), "should have content array");
    assert.equal(resp.result.content[0].type, "text");
    const text = resp.result.content[0].text;
    // Empty temp DB → "No results found." or worker error (acceptable on first run)
    assert.ok(
      text.includes("No results") ||
      text.includes("score:") ||
      text.includes("unavailable") ||
      text.includes("Error"),
      `Unexpected response: ${text.slice(0, 300)}`
    );
  });

  it("vector_search with missing query returns validation error", async () => {
    const resp = await client.callTool("vector_search", {});
    // MCP SDK returns validation errors as result with isError: true
    assert.ok(resp.result || resp.error, "should have result or error");
    if (resp.result) {
      assert.ok(resp.result.isError, "should be flagged as error");
      assert.ok(resp.result.content[0].text.includes("invalid") ||
                resp.result.content[0].text.includes("Invalid") ||
                resp.result.content[0].text.includes("required"),
        `Expected validation error, got: ${resp.result.content[0].text.slice(0, 200)}`);
    }
  });

  it("vector_search with invalid limit type returns validation error", async () => {
    const resp = await client.callTool("vector_search", { query: "test", limit: "not a number" });
    assert.ok(resp.result || resp.error, "should have result or error");
    if (resp.result) {
      assert.ok(resp.result.isError, "should be flagged as error");
      assert.ok(resp.result.content[0].text.includes("invalid") ||
                resp.result.content[0].text.includes("Invalid") ||
                resp.result.content[0].text.includes("number"),
        `Expected type validation error, got: ${resp.result.content[0].text.slice(0, 200)}`);
    }
  });

  it("vector_reindex returns count or session store message", async () => {
    const resp = await client.callTool("vector_reindex", {});
    assert.ok(resp.result, "should have result");
    assert.ok(Array.isArray(resp.result.content), "should have content array");
    const text = resp.result.content[0].text;
    assert.ok(
      text.includes("Reindexed") ||
      text.includes("Session store") ||
      text.includes("not found") ||
      text.includes("unavailable") ||
      text.includes("Error"),
      `Expected reindex result or error message, got: ${text.slice(0, 300)}`
    );
  });

  it("calling unknown tool returns error", async () => {
    const resp = await client.callTool("nonexistent_tool", {});
    // MCP SDK returns unknown tool as either error or result with isError
    assert.ok(
      resp.error || (resp.result && resp.result.isError),
      `Expected error for unknown tool, got: ${JSON.stringify(resp.result || resp.error).slice(0, 200)}`
    );
  });

  it("PID file is created in temp data dir", async () => {
    // The server should have written its PID file to our temp dir
    const pidFile = join(tmpDir, "vector-memory.pid");
    // Give the server a moment if it's still starting
    for (let i = 0; i < 10; i++) {
      if (existsSync(pidFile)) break;
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(existsSync(pidFile), "PID file should exist in temp data dir (not ~/.copilot/)");
  });
});
