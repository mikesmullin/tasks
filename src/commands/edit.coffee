import { setWorkUnitFields } from '../workunits.coffee'
import { shortId } from '../workunit.coffee'

export run = (argv, cwd = process.cwd()) ->
  id = argv[0]
  assignments = argv.slice(1)
  throw new Error('usage: tasks edit <id|prefix> key=value ...') unless id and assignments.length
  wu = await setWorkUnitFields(cwd, id, assignments)
  console.log "edited WorkUnit/#{wu.id}  (#{shortId(wu.id)})"
  0
