import { readFile } from 'fs/promises'
import yaml from 'js-yaml'
import { parse } from '../../public/shorthand.js'
import { stampNew, toContentObject, normalizeFields } from '../workunit.coffee'

export run = (argv, cwd = process.cwd()) ->
  arg = argv[0]
  text = ''
  if not arg or arg is '-'
    chunks = []
    for await chunk from process.stdin
      chunks.push(chunk)
    text = Buffer.concat(chunks.map (c) -> Buffer.from(c)).toString('utf-8')
  else
    text = await readFile(arg, 'utf-8')
  throw new Error('no input') unless text.trim()

  { workunits } = parse(text)
  throw new Error('no work-unit parsed') unless workunits.length

  docs = []
  for node in workunits
    f = stampNew(node.fields)
    docs.push toContentObject(f, node.dependsOn)

  if docs.length is 1
    console.log yaml.dump(docs[0], { lineWidth: 100, noRefs: true, sortKeys: false }).trimEnd()
  else
    console.log yaml.dump(docs, { lineWidth: 100, noRefs: true, sortKeys: false }).trimEnd()
  0
