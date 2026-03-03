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
- **vector-memory-server.js** — Singleton HTTP server on `localhost:31337`. Owns the embedding model (one copy in memory), SQLite vector DB, and background indexing.
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
| `VECTOR_MEMORY_PORT` | `31337` | HTTP port for the singleton server. Change this to run independent instances per user. |
| `VECTOR_MEMORY_IDLE_TIMEOUT` | `5` | Minutes of inactivity before the server shuts down. `0` or negative = never shut down. |

Set these in the `env` block of `mcp-config.json`:

```json
{
  "mcpServers": {
    "vector-memory": {
      "command": "node",
      "args": ["C:/Users/<you>/.copilot/mcp-servers/vector-memory/index.js"],
      "env": {
        "VECTOR_MEMORY_PORT": "31338",
        "VECTOR_MEMORY_IDLE_TIMEOUT": "10"
      }
    }
  }
}
```

#### Multi-user setup

On a shared machine, each user needs their own port to keep session history isolated (the vector index lives in each user's `~/.copilot/`). Point both configs at the same codebase:

**User A** (`~/.copilot/mcp-config.json`) — uses default port 31337:
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

**User B** (`~/.copilot/mcp-config.json`) — uses port 31338:
```json
{
  "mcpServers": {
    "vector-memory": {
      "command": "node",
      "args": ["D:/shared/vector-memory/index.js"],
      "env": {
        "VECTOR_MEMORY_PORT": "31338"
      }
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

# Check if running
curl -X POST http://127.0.0.1:31337/ping -d "{}"

# Search directly
curl -X POST http://127.0.0.1:31337/search \
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

## License

MIT — see [LICENSE](LICENSE).
