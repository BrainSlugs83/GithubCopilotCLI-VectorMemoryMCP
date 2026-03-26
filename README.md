# Vector Memory MCP Server for GitHub Copilot CLI

[![CI](https://github.com/BrainSlugs83/GithubCopilotCLI-VectorMemoryMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainSlugs83/GithubCopilotCLI-VectorMemoryMCP/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/ghcp-cli-vector-memory-mcp)](https://www.npmjs.com/package/ghcp-cli-vector-memory-mcp)
[![npm downloads](https://img.shields.io/npm/dm/ghcp-cli-vector-memory-mcp)](https://www.npmjs.com/package/ghcp-cli-vector-memory-mcp)
[![license](https://img.shields.io/npm/l/ghcp-cli-vector-memory-mcp)](LICENSE)
[![node](https://img.shields.io/node/v/ghcp-cli-vector-memory-mcp)](package.json)

An [MCP](https://modelcontextprotocol.io/) server that adds **persistent long-term memory** to [**GitHub Copilot CLI**](https://docs.github.com/en/copilot/github-copilot-in-the-cli) via local semantic vector search. Copilot can recall past conversations, code changes, and decisions across all sessions — by meaning, not just keywords.

> **Note:** This is a community project and is not affiliated with or endorsed by GitHub. [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) is a product of GitHub / Microsoft.

---

## Installation

### Prerequisites

You need **Node.js ≥18** installed. This gives you `node`, `npm`, and `npx`.

- **Windows:** `winget install OpenJS.NodeJS.LTS`
- **macOS:** `brew install node` or download from [nodejs.org](https://nodejs.org)
- **Linux:** Use your package manager or [nodejs.org](https://nodejs.org)

That's it. The native SQLite modules (`better-sqlite3`, `sqlite-vec`) ship prebuilt binaries for Windows (x64), macOS (x64, ARM), and Linux (x64, ARM) — no compiler or build tools needed.

> <details><summary>Build tools only needed if prebuilds aren't available for your platform</summary>
>
> If you're on an unusual platform and the prebuilt binaries aren't available, `better-sqlite3` falls back to compiling from source. In that case you'll need:
> - **Windows:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload
> - **macOS:** `xcode-select --install`
> - **Linux:** `sudo apt install build-essential python3` (or equivalent)
>
> </details>

### Step 1: Find (or create) your MCP config file

GitHub Copilot CLI reads MCP server definitions from a JSON config file. The **user-level** config lives at:

| OS | Path |
|---|---|
| **Windows** | `%USERPROFILE%\.copilot\mcp-config.json` (e.g. `C:\Users\YourName\.copilot\mcp-config.json`) |
| **macOS / Linux** | `~/.copilot/mcp-config.json` |

> **If this file doesn't exist yet**, create it. If the `.copilot` folder doesn't exist either, create that too — Copilot CLI will use it.
>
> You can also place a **project-level** config at `.copilot/mcp-config.json` in any repo root, but user-level is recommended for this server since it provides memory across all projects.

### Step 2: Add the vector-memory server

**If the file doesn't exist or is empty**, create it with this content:

```json
{
  "mcpServers": {
    "vector-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "ghcp-cli-vector-memory-mcp"]
    }
  }
}
```

**If you already have an `mcp-config.json`** with other servers, add the `"vector-memory"` entry inside the existing `"mcpServers"` object:

```json
{
  "mcpServers": {
    "your-existing-server": { "...": "..." },
    "vector-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "ghcp-cli-vector-memory-mcp"]
    }
  }
}
```

> **You do not need to clone this repo or run `npm install` yourself.** The `npx -y` command automatically downloads, installs, and runs the package from the npm registry. It caches the package locally so subsequent launches are fast.

### Step 3: Load the server

Close any running Copilot CLI session and start a new one — **or** if you already have a session open, type `/mcp reload` to pick up the new config without restarting. The MCP server will launch automatically in the background.

> [!IMPORTANT]
> **The very first launch takes a few minutes.** On first run, `npx` installs the package and its
> native dependencies, then the server downloads a small machine learning model (~34 MB,
> [Xenova/gte-small](https://huggingface.co/Xenova/gte-small)). This is a **one-time cost** —
> subsequent starts are near-instant.
>
> The MCP proxy connects immediately and won't block Copilot CLI from starting. If you try to
> use vector search before the model is ready, it will tell you it's still warming up.

> [!NOTE]
> **Runs comfortably on any laptop.** The ONNX embedding model is tiny (~34 MB in memory) and
> inference is fast even on CPU. There is no GPU requirement. You will not notice any impact on
> battery life or system performance. The server also idles down and exits automatically after
> 5 minutes of inactivity, so it costs zero resources when you're not using Copilot.

### Step 4: Verify it's working

In a new Copilot CLI session, ask:

```
Do you have vector search available?
```

Copilot should confirm it has the `vector_search` and `vector_reindex` tools. If it's the first launch and the model is still downloading, it will tell you — just wait a minute and try again.

---

## What it does

Once installed, Copilot CLI gains two new tools:

| Tool | Description |
|---|---|
| `vector_search` | Semantic search across all past session history. Find conversations, code changes, and decisions by meaning — not just keywords. Returns ranked results with similarity scores. |
| `vector_reindex` | Force a full rebuild of the vector index. Normally not needed — search auto-indexes new content. Use if the index seems stale. |

Copilot will use `vector_search` automatically when it needs to recall past context. You can also prompt it directly: *"search your memory for..."* or *"do you remember when we..."*

### Data flow

1. Copilot CLI writes session data to `~/.copilot/session-store.db` (this already exists)
2. vector-memory reads from that DB (read-only) and creates embeddings
3. Embeddings are stored in `~/.copilot/vector-index.db`
4. Indexing triggers: on startup, on each search (if new content exists), and every 15 minutes

All data stays local. Nothing is sent to any external service.

---

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `VECTOR_MEMORY_PORT` | *(auto)* | HTTP port for the singleton server. A deterministic port is computed from your OS username (FNV-1a hash, range 31337–35432). Only set this if two users collide. |
| `VECTOR_MEMORY_IDLE_TIMEOUT` | `5` | Minutes of inactivity before the server shuts down. `0` or negative = never shut down. |

Set these in the `env` block of your config (only if needed):

```json
{
  "mcpServers": {
    "vector-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "ghcp-cli-vector-memory-mcp"],
      "env": {
        "VECTOR_MEMORY_IDLE_TIMEOUT": "10"
      }
    }
  }
}
```

### Multi-user setup

On a shared machine, each user's server runs on a unique auto-assigned port. No extra config needed — just use the same `mcp-config.json` entry above and each user gets their own singleton server, vector index, and session history.

In the rare case of a port hash collision, the server detects it at startup and tells the affected user to set `VECTOR_MEMORY_PORT` manually.

---

## Architecture

```
copilot.exe ──STDIO──▶ index.js (proxy) ──HTTP──▶ vector-memory-server.js (singleton)
                                                          │
                                                   embed-worker.js (worker thread)
                                                          │
                                                   Xenova/gte-small (ONNX, 34MB)
```

- **index.js** — Thin STDIO MCP proxy. One per copilot instance. Checks if the HTTP server is running, launches it if not, then ferries tool calls over HTTP.
- **vector-memory-server.js** — Singleton HTTP server. Owns the embedding model (one copy in memory), SQLite vector DB, and background indexing. Port is auto-assigned per user via a deterministic hash of the username.
- **embed-worker.js** — Worker thread that loads the ONNX model and handles embedding inference off the main thread.
- **lib.js** — Pure logic extracted for testability: filtering, dedup, post-processing, process detection.

### Key design decisions

- **Singleton**: Only one server runs regardless of how many copilot instances are open. Saves ~200MB RAM per additional instance.
- **Race condition hardened**: EADDRINUSE detection with full diagnostics — distinguishes between healthy singleton, zombie process, and foreign port conflict.
- **No duplicates**: `UNIQUE` constraint + `INSERT OR IGNORE` + `isIndexing` guard prevents duplicate embeddings even under concurrent access.
- **Lazy init**: ONNX model only loads after winning the singleton race. Losers exit in about 500ms.
- **Idle shutdown**: Server exits after 5 minutes of inactivity (no requests and no new session content). The proxy re-launches it on next use.
- **Self-healing**: Detects and deletes corrupt/truncated model files, re-downloads automatically. Retries with backoff for Windows Defender file locks.

## Development

### Scripts

```bash
npm run lint     # ESLint on all source files
npm test         # 44 unit tests with 100% coverage (node:test, zero external deps)
npm run check    # lint + test
```

### Running tests

```bash
npm test
```

With coverage:

```bash
npm test   # coverage is enforced at 100% by default
```

### File overview

| File | Purpose |
|---|---|
| `index.js` | STDIO MCP proxy — what copilot.exe launches via npx |
| `vector-memory-server.js` | HTTP singleton — owns model, DB, indexing |
| `embed-worker.js` | Worker thread for ONNX embedding inference |
| `lib.js` | Pure logic: filtering, dedup, scoring, handler factory |
| `test.js` | 44 unit tests with DI mocks, 100% coverage enforced |
| `eslint.config.js` | Lint config |

### Manual server management

```bash
# Start server directly (normally done by the proxy)
node vector-memory-server.js

# Check if running (port varies per user — see startup log)
curl -X POST http://127.0.0.1:<PORT>/ping -d "{}"

# Search directly
curl -X POST http://127.0.0.1:<PORT>/search \
  -H "Content-Type: application/json" \
  -d '{"query":"what did I work on yesterday","limit":5}'

# Kill server (find PID first)
cat ~/.copilot/vector-memory.pid
```

---

## Troubleshooting

### First run is slow

This is expected! On first launch, the server needs to:
1. Install native SQLite extensions (`better-sqlite3`, `sqlite-vec`)
2. Download the embedding model (~34 MB from Hugging Face)

This can take **2–5 minutes** depending on your connection speed and whether native compilation is needed. Subsequent launches start in seconds.

### Port collision with another user

**Error:** `Port 31796 is owned by user "X" (expected "Y")`

Two usernames hashed to the same port (rare). One user needs to set a manual override:

```json
{
  "mcpServers": {
    "vector-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "ghcp-cli-vector-memory-mcp"],
      "env": {
        "VECTOR_MEMORY_PORT": "31338"
      }
    }
  }
}
```

### Port occupied by another service

**Error:** `Vector memory server failed to start — port XXXXX may be in use by another service`

Something else is listening on your auto-assigned port. Pick a different port using the `VECTOR_MEMORY_PORT` env var as above.

To check what's on the port:
```bash
# Windows
netstat -ano | findstr :31337

# macOS/Linux
lsof -i :31337
```

### Version mismatch

**Warning:** `server version X ≠ proxy version Y`

An older server is still running from before an update. Kill it and let the proxy spawn a fresh one:

```bash
# Find and kill the server
cat ~/.copilot/vector-memory.pid   # get the PID
kill <PID>                          # or Stop-Process -Id <PID> on Windows
```

The next copilot launch will start the updated server automatically.

### Session store not found

**Error:** `Session store not found`

The file `~/.copilot/session-store.db` doesn't exist yet. This is normal on a fresh Copilot CLI install — it creates the file after your first conversation. Use Copilot for a bit, then try again.

### Embedding model corrupt

**Symptom:** Server starts but search returns no results or errors.

The ONNX model file may be corrupt (e.g., interrupted download). The server self-heals on restart — kill the server and let it re-launch:

```bash
cat ~/.copilot/vector-memory.pid
kill <PID>
```

If it persists, clear the model cache:

```bash
rm -rf node_modules/@huggingface/transformers/.cache
```

The model will re-download on next launch.

---

## License

MIT — see [LICENSE](LICENSE).
