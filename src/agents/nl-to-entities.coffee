# nl-to-entities.coffee — AGL microagent: sketch → entities + relations.
#
# Large-DB design (thousands of classes / millions of entities):
#   • System prompt is short — no full field catalogs in context.
#   • Compact overview (class/relation names + counts) from brain schema helpers
#     (same spirit as `brain schema uniq|graph`).
#   • Intermediate tools let the model traverse the live brain (search, ls,
#     get_entity, schema_class, schema_relation) before calling final_result.
#   • Deterministic code still owns slug locks, YAML put bags, and persistence.
import Agent from 'agl-ai'
import yaml from 'js-yaml'
import { loadConfig } from 'brain/config'
import {
  compactSchemaOverview
  formatClassDetail
  formatRelationDetail
} from 'brain/schema'
import { request, requestStream } from '../rpc.coffee'
import { parseSlug, formatSlug } from 'brain/slug'

xmlEscape = (s) ->
  String(s ? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

slugify = (s) ->
  String(s or '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/\*+/g, '')          # markdown bold leakage (e.g. product** )
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) or 'entity'

# brain id: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ — strip markdown / junk from LLM ids
sanitizeEntityId = (id) ->
  s = String(id or '').trim()
  s = s.replace(/\*+/g, '').replace(/[`'"<>]+/g, '')
  s = s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  s = s.slice(0, 64)
  s or 'entity'

# Relation targets may arrive as bare ids, Class/id, or markdown-wrapped.
sanitizeRelationTarget = (t) ->
  raw = String(t or '').trim()
  return '' unless raw
  raw = raw.replace(/\*+/g, '').replace(/^\[\[|\]\]$/g, '').trim()
  if raw.includes('/')
    try
      { cls, id } = parseSlug(raw)  # may throw if still dirty
      return formatSlug(cls, sanitizeEntityId(id))
    catch
      idx = raw.indexOf('/')
      cls = raw.slice(0, idx)
      id = sanitizeEntityId(raw.slice(idx + 1))
      return "#{cls}/#{id}"
  sanitizeEntityId(raw)

resolveModel = (cwd) ->
  try
    cfg = await loadConfig(cwd)
    return cfg.think?.model if cfg.think?.model
  catch then undefined
  fav = (process.env.FAV_LOCAL_LLM or '').trim()
  return fav if fav
  undefined

# ── Compact overview (RPC) — scales with T-box names, not field dumps ──────
export buildCompactOverview = (cwd) ->
  info = await request(cwd, 'schema_info', {})
  g = null
  try
    g = await request(cwd, 'schema_graph', {})
  catch then g = null

  # classCounts live on schema_graph types as "Name (n)" when server provides them
  counts = {}
  if g?.types
    for t in g.types
      m = String(t).match(/^(.+?)\s*\(([\d,]+)\)$/)
      if m
        counts[m[1]] = Number(String(m[2]).replace(/,/g, '')) or 0
      else
        counts[String(t)] = counts[String(t)] or 0

  schema =
    components: info.components or {}
    classes: info.classes or {}
    relations: info.relations or {}

  overview = compactSchemaOverview(schema, counts, g?.totals or null)
  { overview, schema, counts, totals: g?.totals or null }

# Legacy name — tests / callers may still use buildContext
export buildContext = (cwd) ->
  { overview, schema, counts, totals } = await buildCompactOverview(cwd)
  # Keep a thin classSummaries-shaped bag for normaliseEntity validation
  classSummaries = for own name, def of (schema.classes or {})
    {
      class: name
      top: !!def.top
      idField: def.idField or null
      displayField: def.displayField or null
    }
  relSummaries = for own name, r of (schema.relations or {})
    { name, domain: r.domain, range: r.range, cardinality: r.cardinality }
  {
    overview
    schema
    counts
    totals
    classSummaries
    relSummaries
    known: [] # no longer preload entity lists into the prompt
    raw: schema
  }

normaliseEntity = (raw, schemaInfo) ->
  classes = schemaInfo.classes or schemaInfo.schema?.classes or schemaInfo.raw?.classes or {}
  cls = String(raw.class or raw.cls or '').trim()
  throw new Error('entity missing class') unless cls
  # Allow any class present in schema map or classSummaries
  knownCls =
    classes[cls]? or
    schemaInfo.classSummaries?.some((c) -> c.class is cls)
  throw new Error("unknown class '#{cls}'") unless knownCls

  id = String(raw.id or '').trim()
  unless id
    name = raw.components?.identity?.username or
      raw.components?.identity?.name or
      raw.components?.naming?.name or
      raw.components?.info?.name or
      raw.name or 'entity'
    id = slugify(name)
  else
    # LLM sometimes emits markdown-bold ids (product_atlas_suite**) — scrub to brain ID_RE
    id = sanitizeEntityId(id)

  if cls is 'Person'
    raw.components ?= {}
    raw.components.identity ?= {}
    raw.components.identity.username = id
    if raw.components.identity.name and not raw.components.identity.givenName
      parts = String(raw.components.identity.name).split(/\s+/)
      raw.components.identity.givenName or= parts[0]
      raw.components.identity.surname or= parts.slice(1).join(' ') or parts[0]

  slug = formatSlug(cls, id)

  relations = {}
  for own k, v of (raw.relations or {})
    key = k.toUpperCase()
    arr = if Array.isArray(v) then v else [v]
    relations[key] = arr.map(sanitizeRelationTarget).filter(Boolean)

  for own k, v of raw when /^[A-Z][A-Z0-9_]*$/.test(k)
    arr = if Array.isArray(v) then v else [v]
    relations[k] = arr.map(sanitizeRelationTarget).filter(Boolean)

  components = raw.components or {}
  for own k, v of raw when k not in ['class', 'cls', 'id', 'slug', 'components', 'relations', 'name', 'body'] and not /^[A-Z][A-Z0-9_]*$/.test(k)
    if v and typeof v is 'object' and not Array.isArray(v)
      components[k] = v

  # shorthand lives on Alias (Product/Team/Cloud/Region/Environment), not Naming
  if components.alias?.shorthand? and not Array.isArray(components.alias.shorthand)
    components.alias.shorthand = [String(components.alias.shorthand)]
  # Soft migrate LLM mistakes: naming.shorthand → alias.shorthand
  if components.naming?.shorthand?
    components.alias ?= {}
    unless components.alias.shorthand?
      sh = components.naming.shorthand
      components.alias.shorthand = if Array.isArray(sh) then sh else [String(sh)]
    delete components.naming.shorthand
  if components.documentation?.url? and not Array.isArray(components.documentation.url)
    components.documentation.url = [String(components.documentation.url)]
  if components.workunit?.tags? and not Array.isArray(components.workunit.tags)
    components.workunit.tags = String(components.workunit.tags).split(/[,\s]+/).filter(Boolean)

  { slug, cls, id, components, relations, body: raw.body or '' }

toPutContent = (entity) ->
  data = {}
  for own alias, fields of (entity.components or {})
    data[alias] = fields
  for own rel, targets of (entity.relations or {})
    data[rel] = targets
  yaml.dump(data, { lineWidth: 100, noRefs: true, sortKeys: false })

lockEntityToSlug = (entity, lockedSlug, schemaInfo) ->
  return entity unless lockedSlug
  try
    { cls, id } = parseSlug(lockedSlug)
  catch
    return entity
  entity.cls = cls
  entity.id = id
  entity.slug = formatSlug(cls, id)
  entity.components ?= {}
  if cls is 'Person'
    entity.components.identity ?= {}
    entity.components.identity.username = id
  entity

export coerceEntitiesList = (raw) ->
  if raw is null or raw is undefined
    return []
  if Array.isArray(raw)
    return raw
  if typeof raw is 'object'
    if raw.class or raw.cls or raw.id or raw.components
      return [raw]
    if Array.isArray(raw.entities)
      return raw.entities
    return [raw]

  s = String(raw).trim()
  return [] unless s

  fence = s.match(/^```(?:json|JSON)?\s*([\s\S]*?)```\s*$/)
  s = fence[1].trim() if fence

  if not (s.startsWith('[') or s.startsWith('{'))
    bracket = s.indexOf('[')
    brace = s.indexOf('{')
    if bracket >= 0 and (brace < 0 or bracket < brace)
      s = s.slice(bracket)
      end = s.lastIndexOf(']')
      s = s.slice(0, end + 1) if end > 0
    else if brace >= 0
      s = s.slice(brace)
      end = s.lastIndexOf('}')
      s = s.slice(0, end + 1) if end > 0

  try
    parsed = JSON.parse(s)
  catch err
    throw new Error("model returned invalid entities JSON: #{err.message}")

  if Array.isArray(parsed)
    return parsed
  if parsed and typeof parsed is 'object'
    if Array.isArray(parsed.entities)
      return parsed.entities
    return [parsed]
  throw new Error("model returned unexpected entities payload type: #{typeof parsed}")

extractEntitiesAndSummary = (result) ->
  rawEntities =
    result?.entities ?
    result?.entities_json ?
    result?.entity_list ?
    null
  summary = result?.summary ? result?.narrative ? ''
  if rawEntities is null and result?.choices
    content = result.choices?[0]?.message?.content
    if content
      try
        rawEntities = coerceEntitiesList(content)
      catch then rawEntities = null
  list = coerceEntitiesList(rawEntities)
  { list, summary: String(summary or '').trim() }

# ── Agent tools (brain RPC — same surface as brain MCP query tools) ────────
registerBrainTools = (agent, cwd, schema) ->
  # Cap list/search result size so tool replies stay small even on huge DBs
  LS_LIMIT = Number(process.env.TASKS_SEED_LS_LIMIT or 24)
  SEARCH_LIMIT = Number(process.env.TASKS_SEED_SEARCH_LIMIT or 8)

  agent.Tool(
    'schema_class'
    'Look up one class: required fields, components, relations that touch it. Call this before inventing entities of that class.'
    { name: { type: 'string', description: 'Class name, e.g. Product' } }
    ['name']
    (_ctx, args) -> formatClassDetail(schema, String(args?.name or '').trim())
  )

  agent.Tool(
    'schema_relation'
    'Look up one relation: domain, range, cardinality, qualifiers.'
    { name: { type: 'string', description: 'Relation name, e.g. OWNS' } }
    ['name']
    (_ctx, args) -> formatRelationDetail(schema, String(args?.name or '').trim())
  )

  agent.Tool(
    'search'
    'Hybrid search over existing entities (keyword + vector). Use before creating to reuse matches or discover related slugs.'
    {
      query: { type: 'string', description: 'Search query' }
      limit: { type: 'number', description: "Max hits (default #{SEARCH_LIMIT})" }
    }
    ['query']
    (_ctx, args) ->
      limit = Math.min(Number(args?.limit) or SEARCH_LIMIT, 20)
      res = await request(cwd, 'search', {
        query: String(args?.query or '')
        limit: limit
        strategy: 'hybrid'
        expand: false
      })
      # Compact hits for the model
      hits = (res?.results or res?.hits or res or [])
      hits = hits.slice(0, limit) if Array.isArray(hits)
      if Array.isArray(hits)
        lines = for h in hits
          slug = h.slug or h.id or ''
          title = h.title or h.label or h.summary or ''
          score = if h.score? then " score=#{h.score}" else ''
          "#{slug}\t#{title}#{score}"
        return lines.join('\n') or '(no hits)'
      yaml.dump(res, { lineWidth: 100, noRefs: true, sortKeys: false })
  )

  agent.Tool(
    'ls'
    'List entity ids for one class (capped). Use to scan what already exists under a class.'
    {
      class: { type: 'string', description: 'Class name' }
      limit: { type: 'number', description: "Max ids (default #{LS_LIMIT})" }
    }
    ['class']
    (_ctx, args) ->
      cls = String(args?.class or args?.cls or '').trim()
      limit = Math.min(Number(args?.limit) or LS_LIMIT, 50)
      ids = []
      await requestStream cwd, 'ls', { class: cls }, (item) ->
        return if ids.length >= limit
        ids.push(item.id) if item?.id?
      if ids.length is 0
        return "(no instances of #{cls})"
      ("#{cls}/#{id}" for id in ids).join('\n')
  )

  agent.Tool(
    'get_entity'
    'Read one entity by slug (components + outgoing relations; optional incoming).'
    {
      slug: { type: 'string', description: 'Class/id' }
      include_links: { type: 'boolean', description: 'Include incoming links (default false)' }
    }
    ['slug']
    (_ctx, args) ->
      slug = String(args?.slug or '').trim()
      ent = await request(cwd, 'get_entity', {
        slug: slug
        include_links: !!args?.include_links
      })
      # Drop heavy/noise fields for the model
      bag =
        slug: ent.slug
        components: ent.components or {}
        relations: ent.relations or {}
      bag.incoming = ent.incoming if args?.include_links and ent.incoming
      yaml.dump(bag, { lineWidth: 100, noRefs: true, sortKeys: false })
  )

export parseNlEntities = (text, opts = {}) ->
  cwd = opts.cwd or process.cwd()
  ctx = opts.context or await buildContext(cwd)
  model = opts.model or await resolveModel(cwd)
  lockedSlug = if opts.lockedSlug then String(opts.lockedSlug).trim() else ''
  signal = opts.signal or null
  validationFeedback = String(opts.validationFeedback or opts.validation or '').trim()
  latestYaml = String(opts.latestYaml or opts.yaml or opts.latest_yaml or '').trim()
  latestSummary = String(opts.latestSummary or opts.summary or opts.latest_summary or '').trim()
  additionalUserInstructions = String(
    opts.additionalUserInstructions or opts.additional_user_instructions or ''
  ).trim()

  # Room for multi-entity final_result JSON; avoid finish_reason=length thrash.
  # Override with TASKS_SEED_MAX_TOKENS / TASKS_SEED_MAX_TURNS if needed.
  maxTokens = Number(opts.max_tokens ? process.env.TASKS_SEED_MAX_TOKENS ? 2048)
  maxTurns = Number(opts.max_turns ? process.env.TASKS_SEED_MAX_TURNS ? 20)

  lockedBlock = if lockedSlug
    try
      { cls, id } = parseSlug(lockedSlug)
      """
      Locked subject (server will force this slug after you finish):
      - slug: #{lockedSlug}  (class=#{cls}, id=#{id})
      Prefer describing this subject; other related entities optional and few.
      Call schema_class for "#{cls}" before inventing its fields.
      """
    catch
      "Locked subject slug: #{lockedSlug}."
  else
    ''

  yamlBlock = if latestYaml then latestYaml else '(none yet)'
  summaryBlock = if latestSummary then latestSummary else '(none yet)'
  validationBlock = if validationFeedback then validationFeedback else '(none)'
  extraInstrBlock = if additionalUserInstructions then additionalUserInstructions else '(none)'

  overview = ctx.overview or ''
  schema = ctx.schema or ctx.raw or { classes: {}, relations: {}, components: {} }

  factoryOpts =
    system_prompt: """
      You expand a short natural-language sketch into a small set of knowledge-graph
      entities for the local brain database.

      You are given only a compact class/relation overview (names + instance counts).
      Field requirements and existing data are NOT fully inlined. Optional tools:
        schema_class, schema_relation, search, ls, get_entity

      TWO MODES (check <latest-yaml> first — this overrides invent-vs-refine):
      A) BOOTSTRAP — <latest-yaml> is "(none yet)":
         Tools are optional. Invent entities from the sketch and call final_result.
         Only search if you need an exact existing slug; inventing is the default.
      B) REFINE — <latest-yaml> is NOT "(none yet)" (section B draft is present):
         SURGICAL PATCH ONLY. You are a patch editor, not an author rewriting a story.

         Start from <latest-yaml> as the sole base. Mentally load that YAML, then apply
         the smallest set of edits demanded by <user-sketch>, <validation-feedback>,
         and trash lines. Emit the full draft via final_result — but the content must
         be that base with patches applied, not a greenfield invent that happens to
         cover similar topics.

         FORBIDDEN in REFINE (common thrash patterns — do not do these):
         - Replacing the cast with a "cleaner" invent that renames everyone
         - Inventing parallel ids (e.g. keep Product/product-atlas while summary says atlas)
         - Fixing one validation bullet while reintroducing a prior id/relation bug
         - Changing entity count/classes unless sketch or validation explicitly requires
           add/remove
         - Ignoring an id rename in validation while only rewriting prose/summary

         WHEN RENAMING (validation or sketch says id X → Y):
         - Change that entity's id (and class/id slug) to Y
         - Rewrite EVERY relation target that pointed at X so it points at Y
         - Keep the same components/fields unless validation also requires field fixes
         - Summary wiki links must use the same Class/id as entities[] after the rename

         SKETCH DELTAS OVERRIDE STABILITY (highest priority after trash/locks):
         - <user-sketch> is the operator's live intent. New or changed sentences are
           HARD CORRECTIONS to B, not optional flavor text.
         - If the sketch renames something (e.g. "franchise is not Acme, it's
           Northwind"), you MUST rename ids/names/shorthand accordingly.
         - If the sketch forbids a class or entity (e.g. "one product and no service"),
           you MUST remove those entities and all edges that pointed at them — emptying
           a relation array is not enough if the entity still appears in final_result.
         - If the sketch dictates naming ("call it Atlas, not Atlas Suite"), fix id, name,
           and alias.shorthand (when the class has Alias) to match; do not keep the
           old token under a new label.
         - Stability only protects fields/entities that are NOT contradicted by the
           sketch, <validation-feedback>, or <additional-user-instructions>.
         - Do not drop previously valid fields that the sketch and validation never
           mentioned (e.g. keep naming.name when only fixing an id).

         APPLY-THESE-EDITS CHECKLIST (mentally, every REFINE call — then final_result):
         1. DIFF: Compare <user-sketch> + <validation-feedback> + trash lines against
            <latest-yaml>. List concrete mismatches only (wrong id, missing field,
            broken relation target, extra/forbidden entity, etc.).
         2. PATCH ONLY those items on the base YAML. Prefer rename-in-place over invent.
            Do not rewrite unrelated entities or invent classes the sketch did not ask for.
         3. EMIT FULL DRAFT: final_result with the complete entities array (class + id
            on every entity) = patched previous draft, not a from-scratch graph.
         4. SELF-CHECK before finishing: every validation bullet is resolved; relation
            targets match entity slugs; summary links match entities[].

      TURN BUDGET (hard self-limit):
      - Budget is ~#{maxTurns} turns max; the run aborts without a successful final_result.
      - Prefer early final_result: turn 1 is ideal for simple sketches and for pure
        refine patches (validation-only / id renames need no tools).
      - Use at most a few tool turns; do not burn the budget exploring. If tools do not
        help by turn ~4, call final_result with a surgical patch of <latest-yaml>.

      SEARCH DISCIPLINE:
      - Never repeat a search with a synonymous / paraphrased query for the same concept
        (e.g. "Acme" then "Acme Corp" then "Acme Incorporated" — pick one).
      - One search query per concept. If the hit is empty, unrelated, or a very weak score,
        do not rephrase and search again — finish with final_result (invent only in
        BOOTSTRAP mode; in REFINE mode patch <latest-yaml> instead).

      Rules:
      - Only use classes and relations that exist in the overview (or confirmed via tools).
      - Prefer reusing existing entities when a tool already returned a clear name match;
        do not burn turns hunting for weak matches.
      - Keep the set small (typically 1–6 entities). Invent plausible missing details
        only in BOOTSTRAP mode (or when validation/sketch explicitly requires a new entity).
      - Output dependency order when possible (targets before sources).
      - When a locked slug is provided, that Class/id is authoritative — never rename it.
      - When <validation-feedback> is not "(none)", fix every listed error/warning in
        final_result without dropping fields that were already valid and unmentioned.
      - When <additional-user-instructions> is not "(none)", those are operator overrides
        (e.g. trash-remove an entity). Obey them strictly: do not create those entities,
        strip them from final_result, and drop relations that pointed at them.
      - Lines in <user-sketch> like "The {{Class/id}} entity is wrong; remove it."
        are operator overrides (UI trash). Obey them even if <latest-yaml> still lists
        that entity — remove it and its edges from final_result.
      - Entity ids: short tokens only (e.g. Franchise/northwind, Product/atlas). Never echo the
        class name inside the id (bad: Franchise/franchise-northwind).
      - Relation targets must be full Class/id slugs. Place each relation on its domain class.
      - Finish ONLY by calling final_result. Never dump freeform JSON or markdown fences
        in the assistant message body.
      """
    output_tool:
      description: 'Finish: proposed entities + short summary. ALWAYS call this to complete.'
      parameters:
        entities:
          type: 'array'
          description: '''
            Array of entity objects:
            { "class": "…", "id": "…", "components": { "alias": { "field": value } },
              "relations": { "REL": ["Class/id", …] } }
            Use schema_class to learn required fields for each class you invent.
            '''
        entities_json:
          type: 'string'
          description: 'Optional: same as entities but as a JSON array string.'
        summary:
          type: 'string'
          description: '2–5 sentences with {{Class/id|Display Name}} wiki links.'
      required: ['summary']
    # auto: allow intermediate tools without forcing peg-gemma4 required-tool failures
    tool_choice: 'auto'
    max_tokens: maxTokens
    max_turns: maxTurns
    # Fail fast on provider errors (peg-gemma4 / 400) — do not burn minutes retrying
    retries: Number(opts.retries ? process.env.TASKS_SEED_RETRIES ? 0)

  factoryOpts.model = model if model
  agent = await Agent.factory factoryOpts
  registerBrainTools(agent, cwd, schema)

  onAbort = null
  if signal
    onAbort = ->
      try agent.abort('client disconnect / superseded preview')
      catch then undefined
    if signal.aborted
      onAbort()
    else
      signal.addEventListener 'abort', onAbort, { once: true }

  prompt = """
    <user-sketch>
    #{xmlEscape text}
    </user-sketch>

    <schema-overview>
    #{xmlEscape overview}
    </schema-overview>

    #{lockedBlock}

    <latest-yaml>
    #{xmlEscape yamlBlock}
    </latest-yaml>

    <latest-summary>
    #{xmlEscape summaryBlock}
    </latest-summary>

    <validation-feedback>
    #{xmlEscape validationBlock}
    </validation-feedback>

    <additional-user-instructions>
    #{xmlEscape extraInstrBlock}
    </additional-user-instructions>

    Workflow:
    1. MODE: if <latest-yaml> is "(none yet)" → BOOTSTRAP invent from the sketch.
       Else → REFINE: you are a surgical patch editor on <latest-yaml> (not a rewrite).
    2. If REFINE, run the APPLY-THESE-EDITS checklist before finishing:
       (1) DIFF sketch + validation + trash vs <latest-yaml> — concrete mismatches only.
       (2) PATCH ONLY those items on the base — rename-in-place; update all relation
           targets when an id changes; do not greenfield invent a parallel cast.
       (3) EMIT full patched draft via final_result (every entity has class + id).
       (4) SELF-CHECK: every validation bullet fixed; summary slugs match entities[].
    3. If <validation-feedback> is not "(none)", fix every issue it lists without
       dropping fields that were already valid and unmentioned.
    4. If <additional-user-instructions> is not "(none)", obey those operator overrides
       (e.g. do not create listed entities; remove them and their edges from the draft).
    5. Tools are optional. At most one search per concept; never paraphrase-retry.
       Prefer final_result. Invent-from-scratch only in BOOTSTRAP mode.
    6. Call final_result as soon as the patch (or invent) is ready — ideally turn 1
       for refine. Do not spend the ~#{maxTurns}-turn budget on tools.
    """

  try
    result = await agent.run { prompt }
  finally
    if signal and onAbort
      try signal.removeEventListener 'abort', onAbort
      catch then undefined

  { list: rawList, summary } = extractEntitiesAndSummary(result)

  schemaInfo =
    schema: schema
    classes: schema.classes or {}
    classSummaries: ctx.classSummaries or []
    raw: schema

  entities = []
  for raw in rawList
    try
      entities.push normaliseEntity(raw, schemaInfo)
    catch err
      if process.env.DEBUG
        console.error 'skip entity', err.message, raw

  if lockedSlug
    hit = entities.find((e) -> e.slug is lockedSlug)
    unless hit
      if entities.length
        entities[0] = lockEntityToSlug(entities[0], lockedSlug, schemaInfo)
      else
        try
          { cls, id } = parseSlug(lockedSlug)
          entities.push normaliseEntity({ class: cls, id, components: {} }, schemaInfo)
        catch then undefined
    else
      for e, i in entities when e.slug is lockedSlug
        entities[i] = lockEntityToSlug(e, lockedSlug, schemaInfo)

  throw new Error('no valid entities produced') unless entities.length

  summary = summary or String(result?.summary or '').trim()
  unless summary
    links = entities.map((e) -> "{{#{e.slug}|#{e.id}}}").join(', ')
    summary = "Created #{entities.length} entities: #{links}."

  for e in entities
    e.yaml = toPutContent(e)

  { entities, summary, source: 'llm', raw: result, lockedSlug: lockedSlug or null }

# put_entity should be ms with embed:none. Bound so a wedged pglite cannot
# leave the SPA on "Saving…" until Bun idleTimeout (and so we can report).
PUT_ENTITY_TIMEOUT_MS = 8000

withTimeout = (promise, ms, label) ->
  new Promise (resolve, reject) ->
    settled = false
    timer = setTimeout ->
      return if settled
      settled = true
      reject new Error("#{label} timed out after #{ms}ms")
    , ms
    promise.then(
      (v) ->
        return if settled
        settled = true
        clearTimeout(timer)
        resolve(v)
      (err) ->
        return if settled
        settled = true
        clearTimeout(timer)
        reject(err)
    )

export persistEntities = (cwd, entities, opts = {}) ->
  overwrite = opts.overwrite isnt false
  timeoutMs = opts.timeoutMs ? PUT_ENTITY_TIMEOUT_MS
  results = []
  for entity in entities
    # Prefer the preview YAML bag when present (same bytes V validated).
    content = if typeof entity.yaml is 'string' and entity.yaml.trim()
      entity.yaml
    else
      toPutContent(entity)
    try
      res = await withTimeout(
        request(cwd, 'put_entity', { slug: entity.slug, content, overwrite })
        timeoutMs
        "put_entity #{entity.slug}"
      )
      results.push { slug: entity.slug, ok: true, valid: res.valid, warnings: res.warnings, validationErrors: res.validationErrors }
    catch err
      results.push { slug: entity.slug, ok: false, error: err.message }
  results

export { toPutContent, normaliseEntity, slugify }
