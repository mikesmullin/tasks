import yaml from 'js-yaml'
import { getWorkUnit } from '../workunits.coffee'
import { toContentObject } from '../workunit.coffee'

export run = (argv, cwd = process.cwd()) ->
  id = argv[0]
  throw new Error('usage: tasks view <id|prefix>') unless id
  wu = await getWorkUnit(cwd, id)
  obj = toContentObject(wu, wu.dependsOn)
  console.log yaml.dump(obj, { lineWidth: 100, noRefs: true, sortKeys: false }).trimEnd()
  0
