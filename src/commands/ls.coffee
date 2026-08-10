import { parseArgs } from '../args.coffee'
import { listWorkUnits } from '../workunits.coffee'
import { shortId } from '../workunit.coffee'
import { priorityOf } from '../../public/shorthand.js'
import { colorizeWorkLine, paintMuted, useColor } from '../theme.coffee'

export run = (argv, cwd = process.cwd()) ->
  { flags } = parseArgs(argv, { booleans: ['mine', 'long'] })
  list = await listWorkUnits(cwd, {
    status: flags.status
    tag: flags.tag
    worker: flags.worker
    mine: flags.mine
    me: process.env.USER or process.env.USERNAME
  })
  if list.length is 0
    console.log paintMuted('(no WorkUnits)')
    return 0
  colorOn = useColor()
  for w in list
    pri = priorityOf(w)
    tags = (w.tags or []).join(' ')
    due = if w.due then String(w.due).slice(0, 10) else ''
    console.log colorizeWorkLine({
      id: shortId(w.id)
      status: w.status or 'idle'
      pri: pri
      summary: w.summary or '(untitled)'
      due: due or undefined
      worker: w.worker or undefined
      tags: tags or undefined
    }, colorOn)
  console.log ''
  console.log paintMuted("#{list.length} work-unit(s)", colorOn)
  0
