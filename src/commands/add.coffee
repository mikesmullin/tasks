import { parse } from '../../public/shorthand.js'
import { putWorkUnit } from '../workunits.coffee'
import { shortId } from '../workunit.coffee'

export run = (argv, cwd = process.cwd()) ->
  text = argv.join(' ').trim()
  throw new Error('usage: tasks add "<shorthand>"') unless text
  # allow multi-line via real newlines in the string
  { workunits } = parse(text)
  throw new Error('no work-unit parsed from input') unless workunits.length
  for node in workunits
    wu = await putWorkUnit(cwd, node.fields, node.dependsOn, { isNew: true })
    console.log "added WorkUnit/#{wu.id}  (#{shortId(wu.id)})  #{wu.summary}"
  0
