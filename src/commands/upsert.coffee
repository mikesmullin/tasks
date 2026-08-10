import { readFile } from 'fs/promises'
import yaml from 'js-yaml'
import { putWorkUnit } from '../workunits.coffee'
import { shortId, normalizeFields } from '../workunit.coffee'

export run = (argv, cwd = process.cwd()) ->
  file = argv[0]
  throw new Error('usage: tasks upsert <file.yaml>') unless file
  text = await readFile(file, 'utf-8')
  raw = yaml.load(text) or {}
  # accept { workunit: {...}, DEPENDS_ON: [...] } or flat workunit fields
  fields = raw.workunit or raw
  dependsOn = raw.DEPENDS_ON or raw.dependsOn or fields.dependsOn or []
  delete fields.dependsOn if fields.dependsOn?
  # title alias
  fields.summary = fields.summary or fields.title
  wu = await putWorkUnit(cwd, fields, dependsOn, { isNew: true, overwrite: true })
  console.log "upserted WorkUnit/#{wu.id}  (#{shortId(wu.id)})  #{wu.summary}"
  0
