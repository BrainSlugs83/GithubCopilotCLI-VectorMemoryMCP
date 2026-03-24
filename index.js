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

  // Check stale pidfile
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    if (!isNaN(pid) && !isProcessAlive(pid)) {
      // Stale pid, server is dead
    } else if (!isNaN(pid) && isProcessAlive(pid)) {
      // Process exists but not responding to ping yet — wait a bit
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const result = await ping();
        if (result) {
          validateServer(result);
          return;
        }
      }
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

  // Wait for it to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const result = await ping();
    if (result) {
      validateServer(result);
      return;
    }
  }
  throw new Error(
    `Vector memory server failed to start — port ${PORT} may be in use by another service. ` +
    `Fix: set VECTOR_MEMORY_PORT to an unused port in ~/.copilot/mcp-config.json — ` +
    `see https://github.com/BrainSlugs83/GithubCopilotCLI-VectorMemoryMCP#port-occupied-by-another-service`
  );
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

// Auto-relaunch wrapper: retries once after ensureServer on connection failure
async function callServerWithRetry(path, body) {
  try {
    return await callServer(path, body);
  } catch (err) {
    if (err.message && (err.message.includes("ECONNREFUSED") || err.message.includes("ECONNRESET"))) {
      startupError = null;
      await ensureServer();
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
      // Server died — relaunch it
      startupError = null;
      await ensureServer();
    }
  } catch {}
}, KEEPALIVE_MS);
keepaliveTimer.unref(); // Don't block process exit for keepalive

// --- Start: ensure server, then expose MCP tools ---

let startupError = null;
try {
  await ensureServer();
} catch (err) {
  startupError = err.message;
}

const server = new McpServer({
  name: "vector-memory",
  version: PKG.version,
});

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
    if (startupError) {
      return { content: [{ type: "text", text: `⚠ vector-memory misconfigured: ${startupError}` }] };
    }
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
    if (startupError) {
      return { content: [{ type: "text", text: `⚠ vector-memory misconfigured: ${startupError}` }] };
    }
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
