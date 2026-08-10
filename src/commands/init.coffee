# init.coffee — drive `brain def …` to install the WorkUnit T-box.
import { spawn } from 'child_process'
import { exists, brainRoot } from 'brain/config'
import { defArgvList } from '../schema-def.coffee'

runBrain = (argv, cwd) ->
  new Promise (resolve, reject) ->
    child = spawn 'brain', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
    stdout = ''
    stderr = ''
    child.stdout.on 'data', (d) -> stdout += d
    child.stderr.on 'data', (d) -> stderr += d
    child.on 'error', (err) ->
      if err.code is 'ENOENT'
        reject new Error('`brain` not found on PATH. Install/link brain first.')
      else
        reject err
    child.on 'close', (code) ->
      resolve { code, stdout, stderr }

export run = (argv, cwd = process.cwd()) ->
  unless exists(cwd)
    console.error "no brain db/ found (looked at #{brainRoot(cwd)})."
    console.error 'Run `brain init` first, or `brain use <alias>` to select one.'
    return 1

  console.log "tasks init: installing WorkUnit T-box into #{brainRoot(cwd)}"
  for args in defArgvList()
    console.log "  $ brain #{args.join ' '}"
    { code, stdout, stderr } = await runBrain(args, cwd)
    process.stdout.write stdout if stdout
    process.stderr.write stderr if stderr
    if code isnt 0
      console.error "brain def failed (exit #{code})"
      return code or 1

  console.log 'tasks init: done. Run `tasks doctor` to verify, then `brain reindex` if needed.'
  0
