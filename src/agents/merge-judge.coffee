# merge-judge.coffee — AGL microagent: LLM-as-judge for seed overwrite merges.
#
# When a proposed seed entity reuses an existing slug, decide whether the
# proposal intentionally supersedes the prior entity (safe overwrite) or would
# drop data the user did not mean to remove.
#
# Inputs: user sketch (section A), existing entity YAML, proposed entity YAML.
# Output: { ok: boolean, rationale: string }
import Agent from 'agl-ai'
import yaml from 'js-yaml'
import { loadConfig } from 'brain/config'

resolveModel = (cwd) ->
  try
    cfg = await loadConfig(cwd)
    return cfg.think?.model if cfg.think?.model
  catch then undefined
  fav = (process.env.FAV_LOCAL_LLM or '').trim()
  return fav if fav
  undefined

xmlEscape = (s) ->
  String(s ? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

entityToYaml = (entity) ->
  return '' unless entity?
  if typeof entity is 'string'
    return entity.trim()
  if typeof entity.yaml is 'string' and entity.yaml.trim()
    return entity.yaml.trim()
  data = {}
  comps = entity.components or {}
  for own k, v of comps
    data[k] = v
  rels = entity.relations or {}
  for own rel, targets of rels
    data[rel] = if Array.isArray(targets)
      targets.map (t) ->
        if typeof t is 'string' then t
        else if t?._to then t._to
        else t
    else
      targets
  try
    yaml.dump(data, { lineWidth: 100, noRefs: true, sortKeys: false }).trim()
  catch
    JSON.stringify(entity, null, 2)

parseJudgement = (result) ->
  bag = result
  if result?.last_output?
    bag = result.last_output
  else if result?.output?
    bag = result.output
  # Nested under tool name
  if bag and typeof bag is 'object' and not ('ok' of bag) and not ('safe' of bag)
    for own k, v of bag when v and typeof v is 'object' and ('ok' of v or 'safe' of v or 'rationale' of v)
      bag = v
      break
  ok = bag?.ok
  if ok is undefined and bag?.safe isnt undefined
    ok = bag.safe
  if typeof ok is 'string'
    ok = /^(true|yes|1|ok)$/i.test(ok.trim())
  ok = !!ok
  rationale = String(bag?.rationale or bag?.reason or bag?.explanation or '').trim()
  unless rationale
    rationale = if ok
      'Proposed entity is a safe intentional update of the existing record.'
    else
      'Proposed entity may drop or rewrite data unintentionally — pull the existing entity and merge required fields before overwriting.'
  { ok, rationale }

# Fast path when YAMLs are identical.
structuralSafe = (existingYaml, proposedYaml) ->
  try
    a = yaml.load(existingYaml) or {}
    b = yaml.load(proposedYaml) or {}
  catch
    return null
  return null unless a and typeof a is 'object' and b and typeof b is 'object'
  try
    if JSON.stringify(a) is JSON.stringify(b)
      return {
        ok: true
        rationale: 'Proposed YAML matches the existing entity; overwrite is a no-op merge.'
      }
  catch then undefined
  null

# Judge one slug conflict.
# opts: { cwd, sketch, slug, existing, proposed, model?, signal? }
# returns: { ok, rationale, slug }
export judgeMerge = (opts = {}) ->
  cwd = opts.cwd or process.cwd()
  slug = String(opts.slug or '').trim()
  sketch = String(opts.sketch or opts.seedText or opts.text or '').trim()
  existingYaml = entityToYaml(opts.existing)
  proposedYaml = entityToYaml(opts.proposed)
  signal = opts.signal or null

  unless slug
    return {
      ok: false
      rationale: 'Missing slug for merge judgement.'
      slug: slug
    }
  unless proposedYaml
    return {
      ok: false
      rationale: "Proposed entity for #{slug} is empty — pull existing #{slug} and merge fields from the sketch before overwriting."
      slug: slug
    }
  unless existingYaml
    return {
      ok: true
      rationale: "No existing body for #{slug}; create is fine."
      slug: slug
    }

  fast = structuralSafe(existingYaml, proposedYaml)
  if fast
    return Object.assign({ slug }, fast)

  model = opts.model or await resolveModel(cwd)
  maxTokens = Number(opts.max_tokens ? process.env.TASKS_MERGE_JUDGE_MAX_TOKENS ? 512)
  maxTurns = Number(opts.max_turns ? process.env.TASKS_MERGE_JUDGE_MAX_TURNS ? 3)

  factoryOpts =
    system_prompt: """
      You are a careful merge judge for a knowledge-graph seed editor.

      The operator wrote a short sketch (section A). The agent proposed an entity
      whose slug already exists in the database. Decide whether overwriting the
      existing entity with the proposal is SAFE given the sketch.

      SAFE (ok=true) when:
      - The proposal is an intentional update of the same real-world entity
        (same product/person/franchise the sketch is about).
      - Fields present on the existing entity that the sketch does NOT ask to
        remove or replace are preserved in the proposal (or are clearly obsolete
        / superseded by the sketch).
      - Relation targets the sketch still implies are kept or correctly updated.

      UNSAFE (ok=false) when:
      - The proposal drops components/fields that look intentional data
        (name, description, lifecycle, emails, relations) without the sketch
        asking for that removal.
      - The proposal looks like a partial invent that would clobber a richer
        existing record.
      - The sketch only mentions a related new entity (e.g. a product) and the
        existing franchise/person would lose unrelated stored detail.

      When UNSAFE, rationale MUST tell the main composer how to fix it:
      - Pull (read) the existing entity for this slug.
      - Merge: start from existing fields, apply only sketch-driven deltas.
      - Name any concrete fields/relations that would be lost if overwritten as-is.

      Be concise. No tools. Always finish via final_result.
      """
    output_tool:
      description: 'Merge safety judgement for one slug conflict.'
      parameters:
        ok:
          type: 'boolean'
          description: 'true if proposed entity safely supersedes existing without unintentional data loss'
        rationale:
          type: 'string'
          description: 'Why ok/not; if false, how to pull existing entity and merge fields'
      required: ['ok', 'rationale']
    tool_choice: 'required'
    max_tokens: maxTokens
    max_turns: maxTurns
    retries: Number(opts.retries ? 0)

  factoryOpts.model = model if model
  agent = await Agent.factory factoryOpts

  onAbort = null
  if signal
    onAbort = ->
      try agent.abort('client disconnect / superseded judge')
      catch then undefined
    if signal.aborted then onAbort()
    else signal.addEventListener 'abort', onAbort, { once: true }

  prompt = """
    <slug>#{xmlEscape slug}</slug>

    <user-sketch>
    #{xmlEscape sketch or '(empty)'}
    </user-sketch>

    <existing-entity>
    #{xmlEscape existingYaml}
    </existing-entity>

    <proposed-entity>
    #{xmlEscape proposedYaml}
    </proposed-entity>

    Judge whether overwriting <existing-entity> with <proposed-entity> is safe
    for this sketch. Call final_result with ok + rationale.
    """

  try
    result = await agent.run { prompt }
    judgement = parseJudgement(result)
    return Object.assign({ slug }, judgement)
  catch err
    return {
      ok: false
      slug: slug
      rationale:
        "Could not judge merge for #{slug} (#{err.message or err}). " +
        "Pull the existing entity and merge sketch-driven fields into it before overwriting " +
        "(preserve fields the sketch does not intend to remove)."
    }
  finally
    if signal and onAbort
      try signal.removeEventListener 'abort', onAbort
      catch then undefined

# Judge many slug conflicts sequentially (keeps local LLM load predictable).
export judgeMerges = (opts = {}) ->
  sketch = opts.sketch or ''
  cwd = opts.cwd
  signal = opts.signal
  out = []
  for c in (opts.conflicts or [])
    if signal?.aborted
      out.push {
        slug: c.slug
        ok: false
        rationale: 'Merge judgement aborted.'
      }
      continue
    out.push await judgeMerge({
      cwd
      sketch
      slug: c.slug
      existing: c.existing
      proposed: c.proposed
      signal
    })
  out

export { entityToYaml }
