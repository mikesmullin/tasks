# workunits.coffee — list/get/put/set/link/delete/take/release — ALL over RPC.
# Deliberately NOT named store.* — there is no local store.
import yaml from 'js-yaml'
import { request, requestStream, noServerError, serverRunning } from './rpc.coffee'
import { parseSlug, formatSlug } from 'brain/slug'
import {
  fromEntity, toContentObject, normalizeFields, stampNew, stampUpdate,
  localValidate, shortId, mintId, nowIso
} from './workunit.coffee'

requireServer = (cwd) ->
  throw noServerError(cwd) unless serverRunning(cwd)

# Stream all WorkUnit ids, then hydrate.
export listWorkUnits = (cwd, opts = {}) ->
  requireServer(cwd)
  ids = []
  await requestStream cwd, 'ls', { class: 'WorkUnit' }, (item) ->
    ids.push(item.id) if item?.id?
  return [] unless ids.length
  # hydrate in batches via get_entity
  out = []
  for id in ids
    try
      raw = await request(cwd, 'get_entity', { slug: formatSlug('WorkUnit', id), include_links: true })
      { fields, dependsOn, slug } = fromEntity(raw)
      # also collect incoming DEPENDS_ON for scoring dependents
      incoming = []
      for link in (raw.incoming or [])
        incoming.push(link.from) if link.rel is 'DEPENDS_ON'
      wu = Object.assign({}, fields, { dependsOn, slug, incomingDepends: incoming })
      out.push(wu)
    catch err
      if process.env.DEBUG
        console.error "listWorkUnits hydrate #{id}: #{err.message}"
  out = filterWorkUnits(out, opts)
  out

export filterWorkUnits = (list, opts = {}) ->
  out = list
  if opts.status
    out = out.filter (w) -> w.status is opts.status
  if opts.tag
    tag = if String(opts.tag).startsWith('#') then opts.tag else "##{opts.tag}"
    out = out.filter (w) -> (w.tags or []).includes(tag)
  if opts.worker
    out = out.filter (w) -> w.worker is opts.worker
  if opts.mine and opts.me
    out = out.filter (w) -> w.worker is opts.me
  out

# Resolve full id or 6-char prefix → slug.
export resolveWorkUnitSlug = (cwd, idOrPrefix) ->
  requireServer(cwd)
  raw = String(idOrPrefix or '').trim()
  throw new Error('id required') unless raw
  if raw.includes('/')
    s = parseSlug(raw)
    throw new Error("not a WorkUnit: #{raw}") unless s.cls is 'WorkUnit'
    # verify exists
    await request(cwd, 'get_entity', { slug: s.slug, include_links: false })
    return s.slug
  # try full id
  try
    slug = formatSlug('WorkUnit', raw)
    await request(cwd, 'get_entity', { slug, include_links: false })
    return slug
  catch
    # prefix search
  all = []
  await requestStream cwd, 'ls', { class: 'WorkUnit' }, (item) ->
    all.push(item.id) if item?.id?
  matches = all.filter (id) -> id.startsWith(raw)
  throw new Error("no WorkUnit matching '#{raw}'") unless matches.length
  if matches.length > 1 and raw.length < 40
    # if exact length-6 unique prefix ok; else error on ambiguity
    if matches.length > 1
      previews = matches.slice(0, 5).map((id) -> shortId(id)).join(', ')
      throw new Error("ambiguous id prefix '#{raw}': #{previews}#{if matches.length > 5 then '…' else ''}")
  formatSlug('WorkUnit', matches[0])

export getWorkUnit = (cwd, idOrPrefix) ->
  slug = await resolveWorkUnitSlug(cwd, idOrPrefix)
  raw = await request(cwd, 'get_entity', { slug, include_links: true })
  { fields, dependsOn, body } = fromEntity(raw)
  incoming = []
  for link in (raw.incoming or [])
    incoming.push(link.from) if link.rel is 'DEPENDS_ON'
  Object.assign({}, fields, { dependsOn, slug, body, incomingDepends: incoming })

