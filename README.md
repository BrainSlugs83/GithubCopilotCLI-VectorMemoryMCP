# vector-memory

An [MCP](https://modelcontextprotocol.io/) server that adds semantic vector search to [**GitHub Copilot CLI**](https://docs.github.com/en/copilot/github-copilot-in-the-cli) (`github-copilot-cli`). Gives Copilot persistent long-term memory across sessions using local embeddings and vector search.

> **Note:** This is a community project and is not affiliated with or endorsed by GitHub. [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) is a product of GitHub / Microsoft.

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
- **Lazy init**: ONNX model only loads after winning the singleton race. Losers exit in ~500ms.
- **Idle shutdown**: Server exits after 5 minutes of inactivity (no requests and no new session content). The proxy re-launches it on next use.
- **Self-healing**: Detects and deletes corrupt/truncated model files, re-downloads automatically. Retries with backoff for Windows Defender file locks.

## Prerequisites

| Requirement | Version | Install |
|---|---|---|
| Node.js | ≥18.x | `winget install OpenJS.NodeJS.LTS` or [nodejs.org](https://nodejs.org) |
| npm | (comes with Node) | — |
| Python build tools¹ | — | `npm install -g windows-build-tools` (Windows) |
| C++ compiler¹ | — | Visual Studio Build Tools with "Desktop C++" workload |

¹ Required by `better-sqlite3` and `sqlite-vec` native modules. On macOS, `xcode-select --install` covers both.

## Installation

```bash
cd ~/.copilot/mcp-servers/vector-memory
npm install
```

The ONNX embedding model (`Xenova/gte-small`, ~34MB) downloads automatically on first run.

### Register with Copilot CLI

Add to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "vector-memory": {
      "command": "node",
      "args": ["C:/Users/<you>/.copilot/mcp-servers/vector-memory/index.js"]
    }
  }
}
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `VECTOR_MEMORY_PORT` | *(auto)* | HTTP port for the singleton server. By default, a deterministic port is computed from your OS username (FNV-1a hash, range 31337–35432). Only set this if two users happen to collide. |
| `VECTOR_MEMORY_IDLE_TIMEOUT` | `5` | Minutes of inactivity before the server shuts down. `0` or negative = never shut down. |

Set these in the `env` block of `mcp-config.json` (only if needed):

```json
{
  "mcpServers": {
    "vector-memory": {
      "command": "node",
      "args": ["C:/Users/<you>/.copilot/mcp-servers/vector-memory/index.js"],
      "env": {
        "VECTOR_MEMORY_IDLE_TIMEOUT": "10"
      }
    }
  }
}
```

#### Auto-port assignment

Each user automatically gets a deterministic port based on their OS username (FNV-1a hash with rotation, range 31337–35432). This means multi-user setups work **zero-config** — no manual port assignment needed.

In the rare case of a hash collision (two usernames mapping to the same port), the server detects the conflict at startup and tells the affected user to set `VECTOR_MEMORY_PORT` manually.

#### Multi-user setup

On a shared machine, each user's server runs on their auto-assigned port. Just point both configs at the same codebase — no `env` block needed:

**User A** (`~/.copilot/mcp-config.json`):
```json
{
  "mcpServers": {
    "vector-memory": {
      "command": "node",
      "args": ["D:/shared/vector-memory/index.js"]
    }
  }
}
```

**User B** (`~/.copilot/mcp-config.json`) — same config, different port automatically:
```json
{
  "mcpServers": {
    "vector-memory": {
      "command": "node",
      "args": ["D:/shared/vector-memory/index.js"]
    }
  }
}
```

Each user gets their own singleton server, their own vector index, and their own session history. The idle timeout ensures servers shut down automatically when not in use.

## Tools

| Tool | Description |
|---|---|
| `vector_search` | Semantic search across all past session history. Returns ranked results with similarity scores. |
| `vector_reindex` | Force a full rebuild of the vector index. Normally not needed — search auto-indexes new content. |

## Data flow

1. Copilot CLI writes session data to `~/.copilot/session-store.db` (FTS5 search index)
2. vector-memory reads from that DB (read-only) and creates embeddings
3. Embeddings are stored in `~/.copilot/vector-index.db` (sqlite-vec)
4. Indexing triggers: on startup, on each search (if idle), and every 15 minutes

## Scripts

```bash
npm run lint     # ESLint on all source files
npm test         # 38 unit tests (node:test, zero external deps)
npm run check    # lint + test
```

## Running tests

```bash
cd ~/.copilot/mcp-servers/vector-memory
npm test
```

With coverage:

```bash
node --test --experimental-test-coverage test.js
```

## Manual server management

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

## File overview

| File | Purpose |
|---|---|
| `index.js` | STDIO MCP proxy — what copilot.exe launches |
| `vector-memory-server.js` | HTTP singleton — owns model, DB, indexing |
| `embed-worker.js` | Worker thread for ONNX embedding inference |
| `lib.js` | Pure logic: filtering, dedup, scoring, handler factory |
| `test.js` | 38 unit tests with DI mocks |
| `eslint.config.js` | Lint config |

## Troubleshooting

### Port collision with another user

**Error:** `Port 31796 is owned by user "X" (expected "Y")`

Two usernames hashed to the same port (rare — FNV-1a produces very few collisions). One user needs to set a manual override. Edit `~/.copilot/mcp-config.json` and add a `VECTOR_MEMORY_PORT` env var:

```json
{
  "mcpServers": {
    "vector-memory": {
      "command": "node",
      "args": ["<path-to>/index.js"],
      "env": {
        "VECTOR_MEMORY_PORT": "31338"
      }
    }
  }
}
```

See [Multi-user setup](#multi-user-setup) for full details.

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

The file `~/.copilot/session-store.db` doesn't exist yet. This is normal on a fresh install — Copilot CLI creates it after your first conversation. Use copilot for a bit, then try again.

### Embedding model corrupt

**Symptom:** Server starts but search returns no results or errors.

The ONNX model file may be corrupt (e.g., interrupted download). The server self-heals on restart — kill the server and let it re-launch:

```bash
cat ~/.copilot/vector-memory.pid
kill <PID>
```

If it persists, delete the model cache and reinstall:

```bash
rm -rf node_modules/@huggingface/transformers/.cache
npm run postinstall
```

## License

MIT — see [LICENSE](LICENSE).
