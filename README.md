# tasks

A **WorkUnit**-shaped front-end for [`brain`](../brain). CLI + browser data-entry
UI; the store is always `brain server`'s pglite — `tasks` never opens the DB or
writes `db/**`.

## Install

```sh
cd /workspace/cli/tasks
bun install
bun link          # exposes `tasks` on PATH
```

Upstream `brain` must publish its library exports (`brain/client`, `brain/config`,
`brain/schema`, `brain/slug`) — see M0a in `tmp/PLAN1.md`.

## Quick start (playground)

```sh
cd examples/playground
brain use .
brain reindex
brain server start &
tasks next
tasks web          # http://127.0.0.1:4322
```

## CLI

| Command | Purpose |
|---|---|
| `tasks init` | drive `brain def …` for the WorkUnit T-box |
| `tasks doctor` | read-only readiness check |
| `tasks ls` / `next` / `tree` / `view` | reads |
| `tasks add` / `edit` / `upsert` / `rm` / `take` / `release` | writes (RPC) |
| `tasks fmt` / `parse` | shorthand ↔ YAML |
| `tasks nl "…"` | English → WorkUnit (AGL microagent) |
| `tasks web` | four-pane SPA |

## Web UI routes

| Path | Page |
|---|---|
| `/` | WorkUnit four-pane data entry |
| `/browse` | Schema browser (T-box tree + A-box entities + inspector) |
| `/seed` | Natural-language multi-entity creator |

Top-right **Snapshot** commits the live brain to the local `db/` git repo
(after `brain export`). Status chip shows how many uncommitted changes remain.

## Architecture

```
brain server  ←── NDJSON RPC ──  tasks CLI
                           └──  tasks web (Bun.serve + m.js)
```

B is authoritative YAML; A is English (microagent); D is read-only shorthand
rendered from B. See `tmp/PLAN1.md` for the full plan.
