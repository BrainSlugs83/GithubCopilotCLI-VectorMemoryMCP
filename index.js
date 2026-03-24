#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { request } from "http";
import { userInfo } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COPILOT_DIR = join(homedir(), ".copilot");
const EXPECTED_USER = userInfo().username;
const PKG = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));

import { userPort } from "./lib.js";
const PORT = parseInt(process.env.VECTOR_MEMORY_PORT || String(userPort(EXPECTED_USER)), 10);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const PID_FILE = join(COPILOT_DIR, "vector-memory.pid");

// --- Check if server is running ---

function ping() {
  return new Promise((resolve) => {
    const req = request(`${SERVER_URL}/ping`, { method: "POST", timeout: 2000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end(JSON.stringify({}));
  });
}

function validateServer(pingResult) {
  if (!pingResult || !pingResult.ok) return null;

  if (pingResult.user && pingResult.user !== EXPECTED_USER) {
    throw new Error(
      `Port ${PORT} is owned by user "${pingResult.user}" (expected "${EXPECTED_USER}"). ` +
      `Fix: set VECTOR_MEMORY_PORT to a unique port in ~/.copilot/mcp-config.json — ` +
      `see https://github.com/BrainSlugs83/GithubCopilotCLI-VectorMemoryMCP#port-owned-by-another-user`
    );
  }

  if (pingResult.version && pingResult.version !== PKG.version) {
    process.stderr.write(
      `[vector-memory] Warning: server version ${pingResult.version} ≠ proxy version ${PKG.version}. Consider restarting.\n`
    );
  }

  return true;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureServer() {
  // Check if already running
  const existing = await ping();
  if (existing) {
    validateServer(existing);
    return;
  }

  // Check stale pidfile — if process is alive but not responding, give it a moment
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    if (!isNaN(pid) && isProcessAlive(pid)) {
      // Process exists but not responding — it may still be starting up
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const result = await ping();
        if (result) {
          validateServer(result);
          return;
        }
      }
      // Still alive but not responding — fall through to launch a new one
    }
  }

  // Launch server detached
  const serverPath = join(__dirname, "vector-memory-server.js");
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, VECTOR_MEMORY_PORT: String(PORT) },
  });
  child.unref();
}

// Wait for the server to become responsive, with a configurable timeout.
// Returns true if ready, false if timed out.
async function waitForServer(maxWaitMs = 300_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const result = await ping();
    if (result) {
      validateServer(result);
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// --- HTTP client helper ---

function callServer(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(`${SERVER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.end(data);
  });
}

// Auto-relaunch wrapper: if the server isn't reachable, launch it and wait patiently.
// On first run the model download can take several minutes — we wait up to 5 min.
const WARMUP_MSG =
  "⏳ Vector memory server is still starting up (first launch downloads a ~34 MB ML model " +
  "and compiles native modules — this is a one-time cost). Try again in a minute or two.";

async function callServerWithRetry(path, body) {
  try {
    return await callServer(path, body);
  } catch (err) {
    if (err.message && (err.message.includes("ECONNREFUSED") || err.message.includes("ECONNRESET"))) {
      // Server isn't responding — (re)launch and wait for it
      await ensureServer();
      const ready = await waitForServer(300_000); // 5 minutes for first-run model download
      if (!ready) {
        return { error: WARMUP_MSG };
      }
      return await callServer(path, body);
    }
    throw err;
  }
}

// --- Keepalive: ping server every 2 minutes to prevent idle shutdown ---
const KEEPALIVE_MS = 2 * 60_000;
const keepaliveTimer = setInterval(async () => {
  try {
    const result = await ping();
    if (!result) {
      // Server died — relaunch it (non-blocking)
      await ensureServer();
    }
  } catch {}
}, KEEPALIVE_MS);
keepaliveTimer.unref(); // Don't block process exit for keepalive

// --- Start: launch server in background, connect MCP transport immediately ---
// Don't block here — the server may need minutes on first run to download the ML model.
// Tools will wait for the server when called.
ensureServer().catch(() => {});  // fire-and-forget; tools handle readiness

const server = new McpServer(
  {
    name: "vector-memory",
    version: PKG.version,
  },
  {
    instructions: [
      "## Vector Memory — Usage Guide",
      "",
      "You have a `vector_search` tool that provides **semantic search across all past session history.**",
      "Use it proactively and aggressively — don't wait to be asked.",
      "",
      "### When to search (default to searching — it's local, free, and instant):",
      "- Any topic where prior sessions might have context (a project, tool, concept, problem)",
      "- User mentions something that implies shared history: \"remember when...\", \"didn't we...\", \"have we ever...\"",
      "- User annotates a word with `(r)` or `(recall)` — e.g. \"my RTX 3090(r) machine\" — treat it like a hyperlink to memory",
      "- Beginning of a new session — search for recent context on the current repo/directory",
      "- Before making assumptions about prior decisions or conventions — check memory first",
      "- When the user starts a task similar to something done before",
      "",
      "### How it works:",
      "- It's **semantic** search — query by concept, not just keywords. \"How did we handle auth\" finds results even if \"auth\" was never literally used.",
      "- It's stochastic — results vary slightly each call. If a search doesn't surface what you need, rephrase and try again.",
      "- Better to search and find nothing than to miss context that existed.",
      "- Use `vector_reindex` only if results seem stale — auto-indexing handles most cases.",
      "",
      "### Architecture (for troubleshooting):",
      "- Singleton HTTP server (one ONNX model in memory shared across all copilot instances)",
      "- Thin STDIO proxy per copilot instance auto-launches the server if needed",
      "- Server idles down after 5 min of inactivity; proxy restarts it on next use",
    ].join("\n"),
  },
);

server.tool(
  "vector_search",
  "Semantic search across all past GHCP session history. Use this for finding past conversations, " +
    "code changes, decisions, and context by meaning — not just keywords. Returns ranked results " +
    "with similarity scores. Much better than FTS5 keyword search for conceptual queries.",
  {
    query: z.string().describe("Natural language search query — what are you looking for?"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .default(10)
      .describe("Max results to return (default 10)"),
  },
  async ({ query, limit }) => {
    try {
      const results = await callServerWithRetry("/search", { query, limit });

      if (results.error) {
        return { content: [{ type: "text", text: `Error: ${results.error}` }] };
      }
      if (!results.length || results.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }

      const formatted = results
        .map(
          (r, i) =>
            `**#${i + 1}** (score: ${r.score}, type: ${r.source_type}, session: ${r.session_id})\n${r.snippet}`
        )
        .join("\n\n---\n\n");

      return { content: [{ type: "text", text: formatted }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Vector search unavailable: ${err.message}` }] };
    }
  }
);

server.tool(
  "vector_reindex",
  "Force a full reindex of the vector search database. Normally not needed — " +
    "vector_search auto-indexes new content. Use this if the index seems stale or corrupted.",
  {},
  async () => {
    try {
      const result = await callServerWithRetry("/reindex", {});
      if (result.error) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      }
      return {
        content: [{ type: "text", text: `Reindexed ${result.count} items into vector search database.` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Reindex unavailable: ${err.message}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
