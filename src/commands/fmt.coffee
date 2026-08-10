import { readFile } from 'fs/promises'
import yaml from 'js-yaml'
import { render } from '../../public/shorthand.js'
import { getWorkUnit } from '../workunits.coffee'
import { normalizeFields } from '../workunit.coffee'
import { colorizeShorthand, useColor } from '../theme.coffee'

export run = (argv, cwd = process.cwd()) ->
  arg = argv[0]
  wu = null
  dependsOn = []

  if not arg or arg is '-'
    chunks = []
    for await chunk from process.stdin
      chunks.push(chunk)
    text = Buffer.concat(chunks.map (c) -> Buffer.from(c)).toString('utf-8')
    throw new Error('no input on stdin') unless text.trim()
    raw = yaml.load(text) or {}
    fields = raw.workunit or raw
    dependsOn = raw.DEPENDS_ON or raw.dependsOn or []
    wu = normalizeFields(fields)
  else
    got = await getWorkUnit(cwd, arg)
    wu = got
    dependsOn = got.dependsOn or []

  text = render(wu, { dependsOn })
  # Vivacious 24-bit ANSI when TTY (respects NO_COLOR / FORCE_COLOR)
  text = colorizeShorthand(text) if useColor()
  console.log text
  0