export putWorkUnit = (cwd, fields, dependsOn = [], opts = {}) ->
  requireServer(cwd)
  f = if opts.isNew is false then stampUpdate(fields) else stampNew(fields)
  v = localValidate(f)
  throw new Error("invalid WorkUnit: #{v.errors.join('; ')}") unless v.ok
  slug = formatSlug('WorkUnit', f.id)
  contentObj = toContentObject(f, [])  # relations via link RPC
  content = yaml.dump(contentObj, { lineWidth: 100, noRefs: true, sortKeys: false })
  await request(cwd, 'put_entity', { slug, content, overwrite: opts.overwrite isnt false })
  # sync DEPENDS_ON edges
  await syncDependsOn(cwd, slug, dependsOn)
  getWorkUnit(cwd, f.id)

export syncDependsOn = (cwd, fromSlug, dependsOn) ->
  # read current
  raw = await request(cwd, 'get_entity', { slug: fromSlug, include_links: false })
  current = []
  for t in (raw.relations?.DEPENDS_ON or [])
    current.push(if typeof t is 'string' then t else t._to)
  wanted = (dependsOn or []).map(String).filter(Boolean)
  # add missing
  for to in wanted when to not in current
    try
      await request(cwd, 'link', { from: fromSlug, rel: 'DEPENDS_ON', to })
    catch err
      # link may fail if already present or target missing
      if process.env.DEBUG
        console.error "link #{fromSlug} -DEPENDS_ON-> #{to}: #{err.message}"
  # note: brain has no unlink RPC in the plan surface — we leave extra edges;
  # explicit DELETE /task/:id/deps is handled via set of relations on put when content includes DEPENDS_ON
  if wanted.length
    # re-put with DEPENDS_ON in content to replace relation set if core supports it
    f = fromEntity(raw).fields
    contentObj = toContentObject(f, wanted)
    content = yaml.dump(contentObj, { lineWidth: 100, noRefs: true, sortKeys: false })
    await request(cwd, 'put_entity', { slug: fromSlug, content, overwrite: true })

export setWorkUnitFields = (cwd, idOrPrefix, assignments) ->
  requireServer(cwd)
  slug = await resolveWorkUnitSlug(cwd, idOrPrefix)
  # stamp updatedAt
  ts = nowIso()
  norm = []
  for a in assignments
    if a.startsWith('workunit.') or a.includes('=')
      norm.push(a)
    else
      # bare key=value → workunit.key=value
      norm.push(if a.includes('=') then "workunit.#{a}" else a)
  # ensure workunit. prefix
  final = []
  for a in norm
    if a.includes('=')
      [k, v...] = a.split('=')
      key = k
      val = v.join('=')
      unless key.startsWith('workunit.') or /^[A-Z][A-Z0-9_]*$/.test(key)
        key = "workunit.#{key}"
      final.push("#{key}=#{val}")
    else
      final.push(a)
  final.push("workunit.updatedAt=#{ts}")
  await request(cwd, 'set_instance', { slug, assignments: final })
  getWorkUnit(cwd, slug)

export deleteWorkUnit = (cwd, idOrPrefix) ->
  requireServer(cwd)
  slug = await resolveWorkUnitSlug(cwd, idOrPrefix)
  await request(cwd, 'delete_entity', { slug })
  { slug }

export takeWorkUnit = (cwd, idOrPrefix, worker) ->
  wu = await getWorkUnit(cwd, idOrPrefix)
  throw new Error('worker required') unless worker
  if wu.worker and wu.worker isnt worker
    throw new Error("WorkUnit #{shortId(wu.id)} is held by #{wu.worker}")
  setWorkUnitFields(cwd, wu.id, ["worker=#{worker}"])

export releaseWorkUnit = (cwd, idOrPrefix, worker) ->
  wu = await getWorkUnit(cwd, idOrPrefix)
  throw new Error('worker required') unless worker
  if wu.worker and wu.worker isnt worker
    throw new Error("WorkUnit #{shortId(wu.id)} is held by #{wu.worker}, not #{worker}")
  setWorkUnitFields(cwd, wu.id, ['worker='])

# Scoring-ready flat list: id is bare hex; dependsOn are bare ids for score.coffee
export toScoreShape = (list) ->
  list.map (w) ->
    deps = (w.dependsOn or []).map (d) ->
      if String(d).includes('/') then String(d).split('/').pop() else String(d)
    Object.assign({}, w, {
      id: w.id
      dependsOn: deps
    })
