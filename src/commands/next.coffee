import { parseArgs } from '../args.coffee'
import { listWorkUnits, toScoreShape } from '../workunits.coffee'
import { rankNext } from '../score.coffee'
import { shortId } from '../workunit.coffee'
import { priorityOf } from '../../public/shorthand.js'
import { colorizeWorkLine, paintMuted, useColor } from '../theme.coffee'

export run = (argv, cwd = process.cwd()) ->
  { flags } = parseArgs(argv, {})
  limit = parseInt(flags.l or flags.limit or '10', 10)
  list = toScoreShape(await listWorkUnits(cwd))
  ranked = rankNext(list, { limit })
  if ranked.length is 0
    console.log paintMuted('(no open work)')
    return 0
  colorOn = useColor()
  for w, i in ranked
    pri = priorityOf(w)
    score = if typeof w.score is 'number' then w.score.toFixed(1) else '?'
    tags = (w.tags or []).join(' ')
    due = if w.due then String(w.due).slice(0, 10) else ''
    console.log colorizeWorkLine({
      index: i + 1
      score: score
      id: shortId(w.id)
      status: w.status
      pri: pri
      summary: w.summary or '(untitled)'
      due: due or undefined
      tags: tags or undefined
    }, colorOn)
  0
