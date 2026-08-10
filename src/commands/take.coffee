import { takeWorkUnit } from '../workunits.coffee'
import { shortId } from '../workunit.coffee'

export run = (argv, cwd = process.cwd()) ->
  [id, worker] = argv
  throw new Error('usage: tasks take <id|prefix> <worker>') unless id and worker
  wu = await takeWorkUnit(cwd, id, worker)
  console.log "took WorkUnit/#{shortId(wu.id)} as #{worker}"
  0
