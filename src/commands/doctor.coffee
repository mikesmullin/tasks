# doctor.coffee — read-only: is the active brain task-ready?
import { request, serverRunning, noServerError } from '../rpc.coffee'
import { exists, brainRoot } from 'brain/config'
import { doctorReport, workunitFieldsFlow } from '../schema-def.coffee'

export run = (argv, cwd = process.cwd()) ->
  unless exists(cwd)
    console.error "no brain db/ at #{brainRoot(cwd)}"
    return 1

  info = null
  if serverRunning(cwd)
    try
      info = await request(cwd, 'schema_info', {})
    catch err
      console.error "schema_info RPC failed: #{err.message}"
      return 1
  else
    # fall back to reading schema from disk via brain/schema (read-only)
    try
      { loadSchema } = await import('brain/schema')
      { storageDirs } = await import('brain/config')
      schema = await loadSchema(await storageDirs(cwd))
      info = { components: schema.components, classes: schema.classes, relations: schema.relations }
      console.log '(no brain server — reading schema.yaml from disk)'
    catch err
      console.error noServerError(cwd).message
      console.error "(also failed to load schema from disk: #{err.message})"
      return 1

  report = doctorReport(info)
  console.log "brain: #{brainRoot(cwd)}"
  if report.ok
    console.log 'tasks doctor: OK — WorkUnit T-box looks ready'
  else
    console.log 'tasks doctor: MISSING pieces:'
    console.log "  - #{m}" for m in report.missing
  if report.notes.length
    console.log 'notes:'
    console.log "  · #{n}" for n in report.notes
  if report.ok then 0 else 1
