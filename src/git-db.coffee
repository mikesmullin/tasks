# git-db.coffee — revision control for the brain db/ directory.
# Operator owns a local-only git repo at db/; we never push remotes.
# Snapshot = brain export (pglite → .md) then git add + commit.
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from 'brain/config'
import { request, serverRunning } from './rpc.coffee'

runGit = (dbDir, args, opts = {}) ->
  new Promise (resolve, reject) ->
    child = spawn 'git', args,
      cwd: dbDir
      env: Object.assign({}, process.env, opts.env or {})
      stdio: ['ignore', 'pipe', 'pipe']
    stdout = ''
    stderr = ''
    child.stdout.on 'data', (d) -> stdout += d
    child.stderr.on 'data', (d) -> stderr += d
    child.on 'error', reject
    child.on 'close', (code) ->
      resolve { code, stdout: stdout.trim(), stderr: stderr.trim() }

export dbDirOf = (cwd = process.cwd()) -> paths(cwd).root

export isGitRepo = (dbDir) ->
  existsSync(join(dbDir, '.git'))

# Porcelain-friendly status for the UI.
export gitStatus = (cwd = process.cwd()) ->
  dbDir = dbDirOf(cwd)
  unless isGitRepo(dbDir)
    return {
      ok: false
      repo: false
      dbDir
      error: "no git repo at #{dbDir} — run: cd #{dbDir} && git init"
    }

  # branch
  br = await runGit(dbDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  branch = br.stdout or 'HEAD'

  # short status
  st = await runGit(dbDir, ['status', '--porcelain'])
  lines = if st.stdout then st.stdout.split('\n').filter(Boolean) else []
  # porcelain: "XY path" or "XY origin -> path" (XY is always two chars)
  files = lines.map (line) ->
    m = line.match(/^(..)\s+(.*)$/)
    code = m?[1] or line.slice(0, 2)
    path = (m?[2] or line.slice(3)).trim()
    if path.includes(' -> ')
      path = path.split(' -> ').pop().trim()
    # strip optional quotes from git
    if path.startsWith('"') and path.endsWith('"')
      path = path.slice(1, -1)
    { code, path }

  # last commit
  last = await runGit(dbDir, ['log', '-1', '--format=%H%x09%ci%x09%s'])
  lastCommit = null
  if last.code is 0 and last.stdout
    [hash, date, subject] = last.stdout.split('\t')
    lastCommit = { hash, date, subject }

  dirty = files.length
  {
    ok: true
    repo: true
    dbDir
    branch
    dirty
    files
    clean: dirty is 0
    lastCommit
  }

# Materialize pglite → .md, then commit all tracked/untracked (respecting .gitignore).
export gitSnapshot = (cwd = process.cwd(), message = 'snapshot') ->
  dbDir = dbDirOf(cwd)
  unless isGitRepo(dbDir)
    throw new Error("no git repo at #{dbDir}. Run: cd #{dbDir} && git init")

  msg = String(message or '').trim() or 'snapshot'

  # 1) export live index to disk so the commit includes latest writes
  exported = null
  if serverRunning(cwd)
    exported = await request(cwd, 'export', { prune: false })
  else
    # fall back to CLI if no server — still prefer server path
    throw new Error('brain server must be running to snapshot (need export RPC)')

  # 2) stage everything (gitignore excludes pgdata/locks)
  add = await runGit(dbDir, ['add', '-A'])
  if add.code isnt 0
    throw new Error("git add failed: #{add.stderr or add.stdout}")

  # 3) anything to commit?
  st = await runGit(dbDir, ['status', '--porcelain'])
  if not st.stdout
    return {
      committed: false
      message: msg
      reason: 'nothing to commit — working tree clean after export'
      export: exported
      status: await gitStatus(cwd)
    }

  # 4) commit (allow empty author env already set by operator)
  commit = await runGit(dbDir, ['commit', '-m', msg])
  if commit.code isnt 0
    throw new Error("git commit failed: #{commit.stderr or commit.stdout}")

  {
    committed: true
    message: msg
    log: commit.stdout
    export: exported
    status: await gitStatus(cwd)
  }
