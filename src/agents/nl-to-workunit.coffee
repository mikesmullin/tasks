# nl-to-workunit.coffee — AGL microagent: English → WorkUnit fields (+ clarifying Qs).
# Contract: /workspace/agl/docs/MICROAGENT.md — one factory, one run, one typed output.
# Tools: lookup_entity (live brain), stage_entity (deferred until Save).
import Agent from 'agl-ai'
import {
  parse as parseShorthand
  plainBulletListToFields
  countTopLevelBullets
  extractWikiLinkSlugs
  ensureWikilinksInDescription
  computeCorrelations
} from '../../public/shorthand.js'
import { stampNew, localValidate } from '../workunit.coffee'
import { loadConfig, storageDirs } from 'brain/config'
import { loadSchema } from 'brain/schema'
import { request, serverRunning } from '../rpc.coffee'
import { formatSlug } from 'brain/slug'
import yaml from 'js-yaml'

# True only for a *single-line* (or single workunit) real task.md line — NOT multi-bullet sketches.
export looksLikeShorthand = (text) ->
  t = String(text or '').trim()
  return false unless t
  # Multi top-level bullets are always a one-task sketch, never pure shorthand early-out.
  return false if countTopLevelBullets(t) >= 2
  return true if /^-\s+[A-D]\b/.test(t)
  return true if /^-\s+\[(?:_|x|X|r|\-| )\]/.test(t)
  return true if /^-\s+.*[`'"]/.test(t)
  return true if /^-\s+(?:@\w+|\#\w+)/.test(t)
  return true if /^-\s+.+\s[@#]\w+/.test(t)
  return true if /\n\s{2,}[A-Za-z_][\w-]*:\s/.test(t)
  return true if /\b(?:due|w|needs|worker|est):\s/.test(t)
  false

# Re-export for tests
export { plainBulletListToFields, countTopLevelBullets }

resolveModel = (cwd) ->
  fav = (process.env.FAV_LOCAL_LLM or '').trim()
  return fav if fav
  try
    cfg = await loadConfig(cwd)
    return cfg.think?.model if cfg.think?.model
  catch
    undefined
  undefined

xmlEscape = (s) ->
  String(s ? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

longNow = (d = new Date()) ->
  # e.g. "Sunday, August 9, 2026, 1:30:00 PM UTC"
  try
    d.toLocaleString 'en-US',
      weekday: 'long'
      year: 'numeric'
      month: 'long'
      day: 'numeric'
      hour: 'numeric'
      minute: '2-digit'
      second: '2-digit'
      timeZoneName: 'short'
  catch
    d.toISOString()

parseQuestionsFromModel = (raw) ->
  list = raw
  if typeof raw is 'string'
    s = raw.trim()
    return [] unless s
    try
      list = JSON.parse(s)
    catch
      return []
  return [] unless Array.isArray(list)
  out = []
  for q in list
    continue unless q?
    id = Number(q.id ? q.n ? q.number)
    text = String(q.text ? q.question ? q.q ? '').trim()
    continue unless Number.isFinite(id) and id > 0 and text
    out.push { id: Math.floor(id), text }
  out.sort (a, b) -> a.id - b.id
  out

parsePendingEntities = (raw) ->
  list = raw
  if typeof raw is 'string'
    s = raw.trim()
    return [] unless s and s isnt '[]'
    try
      list = JSON.parse(s)
    catch
      return []
  return [] unless Array.isArray(list)
  out = []
  for e in list
    continue unless e and (e.class or e.cls)
    cls = String(e.class or e.cls).trim()
    id = String(e.id or '').trim()
    continue unless cls and id
    out.push
      class: cls
      id: id
      slug: "#{cls}/#{id}"
      components: e.components or {}
      relations: e.relations or {}
      reason: String(e.reason or '')
  out

export mergeClarifyingQuestions = (prior, fromModel) ->
  prior = prior or []
  fromModel = fromModel or []
  byId = new Map()
  for q in prior
    id = Number(q.id)
    continue unless Number.isFinite(id)
    byId.set id,
      id: id
      text: String(q.text or '')
      answer: if q.answer? then String(q.answer) else ''
  for q in fromModel
    id = Number(q.id)
    continue unless Number.isFinite(id) and id > 0
    if byId.has(id)
      continue
    byId.set id,
      id: id
      text: String(q.text or '').trim()
      answer: ''
  [...byId.values()].sort (a, b) -> a.id - b.id

formatQuestionsBlock = (questions) ->
  return '(none yet)' unless questions?.length
  lines = for q in questions
    ans = if String(q.answer or '').trim() then String(q.answer).trim() else '(unanswered)'
    "Q#{q.id}: #{q.text}\nA#{q.id}: #{ans}"
  lines.join '\n\n'

# Live WorkUnit T-box slice (class + component + DEPENDS_ON) as YAML for the prompt.
export loadWorkUnitSchemaYaml = (cwd) ->
  components = null
  classes = null
  relations = null
  if serverRunning(cwd)
    try
      info = await request(cwd, 'schema_info', {})
      components = info.components or info.schema?.components
      classes = info.classes or info.schema?.classes
      relations = info.relations or info.schema?.relations
    catch then undefined
  unless components?
    try
      schema = await loadSchema(await storageDirs(cwd))
      components = schema.components
      classes = schema.classes
      relations = schema.relations
    catch err
      return "# schema unavailable: #{err.message}"

  slice =
    components:
      WorkUnit: components?.WorkUnit or { fields: {} }
    classes:
      WorkUnit: classes?.WorkUnit or { components: { workunit: 'WorkUnit' } }
    relations: {}
  if relations?.DEPENDS_ON?
    slice.relations.DEPENDS_ON = relations.DEPENDS_ON
  else
    slice.relations.DEPENDS_ON = { domain: 'WorkUnit', range: 'WorkUnit', cardinality: 'mtm' }

  # Annotate machine-set fields for the model (not author-facing).
  note = """
    # WorkUnit T-box from brain schema (authoritative).
    # Machine-set (do NOT invent): id, createdAt, updatedAt.
    # Author-facing fields go in final_result. Dependencies are DEPENDS_ON edges (needs:), not a field.
    """
  note + '\n' + yaml.dump(slice, { lineWidth: 100, noRefs: true, sortKeys: false }).trimEnd()

# Merge checklist from sketch baseline into LLM fields if LLM dropped them.
# Also restore {{Class/id}} wikilinks the model often strips from checklist lines.
ensureChecklist = (fields, baseline, sourceText = '') ->
  if baseline?.description
    hasCheck = /-\s\[[ xX~\-]\]/.test(String(fields.description or ''))
    unless hasCheck
      baseDesc = baseline.description
      if fields.description and String(fields.description).trim()
        fields.description = "#{String(fields.description).trim()}\n\n#{baseDesc}"
      else
        fields.description = baseDesc
    fields.summary or= baseline.summary
    # Prefer baseline stakeholders/tags if LLM emptied them
    if baseline.stakeholders?.length and not (fields.stakeholders?.length)
      fields.stakeholders = baseline.stakeholders
    if baseline.tags?.length and not (fields.tags?.length)
      fields.tags = baseline.tags
    if baseline.important? and fields.important is false and baseline.important
      fields.important = true
    if baseline.urgent? and fields.urgent is false and baseline.urgent
      fields.urgent = true
  # Deterministic: keep {{…}} from pane A / sketch inside description
  ensureWikilinksInDescription(fields, baseline, sourceText)
  fields

export parseNl = (text, opts = {}) ->
  cwd = opts.cwd or process.cwd()
  now = opts.now or new Date()
  today = opts.today or now.toISOString().slice(0, 10)
  nowLong = opts.nowLong or longNow(now)
  knownPeople = opts.knownPeople or []
  knownTags = opts.knownTags or []
  existing = opts.existing or null
  priorQuestions = opts.clarifyingQuestions or opts.questions or []
  priorPending = opts.pendingEntities or []

  # Always build multi-bullet / sketch baseline when possible (priority/@ on head OK).
  sketch = plainBulletListToFields(text)
  if sketch?
    opts = Object.assign({}, opts, { _plainBaseline: sketch })

  # Single-line pure shorthand: deterministic fast path (still no multi-bullet).
  if looksLikeShorthand(text) and countTopLevelBullets(text) < 2
    { workunits } = parseShorthand(text)
    if workunits.length is 1
      node = workunits[0]
      f = stampNew(node.fields, { id: existing?.id })
      # Still run LLM when we want clarifying Qs / entity lookup — fall through with baseline
      opts = Object.assign({}, opts, {
        _plainBaseline: Object.assign({}, f, { description: f.description or '' })
      })

  try
    return await runLlmParse(text, opts, {
      cwd, today, nowLong, knownPeople, knownTags, existing, priorQuestions, priorPending
    })
  catch err
    # Client cancelled (typing supersedes / fetch abort) — do not synthesize a
    # sketch fallback. Wall-clock timeout aborts still fall through below.
    if opts.signal?.aborted
      throw err
    baseline = opts._plainBaseline or sketch
    if baseline?
      f = stampNew(baseline, { id: existing?.id })
      if existing?.createdAt then f.createdAt = existing.createdAt
      return {
        fields: f
        dependsOn: []
        source: if sketch? then 'sketch' else 'plain-bullets'
        clarifyingQuestions: mergeClarifyingQuestions(priorQuestions, [])
        pendingEntities: priorPending
        warning: String(err.message or err)
      }
    # last resort single-line shorthand without LLM
    if looksLikeShorthand(text)
      { workunits } = parseShorthand(text)
      if workunits.length
        node = workunits[0]
        f = stampNew(node.fields, { id: existing?.id })
        return {
          fields: f
          dependsOn: node.dependsOn or []
          source: 'shorthand'
          clarifyingQuestions: mergeClarifyingQuestions(priorQuestions, [])
          pendingEntities: priorPending
          warning: String(err.message or err)
        }
    throw err

runLlmParse = (text, opts, ctx) ->
  { cwd, today, nowLong, knownPeople, knownTags, existing, priorQuestions, priorPending } = ctx
  model = if opts.model? then opts.model else await resolveModel(cwd)

  peopleBlock = if knownPeople.length then knownPeople.join('\n') else '(none)'
  tagsBlock = if knownTags.length then knownTags.join(', ') else '(none)'
  existingBlock = if existing then JSON.stringify(existing, null, 2) else '(none)'
  priorBlock = formatQuestionsBlock(priorQuestions)
  baselineBlock = if opts._plainBaseline
    JSON.stringify(opts._plainBaseline, null, 2)
  else
    '(none)'
  shorthandBlock = String(opts.latestShorthand ? opts.shorthand ? '').trim() or '(none yet)'
  yamlBlock = String(opts.latestYaml ? opts.yaml ? '').trim() or '(none yet)'
  validationFeedback = String(opts.validationFeedback or opts.validation or '').trim()
  validationBlock = if validationFeedback then validationFeedback else '(none)'
  pendingBlock = if priorPending?.length then JSON.stringify(priorPending, null, 2) else '(none yet)'
  schemaBlock = opts.workunitSchemaYaml or await loadWorkUnitSchemaYaml(cwd)

  maxPrior = 0
  for q in priorQuestions
    maxPrior = Math.max(maxPrior, Number(q.id) or 0)

  # Staged entities this run (lookup misses → stage_entity tool)
  staged = []
  for e in (priorPending or [])
    staged.push(e)

  system_prompt = """
    You extract and refine a single work item (WorkUnit) from the operator's draft.
    retain_history is OFF — every call is a fresh run. Stability comes from SCOPE/STATE below.

    CRITICAL — HOW YOU MUST FINISH:
    - Your final answer MUST be a call to the output tool named `final_result`.
    - Do NOT end with freeform prose or a JSON blob in the message body.
    - Call `final_result` exactly once with all required parameters filled.
    - Use tools first when you need to verify names (@bob, Person/x, Team/y, …).

    TOOLS:
    - lookup_entity: search the live brain for real entities. Use before treating a name as known.
      If nothing matches, either stage_entity (for later create-on-save) or ask a clarifying question.
    - stage_entity: queue a NEW entity to be created when the operator hits Save (not now).
      Use for people/teams/etc. that do not exist yet but are clearly needed.
      Do NOT invent slugs for real people without looking them up first.

    ITERATION RULES:
    - Prefer refining <latest-yaml> / <latest-shorthand> over starting over.
    - Use answered clarifying questions to fill fields.
    - When <validation-feedback> is non-empty, it is brain lint output for the latest YAML.
      You MUST correct those errors/warnings in final_result (required fields, types, refs).
    - Only emit fields that exist on the WorkUnit component in <workunit-schema>.
    - Do not invent ids or timestamps for the WorkUnit (machine-set: id, createdAt, updatedAt).
    - Do not invent `correlations` — it is machine-computed from {{Class/id}} wikilinks found
      in the user input + summary + description (unique set).
    - WIKILINKS (tasks form only): when the user input contains {{Class/id}} or {{Class/id|Label}}
      (including from @-mention chips), you MUST copy those exact {{…}} tokens into the matching
      checklist/prose lines in description (and/or summary if the link is in the title).
      Never replace {{Product/atlas}} with plain "Product/atlas" or drop the braces.
    - tags: bare tokens WITHOUT a leading # (e.g. crispy, platform). Never emit #crispy in tags.
      (The # in user input is only task.md sugar; strip it for the tags field.)
    - status enum and ref constraints in <workunit-schema> are authoritative.
    - important/urgent = Eisenhower (A = both, B = important, C = urgent).

    MULTI-BULLET / OUTLINE (task.md-inspired shorthand):
    - A short bullet list is ONE work item, not many tickets.
    - First top-level bullet → summary (+ optional A–D priority, [_]/[r]/[x]/[-] status, @person, #tag).
    - Every subsequent bullet (same indent or nested) → ONE checklist item inside description.
    - description is a multiline string of GFM / task.md checklist lines — each item on its OWN line:
        - [ ] series of tests
        - [ ] prove gemma4 vs qwen3.5
        - [ ] work up to reliable {{Product/atlas}} demo
    - PRESERVE {{Class/id}} wikilinks inside those checklist lines exactly as written.
    - Use real line breaks between checklist items (the actual newline character in the string).
    - NEVER put the two-character escape sequence backslash-n (\\n) inside description, summary,
      journal, or any other text field. That is wrong: it shows up as literal "\\n" in YAML/UI.
    - NEVER join checklist items with spaces or "\\n" on a single line.
    - Never invent a second WorkUnit for sub-bullets.

    CLARIFYING QUESTIONS:
    - Ambiguous facts → clarifying_questions_json.
    - Unrecognized @names / refs after lookup_entity fails → ask whether to create them
      (and what givenName/surname/email/title are needed) OR stage_entity if the answer already
      provides enough create info.
    - Stable ids: reuse prior Q ids; only append new higher ids. Never renumber.
    - ANSWERS ARE AUTHORITATIVE: when <clarifying-questions> shows A# with a real answer
      (not "(unanswered)"), you MUST apply that answer to WorkUnit fields in this same turn.
      Examples:
        · deadline / "next week" / "friday" / "by EOD" → set `due` to a concrete ISO date
          (YYYY-MM-DD) relative to <today-iso> / <system-time>. "next week" ≈ today+7 days.
        · assignee names → stakeholders
        · priority language → important/urgent
      Do not leave due empty when a deadline answer is present.
    - Re-emit clarifying_questions_json with the same Q ids (answers are kept client-side;
      you may return [] for clarifying_questions_json if nothing new to ask).

    ─── SCOPE / STATE ───

    <system-time>#{xmlEscape nowLong}</system-time>
    <today-iso>#{xmlEscape today}</today-iso>

    <workunit-schema>
    #{xmlEscape schemaBlock}
    </workunit-schema>

    <user-input>
    #{xmlEscape text}
    </user-input>

    <latest-shorthand>
    #{xmlEscape shorthandBlock}
    </latest-shorthand>

    <latest-yaml>
    #{xmlEscape yamlBlock}
    </latest-yaml>

    <validation-feedback>
    #{xmlEscape validationBlock}
    </validation-feedback>

    <clarifying-questions>
    #{xmlEscape priorBlock}
    </clarifying-questions>

    <highest-question-id>#{maxPrior}</highest-question-id>

    <pending-entities-already-staged>
    #{xmlEscape pendingBlock}
    </pending-entities-already-staged>

    <sketch-baseline>
    #{xmlEscape baselineBlock}
    </sketch-baseline>

    <known-people>
    #{xmlEscape peopleBlock}
    </known-people>

    <known-tags>
    #{xmlEscape tagsBlock}
    </known-tags>

    <existing-workunit>
    #{xmlEscape existingBlock}
    </existing-workunit>
    """

  factoryOpts =
    system_prompt: system_prompt
    retries: 0
    retain_history: false
    parallel_tools: true
    output_tool:
      name: 'final_result'
      description: 'FINAL ANSWER — call exactly once with the WorkUnit fields and questions. Required to finish.'
      parameters:
        summary:
          type: 'string'
          description: 'Short imperative title (required)'
        description:
          type: 'string'
          description: """
            Multiline prose and/or task.md-style GFM checklist. Put each checklist item on its own
            line using real newlines (not the escape text backslash-n). Checkbox forms:
            [ ] todo, [x] done, [~] in progress, [-] skipped. Example (three separate lines):
            - [ ] series of tests
            - [ ] prove gemma4 vs qwen3.5
            - [ ] work up to reliable {{Product/atlas}} demo
            Preserve any {{Class/id}} wikilinks from the user input inside the matching lines.
            """
        important: { type: 'boolean', description: 'Eisenhower important' }
        urgent: { type: 'boolean', description: 'Eisenhower urgent' }
        weight: { type: 'integer', description: '0–100' }
        status: { type: 'string', description: 'idle|running|success|fail' }
        worker: { type: 'string', description: 'Assignee username if known' }
        tags: { type: 'string', description: 'Comma-separated tags WITHOUT leading # (e.g. crispy,platform not #crispy)' }
        stakeholders: { type: 'string', description: 'Comma-separated Person/id or @name (prefer verified slugs)' }
        due: { type: 'string', description: 'ISO date YYYY-MM-DD' }
        estimateOptimistic: { type: 'string', description: 'ISO date' }
        estimateLikely: { type: 'string', description: 'ISO date' }
        estimatePessimistic: { type: 'string', description: 'ISO date' }
        dependsOn: { type: 'string', description: 'Comma-separated WorkUnit slugs' }
        clarifying_questions_json:
          type: 'string'
          description: 'JSON array [{"id":1,"text":"..."}]. Reuse prior ids; append only. [] if none.'
        pending_entities_json:
          type: 'string'
          description: """
            JSON array of entities staged for create-on-save (from stage_entity and any extras):
            [{"class":"Person","id":"bob","components":{...},"reason":"..."}]. [] if none.
            """
      required: ['summary', 'clarifying_questions_json', 'pending_entities_json']

  factoryOpts.model = model if model
  agent = await Agent.factory factoryOpts

  # ── tools ──────────────────────────────────────────────────────────────
  agent.Tool 'lookup_entity',
    'Search the live brain for entities matching a name or slug. Use to verify @mentions and refs exist.',
    {
      query:
        type: 'string'
        description: 'Name fragment, @handle, or Class/id slug'
      class_hint:
        type: 'string'
        description: 'Optional class filter e.g. Person, Team, Product'
    },
    ['query'],
    (ctx, args) ->
      q = String(args.query or '').trim()
      return JSON.stringify({ ok: false, error: 'empty query' }) unless q
      hint = String(args.class_hint or '').trim()
      unless serverRunning(cwd)
        return JSON.stringify({ ok: false, error: 'no brain server' })
      # Exact slug probe
      if q.includes('/')
        try
          e = await request(cwd, 'get_entity', { slug: q, include_links: false })
          label = e.components?.identity?.name or e.components?.naming?.name or e.components?.workunit?.summary or q
          return JSON.stringify({ ok: true, matches: [{ slug: e.slug or q, label, exists: true }] })
        catch
          return JSON.stringify({ ok: true, matches: [], exists: false, note: "no entity #{q}" })
      # Keyword search
      try
        res = await request(cwd, 'search', { query: q.replace(/^@/, ''), strategy: 'keyword', limit: 8 })
        hits = if Array.isArray(res) then res else res?.results or []
        matches = []
        for h in hits
          slug = h.slug or h.id
          continue unless slug
          if hint and not String(slug).startsWith("#{hint}/")
            continue
          label = h.preview?.identity?.name or h.preview?.naming?.name or h.title or slug
          matches.push { slug, label, score: h.score, exists: true }
        # Also try Person/<handle> for bare @names
        bare = q.replace(/^@/, '')
        if bare and not bare.includes('/')
          try
            slug = formatSlug('Person', bare.toLowerCase())
            e = await request(cwd, 'get_entity', { slug, include_links: false })
            unless matches.some((m) -> m.slug is slug)
              matches.unshift
                slug: slug
                label: e.components?.identity?.name or bare
                exists: true
          catch then undefined
        JSON.stringify({ ok: true, matches, count: matches.length })
      catch err
        JSON.stringify({ ok: false, error: err.message })

  agent.Tool 'stage_entity',
    'Queue a NEW entity to create when the operator Saves (does not write the brain now). Use after lookup_entity found nothing.',
    {
      class:
        type: 'string'
        description: 'Person | Team | Product | Franchise | System | Service | …'
      id:
        type: 'string'
        description: 'slug id (e.g. bob for Person/bob). lowercase token.'
      components_json:
        type: 'string'
        description: 'JSON object of component bags, e.g. {"identity":{"username":"bob","name":"Bob Smith",...}}'
      reason:
        type: 'string'
        description: 'Why this entity is needed (shown to operator)'
    },
    ['class', 'id'],
    (ctx, args) ->
      cls = String(args.class or '').trim()
      id = String(args.id or '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
      return JSON.stringify({ ok: false, error: 'class and id required' }) unless cls and id
      comps = {}
      if args.components_json
        try
          comps = JSON.parse(String(args.components_json))
        catch err
          return JSON.stringify({ ok: false, error: "bad components_json: #{err.message}" })
      # Person convenience defaults
      if cls is 'Person'
        comps.identity ?= {}
        comps.identity.username = id
        comps.identity.name ?= id
        comps.contact ?= {}
        comps.employment ?= { active: true, created: today, title: 'Unknown' }
      entry =
        class: cls
        id: id
        slug: "#{cls}/#{id}"
        components: comps
        relations: {}
        reason: String(args.reason or 'staged by microagent')
      # de-dupe by slug
      staged = staged.filter((e) -> e.slug isnt entry.slug)
      staged.push entry
      JSON.stringify({ ok: true, staged: entry, note: 'will be created on Save, not now' })

  answered = (priorQuestions or []).filter (q) -> String(q.answer or '').trim()
  answeredHint = if answered.length
    "APPLY these clarifying answers now (especially due dates from relative phrases): " +
      answered.map((q) -> "Q#{q.id}=#{String(q.answer).trim()}").join('; ') + "."
  else
    ''

  prompt = """
    Re-evaluate SCOPE/STATE. Use lookup_entity for any @name or Class/id you are unsure about.
    Stage new entities with stage_entity when the operator clearly needs them and lookup fails.
    #{answeredHint}
    Then call `final_result` with an updated WorkUnit and clarifying_questions_json + pending_entities_json.
    description checklist: one "- [ ] …" line per sub-bullet, real newlines only — never literal \\n text.
    tags without leading #. Preserve {{Class/id}} wikilinks in description.
    """

  timeoutMs = Number(opts.timeoutMs ? process.env.TASKS_NL_TIMEOUT_MS ? 90000)
  timer = null
  signal = opts.signal or null
  onAbort = null
  if signal
    onAbort = ->
      try agent.abort('client disconnect / superseded NL parse')
      catch then undefined
    if signal.aborted
      onAbort()
    else
      signal.addEventListener 'abort', onAbort, { once: true }
  if timeoutMs > 0
    timer = setTimeout (->
      try agent.abort("nl-to-workunit timed out after #{timeoutMs}ms")
      catch then undefined
    ), timeoutMs
  try
    result = await agent.run { prompt }
  finally
    clearTimeout(timer) if timer?
    if signal and onAbort
      try signal.removeEventListener 'abort', onAbort
      catch then undefined

  raw =
    summary: result.summary
    description: result.description or ''
    important: result.important is true or result.important is 'true'
    urgent: result.urgent is true or result.urgent is 'true'
    weight: Number(result.weight) or 0
    status: result.status or 'idle'
    worker: result.worker or null
    tags: result.tags
    stakeholders: result.stakeholders
    due: result.due or null
    estimateOptimistic: result.estimateOptimistic or null
    estimateLikely: result.estimateLikely or null
    estimatePessimistic: result.estimatePessimistic or null
    journal: []
    # so normalizeFields / correlations see the original {{…}} pills from A
    _sourceText: text

  raw = ensureChecklist(raw, opts._plainBaseline, text)

  dependsOn = []
  if result.dependsOn
    dependsOn = String(result.dependsOn).split(',').map((s) -> s.trim()).filter(Boolean)
      .map (s) -> if s.includes('/') then s else "WorkUnit/#{s}"

  f = stampNew(raw, { id: existing?.id })
  if existing?.createdAt
    f.createdAt = existing.createdAt
  # Recompute correlations from full A text + final fields (Set; survives LLM strip)
  f.correlations = computeCorrelations(f.summary, f.description, text)

  v = localValidate(f)
  unless v.ok
    f.summary or= String(text).split('\n').find((l) -> l.trim())?.replace(/^\s*-\s+/, '').replace(/^[A-D]\s+/, '').replace(/^@\w+\s+/, '').slice(0, 80) or 'untitled'
    f = stampNew(f, { id: f.id })

  modelQs = parseQuestionsFromModel(result.clarifying_questions_json)
  clarifyingQuestions = mergeClarifyingQuestions(priorQuestions, modelQs)

  fromOutput = parsePendingEntities(result.pending_entities_json)
  # Merge staged tool calls + model output + prior
  bySlug = new Map()
  for e in (priorPending or [])
    bySlug.set(e.slug or "#{e.class}/#{e.id}", e)
  for e in staged
    bySlug.set(e.slug, e)
  for e in fromOutput
    bySlug.set(e.slug, e)
  pendingEntities = [...bySlug.values()]

  { fields: f, dependsOn, source: 'llm', raw: result, clarifyingQuestions, pendingEntities }

# ── save-time: create staged entities then the WorkUnit ───────────────────
export createPendingEntities = (cwd, pending) ->
  results = []
  for e in (pending or [])
    cls = e.class or e.cls
    id = e.id
    slug = e.slug or "#{cls}/#{id}"
    content = {}
    for own k, v of (e.components or {})
      content[k] = v
    for own rel, ts of (e.relations or {})
      content[rel] = ts
    try
      # skip if already exists
      try
        await request(cwd, 'get_entity', { slug, include_links: false })
        results.push { slug, ok: true, skipped: true, note: 'already exists' }
        continue
      catch then undefined
      y = yaml.dump(content, { lineWidth: 100, noRefs: true, sortKeys: false })
      res = await request(cwd, 'put_entity', { slug, content: y, overwrite: false })
      results.push { slug, ok: true, valid: res.valid, warnings: res.warnings }
    catch err
      results.push { slug, ok: false, error: err.message }
  results
