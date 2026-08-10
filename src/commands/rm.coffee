import { deleteWorkUnit } from '../workunits.coffee'

export run = (argv, cwd = process.cwd()) ->
  id = argv[0]
  throw new Error('usage: tasks rm <id|prefix>') unless id
  { slug } = await deleteWorkUnit(cwd, id)
  console.log "removed #{slug}"
  0
