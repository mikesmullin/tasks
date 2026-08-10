# workunit.coffee — normalize · validate · id · correlations · priority ↔ I/U · status aliases.
# Pure helpers (no RPC). Timestamps are machine-set here when stamping.
import { createHash, randomBytes } from 'crypto'
import { priorityOf, applyPriority, asArray, tagNorm, personSlug, workunitSlug, computeCorrelations } from '../public/shorthand.js'

STATUS_VALUES = ['idle', 'running', 'success', 'fail']

export mintId = (seed = null) ->
  if seed?
    createHash('sha1').update(String(seed)).digest('hex')
  else
    randomBytes(20).toString('hex')

export shortId = (id) -> String(id or '').slice(0, 6)

export nowIso = -> new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

# Flatten brain entity → workunit fields + dependsOn list.
export fromEntity = (entity) ->
  wu = entity?.components?.workunit or {}
  dependsOn = []
  for t in (entity?.relations?.DEPENDS_ON or [])
    dependsOn.push(if typeof t is 'string' then t else t._to)
  fields = normalizeFields(wu)
  { fields, dependsOn, slug: entity?.slug, body: entity?.body or '' }

# Build put_entity content (flattened YAML-ready object).
# Omit null/empty optional scalars — brain validate rejects `null` for typed fields.
export toContentObject = (fields, dependsOn = []) ->
  f = normalizeFields(fields)
  workunit = {}
  always = new Set(['id', 'summary', 'status', 'createdAt', 'updatedAt', 'important', 'urgent'])
  for own k, v of f
    continue unless v?
    continue if v is '' and k not in ['summary', 'description']
    continue if Array.isArray(v) and v.length is 0 and k not in ['tags', 'stakeholders', 'correlations', 'journal']
    # skip empty optional arrays entirely for cleaner YAML
    if Array.isArray(v) and v.length is 0
      continue unless always.has(k)
    workunit[k] = v
  workunit.summary = f.summary or ''
  workunit.status = f.status or 'idle'
  workunit.important = !!f.important
  workunit.urgent = !!f.urgent
  workunit.createdAt = f.createdAt if f.createdAt
  workunit.updatedAt = f.updatedAt if f.updatedAt
  workunit.id = f.id if f.id
  out = { workunit }
  deps = asArray(dependsOn).filter(Boolean)
  out.DEPENDS_ON = deps if deps.length
  out

export normalizeFields = (raw = {}) ->
  f = {}
  f.id = String(raw.id).trim() if raw.id?
  f.summary = String(raw.summary ? raw.title ? '').trim()
  f.description = if raw.description? then String(raw.description) else ''
  f.important = raw.important is true or raw.important is 'true'
  f.urgent = raw.urgent is true or raw.urgent is 'true'
  # priority sugar
  if raw.priority? and not (raw.important? or raw.urgent?)
    p = applyPriority(raw.priority)
    f.important = p.important
    f.urgent = p.urgent
  f.weight = if raw.weight? and raw.weight isnt '' then Number(raw.weight) else 0
  f.status = resolveStatus(raw)
  f.worker = if raw.worker? and raw.worker isnt '' then String(raw.worker) else undefined
  # tags: always strip leading # (YAML stores crispy not #crispy)
  f.tags = asArray(raw.tags).map(tagNorm).filter(Boolean)
  f.stakeholders = asArray(raw.stakeholders).map(personSlug)
  f.due = dateOrNull(raw.due) or undefined
  f.estimateOptimistic = dateOrNull(raw.estimateOptimistic) or undefined
  f.estimateLikely = dateOrNull(raw.estimateLikely) or undefined
  f.estimatePessimistic = dateOrNull(raw.estimatePessimistic) or undefined
  f.journal = asArray(raw.journal).map(String)
  f.createdAt = dateOrNull(raw.createdAt) or undefined
  f.updatedAt = dateOrNull(raw.updatedAt) or undefined
  # correlations is computed from {{Class/id}} wikilinks (unique set).
  # Prefer optional raw._sourceText (pane A / NL input) so pills survive LLM rewrites.
  # Do not trust a stored/raw correlations value — always re-derive.
  f.correlations = computeCorrelations(f.summary, f.description, raw._sourceText or '')
  delete f._sourceText if f._sourceText?
  f

export resolveStatus = (data = {}) ->
  s = data.status
  return s if s in STATUS_VALUES
  return 'success' if data.completed is true or data.completed is 'true'
  return 'fail' if data.skipped is true or data.skipped is 'true' or data.skipped is 'fail'
  return 'idle' if data.completed is false
  'idle'

export dateOrNull = (v) ->
  return null unless v?
  return null if v is ''
  s = String(v).trim()
  return null unless s
  # accept date-only or full ISO
  s

export isOpenStatus = (status) -> status in ['idle', 'running']

export stampNew = (fields, opts = {}) ->
  f = normalizeFields(fields)
  f.id = f.id or opts.id or mintId(f.summary + '|' + Date.now())
  ts = opts.now or nowIso()
  f.createdAt = f.createdAt or ts
  f.updatedAt = f.updatedAt or ts
  f.status = f.status or 'idle'
  f

export stampUpdate = (fields, opts = {}) ->
  f = normalizeFields(fields)
  f.updatedAt = opts.now or nowIso()
  f

export localValidate = (fields) ->
  errors = []
  errors.push('summary is required') unless fields?.summary
  errors.push("status must be one of #{STATUS_VALUES.join(', ')}") if fields?.status and fields.status not in STATUS_VALUES
  errors.push('createdAt is required') unless fields?.createdAt
  errors.push('updatedAt is required') unless fields?.updatedAt
  errors.push('id is required') unless fields?.id
  { ok: errors.length is 0, errors }

export priorityOfExport = priorityOf
export applyPriorityExport = applyPriority
export { STATUS_VALUES, priorityOf, applyPriority }
