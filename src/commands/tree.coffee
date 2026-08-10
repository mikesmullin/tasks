import { parseArgs } from '../args.coffee'
import { listWorkUnits, toScoreShape } from '../workunits.coffee'
import { formatTree } from '../score.coffee'

export run = (argv, cwd = process.cwd()) ->
  { flags } = parseArgs(argv, { booleans: ['crit'] })
  list = toScoreShape(await listWorkUnits(cwd))
  console.log formatTree(list, { crit: !!flags.crit })
  0
