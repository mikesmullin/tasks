# cli.coffee — command dispatcher for `tasks`.
import { exists } from 'brain/config'

HELP = """
tasks — WorkUnit front-end for brain
usage: tasks <subcommand> [args...]

setup:
  init        declare the WorkUnit T-box via `brain def …`
  doctor      check whether the active brain is task-ready

read:
  ls          list WorkUnits (filter by status/tag/worker)
  next        scored, prioritised queue
  tree        dependency tree over DEPENDS_ON (--crit = longest-path CPM)
  view        full WorkUnit YAML (6-char prefix accepted)
  fmt         WorkUnit → shorthand (ANSI-coloured on a tty)

write:
  add         parse shorthand → put_entity (+ link for needs:)
  edit        set_instance field writes
  upsert      gdedit-shaped YAML in
  rm          delete a WorkUnit
  take        cooperative lock via worker
  release     release cooperative lock

translate:
  parse       shorthand → WorkUnit YAML
  nl          English → WorkUnit (AGL microagent); --save to persist

serve:
  web         four-pane data-entry browser UI (default :4322)

for further help:
  help <subcommand>      detailed args and examples
  tasks <cmd> --help

brain owns the store (pglite). Use `brain server start`, `brain reindex`,
`brain export` — tasks never wraps those.
"""

USAGE =
  init: """
    Usage:
        tasks init

    Description:
        Drive `brain def component|class|relation …` to install the WorkUnit
        T-box into the active brain. Never writes db/ files directly — every
        mutation goes through brain's own writeSchema.
  """
  doctor: """
    Usage:
        tasks doctor

    Description:
        Read-only check: is the active brain task-ready? Prints missing
        `brain def …` lines for anything absent (WorkUnit class, 18 fields,
        DEPENDS_ON relation, status enum, createdAt/updatedAt).
  """
  ls: """
    Usage:
        tasks ls [--status S] [--tag T] [--worker W] [--mine]

    Description:
        List WorkUnits from the running brain server (ls RPC). Filters are
        applied client-side after hydration.
  """
  next: """
    Usage:
        tasks next [-l N|--limit N]

    Description:
        Scored, prioritised open-work queue (Eisenhower + due pressure +
        dependents + tags + age creep).
  """
  tree: """
    Usage:
        tasks tree [--crit]

    Description:
        Print the DEPENDS_ON dependency DAG. --crit marks the longest-path
        critical path (true CPM over estimateOptimistic→estimateLikely).
  """
  view: """
    Usage:
        tasks view <id|prefix>

    Description:
        Dump the full WorkUnit as YAML. Accepts a 6-char id prefix.
  """
  add: """
    Usage:
        tasks add "<shorthand>"

    Description:
        Parse task.md-style shorthand into a WorkUnit and put_entity.
        `needs:` produces real DEPENDS_ON edges via the link RPC.
  """
  edit: """
    Usage:
        tasks edit <id|prefix> key=value ...

    Description:
        Per-field writes via set_instance. Keys may be bare (summary=…) or
        dotted (workunit.status=running). Stamps updatedAt.
  """
  upsert: """
    Usage:
        tasks upsert <file.yaml>

    Description:
        Accept a hand-authored WorkUnit YAML file and put_entity. Validates
        against the live schema. Stamps createdAt/updatedAt when missing.
  """
  rm: """
    Usage:
        tasks rm <id|prefix>

    Description:
        Delete a WorkUnit (delete_entity RPC).
  """
  take: """
    Usage:
        tasks take <id|prefix> <worker>

    Description:
        Cooperative lock: set workunit.worker if currently empty or already
        held by the same worker.
  """
  release: """
    Usage:
        tasks release <id|prefix> <worker>

    Description:
        Clear workunit.worker if it matches <worker>.
  """
  fmt: """
    Usage:
        tasks fmt [<id|prefix>|-]

    Description:
        Render a WorkUnit as task.md-style shorthand. Reads YAML from stdin
        when arg is `-` or omitted with piped input.
  """
  parse: """
    Usage:
        tasks parse [<file>|-]

    Description:
        Parse task.md-style shorthand into WorkUnit YAML (stdout). Does not
        persist — use `tasks add` to write.
  """
  nl: """
    Usage:
        tasks nl "<english>" [--save]

    Description:
        Run the AGL microagent to translate natural language into a validated
        WorkUnit. --save persists via put_entity.
  """
  web: """
    Usage:
        tasks web [--port 4322]

    Description:
        Bun.serve the four-pane data-entry SPA. Singleton lock at
        db/.tasksweb.lock. Requires `brain server start`.
  """

COMMANDS =
  init: './commands/init.coffee'
  doctor: './commands/doctor.coffee'
  ls: './commands/ls.coffee'
  next: './commands/next.coffee'
  tree: './commands/tree.coffee'
  view: './commands/view.coffee'
  add: './commands/add.coffee'
  edit: './commands/edit.coffee'
  upsert: './commands/upsert.coffee'
  rm: './commands/rm.coffee'
  take: './commands/take.coffee'
  release: './commands/release.coffee'
  fmt: './commands/fmt.coffee'
  parse: './commands/parse.coffee'
  nl: './commands/nl.coffee'
  web: './commands/web.coffee'

isHelp = (a) -> a in ['-h', '--help', 'help']

export main = (argv) ->
  if argv.length is 0 or (argv.length is 1 and isHelp(argv[0]))
    console.log HELP
    return 0

  if argv[0] is 'help'
    topic = argv[1]
    if topic and USAGE[topic]
      console.log USAGE[topic]
      return 0
    if topic and COMMANDS[topic]
      console.log "No detailed usage for '#{topic}' yet."
      return 0
    console.log HELP
    return if topic then 1 else 0

  cmd = argv[0]
  rest = argv.slice(1)

  unless COMMANDS[cmd]
    console.error "unknown command '#{cmd}'. Run `tasks --help`."
    return 1

  if rest.some(isHelp) or (rest.length is 1 and isHelp(rest[0]))
    console.log USAGE[cmd] or "tasks #{cmd}"
    return 0

  try
    mod = await import(COMMANDS[cmd])
    code = await mod.run(rest, process.cwd())
    process.exitCode = if typeof code is 'number' then code else 0
    return process.exitCode
  catch err
    msg = err?.message or String(err)
    console.error msg
    if process.env.DEBUG
      console.error err.stack
    process.exitCode = 1
    return 1
