# entities.coffee — generic entity list/get/put over brain RPC (any class).
import yaml from 'js-yaml'
import { request, requestStream, serverRunning, noServerError } from './rpc.coffee'
import { parseSlug, formatSlug } from 'brain/slug'

requireServer = (cwd) ->
  throw noServerError(cwd) unless serverRunning(cwd)

export listClasses = (cwd) ->
  requireServer(cwd)
  info = await request(cwd, 'schema_info', {})
  classes = info.classes or {}
  relations = info.relations or {}
  components = info.components or {}
  # counts via ls stream per class
  out = []
  for own cls, def of classes
    count = 0
    try
      await requestStream cwd, 'ls', { class: cls }, -> count++
    catch then undefined
    out.push {
      name: cls
      top: !!def.top
      idField: def.idField or null
      displayField: def.displayField or null
      components: def.components or {}
      count: count
    }
  out.sort (a, b) -> String(a.name or '').localeCompare(String(b.name or ''))
  { classes: out, relations, components, schema: info }

export listEntities = (cwd, cls) ->
  requireServer(cwd)
  throw new Error('class required') unless cls
  ids = []
  await requestStream cwd, 'ls', { class: cls }, (item) ->
    ids.push(item.id) if item?.id?
  entities = []
  for id in ids
    slug = formatSlug(cls, id)
    try
      raw = await request(cwd, 'get_entity', { slug, include_links: false })
      label = displayLabel(raw, slug)
      entities.push { slug, id, label, components: raw.components, relations: raw.relations }
    catch then undefined
  entities.sort (a, b) -> a.label.localeCompare(b.label)
  entities

export getEntity = (cwd, slugOrParts) ->
  requireServer(cwd)
  slug = if String(slugOrParts).includes('/')
    parseSlug(slugOrParts).slug
  else
    throw new Error('slug required as Class/id')
  raw = await request(cwd, 'get_entity', { slug, include_links: true })
  {
    slug: raw.slug
    cls: parseSlug(raw.slug).cls
    id: parseSlug(raw.slug).id
    label: displayLabel(raw, raw.slug)
    components: raw.components or {}
    relations: raw.relations or {}
    body: raw.body or ''
    incoming: raw.incoming or []
  }

export putEntity = (cwd, slug, contentObj, opts = {}) ->
  requireServer(cwd)
  s = parseSlug(slug)
  content = if typeof contentObj is 'string'
    contentObj
  else
    yaml.dump(contentObj, { lineWidth: 100, noRefs: true, sortKeys: false })
  res = await request(cwd, 'put_entity', { slug: s.slug, content, overwrite: opts.overwrite isnt false })
  Object.assign(res, await getEntity(cwd, s.slug))

export deleteEntity = (cwd, slugOrParts) ->
  requireServer(cwd)
  slug = if String(slugOrParts).includes('/')
    parseSlug(slugOrParts).slug
  else
    throw new Error('slug required as Class/id')
  res = await request(cwd, 'delete_entity', { slug })
  { slug: res?.slug or slug, removed: res?.removed isnt false, note: res?.note or null }

export displayLabel = (raw, slug) ->
  c = raw?.components or {}
  c.identity?.name or c.workunit?.summary or c.naming?.name or c.info?.name or
    (slug and String(slug).split('/').pop()) or 'entity'

export entityToYaml = (entity) ->
  data = {}
  for own k, v of (entity.components or {})
    data[k] = v
  for own rel, targets of (entity.relations or {})
    data[rel] = (targets or []).map (t) -> if typeof t is 'string' then t else t._to
  yaml.dump(data, { lineWidth: 100, noRefs: true, sortKeys: false })

# Live edge counts per relation, for the class-definition view.
#
# The schema alone cannot answer "how many of these relationships actually
# exist?" — brain stores edges in its `links` table and exposes no aggregate
# RPC for them. So we tally from the instances of the class being viewed:
# outgoing edges come off each entity's own `relations`, incoming ones off
# `get_entity --links`. That is exactly the set of edges that touch this class.
#
# Bounded on purpose: a class with thousands of instances would otherwise fan
# out into thousands of RPCs to decorate a schema page. Past `cap` we report
# what we sampled and let the UI say so rather than silently under-count.
export relationCounts = (cwd, cls, cap = 300) ->
  requireServer(cwd)
  throw new Error('class required') unless cls
  ids = []
  await requestStream cwd, 'ls', { class: cls }, (item) ->
    ids.push(item.id) if item?.id?
  total = ids.length
  sample = ids.slice(0, cap)
  counts = {}
  bump = (rel, n) ->
    return unless rel and n
    counts[rel] = (counts[rel] or 0) + n
  for id in sample
    slug = formatSlug(cls, id)
    try
      raw = await request(cwd, 'get_entity', { slug, include_links: true })
      for own rel, targets of (raw.relations or {})
        bump(rel, (targets or []).length)
      for link in (raw.incoming or [])
        bump(link?.rel, 1)
    catch then undefined
  { class: cls, counts, sampled: sample.length, total, truncated: total > sample.length }
