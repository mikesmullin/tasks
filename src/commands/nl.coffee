import yaml from 'js-yaml'
import { parseArgs } from '../args.coffee'
import { parseNl } from '../agents/nl-to-workunit.coffee'
import { putWorkUnit } from '../workunits.coffee'
import { toContentObject, shortId } from '../workunit.coffee'

export run = (argv, cwd = process.cwd()) ->
  { _, flags } = parseArgs(argv, { booleans: ['save'] })
  text = _.join(' ').trim()
  throw new Error('usage: tasks nl "<english>" [--save]') unless text

  { fields, dependsOn, source } = await parseNl(text, { cwd })
  obj = toContentObject(fields, dependsOn)
  console.log "# source: #{source}"
  console.log yaml.dump(obj, { lineWidth: 100, noRefs: true, sortKeys: false }).trimEnd()

  if flags.save
    wu = await putWorkUnit(cwd, fields, dependsOn, { isNew: true })
    console.error "saved WorkUnit/#{wu.id}  (#{shortId(wu.id)})"
  0
