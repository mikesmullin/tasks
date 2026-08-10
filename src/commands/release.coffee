import { releaseWorkUnit } from '../workunits.coffee'
import { shortId } from '../workunit.coffee'

export run = (argv, cwd = process.cwd()) ->
  [id, worker] = argv
  throw new Error('usage: tasks release <id|prefix> <worker>') unless id and worker
  wu = await releaseWorkUnit(cwd, id, worker)
  console.log "released WorkUnit/#{shortId(wu.id)} from #{worker}"
  0
