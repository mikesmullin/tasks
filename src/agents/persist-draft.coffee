# persist-draft.coffee — Save-time: create staged entities, then put WorkUnit.
# Second phase of the NL draft flow (creation deferred until operator Saves).
import { putWorkUnit } from '../workunits.coffee'
import { createPendingEntities } from './nl-to-workunit.coffee'

export persistDraft = (cwd, opts = {}) ->
  fields = opts.fields or opts.workunit or {}
  dependsOn = opts.dependsOn or opts.DEPENDS_ON or []
  pending = opts.pendingEntities or []

  entityResults = await createPendingEntities(cwd, pending)
  failed = entityResults.filter((r) -> not r.ok)
  if failed.length and opts.strict
    throw new Error("failed to create: #{failed.map((f) -> f.slug + ': ' + f.error).join('; ')}")

  wu = await putWorkUnit(cwd, fields, dependsOn, {
    isNew: opts.isNew isnt false
    overwrite: opts.overwrite isnt false
  })

  {
    workunit: wu
    entityResults
    created: entityResults.filter((r) -> r.ok and not r.skipped).map((r) -> r.slug)
    skipped: entityResults.filter((r) -> r.skipped).map((r) -> r.slug)
    failed: failed.map((r) -> { slug: r.slug, error: r.error })
  }
