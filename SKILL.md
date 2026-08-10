# tasks

WorkUnit front-end for brain (CLI + four-pane web UI).

## When to use

- Managing tickets / work items in a brain that has the WorkUnit T-box
- Scoring and prioritising open work (`tasks next`)
- Capturing work from English or task.md shorthand
- Browsing/editing WorkUnits in the browser (`tasks web`)

## Prerequisites

- `brain server start` for the active brain
- Schema: class `WorkUnit` (18 fields), relation `DEPENDS_ON` — `tasks doctor`

## Common commands

```sh
tasks doctor
tasks next -l 5
tasks add '- A [_] @alice #platform `Fix shard lag` due: 2026-08-15'
tasks view 5c2f9c
tasks tree --crit
tasks web
```

## Non-goals

- No local file store; no `tasks import` from gdedit/tasks.md
- Does not wrap `brain server|reindex|export|validate`
