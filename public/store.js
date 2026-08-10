/**
 * store.js — named m.js store (survives HMR). UI state only; nothing persists to disk.
 *
 * m.js v3: templates bind via $store.tasks.*; reactive writes schedule one coalesced redraw.
 */
import M from '/m.min.js'
import {
  render as renderShorthand,
  tokenize,
  applyComputedCorrelations,
  tagNorm,
} from './shorthand.js'
import { highlightYaml } from './yaml-highlight.js'
import { renderWikiHtml, renderMarkdownHtml, sanitizeSlug, slugIdLabel } from './wiki.js'
import {
  isMentionMenuOpen,
  onMentionMenuOpenChange,
} from './mentions.js'

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Bold Phosphor icon (matches ui.js `ic`). */
function ic(name) {
  return `<i class="ph-bold ph-${name}" aria-hidden="true"></i>`
}

/**
 * Field-type → Phosphor glyph. A reader scanning a component wants to know
 * "what shape is this value?" before they read the type name, and an icon
 * answers that in peripheral vision. Every brain field type is covered
 * (string · bool · int · date · enum · ref · json); unknown types fall back
 * to a neutral dot rather than rendering nothing.
 */
const TYPE_ICON = {
  string: 'text-aa',
  bool: 'toggle-left',
  int: 'hash',
  date: 'calendar-blank',
  enum: 'list-bullets',
  ref: 'link-simple',
  json: 'brackets-curly',
}

/**
 * Cardinality codes spelled out. `mtm` is jargon that means nothing on first
 * read; "many-to-many" needs no glossary.
 */
const CARDINALITY = {
  oto: 'one-to-one',
  otn: 'one-to-many',
  nto: 'many-to-one',
  mtm: 'many-to-many',
}

/**
 * One field (or relation qualifier) as a grid row.
 * Layout: [type icon] [name] [type] [flags] with any `comment` on its own
 * full-width line beneath — the comment is prose about the field, so it reads
 * under the field rather than crammed into a column beside it.
 */
function fieldRowHtml(name, fd = {}) {
  const t = String(fd.type || '')
  const icon = TYPE_ICON[t] || 'dot-outline'
  const flags = []
  if (fd.required) flags.push(`<span class="flag is-req" title="required">required</span>`)
  if (fd.list) flags.push(`<span class="flag is-list" title="repeated value">list</span>`)
  if (Array.isArray(fd.allowedTypes) && fd.allowedTypes.length) {
    flags.push(
      `<span class="flag is-target" title="allowed target classes">→ ${esc(fd.allowedTypes.join(' · '))}</span>`,
    )
  }
  let row =
    `<li class="field-row" data-type="${esc(t)}">` +
    `<i class="ph-bold field-icon ph-${icon}" aria-hidden="true"></i>` +
    `<span class="field-name">${esc(name)}</span>` +
    `<span class="field-type">${esc(t || '—')}${fd.list ? '[]' : ''}</span>` +
    `<span class="field-flags">${flags.join('')}</span>`
  if (Array.isArray(fd.values) && fd.values.length) {
    row +=
      `<span class="field-enum">` +
      fd.values.map((v) => `<span class="enum-val">${esc(v)}</span>`).join('') +
      `</span>`
  }
  const comment = fd.comment == null ? '' : String(fd.comment).trim()
  if (comment) row += `<p class="field-note">${esc(comment)}</p>`
  return row + `</li>`
}

/**
 * A relation endpoint. Deliberately NOT an entity pill: these are class names
 * in a schema signature, not links to instances, and styling them like chips
 * invited exactly that confusion. Plain type-set text, with the class you are
 * currently looking at marked so the direction reads at a glance.
 */
function endpointHtml(cls, currentClass) {
  const self = cls === currentClass ? ' is-self' : ''
  return `<span class="rel-endpoint${self}">${esc(cls || '*')}</span>`
}

/**
 * Group entity relations for the collapsible tree UI (Brain Viz inspector pattern).
 * Outgoing and incoming are separate groups so direction stays explicit.
 * Default: groups open so 1st-degree targets are visible.
 * @param {{ relations?: object, incoming?: Array<{ from?: string, rel?: string }> }} ent
 * @param {Set<string>|null} [prevOpen] null = first paint (open all); Set = restore open keys
 * @returns {Array<{ key: string, rel: string, dir: 'out'|'in', arrow: string, open: boolean, targets: Array<{ slug: string }> }>}
 */
function buildEntityRelationTree(ent, prevOpen = null) {
  if (!ent) return []
  /** @type {Map<string, { key: string, rel: string, dir: 'out'|'in', targets: Set<string> }>} */
  const byKey = new Map()
  const add = (rel, slug, dir) => {
    if (!rel || !slug) return
    const key = `${dir}:${rel}`
    let g = byKey.get(key)
    if (!g) {
      g = { key, rel: String(rel), dir, targets: new Set() }
      byKey.set(key, g)
    }
    g.targets.add(String(slug))
  }
  for (const [rel, targets] of Object.entries(ent.relations || {})) {
    for (const t of targets || []) {
      const slug = typeof t === 'string' ? t : t?._to
      if (slug) add(rel, slug, 'out')
    }
  }
  for (const link of ent.incoming || []) {
    if (link?.from && link?.rel) add(link.rel, link.from, 'in')
  }
  const firstPaint = prevOpen == null
  return [...byKey.values()]
    .sort((a, b) => {
      if (a.dir !== b.dir) return a.dir === 'out' ? -1 : 1
      return a.rel.localeCompare(b.rel)
    })
    .map((g) => ({
      key: g.key,
      rel: g.rel,
      dir: g.dir,
      // `arrow` stays as text for the :title tooltip; `arrowIcon` is what the
      // tree renders (Phosphor bold — see .insp-rel-arrow in styles.css).
      arrow: g.dir === 'out' ? '→' : '←',
      arrowIcon: g.dir === 'out' ? 'ph-arrow-right' : 'ph-arrow-left',
      arrowLabel: g.dir === 'out' ? 'to' : 'from',
      open: firstPaint ? true : prevOpen.has(g.key),
      targets: [...g.targets]
        .sort((a, b) => a.localeCompare(b))
        .map((slug) => ({ slug })),
    }))
}

/** Format brain validate response into a plain text block for V panes / LLM XML. */
function formatValidationText(res) {
  if (!res) return ''
  const errors = Array.isArray(res.errors) ? res.errors : []
  const warnings = Array.isArray(res.warnings) ? res.warnings : []
  if (!errors.length && !warnings.length && res.valid !== false) return ''
  const lines = []
  if (errors.length) {
    lines.push('errors:')
    for (const e of errors) lines.push(`- ${e}`)
  }
  if (warnings.length) {
    lines.push('warnings:')
    for (const w of warnings) lines.push(`- ${w}`)
  }
  if (!lines.length && res.valid === false) lines.push('errors:', '- (invalid)')
  return lines.join('\n')
}

/**
 * Merge brain V text with Seed-tab process-rule messages.
 * Process rules are appended after brain output so redrive prompts see both layers.
 * @param {string} brainText
 * @param {string[]} processErrors
 * @param {string[]} [processWarnings]
 */
function mergeSeedValidationText(brainText, processErrors, processWarnings = []) {
  const pe = (processErrors || []).map((e) => String(e || '').trim()).filter(Boolean)
  const pw = (processWarnings || []).map((w) => String(w || '').trim()).filter(Boolean)
  const base = String(brainText || '').trim()
  if (!pe.length && !pw.length) return base

  // Prefer a single errors:/warnings: document so the LLM sees one coherent block.
  const errLines = []
  const warnLines = []
  if (base) {
    const lines = base.split('\n')
    let section = ''
    for (const line of lines) {
      if (/^errors:\s*$/i.test(line)) {
        section = 'e'
        continue
      }
      if (/^warnings:\s*$/i.test(line)) {
        section = 'w'
        continue
      }
      const m = line.match(/^\s*-\s*(.*)$/)
      if (m) {
        if (section === 'w') warnLines.push(m[1])
        else errLines.push(m[1])
      } else if (line.trim()) {
        // Freeform brain/HTTP error — treat as error line
        errLines.push(line.trim())
      }
    }
  }
  for (const e of pe) errLines.push(e)
  for (const w of pw) warnLines.push(w)

  const out = []
  if (errLines.length) {
    out.push('errors:')
    for (const e of errLines) out.push(`- ${e}`)
  }
  if (warnLines.length) {
    out.push('warnings:')
    for (const w of warnLines) out.push(`- ${w}`)
  }
  return out.join('\n')
}

/**
 * Seed-tab process rules (sync): unique proposed slugs within section B.
 * @param {Array<{ slug?: string }>} entities
 * @returns {{ errors: string[], warnings: string[] }}
 */
function seedProcessRulesDuplicates(entities) {
  const errors = []
  /** @type {Map<string, string[]>} lower → display slugs in order */
  const byLower = new Map()
  for (const e of entities || []) {
    const slug = sanitizeSlug(e?.slug || '')
    if (!slug || !slug.includes('/')) continue
    const key = slug.toLowerCase()
    if (!byLower.has(key)) byLower.set(key, [])
    byLower.get(key).push(slug)
  }
  for (const [, list] of byLower) {
    if (list.length < 2) continue
    const shown = [...new Set(list)].join(', ')
    errors.push(
      `seed process: duplicate entity slug (case-insensitive) in section B — ` +
        `consolidate into one entity (found ${list.length}×: ${shown})`,
    )
  }
  return { errors, warnings: [] }
}

/**
 * Serialize a draft or live entity for merge-judge / process rules.
 * @param {object} ent
 */
function entityBagForJudge(ent) {
  if (!ent || typeof ent !== 'object') return ''
  if (typeof ent.yaml === 'string' && ent.yaml.trim()) return ent.yaml.trim()
  const data = { ...(ent.components || {}) }
  for (const [rel, targets] of Object.entries(ent.relations || {})) {
    data[rel] = (Array.isArray(targets) ? targets : [targets]).map((t) =>
      typeof t === 'string' ? t : t?._to || t,
    )
  }
  try {
    // Prefer plain multi-line text (no js-yaml in browser store)
    return JSON.stringify(data, null, 2)
  } catch {
    return String(ent.slug || '')
  }
}

/**
 * Seed-tab process rules (async): slug already in DB → LLM merge-judge.
 * - ok=true  → allow overwrite on Save (no V error); record in approvedSlugs
 * - ok=false → V error with pull-and-merge rationale for the seed composer
 *
 * @param {Array<{ slug?: string, yaml?: string, components?: object, relations?: object }>} entities
 * @param {{ sketch?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ errors: string[], warnings: string[], approvedSlugs: string[] }>}
 */
async function seedProcessRulesExistingInDb(entities, opts = {}) {
  const errors = []
  const warnings = []
  /** @type {string[]} */
  const approvedSlugs = []
  const sketch = String(opts.sketch || '')
  const bySlug = new Map()
  for (const e of entities || []) {
    const slug = sanitizeSlug(e?.slug || '')
    if (slug && slug.includes('/')) bySlug.set(slug, e)
  }
  const slugs = [...bySlug.keys()]
  if (!slugs.length) return { errors, warnings, approvedSlugs }

  try {
    const q = slugs.map(encodeURIComponent).join(',')
    const res = await fetch(`/nodes?slugs=${q}`, { signal: opts.signal })
    if (!res.ok) {
      return {
        errors: [],
        warnings: [
          `seed process: could not check existing entities (HTTP ${res.status})`,
        ],
        approvedSlugs,
      }
    }
    const data = await res.json().catch(() => ({}))
    /** @type {Map<string, object>} lower slug → existing entity */
    const existingByLower = new Map()
    for (const ent of data.entities || []) {
      const s = sanitizeSlug(ent?.slug || '')
      if (s) existingByLower.set(s.toLowerCase(), ent)
      if (ent?.cls && ent?.id) {
        existingByLower.set(
          sanitizeSlug(`${ent.cls}/${ent.id}`).toLowerCase(),
          ent,
        )
      }
    }

    const conflicts = []
    for (const slug of slugs) {
      const existing = existingByLower.get(slug.toLowerCase())
      if (!existing) continue
      const proposed = bySlug.get(slug)
      conflicts.push({
        slug,
        existing: {
          slug,
          components: existing.components || {},
          relations: existing.relations || {},
          yaml: entityBagForJudge(existing),
        },
        proposed: {
          slug,
          components: proposed?.components || {},
          relations: proposed?.relations || {},
          yaml: proposed?.yaml || entityBagForJudge(proposed || {}),
        },
      })
    }
    if (!conflicts.length) return { errors, warnings, approvedSlugs }

    // Batch LLM-as-judge (server runs sequentially for local LLM load)
    const jr = await fetch('/nl/seed/merge-judge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sketch, conflicts }),
      signal: opts.signal,
    })
    if (!jr.ok) {
      // Fail closed with pull-and-merge advice (no thrash-block without rationale)
      for (const c of conflicts) {
        errors.push(
          `${c.slug}: seed process: entity already exists — pull the existing ` +
            `${c.slug} and merge sketch-driven fields into it before overwriting ` +
            `(preserve fields the sketch does not intend to remove). ` +
            `Judge unavailable (HTTP ${jr.status}).`,
        )
      }
      return { errors, warnings, approvedSlugs }
    }
    const jdata = await jr.json().catch(() => ({}))
    const results = Array.isArray(jdata.results)
      ? jdata.results
      : jdata.slug
        ? [jdata]
        : []
    const byResult = new Map(
      results.map((r) => [sanitizeSlug(r.slug || '').toLowerCase(), r]),
    )

    for (const c of conflicts) {
      const r = byResult.get(c.slug.toLowerCase())
      if (r?.ok === true) {
        approvedSlugs.push(c.slug)
        continue
      }
      const why = String(r?.rationale || '').trim()
      errors.push(
        `${c.slug}: seed process: entity already exists — do not invent a ` +
          `replacement from scratch. Pull the existing ${c.slug} and merge the ` +
          `sketch’s intended changes into it (keep fields the user did not ask ` +
          `to remove).` +
          (why ? ` Judge: ${why}` : ''),
      )
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    return {
      errors: [],
      warnings: [
        `seed process: could not check existing entities (${err?.message || err})`,
      ],
      approvedSlugs,
    }
  }
  return { errors, warnings, approvedSlugs }
}

/**
 * Run all Seed-tab process validators (after brain).
 * @param {Array<{ slug?: string }>} entities
 * @param {{ sketch?: string, signal?: AbortSignal }} [opts]
 */
async function runSeedProcessValidation(entities, opts = {}) {
  const dup = seedProcessRulesDuplicates(entities)
  const exist = await seedProcessRulesExistingInDb(entities, opts)
  return {
    errors: [...dup.errors, ...exist.errors],
    warnings: [...dup.warnings, ...exist.warnings],
    approvedSlugs: exist.approvedSlugs || [],
  }
}

/**
 * Expand a relation target to Class/id.
 * Prefer a matching draft entity id, then schema domain/range heuristics.
 * @param {string} raw
 * @param {string} relName
 * @param {Record<string, { domain?: string, range?: string }>|null} relDefs
 * @param {Map<string, string>} [idToClass] id-tail → class from this draft set
 */
function expandRelationTarget(raw, relName, relDefs, idToClass) {
  const s = sanitizeSlug(raw || '')
  if (!s) return ''
  if (s.includes('/')) return s
  // Prefer co-drafted entity (bare "northwind" → Franchise/northwind when co-drafted)
  if (idToClass?.has(s)) return sanitizeSlug(`${idToClass.get(s)}/${s}`)
  const def = relDefs?.[relName]
  if (def?.domain && def?.range) {
    // Heuristic: id starts with domain/range name (case-insensitive)
    const low = s.toLowerCase()
    if (low.startsWith(String(def.domain).toLowerCase())) {
      return sanitizeSlug(`${def.domain}/${s}`)
    }
    if (low.startsWith(String(def.range).toLowerCase())) {
      return sanitizeSlug(`${def.range}/${s}`)
    }
    // Default to domain for ownership-style edges (OWNS/LEADER_OF/…) when bare
    return sanitizeSlug(`${def.domain}/${s}`)
  }
  if (def?.range) return sanitizeSlug(`${def.range}/${s}`)
  if (def?.domain) return sanitizeSlug(`${def.domain}/${s}`)
  return s
}

/**
 * Rebuild put_entity-shaped YAML from components + relations so V validates
 * the same graph we display (not a stale LLM bag with bare ids).
 * @param {{ components?: object, relations?: object }} e
 */
function seedEntityToYaml(e) {
  const bag = { ...(e.components || {}) }
  for (const [rel, targets] of Object.entries(e.relations || {})) {
    bag[rel] = targets || []
  }
  return dumpYaml(bag)
}

/** Class name from a draft entity or slug. */
function entityClassOf(e) {
  if (!e) return ''
  if (e.class || e.cls) return String(e.class || e.cls)
  const slug = String(e.slug || '')
  const i = slug.indexOf('/')
  return i > 0 ? slug.slice(0, i) : ''
}

/**
 * Normalize draft seed entities so YAML/V/C stay consistent:
 *  - scrub markdown junk from slugs
 *  - expand bare relation targets with schema range class
 *  - move edges that sit on the wrong domain class onto a domain draft
 *  - rebuild yaml from the cleaned bag (validate sees the same graph)
 * @param {object[]} rawList
 * @param {Record<string, { domain?: string, range?: string }>} relDefs
 */
function normalizeSeedEntities(rawList, relDefs) {
  // Pass 0: resolve id-tail → class from co-drafted entities
  const prelim = (rawList || []).map((e) => {
    const slug = sanitizeSlug(e.slug || '')
    const cls = entityClassOf({ ...e, slug })
    return { ...e, slug, cls, class: cls, id: slugIdLabel(slug) || e.id }
  })
  const idToClass = new Map()
  for (const e of prelim) {
    if (e.id && e.cls) idToClass.set(String(e.id), e.cls)
  }

  // Pass 1: expand bare relation targets using draft id map + schema
  const drafts = prelim.map((e) => {
    const relations = {}
    for (const [rel, targets] of Object.entries(e.relations || {})) {
      const key = String(rel).toUpperCase()
      relations[key] = (targets || [])
        .map((t) => {
          const raw = typeof t === 'string' ? t : t?._to
          return expandRelationTarget(raw || '', key, relDefs, idToClass)
        })
        .filter(Boolean)
    }
    return {
      ...e,
      relations,
      components: e.components || {},
    }
  })

  const bySlug = new Map(drafts.map((e) => [e.slug, e]))

  // Pass 2: relocate edges whose domain ≠ this entity's class
  // e.g. Product.OWNS → Franchise/x  becomes  Franchise/x.OWNS → Product
  for (const e of drafts) {
    const kept = {}
    for (const [rel, targets] of Object.entries(e.relations || {})) {
      const def = relDefs?.[rel]
      if (def?.domain && e.cls && def.domain !== e.cls) {
        for (const t of targets) {
          let domainSlug = null
          if (t.startsWith(`${def.domain}/`)) domainSlug = t
          else {
            for (const o of drafts) {
              if (o.cls === def.domain) {
                domainSlug = o.slug
                break
              }
            }
          }
          const domainEnt = domainSlug ? bySlug.get(domainSlug) : null
          if (!domainEnt) continue
          domainEnt.relations = domainEnt.relations || {}
          domainEnt.relations[rel] = domainEnt.relations[rel] || []
          const out = def.range === e.cls ? e.slug : t
          if (!domainEnt.relations[rel].includes(out)) {
            domainEnt.relations[rel].push(out)
          }
        }
        continue
      }
      kept[rel] = targets
    }
    e.relations = kept
  }

  // Pass 3: rebuild yaml + relation trees (YAML is what V validates)
  return drafts.map((e) => {
    e.yaml = seedEntityToYaml(e)
    e.treeOpen = true // proposed-entity branch expanded by default
    e.relationTree = buildEntityRelationTree(e).map((g) => ({
      ...g,
      open: true,
      targets: (g.targets || []).map((t) => ({
        slug: sanitizeSlug(t.slug),
      })),
    }))
    return e
  })
}

function highlightShorthand(text) {
  return tokenize(text || '')
    .map((s) => {
      const cls = s.type === 'punct' ? 'tk-punct' : `tk-${s.type}`
      return `<span class="${cls}">${esc(s.text)}</span>`
    })
    .join('')
}

function priorityOf(t) {
  if (t?.important && t?.urgent) return 'A'
  if (t?.important) return 'B'
  if (t?.urgent) return 'C'
  return 'D'
}

/** Strip # from tags / ensure array form before UI dump (LLM belt-and-suspenders). */
function sanitizeWorkunitFields(wu) {
  if (!wu || typeof wu !== 'object') return wu
  const out = { ...wu }
  if (out.tags != null) {
    const arr = Array.isArray(out.tags)
      ? out.tags
      : String(out.tags)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
    out.tags = arr.map(tagNorm).filter(Boolean)
  }
  return out
}

/** Quote YAML scalars that would otherwise become comments/structures. */
function formatYamlScalar(v) {
  if (v == null) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  const s = String(v)
  // Leading # would start a YAML comment — always quote such strings
  if (
    !s ||
    /^[#&*!|>%@`]/.test(s) ||
    /[:{}\[\],]/.test(s) ||
    /^\s|\s$/.test(s) ||
    s === 'true' ||
    s === 'false' ||
    s === 'null' ||
    s === '~'
  ) {
    return JSON.stringify(s)
  }
  return s
}

function dumpYaml(obj) {
  const lines = []
  for (const [k, v] of Object.entries(obj || {})) {
    if (k === k.toUpperCase() && Array.isArray(v)) {
      if (!v.length) lines.push(`${k}: []`)
      else {
        lines.push(`${k}:`)
        for (const item of v) lines.push(`  - ${formatYamlScalar(item)}`)
      }
    } else if (typeof v === 'object' && v && !Array.isArray(v)) {
      lines.push(`${k}:`)
      for (const [fk, fv] of Object.entries(v)) {
        if (typeof fv === 'string' && fv.includes('\n')) {
          lines.push(`  ${fk}: |`)
          for (const pl of fv.split('\n')) lines.push(`    ${pl}`)
        } else if (Array.isArray(fv)) {
          if (!fv.length) lines.push(`  ${fk}: []`)
          else {
            lines.push(`  ${fk}:`)
            for (const item of fv) {
              // tags must never keep a leading # in authoritative YAML
              const val = fk === 'tags' ? tagNorm(item) : item
              if (fk === 'tags' && !val) continue
              lines.push(`    - ${formatYamlScalar(val)}`)
            }
          }
        } else if (typeof fv === 'boolean' || typeof fv === 'number') {
          lines.push(`  ${fk}: ${fv}`)
        } else if (fv == null) {
          /* omit */
        } else {
          lines.push(`  ${fk}: ${formatYamlScalar(fv)}`)
        }
      }
    }
  }
  return lines.join('\n') + '\n'
}

function parseSimpleYaml(text) {
  const lines = String(text || '').split(/\n/)
  const root = {}
  const stack = [{ indent: -1, obj: root }]
  let i = 0
  const coerce = (v) => {
    if (v === 'true') return true
    if (v === 'false') return false
    if (v === 'null') return null
    if (/^-?\d+$/.test(v)) return parseInt(v, 10)
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      return v.slice(1, -1)
    return v
  }
  while (i < lines.length) {
    const raw = lines[i]
    if (!raw.trim() || raw.trim().startsWith('#')) {
      i++
      continue
    }
    const indent = (raw.match(/^(\s*)/) || ['', ''])[1].length
    const trimmed = raw.trim()
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1]
    if (trimmed.endsWith(': |') || trimmed.endsWith(':|')) {
      const key = trimmed.replace(/:\s*\|$/, '').trim()
      const collected = []
      i++
      while (i < lines.length) {
        const c = lines[i]
        const ci = (c.match(/^(\s*)/) || ['', ''])[1].length
        if (c.trim() && ci <= indent) break
        collected.push(c.slice(indent + 2))
        i++
      }
      parent.obj[key] = collected.join('\n')
      continue
    }
    if (/^[A-Za-z_][\w]*:\s*$/.test(trimmed) || /^[A-Z][A-Z0-9_]*:\s*$/.test(trimmed)) {
      const key = trimmed.slice(0, -1).trim()
      const next = lines[i + 1]
      const nextIndent = next ? (next.match(/^(\s*)/) || ['', ''])[1].length : indent
      if (next && next.trim().startsWith('- ') && nextIndent > indent) {
        parent.obj[key] = []
        stack.push({ indent, obj: parent.obj[key] })
      } else {
        parent.obj[key] = {}
        stack.push({ indent, obj: parent.obj[key] })
      }
      i++
      continue
    }
    if (trimmed.startsWith('- ')) {
      if (Array.isArray(parent.obj)) parent.obj.push(coerce(trimmed.slice(2).trim()))
      i++
      continue
    }
    const m = trimmed.match(/^([A-Za-z_][\w]*|[A-Z][A-Z0-9_]*):\s*(.*)$/)
    if (m) {
      const key = m[1]
      const val = m[2]
      if (val === '[]') parent.obj[key] = []
      else if (val === '') {
        parent.obj[key] = {}
        stack.push({ indent, obj: parent.obj[key] })
      } else parent.obj[key] = coerce(val)
      i++
      continue
    }
    i++
  }
  return root
}

/** Debounce for non-NL work (YAML validate, etc.) */
const DEBOUNCE_MS = 1000
/** Debounce for Section A → LLM inference (WorkUnits + Seed) */
const NL_DEBOUNCE_MS = 2000

/** @type {(() => void) | null} */
let _unsubMentionMenu = null
/** @type {ReturnType<typeof setTimeout> | null} */
let seedTimer = null
/** Invalidate stale seed preview responses */
let seedGen = 0
/** @type {AbortController | null} */
let seedAbort = null
/** Debounce timers for brain validate */
let seedValidateTimer = null
let wuValidateTimer = null
let entityValidateTimer = null
/**
 * Last Section A fingerprint that scheduled NL (WorkUnits / Seed).
 * Whitespace / punctuation / case-only edits share the same key and do not
 * re-trigger debounce or cancel in-flight inference.
 */
let lastNlSignificantKey = ''
let lastSeedSignificantKey = ''

/**
 * Case-insensitive alphanumeric-only key (all other chars stripped).
 * Used so minor whitespace/punctuation tweaks do not re-fire NL debounce.
 * @param {string} text
 */
function nlSignificantKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

/** Brain connectivity errors — shown via LED tooltip, not topbar error strip. */
function isBrainDownMessage(msg) {
  const m = String(msg || '')
  return /no brain server running|Start one first:\s*brain server start|stale .*\.lock|ECONNREFUSED/i.test(
    m,
  )
}
/**
 * Cap auto redrives from validation → NL (avoids infinite fix loops).
 * Virtuous cycle: LLM → validate → (if errors non-empty AND changed) LLM → …
 * Stops when valid/empty, when error text is unchanged, or at this cap.
 */
const MAX_VALIDATE_REDRIVES = 8
/** localStorage key for unsaved New WorkUnit English draft (cleared on Save). */
const LS_PANE_A = 'tasks.draft.paneA'
const LS_PANE_B = 'tasks.draft.paneB'
const LS_PANE_D = 'tasks.draft.paneD'
const LS_DRAFT = 'tasks.draft.draft'
const LS_DIRTY = 'tasks.draft.dirty'
const LS_CLARIFY = 'tasks.draft.clarifyingQuestions'
const LS_PENDING = 'tasks.draft.pendingEntities'
const LS_LAYOUT = 'tasks.layout.v1'
/** Schema tree expand map + last browse path (selection). */
const LS_SCHEMA = 'tasks.schema.v1'
/**
 * Seed tab draft (A description + last B/V/C preview). Survives refresh/HMR
 * until Save or explicit clear — same lifetime idea as WorkUnits draft.
 * Shape: { text, lockedSlug, previewYaml, summary, entities, validationText,
 *          validationValid, validationLastFed }
 * Layout (row heights, B|V width) lives in LS_LAYOUT — not the draft blob.
 */
const LS_SEED = 'tasks.seed.v1'
/**
 * Cached brain validation feedback keyed by entity slug.
 * { [slug]: { yaml: string, text: string, valid: boolean, at: number } }
 * Only refreshed when the user edits YAML (not on first load / navigation).
 */
const LS_VALIDATION = 'tasks.validation.v1'
const VALIDATION_CACHE_MAX = 80

const LAYOUT_DEFAULTS = {
  sidebarWidth: 260,
  rowA: 1.1,
  rowD: 1.0,
  rowB: 1.2,
  /** B · YAML vs V · Validation column fr (WorkUnits + Seed share) */
  bvYaml: 1.4,
  bvVal: 0.85,
  /** Seed page row fr (A description / B+V yaml row / C summary) */
  seedRowIn: 1.1,
  seedRowYaml: 1.4,
  seedRowSum: 1.0,
}
const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 560
const ROW_MIN_FR = 0.35
/** Min fr for B or V column when dragging the B|V gutter */
const BV_MIN_FR = 0.45

/** @type {ReturnType<typeof setTimeout> | null} */
let nlTimer = null
/** Bumped on clear-A / new parse / cancel so in-flight LLM results are ignored. */
let nlGen = 0
/** @type {AbortController | null} cancels in-flight /nl/parse → AGL agent.abort */
let nlAbort = null
/** When true, onPaneAInput only mirrors DOM → store (no scheduleNlParse). */
let suppressPaneANl = false
/** When true, seed A wiki composer sync only mirrors DOM → store (no LLM). */
let suppressSeedNl = false
/** Radial debounce countdown UI tick (WorkUnits + Seed Section A) */
/** @type {ReturnType<typeof setInterval> | null} */
let nlDebounceTick = null

function lsGet(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function lsSet(key, val) {
  try {
    if (val == null || val === '') localStorage.removeItem(key)
    else localStorage.setItem(key, val)
  } catch {
    /* private mode / quota */
  }
}

function lsGetJson(key) {
  const raw = lsGet(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

/** @returns {Record<string, { yaml: string, text: string, valid: boolean, at: number }>} */
function readValidationCache() {
  const raw = lsGetJson(LS_VALIDATION)
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/**
 * Read cached validation for slug when it was computed for the same YAML body.
 * @param {string} slug
 * @param {string} yaml
 * @returns {{ text: string, valid: boolean } | null}
 */
function getCachedValidation(slug, yaml) {
  if (!slug) return null
  const entry = readValidationCache()[slug]
  if (!entry || typeof entry !== 'object') return null
  if (String(entry.yaml ?? '') !== String(yaml ?? '')) return null
  return {
    text: String(entry.text ?? ''),
    valid: entry.valid !== false,
  }
}

/**
 * Persist validation result for a slug+yaml pair (user-triggered validate only).
 * @param {string} slug
 * @param {string} yaml
 * @param {string} text
 * @param {boolean} valid
 */
function putCachedValidation(slug, yaml, text, valid) {
  if (!slug) return
  const all = readValidationCache()
  all[slug] = {
    yaml: String(yaml ?? ''),
    text: String(text ?? ''),
    valid: valid !== false,
    at: Date.now(),
  }
  // Prune oldest when over cap
  const keys = Object.keys(all)
  if (keys.length > VALIDATION_CACHE_MAX) {
    keys
      .map((k) => ({ k, at: all[k]?.at || 0 }))
      .sort((a, b) => a.at - b.at)
      .slice(0, keys.length - VALIDATION_CACHE_MAX)
      .forEach(({ k }) => {
        delete all[k]
      })
  }
  try {
    lsSet(LS_VALIDATION, JSON.stringify(all))
  } catch {
    /* quota */
  }
}

export const store = M.store('tasks', {
  // routing
  route: '/',
  routeParams: {},

  // chrome
  status: '',
  error: '',
  loading: false,
  saving: false,
  /** Pending fetch / entity-ws depth — top net-activity bar when > 0 */
  netPending: 0,
  /**
   * Brain server liveness (WebSocket /__brain_ws — push on change).
   * 'unknown' | 'ok' | 'down'
   */
  brainStatus: 'unknown',
  /** Tooltip / title for the brain status LED */
  brainStatusDetail: 'Connecting to brain status…',
  brainStatusCheckedAt: 0,

  // git
  git: null,
  gitLoading: false,
  gitDialog: false,
  gitMessage: '',
  gitBusy: false,

  // workunits page
  tasks: [],
  selectedId: null,
  paneA: '',
  paneB: '',
  paneBHtml: '',
  paneD: '',
  paneDHtml: '',
  draft: null,
  dirty: false,
  undoRing: [],
  /** @type {Array<{id:number,text:string,answer:string}>} */
  clarifyingQuestions: [],
  /** Staged entities to create on Save (from microagent stage_entity / pending_entities_json) */
  pendingEntities: [],
  translating: false,
  /** Human-readable phase for the status bar during NL */
  translatePhase: '',
  /**
   * Section A NL debounce countdown (WorkUnits + Seed).
   * Active from schedule until timer fires / is cancelled — radial pie + seconds.
   */
  nlDebounceActive: false,
  /** Whole seconds remaining (ceil), for center label */
  nlDebounceSec: 0,
  /** Fraction of total delay still remaining (1 → 0) for pie fill */
  nlDebounceFrac: 0,
  nlDebounceUntil: 0,
  nlDebounceTotalMs: NL_DEBOUNCE_MS,
  /** WorkUnit B · V — brain validate feedback */
  wuValidationText: '',
  wuValidationValid: true,
  wuValidationBusy: false,
  /** Last validation text fed into NL (redrive only when this changes) */
  wuValidationLastFed: '',
  wuValidateRedrives: 0,
  /** WorkUnit delete dialog */
  deleteWorkUnitDialog: false,
  deleteWorkUnitError: '',
  workUnitDeleting: false,

  // resizable layout (persisted separately from draft — LS_LAYOUT)
  sidebarWidth: LAYOUT_DEFAULTS.sidebarWidth,
  rowA: LAYOUT_DEFAULTS.rowA,
  rowD: LAYOUT_DEFAULTS.rowD,
  rowB: LAYOUT_DEFAULTS.rowB,
  /** B|V column fr (shared WorkUnits + Seed) */
  bvYaml: LAYOUT_DEFAULTS.bvYaml,
  bvVal: LAYOUT_DEFAULTS.bvVal,
  /** Seed A / B+V / C row fr */
  seedRowIn: LAYOUT_DEFAULTS.seedRowIn,
  seedRowYaml: LAYOUT_DEFAULTS.seedRowYaml,
  seedRowSum: LAYOUT_DEFAULTS.seedRowSum,
  _resizing: false,

  // browse
  schemaTree: null,
  browseClass: null,
  /** @deprecated prefer classEntities(cls) — kept in sync for active class */
  browseEntities: [],
  /** Per-class entity lists so multiple tree branches can stay expanded */
  browseEntitiesByClass: {},
  entity: null,
  entityYaml: '',
  entityDirty: false,
  entityDeleting: false,
  deleteEntityDialog: false,
  deleteEntityTarget: null, // { slug, label, cls }
  deleteEntityError: '',
  /** Schema entity YAML · V (user-facing only; no auto redrive) */
  entityValidationText: '',
  entityValidationValid: true,
  entityValidationBusy: false,
  /**
   * Collapsible relation tree groups (Brain Viz inspector style).
   * Each: { key, rel, dir: 'out'|'in', arrow, open, targets: [{ slug }] }
   * Split into out/in so x-for binds stable arrays (not filter() each redraw).
   */
  entityRelations: [],
  entityRelationsOut: [],
  entityRelationsIn: [],
  entityComponentsJson: '',
  _entityLabels: {},
  _labelTick: 0,
  expandedClasses: {},
  /** Last Schema URL (`/browse`, `/browse/Class`, `/browse/Class/id`) — localStorage */
  lastSchemaPath: '/browse',
  classDefHtml: '',

  // seed / create-entity draft
  seedText: '',
  seedBusy: false,
  seedSaving: false,
  /**
   * Slugs the merge-judge approved for overwrite on Save (exist in DB but
   * proposal is a safe intentional update). Cleared each validate cycle.
   * @type {string[]}
   */
  seedMergeApproved: [],
  seedResult: null,
  seedSummaryHtml: '',
  /** null | Class/id when creating a missing pill target */
  seedLockedSlug: null,
  seedPreviewYaml: '',
  seedPreviewHtml: '',
  /** Seed B · V validation */
  seedValidationText: '',
  seedValidationValid: true,
  seedValidationBusy: false,
  seedValidationLastFed: '',
  seedValidateRedrives: 0,
  /**
   * Last successful Save — stays until full page refresh.
   * { slugs: string[], failed: Array<{ slug, error }>, at: number }
   */
  seedSaved: null,

  // ── derived / template helpers ─────────────────────────────────
  isWorkUnits() {
    return this.route === '/'
  },
  isBrowse() {
    return String(this.route || '').startsWith('/browse')
  },
  isSeed() {
    return this.route === '/seed'
  },
  navClass(path) {
    if (path === '/') return this.route === '/' ? 'nav-link active' : 'nav-link'
    if (path === '/browse')
      return String(this.route || '').startsWith('/browse') ? 'nav-link active' : 'nav-link'
    if (path === '/seed') return this.route === '/seed' ? 'nav-link active' : 'nav-link'
    return 'nav-link'
  },

  /** Href for Schema nav tab (restores last selection). */
  schemaTabHref() {
    const p = this.lastSchemaPath || '/browse'
    return p.startsWith('/browse') ? p : '/browse'
  },
  gitLabel() {
    const g = this.git
    if (!g || g.repo === false) return 'no git'
    if (this.gitLoading) return 'git…'
    if (g.clean) return 'clean'
    const n = g.dirty ?? 0
    return `${n} change${n === 1 ? '' : 's'}`
  },
  gitStatusClass() {
    const g = this.git
    if (!g || g.repo === false) return 'btn small git-status nogit'
    if (g.clean) return 'btn small git-status clean'
    return 'btn small git-status dirty'
  },
  taskRowClass(t) {
    return 'task-row' + (this.selectedId === t.id ? ' selected' : '')
  },
  pri(t) {
    return priorityOf(t)
  },
  /** Class for priority letter color (Vivacious A/B/C/D). */
  priClass(t) {
    const p = String(priorityOf(t) || 'D').toLowerCase()
    return `pri pri-${p}`
  },
  dueShort(t) {
    return t?.due ? String(t.due).slice(0, 10) : ''
  },
  classRowClass(c) {
    const active = this.browseClass === c.name && !this.routeParams?.id
    return 'class-row' + (active ? ' active' : '')
  },
  classNodeClass(c) {
    const active = this.browseClass === c.name && !this.routeParams?.id
    return 'class-node' + (active ? ' active' : '')
  },
  twisty(c) {
    return this.expandedClasses?.[c.name] ? '▾' : '▸'
  },
  isExpanded(c) {
    return !!this.expandedClasses?.[c?.name]
  },
  /** Entity children for a class node (cached; multi-expand safe). */
  classEntities(c) {
    const name = typeof c === 'string' ? c : c?.name
    if (!name) return []
    return (this.browseEntitiesByClass && this.browseEntitiesByClass[name]) || []
  },
  entityNodeClass(ent) {
    const slug = this.entity?.slug
    return 'entity-node' + (slug === ent.slug ? ' active' : '')
  },

  /**
   * Scope for expand/collapse-all:
   *  - null → whole tree (nothing selected)
   *  - ClassName → that class (folder selected, or entity under it)
   * Entity leaves have no further descendants; scope uses their parent class.
   */
  schemaTreeScopeClass() {
    if (this.entity?.cls) return this.entity.cls
    if (this.entity?.slug && String(this.entity.slug).includes('/')) {
      return String(this.entity.slug).split('/')[0]
    }
    if (this.browseClass) return this.browseClass
    return null
  },

  schemaTreeExpandTitle() {
    const scope = this.schemaTreeScopeClass()
    return scope ? `Expand ${scope}` : 'Expand all'
  },

  schemaTreeCollapseTitle() {
    const scope = this.schemaTreeScopeClass()
    return scope ? `Collapse ${scope}` : 'Collapse all'
  },

  /** Class names under expand/collapse scope (today: one level of folders). */
  schemaTreeScopeClassNames() {
    const scope = this.schemaTreeScopeClass()
    const all = (this.schemaTree?.classes || []).map((c) => c.name).filter(Boolean)
    if (!scope) return all
    // Selected class (or parent of selected entity) + only that folder today
    return all.includes(scope) ? [scope] : [scope]
  },

  /** Load entity lists for every currently expanded class (after restore). */
  async prefetchExpandedClassEntities() {
    const exp = this.expandedClasses || {}
    const names = Object.keys(exp).filter((k) => exp[k])
    if (!names.length) return
    await Promise.all(names.map((n) => this.fetchClassEntities(n)))
  },

  /**
   * Fetch entities for a class without changing selection / clearing the entity pane.
   * Used by expand-all so multi-open branches get populated.
   */
  async fetchClassEntities(cls) {
    if (!cls) return []
    // Already fetched (including empty lists) — key presence check
    if (
      this.browseEntitiesByClass &&
      Object.prototype.hasOwnProperty.call(this.browseEntitiesByClass, cls)
    ) {
      return this.browseEntitiesByClass[cls] || []
    }
    try {
      const res = await fetch(`/entities?class=${encodeURIComponent(cls)}`)
      if (!res.ok) throw new Error((await res.json()).error || res.statusText)
      const data = await res.json()
      const list = data.entities || []
      this.browseEntitiesByClass = {
        ...(this.browseEntitiesByClass || {}),
        [cls]: list,
      }
      if (this.browseClass === cls) this.browseEntities = list
      return list
    } catch (err) {
      this.browseEntitiesByClass = {
        ...(this.browseEntitiesByClass || {}),
        [cls]: [],
      }
      if (this.browseClass === cls) this.browseEntities = []
      // Don't stomp the main error banner for bulk expand; log quietly
      console.warn('fetchClassEntities', cls, err)
      return []
    }
  },

  /** Expand all classes in scope (whole tree if nothing selected). */
  async expandSchemaTree() {
    if (!this.schemaTree) await this.loadSchemaTree()
    const names = this.schemaTreeScopeClassNames()
    if (!names.length) return
    const exp = { ...(this.expandedClasses || {}) }
    for (const name of names) exp[name] = true
    this.expandedClasses = exp
    this.persistSchemaState()
    // Load children for every opened folder (parallel, selection-safe)
    await Promise.all(names.map((n) => this.fetchClassEntities(n)))
  },

  /** Collapse all classes in scope (whole tree if nothing selected). */
  collapseSchemaTree() {
    const names = this.schemaTreeScopeClassNames()
    if (!names.length) {
      this.expandedClasses = {}
      this.persistSchemaState()
      return
    }
    const scope = this.schemaTreeScopeClass()
    if (!scope) {
      // Whole tree
      this.expandedClasses = {}
      this.persistSchemaState()
      return
    }
    // Scoped: collapse that class only (future: + descendants)
    const exp = { ...(this.expandedClasses || {}) }
    for (const name of names) exp[name] = false
    this.expandedClasses = exp
    this.persistSchemaState()
  },

  /**
   * Build canonical Schema path from current route/selection.
   * @returns {string}
   */
  schemaPathFromRoute() {
    const r = this.route
    const p = this.routeParams || {}
    if (r === '/browse/:cls/:id' && p.cls != null && p.id != null) {
      return (
        '/browse/' +
        encodeURIComponent(String(p.cls)) +
        '/' +
        encodeURIComponent(String(p.id))
      )
    }
    if (r === '/browse/:cls' && p.cls != null) {
      return '/browse/' + encodeURIComponent(String(p.cls))
    }
    if (r === '/browse') return '/browse'
    // Fallback from entity / browseClass when route not set yet
    if (this.entity?.slug) {
      return (
        '/browse/' +
        String(this.entity.slug)
          .split('/')
          .map(encodeURIComponent)
          .join('/')
      )
    }
    if (this.browseClass) return '/browse/' + encodeURIComponent(this.browseClass)
    return this.lastSchemaPath || '/browse'
  },

  /** Persist expand map + last Schema path to localStorage. */
  persistSchemaState() {
    const path = this.schemaPathFromRoute()
    if (String(this.route || '').startsWith('/browse') || path.startsWith('/browse')) {
      // Prefer live route when on schema; otherwise keep last path unless we
      // intentionally updated via clearSchemaSelection / navigate.
      if (String(this.route || '').startsWith('/browse')) {
        this.lastSchemaPath = path
      }
    }
    lsSet(
      LS_SCHEMA,
      JSON.stringify({
        expanded: this.expandedClasses || {},
        path: this.lastSchemaPath || '/browse',
      }),
    )
  },

  /**
   * Restore expand map + lastSchemaPath from localStorage (call at boot).
   * Does not navigate — path is used by Schema tab / optional restore.
   */
  loadSchemaStateFromStorage() {
    const data = lsGetJson(LS_SCHEMA)
    if (!data || typeof data !== 'object') return
    if (data.expanded && typeof data.expanded === 'object' && !Array.isArray(data.expanded)) {
      this.expandedClasses = { ...data.expanded }
    }
    if (typeof data.path === 'string' && data.path.startsWith('/browse')) {
      this.lastSchemaPath = data.path
    }
  },

  /**
   * Mark a class expanded/collapsed and persist (multi-expand safe).
   * @param {string} cls
   * @param {boolean} open
   */
  setClassExpanded(cls, open) {
    if (!cls) return
    this.expandedClasses = { ...(this.expandedClasses || {}), [cls]: !!open }
    this.persistSchemaState()
  },
  showEntityDetail() {
    return !!(this.entity && this.routeParams?.id)
  },
  showClassDef() {
    return !!(this.browseClass && !this.routeParams?.id)
  },

  // ── chrome actions ─────────────────────────────────────────────
  setStatus(msg) {
    this.status = msg || ''
  },
  setError(msg) {
    const m = msg || ''
    // Brain connectivity → LED + tooltip only (not the topbar error strip)
    if (isBrainDownMessage(m)) {
      this.brainStatus = 'down'
      this.brainStatusDetail = m
      this.error = ''
      return
    }
    this.error = m
  },

  /**
   * Apply a brain_status payload from /__brain_ws (or legacy /health JSON).
   * @param {{ brain?: boolean, ok?: boolean, detail?: string, error?: string }} data
   */
  applyBrainStatus(data) {
    if (!data || typeof data !== 'object') return
    if (data.brain === true || data.ok === true) {
      this.brainStatus = 'ok'
      this.brainStatusDetail = data.detail || 'brain server running'
    } else {
      this.brainStatus = 'down'
      this.brainStatusDetail =
        data.detail || data.error || 'no brain server running'
      if (isBrainDownMessage(this.error)) this.error = ''
    }
    this.brainStatusCheckedAt = Date.now()
  },

  /**
   * One-shot HTTP fallback (debug / before WS connects). Prefer startBrainStatusWs.
   */
  async refreshBrainStatus() {
    try {
      const res = await fetch('/health', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      this.applyBrainStatus(data)
    } catch (err) {
      this.brainStatus = 'down'
      this.brainStatusDetail = String(err.message || err)
      this.brainStatusCheckedAt = Date.now()
    }
  },

  /**
   * Persistent WebSocket for brain liveness. Server pushes on sock/lock change;
   * client marks down immediately if the WS itself drops (tasks web gone).
   */
  startBrainStatusWs() {
    if (typeof WebSocket === 'undefined') {
      void this.refreshBrainStatus()
      return
    }
    // HMR / re-boot: close prior socket
    try {
      this._brainStatusWs?.close?.()
    } catch {
      /* ignore */
    }
    this._brainStatusWs = null
    if (this._brainStatusReconnectTimer) {
      clearTimeout(this._brainStatusReconnectTimer)
      this._brainStatusReconnectTimer = null
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/__brain_ws`
    let ws
    try {
      ws = new WebSocket(url)
    } catch (err) {
      this.brainStatus = 'down'
      this.brainStatusDetail = String(err.message || err)
      this._scheduleBrainStatusReconnect()
      return
    }
    this._brainStatusWs = ws
    this.brainStatus = 'unknown'
    this.brainStatusDetail = 'Connecting to brain status…'

    ws.addEventListener('open', () => {
      // Server sends snapshot on open; also request refresh for races
      try {
        ws.send(JSON.stringify({ type: 'refresh' }))
      } catch {
        /* ignore */
      }
    })
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (msg?.type === 'brain_status') this.applyBrainStatus(msg)
    })
    ws.addEventListener('close', () => {
      if (this._brainStatusWs === ws) this._brainStatusWs = null
      this.brainStatus = 'down'
      this.brainStatusDetail =
        'tasks web status socket disconnected — reconnecting…'
      this.brainStatusCheckedAt = Date.now()
      this._scheduleBrainStatusReconnect()
    })
    ws.addEventListener('error', () => {
      // close will fire and schedule reconnect
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    })
  },

  _scheduleBrainStatusReconnect() {
    if (this._brainStatusReconnectTimer) return
    this._brainStatusReconnectTimer = setTimeout(() => {
      this._brainStatusReconnectTimer = null
      this.startBrainStatusWs()
    }, 1500)
  },

  brainStatusClass() {
    const s = this.brainStatus || 'unknown'
    return {
      'brain-status': true,
      'is-ok': s === 'ok',
      'is-down': s === 'down',
      'is-unknown': s === 'unknown',
    }
  },

  brainStatusTitle() {
    const s = this.brainStatus || 'unknown'
    const d = String(this.brainStatusDetail || '').trim()
    if (s === 'ok') return d || 'Brain server: online'
    if (s === 'down') return d || 'Brain server: offline'
    return d || 'Brain server: connecting…'
  },

  /** Error text for topbar — suppress brain-down noise (LED covers it). */
  topbarError() {
    if (isBrainDownMessage(this.error)) return ''
    return String(this.error || '')
  },

  async refreshGit() {
    this.gitLoading = true
    try {
      const res = await fetch('/git/status')
      this.git = await res.json()
    } catch (err) {
      this.git = { ok: false, repo: false, error: String(err.message || err) }
    } finally {
      this.gitLoading = false
    }
  },

  openGitDialog() {
    if (this.git?.repo === false) {
      this.setError(this.git.error || 'no git repo in db/')
      return
    }
    this.gitDialog = true
    this.gitMessage = ''
    void this.refreshGit()
  },
  closeGitDialog() {
    this.gitDialog = false
  },
  async commitSnapshot() {
    this.gitBusy = true
    this.error = ''
    try {
      const res = await fetch('/git/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: this.gitMessage || 'snapshot' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      this.git = data.status || (await (await fetch('/git/status')).json())
      this.gitDialog = false
      this.gitMessage = ''
      this.status = data.committed
        ? `committed: ${data.message}`
        : data.reason || 'nothing to commit'
    } catch (err) {
      this.error = String(err.message || err)
    } finally {
      this.gitBusy = false
    }
  },

  /**
   * Select-none in the schema tree: clear class/entity selection, keep expand state.
   * Expand/collapse-all then apply to the whole tree.
   */
  clearSchemaSelection() {
    this.browseClass = null
    this.browseEntities = []
    this.classDefHtml = ''
    this.entity = null
    this.entityYaml = ''
    this.entityDirty = false
    this.entityRelations = []
    this.entityRelationsOut = []
    this.entityRelationsIn = []
    this.entityComponentsJson = ''
    this.error = ''
    this.status = 'schema'
    this.lastSchemaPath = '/browse'
    this.persistSchemaState()
    // URL must match select-none so refresh / expand scope stay consistent
    if (String(this.route || '').startsWith('/browse') && this.route !== '/browse') {
      this.navigate('/browse')
    } else {
      this.route = '/browse'
      this.routeParams = {}
    }
  },

  // ── routing side-effects (called from app.js) ──────────────────
  /**
   * Apply URL → store. Keeps the SPA shell mounted; only patches fields.
   * Skips network when the target view is already loaded (tab switch back).
   * @param {string} route
   * @param {object} params
   * @param {{ force?: boolean }} [opts]
   */
  async onRoute(route, params, opts = {}) {
    const p = params || {}
    const force = !!opts.force
    const prevRoute = this.route
    const prevCls = this.routeParams?.cls
    const prevId = this.routeParams?.id
    const sameView =
      prevRoute === route &&
      String(prevCls || '') === String(p.cls || '') &&
      String(prevId || '') === String(p.id || '')

    // Patch route for x-show / nav — single assignment when possible
    if (!sameView) {
      this.route = route
      this.routeParams = p
    }

    if (route === '/') {
      if (this.tasks?.length && !force) {
        // Tab switch back: list already in memory; soft refresh in background
        void this.loadTasks({ soft: true })
      } else {
        await this.loadTasks()
      }
      return
    }

    if (route === '/seed') {
      // Schema helps re-normalize relation trees when restoring entities
      if (!this.schemaTree) await this.loadSchemaTree()
      // Restore A/B/V/C draft from localStorage (no LLM re-run)
      this.restoreSeedFromStorage()
      return
    }

    if (route === '/browse') {
      if (!this.schemaTree) await this.loadSchemaTree()
      if (this.browseClass || this.entity) {
        this.browseClass = null
        this.browseEntities = []
        this.classDefHtml = ''
        this.entity = null
        this.entityYaml = ''
        this.entityDirty = false
        this.entityRelations = []
        this.entityRelationsOut = []
        this.entityRelationsIn = []
        this.entityComponentsJson = ''
      }
      if (this.lastSchemaPath !== '/browse') {
        this.lastSchemaPath = '/browse'
        this.persistSchemaState()
      }
      return
    }

    if (route === '/browse/:cls') {
      const cls = p.cls
      if (!this.schemaTree) await this.loadSchemaTree()
      const already =
        !force &&
        this.browseClass === cls &&
        this.classEntities(cls).length > 0
      if (already) {
        if (this.entity) {
          this.entity = null
          this.entityYaml = ''
          this.entityDirty = false
          this.entityRelations = []
          this.entityRelationsOut = []
          this.entityRelationsIn = []
          this.entityComponentsJson = ''
          this.refreshClassDef(cls)
        }
        this.lastSchemaPath = this.schemaPathFromRoute()
        this.persistSchemaState()
        return
      }
      await this.loadClassEntities(cls)
      this.lastSchemaPath = this.schemaPathFromRoute()
      this.persistSchemaState()
      return
    }

    if (route === '/browse/:cls/:id') {
      const slug = `${p.cls}/${p.id}`
      if (!this.schemaTree) await this.loadSchemaTree()
      if (!force && this.entity?.slug === slug) {
        // Tab switch back to the same entity — keep YAML/relations in place
        this.browseClass = p.cls
        this.setClassExpanded(p.cls, true)
        this.lastSchemaPath = this.schemaPathFromRoute()
        this.persistSchemaState()
        return
      }
      await this.loadEntity(slug)
      this.lastSchemaPath = this.schemaPathFromRoute()
      this.persistSchemaState()
    }
  },

  // ── workunits ──────────────────────────────────────────────────
  async loadTasks(opts = {}) {
    const soft = !!opts.soft
    if (!soft) this.loading = true
    try {
      const res = await fetch('/tasks')
      if (!res.ok) throw new Error(await res.text())
      this.tasks = await res.json()
    } catch (err) {
      this.error = String(err.message || err)
    } finally {
      if (!soft) this.loading = false
    }
  },

  async loadTask(id) {
    this.loading = true
    this.error = ''
    try {
      const res = await fetch(`/task/${encodeURIComponent(id)}`)
      if (!res.ok) throw new Error(await res.text())
      const wu = await res.json()
      this.selectedId = wu.id
      this.dirty = false
      this.paneA = ''
      this.clarifyingQuestions = []
      const workunit = applyComputedCorrelations({
        id: wu.id,
        summary: wu.summary,
        description: wu.description || '',
        important: !!wu.important,
        urgent: !!wu.urgent,
        weight: wu.weight || 0,
        status: wu.status || 'idle',
        worker: wu.worker || null,
        tags: wu.tags || [],
        stakeholders: wu.stakeholders || [],
        due: wu.due || null,
        estimateOptimistic: wu.estimateOptimistic || null,
        estimateLikely: wu.estimateLikely || null,
        estimatePessimistic: wu.estimatePessimistic || null,
        journal: wu.journal || [],
        createdAt: wu.createdAt,
        updatedAt: wu.updatedAt,
      })
      const dependsOn = wu.dependsOn || []
      const body = { workunit, DEPENDS_ON: dependsOn }
      this.setPaneB(dumpYaml(body))
      this.draft = body
      this.wuValidateRedrives = 0
      this.wuValidationLastFed = ''
      // Load path: restore cached V only — no live validate until user edits B
      const r = await fetch('/shorthand/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workunit, dependsOn }),
      })
      const text = r.ok
        ? (await r.json()).text || ''
        : renderShorthand(workunit, { dependsOn })
      this.paneD = text
      this.paneDHtml = highlightShorthand(text)
      this.status = `loaded ${String(wu.id).slice(0, 6)}`
    } catch (err) {
      this.error = String(err.message || err)
    } finally {
      this.loading = false
    }
  },

  hasClarifyingQuestions() {
    return (this.clarifyingQuestions || []).length > 0
  },
  unansweredCount() {
    return (this.clarifyingQuestions || []).filter((q) => !String(q.answer || '').trim())
      .length
  },

  layoutStyle() {
    const w = Math.round(this.sidebarWidth || LAYOUT_DEFAULTS.sidebarWidth)
    return {
      gridTemplateColumns: `${w}px 5px minmax(0, 1fr)`,
    }
  },
  mainStyle() {
    const a = this.rowA || LAYOUT_DEFAULTS.rowA
    const d = this.rowD || LAYOUT_DEFAULTS.rowD
    const b = this.rowB || LAYOUT_DEFAULTS.rowB
    return {
      gridTemplateRows: `minmax(80px, ${a}fr) 5px minmax(60px, ${d}fr) 5px minmax(80px, ${b}fr)`,
    }
  },
  /** B · YAML | V · Validation column grid (WorkUnits + Seed). */
  bvSplitStyle() {
    const y = this.bvYaml || LAYOUT_DEFAULTS.bvYaml
    const v = this.bvVal || LAYOUT_DEFAULTS.bvVal
    return {
      gridTemplateColumns: `minmax(8rem, ${y}fr) 5px minmax(6rem, ${v}fr)`,
    }
  },

  loadLayoutFromStorage() {
    const raw = lsGetJson(LS_LAYOUT)
    if (!raw || typeof raw !== 'object') return
    if (Number.isFinite(raw.sidebarWidth)) {
      this.sidebarWidth = clamp(raw.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX)
    }
    if (Number.isFinite(raw.rowA)) this.rowA = Math.max(ROW_MIN_FR, raw.rowA)
    if (Number.isFinite(raw.rowD)) this.rowD = Math.max(ROW_MIN_FR, raw.rowD)
    if (Number.isFinite(raw.rowB)) this.rowB = Math.max(ROW_MIN_FR, raw.rowB)
    if (Number.isFinite(raw.bvYaml)) this.bvYaml = Math.max(BV_MIN_FR, raw.bvYaml)
    if (Number.isFinite(raw.bvVal)) this.bvVal = Math.max(BV_MIN_FR, raw.bvVal)
    if (Number.isFinite(raw.seedRowIn)) {
      this.seedRowIn = Math.max(ROW_MIN_FR, raw.seedRowIn)
    }
    if (Number.isFinite(raw.seedRowYaml)) {
      this.seedRowYaml = Math.max(ROW_MIN_FR, raw.seedRowYaml)
    }
    if (Number.isFinite(raw.seedRowSum)) {
      this.seedRowSum = Math.max(ROW_MIN_FR, raw.seedRowSum)
    }
  },

  persistLayout() {
    lsSet(
      LS_LAYOUT,
      JSON.stringify({
        sidebarWidth: this.sidebarWidth,
        rowA: this.rowA,
        rowD: this.rowD,
        rowB: this.rowB,
        bvYaml: this.bvYaml,
        bvVal: this.bvVal,
        seedRowIn: this.seedRowIn,
        seedRowYaml: this.seedRowYaml,
        seedRowSum: this.seedRowSum,
      }),
    )
  },

  /**
   * Start dragging the vertical split between sidebar and main.
   * @param {PointerEvent} ev
   */
  startResizeSidebar(ev) {
    ev.preventDefault()
    const startX = ev.clientX
    const startW = this.sidebarWidth
    this._resizing = true
    document.body.classList.add('resizing-col')

    const onMove = (e) => {
      const dx = e.clientX - startX
      this.sidebarWidth = clamp(startW + dx, SIDEBAR_MIN, SIDEBAR_MAX)
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.classList.remove('resizing-col')
      this._resizing = false
      this.persistLayout()
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  },

  /**
   * Start dragging a horizontal split between main rows.
   * @param {'ad'|'db'} which  ad = between A and D, db = between D and B
   * @param {PointerEvent} ev
   */
  startResizeRow(which, ev) {
    ev.preventDefault()
    const main = ev.currentTarget?.closest?.('.main') || document.querySelector('.page-tasks .main')
    if (!main) return
    const startY = ev.clientY
    const startA = this.rowA
    const startD = this.rowD
    const startB = this.rowB
    const totalFr = startA + startD + startB
    const mainH = main.getBoundingClientRect().height || 1
    // 2 gutters × 5px
    const usable = Math.max(1, mainH - 10)
    this._resizing = true
    document.body.classList.add('resizing-row')

    const onMove = (e) => {
      const dy = e.clientY - startY
      const dfr = (dy / usable) * totalFr
      if (which === 'ad') {
        let a = startA + dfr
        let d = startD - dfr
        if (a < ROW_MIN_FR) {
          d -= ROW_MIN_FR - a
          a = ROW_MIN_FR
        }
        if (d < ROW_MIN_FR) {
          a -= ROW_MIN_FR - d
          d = ROW_MIN_FR
        }
        this.rowA = Math.max(ROW_MIN_FR, a)
        this.rowD = Math.max(ROW_MIN_FR, d)
      } else {
        let d = startD + dfr
        let b = startB - dfr
        if (d < ROW_MIN_FR) {
          b -= ROW_MIN_FR - d
          d = ROW_MIN_FR
        }
        if (b < ROW_MIN_FR) {
          d -= ROW_MIN_FR - b
          b = ROW_MIN_FR
        }
        this.rowD = Math.max(ROW_MIN_FR, d)
        this.rowB = Math.max(ROW_MIN_FR, b)
      }
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.classList.remove('resizing-row')
      this._resizing = false
      this.persistLayout()
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  },

  /**
   * Drag the vertical gutter between B · YAML and V · Validation
   * (WorkUnits pane B and Seed yaml row share the same fr pair).
   * @param {PointerEvent} ev
   */
  startResizeBv(ev) {
    ev.preventDefault()
    const host =
      ev.currentTarget?.closest?.('.bv-split') ||
      document.querySelector('.bv-split')
    if (!host) return
    const startX = ev.clientX
    const startYaml = this.bvYaml || LAYOUT_DEFAULTS.bvYaml
    const startV = this.bvVal || LAYOUT_DEFAULTS.bvVal
    const totalFr = startYaml + startV
    const hostW = host.getBoundingClientRect().width || 1
    const usable = Math.max(1, hostW - 5)
    this._resizing = true
    document.body.classList.add('resizing-col')

    const onMove = (e) => {
      const dx = e.clientX - startX
      const dfr = (dx / usable) * totalFr
      let y = startYaml + dfr
      let v = startV - dfr
      if (y < BV_MIN_FR) {
        v -= BV_MIN_FR - y
        y = BV_MIN_FR
      }
      if (v < BV_MIN_FR) {
        y -= BV_MIN_FR - v
        v = BV_MIN_FR
      }
      this.bvYaml = Math.max(BV_MIN_FR, y)
      this.bvVal = Math.max(BV_MIN_FR, v)
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.classList.remove('resizing-col')
      this._resizing = false
      this.persistLayout()
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  },

  /**
   * Restore unsaved draft from localStorage (A / B / D / Q / pending).
   * Lifetime: until WorkUnit is Saved. Survives refresh and HMR.
   */
  restoreDraftFromStorage() {
    const savedA = lsGet(LS_PANE_A)
    const savedB = lsGet(LS_PANE_B)
    const savedD = lsGet(LS_PANE_D)
    const hasA = savedA != null && String(savedA).trim()
    const hasB = savedB != null && String(savedB).trim()
    const hasD = savedD != null && String(savedD).trim()
    if (!hasA && !hasB && !hasD) return false

    this.selectedId = null
    if (hasA) this.paneA = savedA

    const qs = lsGetJson(LS_CLARIFY)
    if (Array.isArray(qs)) this.clarifyingQuestions = qs
    const pe = lsGetJson(LS_PENDING)
    if (Array.isArray(pe)) this.pendingEntities = pe

    const draft = lsGetJson(LS_DRAFT)
    if (draft && typeof draft === 'object') this.draft = draft

    const dirtyRaw = lsGet(LS_DIRTY)
    if (dirtyRaw === '1' || dirtyRaw === 'true') this.dirty = true

    // Prefer stored B/D (authoritative session state). Do NOT deterministically
    // derive B/D from A — those panes are LLM-owned until a translate lands.
    if (hasB) {
      this.setPaneB(savedB)
    }
    if (hasD) {
      this.paneD = savedD
      this.paneDHtml = highlightShorthand(savedD)
    }

    // Avoid re-LLM on hydrate; only significant A edits after restore schedule NL
    lastNlSignificantKey = nlSignificantKey(this.paneA)
    this.status = 'restored unsaved draft'
    return true
  },

  persistDraftToStorage() {
    // Persist full draft until Save clears it.
    lsSet(LS_PANE_A, this.paneA || '')
    lsSet(LS_PANE_B, this.paneB || '')
    lsSet(LS_PANE_D, this.paneD || '')
    lsSet(LS_DIRTY, this.dirty ? '1' : '0')
    try {
      lsSet(LS_CLARIFY, JSON.stringify(this.clarifyingQuestions || []))
      lsSet(LS_PENDING, JSON.stringify(this.pendingEntities || []))
      if (this.draft) lsSet(LS_DRAFT, JSON.stringify(this.draft))
      else lsSet(LS_DRAFT, null)
    } catch {
      /* ignore */
    }
  },

  clearDraftStorage() {
    lsSet(LS_PANE_A, null)
    lsSet(LS_PANE_B, null)
    lsSet(LS_PANE_D, null)
    lsSet(LS_DRAFT, null)
    lsSet(LS_DIRTY, null)
    lsSet(LS_CLARIFY, null)
    lsSet(LS_PENDING, null)
  },

  newTask() {
    this.selectedId = null
    // Prefer restoring an unsaved draft over a blank page (refresh-friendly).
    if (this.restoreDraftFromStorage()) {
      queueMicrotask(() => this.syncPaneADom())
      return
    }
    this.paneA = ''
    this.setPaneB(
      dumpYaml({
        workunit: {
          summary: '',
          status: 'idle',
          important: false,
          urgent: false,
          tags: [],
          stakeholders: [],
        },
        DEPENDS_ON: [],
      }),
    )
    this.setPaneD('')
    this.draft = null
    this.dirty = false
    this.clarifyingQuestions = []
    this.pendingEntities = []
    this.translatePhase = ''
    this.status = 'new work-unit'
    queueMicrotask(() => this.syncPaneADom())
  },

  /**
   * Push store.paneA into the contenteditable host as pills + text.
   * Uses mention setEditorText so {{Class/id}} becomes chips (not raw innerText).
   */
  syncPaneADom() {
    const el = document.getElementById('pane-a')
    if (!el) return
    const want = this.paneA || ''
    // Programmatic fill must not look like a user edit (no LLM).
    suppressPaneANl = true
    try {
      if (typeof this._setPaneAEditorText === 'function') {
        this._setPaneAEditorText(want)
      } else {
        el.innerText = want
        el.dataset.empty = want.trim() ? '0' : '1'
      }
    } finally {
      queueMicrotask(() => {
        suppressPaneANl = false
      })
    }
  },

  /**
   * After SPA back to WorkUnits, restore chips if the editor DOM was wiped or
   * drifted from store.paneA (draft is kept in memory + localStorage).
   */
  ensurePaneAHydrated() {
    const el = document.getElementById('pane-a')
    if (!el) return
    const want = this.paneA || ''
    const cur = el.__mentionApi?.getText?.() ?? el.innerText ?? ''
    if (cur !== want) this.syncPaneADom()
    else if (want.trim() && !el.querySelector('a[data-entity]')) {
      // Text present but pills missing (plain text) → re-hydrate chips
      this.syncPaneADom()
    }
  },

  /**
   * Pane A text from the mention editor (wiki-serialized: pills → {{Class/id}}).
   * Prefer this over raw contenteditable input so chips round-trip correctly.
   */
  onPaneAWikiChange(text) {
    this.paneA = text == null ? '' : String(text)
    // Empty A → clear Q / D / B immediately (no LLM)
    if (!String(this.paneA).trim()) {
      lastNlSignificantKey = ''
      this.cancelNlParse('a-cleared')
      this.clearDerivedPanes()
      this.clearDraftStorage()
      this.status = ''
      this.error = ''
      this.translating = false
      this.translatePhase = ''
      return
    }
    // Restore / programmatic sync of A must not trigger LLM.
    if (suppressPaneANl) {
      this.persistDraftToStorage()
      return
    }
    // Persist exact text always; only schedule NL when alnum fingerprint changes
    this.persistDraftToStorage()
    const sig = nlSignificantKey(this.paneA)
    if (sig && sig === lastNlSignificantKey) {
      // Whitespace / punctuation / case-only tweak — keep chain, no re-LLM
      return
    }
    lastNlSignificantKey = sig
    // Typing supersedes any queued or in-flight NL (AGL cancel via fetch abort)
    this.cancelNlParse('typing')
    // Fresh significant A text → allow a new validation-redrive budget
    this.wuValidateRedrives = 0
    this.wuValidationLastFed = ''
    // B / D / Q are LLM-owned — do not deterministically preview from A.
    // They stay empty (or stale until apply) until runNlParse finishes.
    this.scheduleNlParse()
  },

  /** @deprecated use onPaneAWikiChange — kept for any residual @input wiring */
  onPaneAInput(ev) {
    const el = ev?.target
    // Prefer mention serializer if bound
    if (el?.__mentionApi) {
      this.onPaneAWikiChange(el.__mentionApi.getText())
      return
    }
    this.onPaneAWikiChange(el?.innerText || el?.textContent || '')
  },

  /** Clear Q, D, B and related draft state derived from A (deterministic). */
  clearDerivedPanes() {
    this.setPaneB('')
    this.setPaneD('')
    this.draft = null
    this.dirty = false
    this.clarifyingQuestions = []
    this.pendingEntities = []
    this.undoRing = []
    this.wuValidationText = ''
    this.wuValidationValid = true
    this.wuValidationLastFed = ''
    this.wuValidateRedrives = 0
  },

  /**
   * Paint dual-layer YAML highlight into a pre, mirror textarea scroll.
   * Matches m-js-docs `paint`/`sync`. Do not bind the pre with x-html —
   * reactive redraws desync the caret.
   */
  paintYamlEditor(preId, taId, src) {
    const pre = document.getElementById(preId)
    const ta = taId ? document.getElementById(taId) : null
    if (!pre) return
    pre.innerHTML = highlightYaml(String(src ?? '') + '\n')
    if (ta) {
      pre.scrollTop = ta.scrollTop
      pre.scrollLeft = ta.scrollLeft
    }
  },

  /**
   * Paint YAML highlight into #pane-b-hl and mirror textarea scroll.
   */
  paintPaneBHighlight() {
    this.paintYamlEditor('pane-b-hl', 'pane-b-input', this.paneB)
  },

  /** Schema entity YAML dual-layer editor. */
  paintEntityYamlHighlight() {
    this.paintYamlEditor('entity-yaml-hl', 'entity-yaml-input', this.entityYaml)
  },

  /**
   * Set pane B text + paint highlight (external / LLM / undo / load).
   * Does NOT call brain validate — load/restore only show localStorage cache.
   * User typing goes through onPaneBInput → scheduleWuValidate.
   */
  setPaneB(text) {
    this.paneB = text == null ? '' : String(text)
    this.paneBHtml = highlightYaml(this.paneB)
    // After m.js may apply :value on the textarea, paint + sync
    queueMicrotask(() => this.paintPaneBHighlight())
    requestAnimationFrame(() => this.paintPaneBHighlight())
    this.restoreWuValidationFromCache()
  },

  setPaneD(text) {
    this.paneD = text || ''
    this.paneDHtml = highlightShorthand(this.paneD)
  },

  /** Textarea is the only scroller; mirror onto the highlight <pre>. */
  onPaneBScroll(ev) {
    const pre = document.getElementById('pane-b-hl')
    const ta = ev?.target
    if (!pre || !ta) return
    pre.scrollTop = ta.scrollTop
    pre.scrollLeft = ta.scrollLeft
  },

  onEntityYamlScroll(ev) {
    const pre = document.getElementById('entity-yaml-hl')
    const ta = ev?.target
    if (!pre || !ta) return
    pre.scrollTop = ta.scrollTop
    pre.scrollLeft = ta.scrollLeft
  },

  onPaneBInput(ev) {
    // Update store + paint in place (like m-js-docs input → paint → sync).
    // Avoid full setPaneB path that races with :value re-bind mid-keystroke.
    const val = ev.target.value
    this.paneB = val
    this.paneBHtml = highlightYaml(val)
    this.paintPaneBHighlight()
    this.dirty = true
    this.persistDraftToStorage()
    void this.parseYamlPane()
    // Only user edits of B enqueue a live /validate (not load / restore)
    this.scheduleWuValidate()
  },

  /** Answer a clarifying question by stable id — never renumbered. */
  onClarifyingAnswer(id, ev) {
    const val = ev?.target?.value ?? ''
    const list = (this.clarifyingQuestions || []).map((q) =>
      Number(q.id) === Number(id) ? { ...q, answer: val } : q,
    )
    this.clarifyingQuestions = list
    this.persistDraftToStorage()
    // Q answers always re-run LLM (even if B was hand-edited); NL_DEBOUNCE_MS
    this.scheduleNlParse({ force: true })
  },

  /**
   * Drop queued NL timer and abort in-flight /nl/parse (AGL + LM Studio).
   * @param {string} [reason]
   */
  cancelNlParse(reason = 'superseded') {
    clearTimeout(nlTimer)
    nlTimer = null
    this.clearNlDebounceUi()
    if (nlAbort) {
      try {
        nlAbort.abort(reason)
      } catch {
        /* ignore */
      }
      nlAbort = null
    }
    // Invalidate any late apply of a cancelled run
    nlGen += 1
    this.translating = false
    this.translatePhase = ''
  },

  /**
   * Start radial debounce countdown (ms until LLM is enqueued).
   * @param {number} [ms]
   */
  startNlDebounceUi(ms = NL_DEBOUNCE_MS) {
    const total = Math.max(1, Math.floor(Number(ms) || NL_DEBOUNCE_MS))
    this.nlDebounceTotalMs = total
    this.nlDebounceUntil = Date.now() + total
    this.nlDebounceActive = true
    this._tickNlDebounceUi()
    if (nlDebounceTick) clearInterval(nlDebounceTick)
    nlDebounceTick = setInterval(() => this._tickNlDebounceUi(), 50)
  },

  /** @private */
  _tickNlDebounceUi() {
    if (!this.nlDebounceActive) return
    const left = (this.nlDebounceUntil || 0) - Date.now()
    if (left <= 0) {
      this.clearNlDebounceUi()
      return
    }
    // 2.0s → "2", 1.01s → "2", 1.0s → "1", 0.05s → "1"
    this.nlDebounceSec = Math.max(1, Math.ceil(left / 1000))
    const total = this.nlDebounceTotalMs || NL_DEBOUNCE_MS
    this.nlDebounceFrac = Math.max(0, Math.min(1, left / total))
  },

  clearNlDebounceUi() {
    if (nlDebounceTick) {
      clearInterval(nlDebounceTick)
      nlDebounceTick = null
    }
    this.nlDebounceActive = false
    this.nlDebounceSec = 0
    this.nlDebounceFrac = 0
    this.nlDebounceUntil = 0
  },

  /**
   * Inline style for donut-ring cooldown (remaining arc).
   * Clock-like: 0deg = 12 o'clock (north). Elapsed track grows clockwise from
   * 12 so the remaining accent always meets the top — starts and ends at 12.
   */
  nlDebouncePieStyle() {
    const remaining = Math.max(0, Math.min(100, (this.nlDebounceFrac || 0) * 100))
    const elapsed = 100 - remaining
    const track = 'color-mix(in srgb, var(--ink-600) 85%, transparent)'
    return {
      // from 0deg = 12 o'clock (CSS conic north); track then accent
      background: `conic-gradient(from 0deg, ${track} 0 ${elapsed}%, var(--accent) 0)`,
    }
  },

  /**
   * @param {{ force?: boolean, fromValidation?: boolean }} [opts]
   *   force=true ignores dirty (Q answers / validation redrive)
   *   fromValidation=true includes <validation-feedback> in the NL prompt
   */
  scheduleNlParse(opts = {}) {
    clearTimeout(nlTimer)
    nlTimer = null
    if (!String(this.paneA || '').trim()) {
      this.clearNlDebounceUi()
      return
    }
    if (this.dirty && !opts.force) {
      this.clearNlDebounceUi()
      return
    }
    // @-mention menu open → wait until pick/dismiss (suggest load can take seconds)
    if (isMentionMenuOpen() && !opts.force) {
      this.clearNlDebounceUi()
      this._nlPendingWhileMention = {
        force: !!opts.force,
        fromValidation: !!opts.fromValidation,
      }
      this._seedPendingWhileMention = null
      return
    }
    this._nlPendingWhileMention = null
    const force = !!opts.force
    const fromValidation = !!opts.fromValidation
    this.startNlDebounceUi(NL_DEBOUNCE_MS)
    nlTimer = setTimeout(() => {
      this.clearNlDebounceUi()
      void this.runNlParse({ force, fromValidation })
    }, NL_DEBOUNCE_MS)
  },

  retranslate() {
    this.dirty = false
    this.cancelNlParse('retranslate')
    void this.runNlParse({ force: true })
  },

  /**
   * Merge server clarifying questions into local list.
   * Preserve answers by id; keep prior question text; append only new ids.
   */
  mergeClarifyingFromServer(fromServer) {
    const prior = this.clarifyingQuestions || []
    const byId = new Map()
    for (const q of prior) {
      byId.set(Number(q.id), {
        id: Number(q.id),
        text: String(q.text || ''),
        answer: q.answer != null ? String(q.answer) : '',
      })
    }
    for (const q of fromServer || []) {
      const id = Number(q.id)
      if (!Number.isFinite(id) || id <= 0) continue
      if (byId.has(id)) {
        // stable: do not overwrite text or answer from model
        continue
      }
      byId.set(id, {
        id,
        text: String(q.text || '').trim(),
        answer: '',
      })
    }
    this.clarifyingQuestions = [...byId.values()].sort((a, b) => a.id - b.id)
    this.persistDraftToStorage()
  },

  /**
   * @param {{ force?: boolean, fromValidation?: boolean }} [opts]
   */
  async runNlParse(opts = {}) {
    if (this.dirty && !opts.force) return
    const text = this.paneA
    if (!String(text).trim()) return
    // Debounce finished — hand off to LLM spinner
    this.clearNlDebounceUi()
    // Supersede any prior in-flight parse (queue depth = 1: latest only)
    if (nlAbort) {
      try {
        nlAbort.abort('superseded parse')
      } catch {
        /* ignore */
      }
      nlAbort = null
    }
    const ac = new AbortController()
    nlAbort = ac
    const gen = ++nlGen
    this.translating = true
    this.translatePhase = 'llm'
    this.status = 'waiting on LLM (lookup + extract)…'
    try {
      this.pushUndo(this.paneB)
      // Snapshot answers at request time (include any just-typed Q answers)
      const clarifyingSnapshot = (this.clarifyingQuestions || []).map((q) => ({
        id: q.id,
        text: q.text,
        answer: q.answer || '',
      }))
      const now = new Date()
      const res = await fetch('/nl/parse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          today: now.toISOString().slice(0, 10),
          nowLong: now.toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            timeZoneName: 'short',
          }),
          existing: this.draft?.workunit || null,
          clarifyingQuestions: clarifyingSnapshot,
          pendingEntities: this.pendingEntities || [],
          latestShorthand: this.paneD || '',
          latestYaml: this.paneB || '',
          // Only feed validation when redriving from V (or explicit redrive)
          validationFeedback:
            opts.fromValidation && this.wuValidationText
              ? this.wuValidationText
              : '',
        }),
        signal: ac.signal,
      })
      // A cleared (or a newer parse started) while we were waiting → drop result
      if (gen !== nlGen || !String(this.paneA).trim()) return
      if (!res.ok) throw new Error((await res.json()).error || res.statusText)
      this.translatePhase = 'apply'
      this.status = 'applying result…'
      const data = await res.json()
      if (gen !== nlGen || !String(this.paneA).trim()) return
      // Normalize LLM bag: strip # from tags; recompute correlations from A
      let workunit = sanitizeWorkunitFields({ ...(data.workunit || {}) })
      workunit = applyComputedCorrelations(workunit, this.paneA || '')
      const dependsOn = data.dependsOn || []
      // Force-driven Q reparse overwrites hand-edits of B (user asked for LLM to apply answers)
      if (opts.force) this.dirty = false
      this.setPaneB(dumpYaml({ workunit, DEPENDS_ON: dependsOn }))
      this.draft = { workunit, DEPENDS_ON: dependsOn }
      this.mergeClarifyingFromServer(data.clarifyingQuestions || [])
      if (Array.isArray(data.pendingEntities)) {
        this.pendingEntities = data.pendingEntities
      }
      const rr = await fetch('/shorthand/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workunit, dependsOn }),
        signal: ac.signal,
      })
      if (gen !== nlGen || !String(this.paneA).trim()) return
      const textOut = rr.ok ? (await rr.json()).text || '' : ''
      if (gen !== nlGen || !String(this.paneA).trim()) return
      this.setPaneD(textOut)
      this.persistDraftToStorage()
      const u = this.unansweredCount()
      const pe = (this.pendingEntities || []).length
      this.status =
        `translated (${data.source})` +
        (u ? ` · ${u} open question${u === 1 ? '' : 's'}` : '') +
        (pe ? ` · ${pe} staged entit${pe === 1 ? 'y' : 'ies'}` : '') +
        (data.warning ? ' · fallback' : '')
      this.error = ''
      // Validate new YAML; may redrive NL if feedback changes
      await this.runWuValidate({ afterNl: true })
    } catch (err) {
      if (gen !== nlGen) return
      // Superseded by typing / cancel — silent
      if (err?.name === 'AbortError' || ac.signal.aborted) return
      this.error = String(err.message || err)
      this.status = 'translate failed'
    } finally {
      if (nlAbort === ac) nlAbort = null
      if (gen === nlGen) {
        this.translating = false
        this.translatePhase = ''
      }
    }
  },

  /** WorkUnit validation cache key for current draft/selection. */
  wuValidationSlug() {
    const id =
      this.selectedId ||
      this.draft?.workunit?.id ||
      this.draft?.id ||
      'preview'
    return String(id).includes('/') ? String(id) : `WorkUnit/${id}`
  },

  /**
   * Restore V from localStorage for current B YAML (no network).
   * Used on page load / task load / programmatic setPaneB.
   */
  restoreWuValidationFromCache() {
    clearTimeout(wuValidateTimer)
    this.wuValidationBusy = false
    const yamlText = String(this.paneB || '')
    if (!yamlText.trim()) {
      this.wuValidationText = ''
      this.wuValidationValid = true
      return
    }
    const cached = getCachedValidation(this.wuValidationSlug(), yamlText)
    if (cached) {
      this.wuValidationText = cached.text
      this.wuValidationValid = cached.valid
    } else {
      // No matching cache for this YAML — leave V empty until user edits B
      this.wuValidationText = ''
      this.wuValidationValid = true
    }
  },

  /** Debounced brain validate for WorkUnit pane B → V (user input only). */
  scheduleWuValidate() {
    clearTimeout(wuValidateTimer)
    if (!String(this.paneB || '').trim()) {
      this.wuValidationText = ''
      this.wuValidationValid = true
      this.wuValidationBusy = false
      return
    }
    wuValidateTimer = setTimeout(() => void this.runWuValidate(), DEBOUNCE_MS)
  },

  /**
   * If WU V feedback is non-empty and changed → redrive NL with validation XML.
   */
  maybeRedriveWuFromValidation() {
    const text = String(this.wuValidationText || '').trim()
    if (!text) return false
    if (text === this.wuValidationLastFed) return false
    if (this.wuValidateRedrives >= MAX_VALIDATE_REDRIVES) return false
    if (!String(this.paneA || '').trim()) return false
    this.wuValidationLastFed = text
    this.wuValidateRedrives += 1
    this.status = `validation feedback → re-translate (${this.wuValidateRedrives}/${MAX_VALIDATE_REDRIVES})…`
    this.scheduleNlParse({ force: true, fromValidation: true })
    return true
  },

  /**
   * Run brain validate on current WorkUnit YAML and cache the result.
   * When feedback is non-empty and changed since last feed → redrive NL.
   * HTTP failures also redrive (same as structured lint errors).
   * @param {{ afterNl?: boolean }} [opts]
   */
  async runWuValidate(opts = {}) {
    const yamlText = String(this.paneB || '').trim()
    if (!yamlText) {
      this.wuValidationText = ''
      this.wuValidationValid = true
      return
    }
    const slug = this.wuValidationSlug()
    this.wuValidationBusy = true
    try {
      const res = await fetch('/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, content: yamlText }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg =
          data.error || data.message || res.statusText || `HTTP ${res.status}`
        this.wuValidationValid = false
        this.wuValidationText = String(msg)
        putCachedValidation(slug, yamlText, this.wuValidationText, false)
        this.maybeRedriveWuFromValidation()
        return
      }
      const text = formatValidationText(data)
      const valid = data.valid !== false
      this.wuValidationValid = valid
      this.wuValidationText = text
      putCachedValidation(slug, yamlText, text, valid)
      this.maybeRedriveWuFromValidation()
    } catch (err) {
      this.wuValidationValid = false
      this.wuValidationText = `validate error: ${err.message || err}`
      putCachedValidation(slug, yamlText, this.wuValidationText, false)
      this.maybeRedriveWuFromValidation()
    } finally {
      this.wuValidationBusy = false
    }
  },

  /** Clear WorkUnits selection (blank A/B/D, no sidebar highlight). */
  clearWorkUnitSelection() {
    clearTimeout(nlTimer)
    clearTimeout(wuValidateTimer)
    this.selectedId = null
    this.paneA = ''
    this.setPaneB('')
    this.setPaneD('')
    this.draft = null
    this.dirty = false
    this.clarifyingQuestions = []
    this.pendingEntities = []
    this.translatePhase = ''
    this.wuValidationText = ''
    this.wuValidationValid = true
    this.wuValidationLastFed = ''
    this.wuValidateRedrives = 0
    this.clearDraftStorage()
    this.status = 'no selection'
    queueMicrotask(() => this.syncPaneADom())
  },

  openDeleteWorkUnitDialog() {
    if (!this.selectedId) return
    this.deleteWorkUnitError = ''
    this.deleteWorkUnitDialog = true
  },

  closeDeleteWorkUnitDialog() {
    if (this.workUnitDeleting) return
    this.deleteWorkUnitDialog = false
    this.deleteWorkUnitError = ''
  },

  async confirmDeleteWorkUnit() {
    const id = this.selectedId
    if (!id) return
    this.workUnitDeleting = true
    this.deleteWorkUnitError = ''
    this.error = ''
    try {
      const res = await fetch(`/task/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || res.statusText)
      this.deleteWorkUnitDialog = false
      this.clearWorkUnitSelection()
      this.status = `deleted WorkUnit/${String(id).slice(0, 6)}`
      await this.loadTasks()
    } catch (err) {
      this.deleteWorkUnitError = String(err.message || err)
    } finally {
      this.workUnitDeleting = false
    }
  },

  async parseYamlPane() {
    try {
      const draft = parseSimpleYaml(this.paneB)
      const wu = applyComputedCorrelations({ ...(draft.workunit || draft || {}) })
      const dependsOn = draft.DEPENDS_ON || draft.dependsOn || []
      // Keep pane B authoritative but refresh computed correlations into it
      draft.workunit = wu
      this.draft = { workunit: wu, DEPENDS_ON: dependsOn }
      this.setPaneB(dumpYaml({ workunit: wu, DEPENDS_ON: dependsOn }))
      const res = await fetch('/shorthand/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workunit: wu, dependsOn }),
      })
      if (res.ok) {
        const text = (await res.json()).text || ''
        this.setPaneD(text)
      }
      this.persistDraftToStorage()
      this.error = ''
    } catch (err) {
      this.error = `YAML: ${err.message || err}`
    }
  },

  pushUndo(yamlText) {
    const ring = this.undoRing || []
    ring.push(yamlText)
    if (ring.length > 20) ring.shift()
    this.undoRing = ring
  },

  undoYaml() {
    const ring = this.undoRing || []
    if (!ring.length) return
    const prev = ring.pop()
    this.undoRing = ring
    this.setPaneB(prev)
    this.dirty = true
    void this.parseYamlPane()
  },

  async saveDraft() {
    this.saving = true
    this.error = ''
    try {
      await this.parseYamlPane()
      const draft = this.draft || parseSimpleYaml(this.paneB)
      const body = {
        workunit: draft.workunit || draft,
        DEPENDS_ON: draft.DEPENDS_ON || draft.dependsOn || [],
        pendingEntities: this.pendingEntities || [],
      }
      const method = this.selectedId ? 'PATCH' : 'POST'
      const url = this.selectedId
        ? `/task/${encodeURIComponent(this.selectedId)}`
        : '/task'
      this.status = (this.pendingEntities || []).length
        ? 'saving (creating staged entities)…'
        : 'saving…'
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json()).error || res.statusText)
      const wu = await res.json()
      this.selectedId = wu.id
      this.dirty = false
      // Saved → drop local draft so refresh no longer restores this composition
      this.clearDraftStorage()
      this.clarifyingQuestions = []
      this.pendingEntities = []
      const created = wu._persist?.created || []
      this.status =
        `saved ${String(wu.id).slice(0, 6)}` +
        (created.length ? ` · created ${created.join(', ')}` : '')
      await this.loadTasks()
      await this.loadTask(wu.id)
    } catch (err) {
      this.error = String(err.message || err)
    } finally {
      this.saving = false
    }
  },

  // ── browse ─────────────────────────────────────────────────────
  async loadSchemaTree() {
    try {
      const res = await fetch('/schema/tree')
      if (!res.ok) throw new Error((await res.json()).error || res.statusText)
      this.schemaTree = await res.json()
      // Do NOT auto-expand every class. Expanding all made the first click on a
      // row toggle expand→false (looked like “need to double-click to open”).
      // Expand only the active browse class if we already have one.
      // Merge with persisted expand map (do not wipe localStorage state).
      if (this.browseClass) {
        this.expandedClasses = {
          ...(this.expandedClasses || {}),
          [this.browseClass]: true,
        }
        this.persistSchemaState()
      }
    } catch (err) {
      this.error = String(err.message || err)
    }
  },

  async loadClassEntities(cls, { clearEntity = true } = {}) {
    this.browseClass = cls
    // Open this branch; leave other expanded classes alone (multi-expand tree)
    if (cls) {
      this.expandedClasses = { ...(this.expandedClasses || {}), [cls]: true }
      this.persistSchemaState()
    }
    if (clearEntity) {
      this.entity = null
      this.entityYaml = ''
      this.entityDirty = false
      this.entityRelations = []
      this.entityRelationsOut = []
      this.entityRelationsIn = []
      this.entityComponentsJson = ''
      this.entityValidationText = ''
      this.entityValidationValid = true
      this.entityValidationBusy = false
      clearTimeout(entityValidateTimer)
    }
    this.refreshClassDef(cls)
    try {
      const res = await fetch(`/entities?class=${encodeURIComponent(cls)}`)
      if (!res.ok) throw new Error((await res.json()).error || res.statusText)
      const data = await res.json()
      const list = data.entities || []
      // Cache per class so siblings stay populated when another branch is selected
      this.browseEntitiesByClass = {
        ...(this.browseEntitiesByClass || {}),
        [cls]: list,
      }
      this.browseEntities = list
    } catch (err) {
      this.error = String(err.message || err)
      this.browseEntitiesByClass = {
        ...(this.browseEntitiesByClass || {}),
        [cls]: [],
      }
      this.browseEntities = []
    }
  },

  refreshClassDef(clsName) {
    const tree = this.schemaTree
    if (!tree) {
      this.classDefHtml = '<p class="muted">Loading schema…</p>'
      return
    }
    const def = (tree.classes || []).find((c) => c.name === clsName)
    if (!def) {
      this.classDefHtml = `<p class="muted">Unknown class ${esc(clsName)}</p>`
      return
    }
    const comps = tree.components || {}
    const rels = tree.relations || {}
    const related = Object.entries(rels).filter(
      ([, r]) => r.domain === clsName || r.range === clsName,
    )
    const counts = this.relCountsByClass?.[clsName] || null
    const compEntries = Object.entries(def.components || {})

    // ── Header: title + a single row of labelled facts ──────────────────
    let html = `<header class="cdef-head">`
    html +=
      `<h2 class="cdef-title">${ic('blueprint')}<span>${esc(clsName)}</span>` +
      (def.top ? ` <span class="badge" title="seed class for ontology traversal">top</span>` : '') +
      `</h2>`
    html += `<div class="cdef-facts">`
    html +=
      `<span class="cdef-fact">${ic('stack')}` +
      `<b class="cdef-fact-v">${def.count}</b>` +
      `<span class="cdef-fact-k">${def.count === 1 ? 'entity' : 'entities'}</span></span>`
    if (def.idField) {
      html +=
        `<span class="cdef-fact" title="the field this class's slug is derived from">${ic('key')}` +
        `<span class="cdef-fact-k">id</span>` +
        `<code class="cdef-fact-v">${esc(def.idField)}</code></span>`
    }
    if (def.displayField) {
      html +=
        `<span class="cdef-fact" title="the field shown as this entity's human label">${ic('tag')}` +
        `<span class="cdef-fact-k">label</span>` +
        `<code class="cdef-fact-v">${esc(def.displayField)}</code></span>`
    }
    html += `</div></header>`

    // ── Components ──────────────────────────────────────────────────────
    html += `<section class="cdef-section">`
    html +=
      `<h3 class="cdef-h">${ic('diamonds-four')}<span>Components</span>` +
      `<span class="cdef-h-count">${compEntries.length}</span></h3>`
    if (!compEntries.length) {
      html += `<p class="cdef-empty">${ic('tray')}This class composes no components.</p>`
    }
    for (const [alias, compName] of compEntries) {
      const fields = Object.entries(comps[compName]?.fields || {})
      html += `<article class="comp-card">`
      html +=
        `<div class="comp-card-head">${ic('diamonds-four')}` +
        `<span class="comp-alias">${esc(alias)}</span>` +
        `<span class="comp-sep">:</span>` +
        `<span class="comp-type">${esc(compName)}</span>` +
        `<span class="comp-fieldcount">${fields.length} ${fields.length === 1 ? 'field' : 'fields'}</span>` +
        `</div>`
      html += `<ul class="field-grid">`
      for (const [fn, fd] of fields) html += fieldRowHtml(fn, fd)
      html += `</ul></article>`
    }
    html += `</section>`

    // ── Relations ───────────────────────────────────────────────────────
    html += `<section class="cdef-section">`
    html +=
      `<h3 class="cdef-h">${ic('graph')}<span>Relations</span>` +
      `<span class="cdef-h-count">${related.length}</span></h3>`
    if (!related.length) {
      html += `<p class="cdef-empty">${ic('tray')}No relations involve this class.</p>`
    } else {
      html += `<ul class="rel-defs">`
      for (const [name, r] of related) {
        const domainHere = r.domain === clsName
        const rangeHere = r.range === clsName
        const [dirIcon, dirLabel, dirKind] =
          domainHere && !rangeHere
            ? ['ph-arrow-right', 'outgoing', 'out']
            : rangeHere && !domainHere
              ? ['ph-arrow-left', 'incoming', 'in']
              : ['ph-arrows-left-right', 'both directions', 'both']
        // The circle is a COUNT of edges that exist, not the cardinality —
        // same meaning it carries in every other relation tree in the app.
        // `counts` non-null means the tally has ARRIVED; a relation missing
        // from it genuinely has zero edges, and must render 0 rather than
        // sitting on the pending marker forever.
        const n = counts ? counts[name] || 0 : null
        const countCell =
          n == null
            ? `<span class="rel-def-count is-pending" title="counting…">·</span>`
            : `<span class="rel-def-count${n ? '' : ' is-zero'}" title="${n} relationship${n === 1 ? '' : 's'} of this type touch ${esc(clsName)}">${n}</span>`
        const qualifiers = Object.entries(r.qualifiers || {})
        html +=
          `<li class="rel-def" data-dir="${dirKind}">` +
          `<div class="rel-def-head">` +
          `<i class="ph-bold rel-def-dir ${dirIcon}" role="img" aria-label="${dirLabel}"></i>` +
          `<span class="rel-def-name">${esc(name)}</span>` +
          countCell +
          `</div>` +
          `<div class="rel-def-sig">` +
          endpointHtml(r.domain, clsName) +
          `<i class="ph-bold ph-arrow-right rel-sig-arrow" aria-hidden="true"></i>` +
          endpointHtml(r.range, clsName) +
          `<span class="rel-card" title="cardinality (${esc(r.cardinality || '?')})">${esc(CARDINALITY[r.cardinality] || r.cardinality || 'unspecified')}</span>` +
          `</div>`
        if (qualifiers.length) {
          html += `<ul class="field-grid is-qualifiers">`
          html += `<li class="field-grid-label">${ic('sliders-horizontal')}qualifiers</li>`
          for (const [qn, qd] of qualifiers) html += fieldRowHtml(qn, qd)
          html += `</ul>`
        }
        html += `</li>`
      }
      html += `</ul>`
    }
    html += `</section>`
    this.classDefHtml = html
    this.ensureRelCounts(clsName)
  },

  /**
   * Fetch live per-relation edge counts for a class, once, then re-render.
   * Non-blocking: the definition paints immediately and the counters fill in.
   */
  async ensureRelCounts(clsName) {
    if (!clsName) return
    this.relCountsByClass = this.relCountsByClass || {}
    this.relCountsPending = this.relCountsPending || {}
    if (this.relCountsByClass[clsName] || this.relCountsPending[clsName]) return
    this.relCountsPending[clsName] = true
    try {
      const res = await fetch('/schema/relcounts?class=' + encodeURIComponent(clsName))
      if (!res.ok) return
      const body = await res.json()
      this.relCountsByClass = {
        ...this.relCountsByClass,
        [clsName]: body.counts || {},
      }
      if (this.browseClass === clsName) this.refreshClassDef(clsName)
    } catch {
      /* counters are decoration — never break the page over them */
    } finally {
      delete this.relCountsPending[clsName]
    }
  },

  async loadEntity(slug) {
    this.loading = true
    try {
      const url = '/entity/' + String(slug).split('/').map(encodeURIComponent).join('/')
      const res = await fetch(url)
      if (!res.ok) {
        // Missing entity → Seed create draft (not a red error)
        const errBody = await res.json().catch(() => ({}))
        const missing =
          res.status === 404 ||
          /not found|no such|unknown/i.test(String(errBody.error || ''))
        if (missing) {
          this.beginSeedCreate(slug)
          // SPA navigate to Seed; keep history so Back works
          this.navigate('/seed')
          return
        }
        throw new Error(errBody.error || res.statusText)
      }
      const ent = await res.json()
      // Capture before overwrite — only restore collapse state when reloading same entity
      const prevEntitySlug = this.entity?.slug
      this.entity = ent
      this.setEntityYaml(ent.yaml || '')
      this.entityDirty = false
      this.browseClass = ent.cls
      // Expand the class in the tree so the active entity row is visible
      this.expandedClasses = { ...(this.expandedClasses || {}), [ent.cls]: true }
      this.persistSchemaState()
      // No status line for select — slug is already in the entity header
      this.status = ''
      this.entityComponentsJson = JSON.stringify(ent.components || {}, null, 2)
      // First open / switch entity → expand all relation edges (1st-degree targets visible).
      // Same-entity reload (e.g. after Save) → keep which edges the user collapsed.
      const sameEntity = prevEntitySlug === ent.slug
      const prevOpen =
        sameEntity && (this.entityRelations || []).length > 0
          ? new Set(
              (this.entityRelations || [])
                .filter((g) => g.open)
                .map((g) => g.key),
            )
          : null
      const tree = buildEntityRelationTree(ent, prevOpen)
      // Always expand first level when landing on a different entity
      if (!sameEntity) {
        for (const g of tree) g.open = true
      }
      this.entityRelations = tree
      this.entityRelationsOut = tree.filter((g) => g.dir === 'out')
      this.entityRelationsIn = tree.filter((g) => g.dir === 'in')
      // Prefetch all 1st-degree target labels (groups open by default)
      void this.prefetchEntityLabels(
        tree.flatMap((g) => (g.targets || []).map((t) => t.slug)).slice(0, 64),
      )
      // V pane: restore localStorage cache only — no live validate on load
      this.restoreEntityValidationFromCache()
      await this.loadClassEntities(ent.cls, { clearEntity: false })
    } catch (err) {
      this.error = String(err.message || err)
    } finally {
      this.loading = false
    }
  },

  /** Set by app.js boot — SPA history push without circular import. */
  navigate(path) {
    if (typeof this._navigate === 'function') this._navigate(path)
    else if (typeof location !== 'undefined') location.assign(path)
  },

  /**
   * Open existing entity in Schema, or start Seed create-draft if missing.
   * Used by entity pills / wiki links.
   */
  async openEntityOrSeed(slug) {
    const s = String(slug || '').trim()
    if (!s) return
    try {
      this.persistDraftToStorage?.()
    } catch {
      /* ignore */
    }
    this.loading = true
    this.error = ''
    try {
      const url = '/entity/' + s.split('/').map(encodeURIComponent).join('/')
      const res = await fetch(url)
      if (res.ok) {
        this.navigate('/browse/' + s)
        return
      }
      // Missing → seed create flow with locked slug
      this.beginSeedCreate(s)
      this.navigate('/seed')
    } catch (err) {
      // Network blip → still offer create draft
      this.beginSeedCreate(s)
      this.navigate('/seed')
      if (!this.seedLockedSlug) this.error = String(err.message || err)
    } finally {
      this.loading = false
    }
  },

  onEntityYamlInput(ev) {
    this.entityYaml = ev.target.value
    this.entityDirty = true
    this.paintEntityYamlHighlight()
    // Only user keystrokes enqueue a live /validate
    this.scheduleEntityValidate()
  },

  /**
   * Programmatic YAML set (load / save response). No network validate —
   * restores V from localStorage cache when yaml matches a prior user check.
   */
  setEntityYaml(text) {
    this.entityYaml = text == null ? '' : String(text)
    // Paint after m.js may insert the dual-layer editor (x-show entity detail)
    const paint = () => this.paintEntityYamlHighlight()
    queueMicrotask(paint)
    requestAnimationFrame(() => {
      paint()
      requestAnimationFrame(paint)
    })
    this.restoreEntityValidationFromCache()
  },

  /**
   * Restore V from localStorage for current entity+YAML (no network).
   * First page load / navigation uses this only.
   */
  restoreEntityValidationFromCache() {
    clearTimeout(entityValidateTimer)
    this.entityValidationBusy = false
    const slug = this.entity?.slug
    const yaml = String(this.entityYaml || '')
    if (!slug || !yaml.trim()) {
      this.entityValidationText = ''
      this.entityValidationValid = true
      return
    }
    const cached = getCachedValidation(slug, yaml)
    if (cached) {
      this.entityValidationText = cached.text
      this.entityValidationValid = cached.valid
    } else {
      this.entityValidationText = ''
      this.entityValidationValid = true
    }
  },

  /** Debounce brain validate for Schema entity YAML (user edits only). */
  scheduleEntityValidate() {
    clearTimeout(entityValidateTimer)
    if (!this.entity?.slug || !String(this.entityYaml || '').trim()) {
      this.entityValidationText = ''
      this.entityValidationValid = true
      this.entityValidationBusy = false
      return
    }
    entityValidateTimer = setTimeout(() => void this.runEntityValidate(), DEBOUNCE_MS)
  },

  async runEntityValidate() {
    const slug = this.entity?.slug
    const content = String(this.entityYaml || '')
    if (!slug || !content.trim()) {
      this.entityValidationText = ''
      this.entityValidationValid = true
      return
    }
    this.entityValidationBusy = true
    try {
      const res = await fetch('/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, content }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || res.statusText)
      // Drop if user navigated away mid-flight
      if (this.entity?.slug !== slug) return
      // Drop if YAML changed again while request was in flight
      if (String(this.entityYaml || '') !== content) return
      const text = formatValidationText(data)
      const valid = data.valid !== false
      this.entityValidationValid = valid
      this.entityValidationText = text
      putCachedValidation(slug, content, text, valid)
    } catch (err) {
      if (this.entity?.slug === slug && String(this.entityYaml || '') === content) {
        this.entityValidationValid = false
        this.entityValidationText = `validate error: ${err.message || err}`
        putCachedValidation(slug, content, this.entityValidationText, false)
      }
    } finally {
      this.entityValidationBusy = false
    }
  },

  async saveEntity() {
    if (!this.entity) return
    this.saving = true
    this.error = ''
    try {
      const url = '/entity/' + this.entity.slug.split('/').map(encodeURIComponent).join('/')
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ yaml: this.entityYaml }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      this.entity = data
      this.setEntityYaml(data.yaml || this.entityYaml)
      this.entityDirty = false
      this.status = `saved ${data.slug}`
      await this.loadClassEntities(data.cls, { clearEntity: false })
    } catch (err) {
      this.error = String(err.message || err)
    } finally {
      this.saving = false
    }
  },

  openDeleteEntityDialog() {
    const ent = this.entity
    if (!ent?.slug) return
    this.deleteEntityTarget = {
      slug: ent.slug,
      label: ent.label || ent.id || ent.slug,
      cls: ent.cls || String(ent.slug).split('/')[0],
    }
    this.deleteEntityError = ''
    this.deleteEntityDialog = true
  },

  closeDeleteEntityDialog() {
    if (this.entityDeleting) return
    this.deleteEntityDialog = false
    this.deleteEntityTarget = null
    this.deleteEntityError = ''
  },

  /**
   * Confirm delete → DELETE /entity/:slug, clear detail, refresh class list,
   * navigate to class detail (or schema root).
   */
  async confirmDeleteEntity() {
    const target = this.deleteEntityTarget
    const slug = target?.slug
    if (!slug) return
    this.entityDeleting = true
    this.deleteEntityError = ''
    this.error = ''
    try {
      const url = '/entity/' + String(slug).split('/').map(encodeURIComponent).join('/')
      const res = await fetch(url, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || res.statusText || `HTTP ${res.status}`)

      const cls = target.cls || String(slug).split('/')[0]
      // Drop from per-class cache
      const by = { ...(this.browseEntitiesByClass || {}) }
      if (by[cls]) {
        by[cls] = by[cls].filter((e) => e.slug !== slug)
        this.browseEntitiesByClass = by
      }
      if (this.browseClass === cls) {
        this.browseEntities = (this.browseEntities || []).filter((e) => e.slug !== slug)
      }
      // Clear open detail if it was this entity
      if (this.entity?.slug === slug) {
        this.entity = null
        this.entityYaml = ''
        this.entityDirty = false
        this.entityRelations = []
        this.entityRelationsOut = []
        this.entityRelationsIn = []
        this.entityComponentsJson = ''
      }

      this.deleteEntityDialog = false
      this.deleteEntityTarget = null
      this.status = `deleted ${slug}`

      // Invalidate class cache; navigate to class detail (onRoute reloads list + counts)
      if (cls) {
        const next = { ...(this.browseEntitiesByClass || {}) }
        delete next[cls]
        this.browseEntitiesByClass = next
        this.navigate(`/browse/${encodeURIComponent(cls)}`)
      } else {
        this.navigate('/browse')
      }
    } catch (err) {
      this.deleteEntityError = String(err.message || err)
      this.error = String(err.message || err)
      this.status = 'delete failed'
    } finally {
      this.entityDeleting = false
    }
  },

  // ── seed ───────────────────────────────────────────────────────
  isSeedCreateMode() {
    return !!this.seedLockedSlug
  },

  /**
   * Open Seed create-mode for a missing Class/id.
   * Slug is stored separately (read-only chip); user only types a free description.
   * Class/id are forced after LLM — not stuffed into the textarea.
   */
  beginSeedCreate(slug) {
    const s = String(slug || '').trim()
    if (!s || !s.includes('/')) return
    this.seedLockedSlug = s
    this.seedResult = null
    this.seedSummaryHtml = ''
    this.seedPreviewYaml = ''
    this.seedPreviewHtml = ''
    this.seedValidationText = ''
    this.seedValidationValid = true
    this.error = ''
    // Empty composer — user describes the entity; locked slug is UI chrome only
    this.seedText = ''
    this.status = `create ${s}`
    this.persistSeedToStorage()
    queueMicrotask(() => this.syncSeedADom())
  },

  clearSeedCreateMode() {
    this.seedLockedSlug = null
    this.seedResult = null
    this.seedSummaryHtml = ''
    this.seedPreviewYaml = ''
    this.seedPreviewHtml = ''
    this.persistSeedToStorage()
  },

  seedLockedClass() {
    const s = this.seedLockedSlug || ''
    const i = s.indexOf('/')
    return i > 0 ? s.slice(0, i) : ''
  },
  seedLockedId() {
    const s = this.seedLockedSlug || ''
    const i = s.indexOf('/')
    return i >= 0 ? s.slice(i + 1) : s
  },

  seedMainStyle() {
    const a = this.seedRowIn || LAYOUT_DEFAULTS.seedRowIn
    const b = this.seedRowYaml || LAYOUT_DEFAULTS.seedRowYaml
    const c = this.seedRowSum || LAYOUT_DEFAULTS.seedRowSum
    return {
      gridTemplateRows: `minmax(100px, ${a}fr) 5px minmax(100px, ${b}fr) 5px minmax(80px, ${c}fr)`,
    }
  },

  /**
   * Drag Seed horizontal splits (A↔B+V or B+V↔C). Persists to LS_LAYOUT
   * (independent of draft content — survives empty A / after Save).
   * @param {'in-yaml'|'yaml-sum'} which
   * @param {PointerEvent} ev
   */
  startResizeSeedRow(which, ev) {
    ev.preventDefault()
    const main =
      ev.currentTarget?.closest?.('.seed-layout') ||
      document.querySelector('.page-seed .seed-layout')
    if (!main) return
    const startY = ev.clientY
    const a0 = this.seedRowIn || LAYOUT_DEFAULTS.seedRowIn
    const d0 = this.seedRowYaml || LAYOUT_DEFAULTS.seedRowYaml
    const b0 = this.seedRowSum || LAYOUT_DEFAULTS.seedRowSum
    const totalFr = a0 + d0 + b0
    const mainH = main.getBoundingClientRect().height || 1
    const usable = Math.max(1, mainH - 10)
    this._resizing = true
    document.body.classList.add('resizing-row')

    const onMove = (e) => {
      const dy = e.clientY - startY
      const dfr = (dy / usable) * totalFr
      if (which === 'in-yaml') {
        let a = a0 + dfr
        let d = d0 - dfr
        if (a < ROW_MIN_FR) {
          d -= ROW_MIN_FR - a
          a = ROW_MIN_FR
        }
        if (d < ROW_MIN_FR) {
          a -= ROW_MIN_FR - d
          d = ROW_MIN_FR
        }
        this.seedRowIn = Math.max(ROW_MIN_FR, a)
        this.seedRowYaml = Math.max(ROW_MIN_FR, d)
      } else if (which === 'yaml-sum') {
        let d = d0 + dfr
        let b = b0 - dfr
        if (d < ROW_MIN_FR) {
          b -= ROW_MIN_FR - d
          d = ROW_MIN_FR
        }
        if (b < ROW_MIN_FR) {
          d -= ROW_MIN_FR - b
          b = ROW_MIN_FR
        }
        this.seedRowYaml = Math.max(ROW_MIN_FR, d)
        this.seedRowSum = Math.max(ROW_MIN_FR, b)
      }
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.classList.remove('resizing-row')
      this._resizing = false
      this.persistLayout()
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  },

  /**
   * WorkUnits Save visible when there is YAML (or a draft) to persist.
   * (In-flight `saving` only disables the button — keep it visible for "Saving…".)
   */
  canSaveWorkUnit() {
    if (String(this.paneB || '').trim()) return true
    const wu = this.draft?.workunit || this.draft
    if (wu && typeof wu === 'object') {
      if (String(wu.summary || '').trim()) return true
      if (String(wu.description || '').trim()) return true
      if (wu.id) return true
    }
    return false
  },

  /**
   * Seed Save visible when preview has at least one entity to write.
   * (Busy/saving only disable the button — keep visible while spinning.)
   */
  canSaveSeed() {
    const ents = this.seedResult?.entities
    return Array.isArray(ents) && ents.length > 0
  },

  /**
   * Seed A · Description from the shared wiki/mention composer
   * (pills serialize to {{Class/id}} — same pipeline as WorkUnits pane A).
   */
  onSeedWikiChange(text) {
    this.seedText = text == null ? '' : String(text)
    if (!String(this.seedText || '').trim()) {
      lastSeedSignificantKey = ''
      // Empty A → cancel LLM + wipe B/V/C (+ localStorage), like WorkUnits empty-A
      this.clearSeedDerivedPanes({ keepLocked: true })
      return
    }
    // Programmatic DOM hydrate must not re-trigger LLM
    if (suppressSeedNl) {
      this.persistSeedToStorage()
      return
    }
    // Persist exact A always; only re-LLM when alnum fingerprint changes.
    // B · YAML is NOT cleared on A edit — runSeedPreview still sends latestYaml.
    this.persistSeedToStorage()
    const sig = nlSignificantKey(this.seedText)
    if (sig && sig === lastSeedSignificantKey) {
      // Whitespace / punctuation / case-only — keep B/V chain, no abort/schedule
      return
    }
    lastSeedSignificantKey = sig
    // Significant A change → new redrive budget (exclusion lines live in A if any)
    this.seedValidateRedrives = 0
    this.seedValidationLastFed = ''
    // Typing supersedes queued debounce + in-flight seed LLM (AGL cancel)
    clearTimeout(seedTimer)
    seedTimer = null
    this.abortSeedPreview('typing')
    seedGen += 1
    this._seedRedrivePending = false
    this.seedBusy = false
    this.scheduleSeedParse()
  },

  /** @deprecated use onSeedWikiChange — residual textarea wiring */
  onSeedTextInput(ev) {
    const el = ev?.target
    if (el?.__mentionApi) {
      this.onSeedWikiChange(el.__mentionApi.getText())
      return
    }
    this.onSeedWikiChange(el?.value ?? el?.innerText ?? '')
  },

  /**
   * Push store.seedText into #seed-a as pills + text (shared mention setEditorText).
   */
  syncSeedADom() {
    const el = document.getElementById('seed-a')
    if (!el) return
    const want = this.seedText || ''
    suppressSeedNl = true
    try {
      if (typeof this._setSeedAEditorText === 'function') {
        this._setSeedAEditorText(want)
      } else {
        el.innerText = want
        el.dataset.empty = want.trim() ? '0' : '1'
      }
    } finally {
      queueMicrotask(() => {
        suppressSeedNl = false
      })
    }
  },

  /** After SPA back to Seed, re-hydrate chips if the editor drifted or was wiped. */
  ensureSeedAHydrated() {
    const el = document.getElementById('seed-a')
    if (!el) return
    const want = this.seedText || ''
    const cur = el.__mentionApi?.getText?.() ?? el.innerText ?? ''
    if (cur !== want) this.syncSeedADom()
    else if (want.trim() && !el.querySelector('a[data-entity]')) {
      this.syncSeedADom()
    }
  },

  /**
   * Cancel in-flight / queued seed LLM and clear B · YAML, V · Validation, C · Summary.
   * Mirrors WorkUnits clearDerivedPanes when A is emptied.
   * @param {{ keepLocked?: boolean }} [opts] keepLocked: preserve create-mode slug chip
   */
  clearSeedDerivedPanes(opts = {}) {
    clearTimeout(seedTimer)
    seedTimer = null
    clearTimeout(seedValidateTimer)
    seedValidateTimer = null
    this.clearNlDebounceUi()
    this._seedRedrivePending = false
    // Invalidate any in-flight preview (runSeedPreview / redrive / validate)
    seedGen += 1
    this.abortSeedPreview('a-cleared')
    this.seedBusy = false
    this.seedSaving = false
    this.seedMergeApproved = []

    this.seedResult = null
    this.seedSummaryHtml = ''
    this.seedPreviewYaml = ''
    this.seedPreviewHtml = ''
    this.seedValidationText = ''
    this.seedValidationValid = true
    this.seedValidationBusy = false
    this.seedValidationLastFed = ''
    this.seedValidateRedrives = 0
    if (!opts.keepLocked) this.seedLockedSlug = null

    this.error = ''
    this.status = ''
    // Persist: empty A + empty B/V/C → remove LS_SEED (unless lock-only create mode)
    this.persistSeedToStorage()
  },

  /**
   * Persist Seed A + last B/V/C preview to localStorage.
   * Lifetime: until successful Save or clearSeedDraft (survives refresh/HMR).
   */
  persistSeedToStorage() {
    const ents = this.seedResult?.entities || []
    const payload = {
      text: this.seedText || '',
      lockedSlug: this.seedLockedSlug || null,
      previewYaml: this.seedPreviewYaml || '',
      summary: this.seedResult?.summary || '',
      entities: ents.map((e) => ({
        slug: e.slug,
        id: e.id,
        cls: e.cls || e.class,
        class: e.class || e.cls,
        components: e.components || {},
        relations: e.relations || {},
        yaml: e.yaml || '',
        treeOpen: e.treeOpen !== false,
        // relationTree rebuilt on restore
      })),
      validationText: this.seedValidationText || '',
      validationValid: this.seedValidationValid !== false,
      validationLastFed: this.seedValidationLastFed || '',
      at: Date.now(),
    }
    const has =
      String(payload.text).trim() ||
      payload.previewYaml ||
      payload.entities.length ||
      payload.validationText ||
      payload.lockedSlug
    if (!has) {
      lsSet(LS_SEED, null)
      return
    }
    try {
      lsSet(LS_SEED, JSON.stringify(payload))
    } catch {
      /* quota */
    }
  },

  /**
   * Restore Seed draft from localStorage. Does not re-run LLM.
   * @returns {boolean} true if anything was restored
   */
  restoreSeedFromStorage() {
    const data = lsGetJson(LS_SEED)
    if (!data || typeof data !== 'object') return false

    const text = data.text != null ? String(data.text) : ''
    const previewYaml = data.previewYaml != null ? String(data.previewYaml) : ''
    const entities = Array.isArray(data.entities) ? data.entities : []
    const summary = data.summary != null ? String(data.summary) : ''
    const locked = data.lockedSlug ? String(data.lockedSlug) : null
    const has =
      text.trim() || previewYaml || entities.length || data.validationText || locked
    if (!has) return false

    this.seedText = text
    this.seedLockedSlug = locked
    this.seedPreviewYaml = previewYaml
    this.seedPreviewHtml = previewYaml ? highlightYaml(previewYaml) : ''
    this.seedValidationText =
      data.validationText != null ? String(data.validationText) : ''
    this.seedValidationValid = data.validationValid !== false
    this.seedValidationLastFed =
      data.validationLastFed != null ? String(data.validationLastFed) : ''
    this.seedValidateRedrives = 0 // don't auto-redrive on restore
    // Avoid re-LLM on hydrate; keep B chain until significant A edit
    lastSeedSignificantKey = nlSignificantKey(this.seedText)

    // One-time migration: older drafts embedded row fr — fold into LS_LAYOUT
    let migratedLayout = false
    if (Number.isFinite(data.seedRowIn)) {
      this.seedRowIn = Math.max(ROW_MIN_FR, data.seedRowIn)
      migratedLayout = true
    }
    if (Number.isFinite(data.seedRowYaml)) {
      this.seedRowYaml = Math.max(ROW_MIN_FR, data.seedRowYaml)
      migratedLayout = true
    }
    if (Number.isFinite(data.seedRowSum)) {
      this.seedRowSum = Math.max(ROW_MIN_FR, data.seedRowSum)
      migratedLayout = true
    }
    if (migratedLayout) this.persistLayout()

    if (entities.length || summary) {
      // Re-normalize so relation trees / yaml stay consistent with current helpers
      const relDefs = this.schemaTree?.relations || {}
      const normalized = normalizeSeedEntities(
        entities.map((e) => ({
          ...e,
          class: e.class || e.cls,
          cls: e.cls || e.class,
        })),
        relDefs,
      )
      this.seedResult = {
        summary,
        entities: normalized,
        source: 'restored',
      }
      this.seedSummaryHtml = renderMarkdownHtml(
        String(summary || '').replace(/\*+/g, ''),
      )
      // Prefer stored combined YAML if present; else rebuild from entities
      if (!previewYaml && normalized.length) {
        const blocks = normalized.map((e) => {
          const y = e.yaml || ''
          return `# ${e.slug}\n${y}`.trimEnd()
        })
        this.seedPreviewYaml = blocks.join('\n---\n')
        this.seedPreviewHtml = highlightYaml(this.seedPreviewYaml)
      }
      const slugs = []
      for (const e of normalized) {
        if (e.slug) slugs.push(e.slug)
        for (const g of e.relationTree || []) {
          for (const t of g.targets || []) {
            if (t?.slug) slugs.push(t.slug)
          }
        }
      }
      void this.prefetchEntityLabels(slugs)
    } else {
      this.seedResult = null
      this.seedSummaryHtml = ''
    }

    this.status = 'restored seed draft'
    queueMicrotask(() => this.syncSeedADom())
    return true
  },

  clearSeedStorage() {
    lsSet(LS_SEED, null)
  },

  /**
   * @param {{ fromValidation?: boolean }} [opts]
   */
  scheduleSeedParse(opts = {}) {
    clearTimeout(seedTimer)
    seedTimer = null
    // No LLM while A is empty (also blocks validation redrives that race with clear)
    if (!String(this.seedText || '').trim()) {
      this.clearNlDebounceUi()
      this._seedPendingWhileMention = null
      return
    }
    const fromValidation = !!opts.fromValidation
    // @-mention menu open → hold debounce until pick/dismiss (suggest can take seconds)
    if (isMentionMenuOpen() && !fromValidation) {
      this.clearNlDebounceUi()
      this._seedPendingWhileMention = { fromValidation }
      this._nlPendingWhileMention = null
      return
    }
    this._seedPendingWhileMention = null
    this.startNlDebounceUi(NL_DEBOUNCE_MS)
    seedTimer = setTimeout(() => {
      this.clearNlDebounceUi()
      void this.runSeedPreview({ fromValidation })
    }, NL_DEBOUNCE_MS)
  },

  /**
   * Wire once: when @-mention menu opens, cancel NL debounce; when it closes,
   * restart any pending seed/WU schedule so the user can finish typing.
   */
  installMentionDebounceGuard() {
    if (_unsubMentionMenu) return
    _unsubMentionMenu = onMentionMenuOpenChange(() => {
      if (isMentionMenuOpen()) {
        clearTimeout(nlTimer)
        nlTimer = null
        clearTimeout(seedTimer)
        seedTimer = null
        this.clearNlDebounceUi()
        return
      }
      if (this._seedPendingWhileMention != null) {
        const o = this._seedPendingWhileMention
        this._seedPendingWhileMention = null
        this.scheduleSeedParse(o)
        return
      }
      if (this._nlPendingWhileMention != null) {
        const o = this._nlPendingWhileMention
        this._nlPendingWhileMention = null
        this.scheduleNlParse(o)
      }
    })
  },

  /**
   * Abort any in-flight seed preview (HTTP + AGL/LM Studio via req.signal).
   * Does not clear the debounce timer — callers clear seedTimer when needed.
   */
  abortSeedPreview(reason = 'superseded') {
    if (seedAbort) {
      try {
        seedAbort.abort(reason)
      } catch {
        /* ignore */
      }
      seedAbort = null
    }
  },

  /**
   * Dry-run NL → YAML preview (no DB write).
   * @param {{ fromValidation?: boolean }} [opts]
   */
  async runSeedPreview(opts = {}) {
    // Guard: never LLM while A is empty (WorkUnits same pattern)
    if (!String(this.seedText || '').trim()) {
      this._seedRedrivePending = false
      this.seedBusy = false
      this.clearNlDebounceUi()
      return
    }
    // Debounce finished (or immediate redrive) — hand off to LLM spinner
    this.clearNlDebounceUi()
    // Cancel previous generation so LM Studio is not piled with concurrent runs
    this.abortSeedPreview('superseded preview')
    this._seedRedrivePending = false
    // Need schema relations for bare-target expand + domain fixups
    if (!this.schemaTree) {
      try {
        await this.loadSchemaTree()
      } catch {
        /* validate may still work without expand */
      }
    }
    const ac = new AbortController()
    seedAbort = ac
    const gen = ++seedGen
    this.seedBusy = true
    this.error = ''
    // Keep latestYaml/summary/V in the request body always (see fetch below).
    // Status reflects refine-vs-bootstrap so A-edits with B don't look greenfield.
    const hasDraftYaml = !!String(this.seedPreviewYaml || '').trim()
    this.status = this.seedLockedSlug
      ? `drafting ${this.seedLockedSlug}…`
      : opts.fromValidation
        ? `re-drafting from validation (${this.seedValidateRedrives}/${MAX_VALIDATE_REDRIVES})…`
        : hasDraftYaml
          ? 'refining from A (keeping B draft)…'
          : 'imagining entities…'
    try {
      // Always send last B/V (and summary) so redrives are corrective, not random
      // rewrites — same pattern as WorkUnits latest-yaml / validation-feedback.
      const res = await fetch('/nl/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: this.seedText,
          persist: false,
          lockedSlug: this.seedLockedSlug || undefined,
          latestYaml: this.seedPreviewYaml || '',
          latestSummary: this.seedResult?.summary || '',
          validationFeedback: this.seedValidationText || '',
        }),
        signal: ac.signal,
      })
      let data = null
      try {
        data = await res.json()
      } catch {
        data = { error: res.statusText || 'invalid JSON response' }
      }
      if (gen !== seedGen) return
      if (!res.ok) {
        throw new Error(data?.error || res.statusText || `HTTP ${res.status}`)
      }
      this.applySeedResult(data)
      this.error = ''
      // Always re-validate after every LLM result (initial + each redrive).
      // maybeRedriveSeedFromValidation continues the virtuous cycle when
      // errors are non-empty and different from the last feedback fed.
      await this.runSeedValidate({ gen, allowRedrive: true })
      // If no redrive was scheduled, leave a friendly preview status
      if (
        gen === seedGen &&
        !this.seedValidationText &&
        this.seedResult?.entities?.length
      ) {
        const n = this.seedResult.entities.length
        this.status = `preview ${n} entit${n === 1 ? 'y' : 'ies'}`
      }
    } catch (err) {
      if (gen !== seedGen) return
      // AbortError from superseded preview — not a user-facing failure
      if (err?.name === 'AbortError' || ac.signal.aborted) {
        return
      }
      this.error = String(err.message || err)
      this.status = 'seed preview failed'
    } finally {
      if (seedAbort === ac) seedAbort = null
      // Keep spinner on while a validation redrive is queued
      if (gen === seedGen && !this._seedRedrivePending) {
        this.seedBusy = false
      }
    }
  },

  applySeedResult(data) {
    const relDefs = this.schemaTree?.relations || {}
    const entities = normalizeSeedEntities(data.entities || [], relDefs)
    this.seedResult = { ...data, entities, summary: data.summary || '' }
    // Summary: drop LLM markdown asterisks that leak into ids/prose; chips sanitize too
    this.seedSummaryHtml = renderMarkdownHtml(
      String(data.summary || '').replace(/\*+/g, ''),
    )
    // Combined YAML for multi-entity preview (matches cleaned bags used by V)
    const blocks = entities.map((e) => {
      const y = e.yaml || ''
      return `# ${e.slug}\n${y}`.trimEnd()
    })
    this.seedPreviewYaml = blocks.join('\n---\n')
    this.seedPreviewHtml = highlightYaml(this.seedPreviewYaml)
    // Prefetch labels for draft entities + relation targets (seed pills)
    const slugs = []
    for (const e of entities) {
      if (e.slug) slugs.push(e.slug)
      for (const g of e.relationTree || []) {
        for (const t of g.targets || []) {
          if (t?.slug) slugs.push(t.slug)
        }
      }
    }
    void this.prefetchEntityLabels(slugs)
    this.persistSeedToStorage()
  },

  /**
   * Virtuous cycle step: if V is non-empty AND different from the last text we
   * fed the LLM, schedule another seed NL round with <validation-feedback>.
   * Stops when valid/empty, when errors are unchanged, or at MAX_VALIDATE_REDRIVES.
   * @returns {'redrive'|'valid'|'unchanged'|'limit'|'skip'}
   */
  maybeRedriveSeedFromValidation() {
    // Never redrive while A is empty
    if (!String(this.seedText || '').trim()) {
      this._seedRedrivePending = false
      return 'skip'
    }
    const text = String(this.seedValidationText || '').trim()
    if (!text) {
      if (this.seedValidateRedrives > 0) {
        this.status = 'preview valid after validation redrive'
      }
      return 'valid'
    }
    if (text === this.seedValidationLastFed) {
      this.status = `validation unchanged after redrive — stopped (${this.seedValidateRedrives} redrive${this.seedValidateRedrives === 1 ? '' : 's'})`
      return 'unchanged'
    }
    if (this.seedValidateRedrives >= MAX_VALIDATE_REDRIVES) {
      this.status = `validation still failing — redrive limit (${MAX_VALIDATE_REDRIVES})`
      return 'limit'
    }
    if (!String(this.seedText || '').trim()) return 'skip'
    // Capture feedback for the next LLM call, then schedule redrive
    this.seedValidationLastFed = text
    this.seedValidateRedrives += 1
    this._seedRedrivePending = true
    this.seedBusy = true
    this.status = `validation feedback → re-seed (${this.seedValidateRedrives}/${MAX_VALIDATE_REDRIVES})…`
    clearTimeout(seedTimer)
    this.startNlDebounceUi(150)
    seedTimer = setTimeout(() => {
      this._seedRedrivePending = false
      this.clearNlDebounceUi()
      void this.runSeedPreview({ fromValidation: true })
    }, 150)
    return 'redrive'
  },

  /**
   * Brain-validate all draft seed entities together (forward refs resolve),
   * then append Seed-tab process rules (unique slugs; not already in DB).
   * Always runs after each LLM result; may redrive NL when feedback changes.
   */
  async runSeedValidate(opts = {}) {
    const entities = this.seedResult?.entities || []
    if (!entities.length) {
      this.seedValidationText = ''
      this.seedValidationValid = true
      return
    }
    const payload = entities
      .filter((e) => e.slug && e.yaml)
      .map((e) => ({ slug: e.slug, content: e.yaml }))
    this.seedValidationBusy = true
    if (!opts.silent) this.status = 'validating draft…'
    try {
      let brainText = ''
      let brainValid = true

      if (payload.length) {
        const res = await fetch('/validate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ entities: payload }),
        })
        const data = await res.json().catch(() => ({}))
        // Stale if a newer preview started
        if (opts.gen != null && opts.gen !== seedGen) return
        if (!res.ok) {
          brainValid = false
          brainText = String(
            data.error ||
              data.message ||
              res.statusText ||
              `HTTP ${res.status}`,
          )
        } else {
          brainText = formatValidationText(data)
          brainValid = data.valid !== false && !/^\s*errors:/m.test(brainText)
          // formatValidationText empty + valid true → ok; errors section → invalid
          if (brainText && /^errors:/m.test(brainText)) brainValid = false
        }
      }

      if (opts.gen != null && opts.gen !== seedGen) return

      // Seed-tab process layer (after brain): uniqueness + merge-judge on exists
      const process = await runSeedProcessValidation(entities, {
        sketch: this.seedText || '',
      })
      if (opts.gen != null && opts.gen !== seedGen) return

      this.seedMergeApproved = process.approvedSlugs || []
      const text = mergeSeedValidationText(
        brainText,
        process.errors,
        process.warnings,
      )
      const processOk = !process.errors.length
      this.seedValidationValid = brainValid && processOk
      this.seedValidationText = text
      this.persistSeedToStorage()
      if (opts.allowRedrive !== false) {
        const action = this.maybeRedriveSeedFromValidation()
        if (action === 'valid') {
          const n = entities.length
          const nMerge = this.seedMergeApproved.length
          this.status =
            nMerge > 0
              ? `preview ${n} entit${n === 1 ? 'y' : 'ies'} (${nMerge} merge overwrite ok)`
              : `preview ${n} entit${n === 1 ? 'y' : 'ies'}`
        }
      } else if (!text) {
        const n = entities.length
        this.status = `preview ${n} entit${n === 1 ? 'y' : 'ies'}`
      }
    } catch (err) {
      if (opts.gen != null && opts.gen !== seedGen) return
      // Still try process rules so V is useful offline of brain
      let process = { errors: [], warnings: [], approvedSlugs: [] }
      try {
        process = await runSeedProcessValidation(entities, {
          sketch: this.seedText || '',
        })
      } catch {
        /* ignore */
      }
      this.seedMergeApproved = process.approvedSlugs || []
      const brainMsg = `validate error: ${err.message || err}`
      this.seedValidationValid = false
      this.seedValidationText = mergeSeedValidationText(
        brainMsg,
        process.errors,
        process.warnings,
      )
      this.persistSeedToStorage()
      if (opts.allowRedrive !== false) this.maybeRedriveSeedFromValidation()
    } finally {
      this.seedValidationBusy = false
    }
  },

  /** Wipe A/B/C draft surfaces (text, YAML preview, summary) without touching seedSaved. */
  clearSeedDraft() {
    this.seedText = ''
    this.seedMergeApproved = []
    this.clearSeedDerivedPanes({ keepLocked: false })
    queueMicrotask(() => this.syncSeedADom())
  },

  /** True if slug is one of the current proposed draft entities. */
  seedIsDraftSlug(slug) {
    const s = sanitizeSlug(slug || '')
    if (!s) return false
    return (this.seedResult?.entities || []).some(
      (e) => sanitizeSlug(e.slug) === s,
    )
  },

  /**
   * Trash on Proposed entities: append an exclusion line to A · Description
   * (persists across validation redrives via user-sketch), then redrive LLM.
   * Does NOT strip B/C immediately — removal lands when the redrive finishes.
   */
  seedExcludeEntity(slug) {
    const s = sanitizeSlug(slug || '')
    if (!s) return
    if (!String(this.seedText || '').trim()) return
    const line = `The {{${s}}} entity is wrong; remove it.`
    const cur = String(this.seedText || '')
    // Idempotent: don't stack duplicate lines for the same slug
    if (!cur.includes(line) && !cur.includes(`{{${s}}}`)) {
      this.seedText = cur.replace(/\s+$/, '') + '\n\n' + line
    }
    lastSeedSignificantKey = nlSignificantKey(this.seedText)
    // Show {{Class/id}} as entity chip in the shared composer (no extra NL from sync)
    this.syncSeedADom()
    this.persistSeedToStorage()
    this.status = `excluding ${s}…`
    // Fresh redrive budget for this user-driven correction
    this.seedValidateRedrives = 0
    this.seedValidationLastFed = ''
    // Cancel any in-flight seed LLM so exclude redrive is not stuck behind it
    clearTimeout(seedTimer)
    seedTimer = null
    this.abortSeedPreview('exclude')
    seedGen += 1
    this.startNlDebounceUi(150)
    seedTimer = setTimeout(() => {
      this.clearNlDebounceUi()
      void this.runSeedPreview({ fromExclude: true })
    }, 150)
  },

  /**
   * Persist last previewed entities (no second LLM call).
   * POST /nl/seed/persist → brain put_entity only (overwrite:true).
   * Merge-judge-approved slugs overwrite existing rows in one put_entity each.
   */
  async saveSeed() {
    const ents = this.seedResult?.entities
    if (!ents?.length) {
      this.error = 'Nothing to save — wait for a preview first'
      return
    }
    if (this.seedSaving) return
    this.seedSaving = true
    this.error = ''
    // persistEntities always overwrite:true — merge-judge-approved slugs replace at once
    const nMerge = (this.seedMergeApproved || []).length
    this.status =
      nMerge > 0
        ? `saving entities (${nMerge} overwrite merge)…`
        : 'saving entities…'
    // Align with Bun idleTimeout (30s) — save is put_entity only, should be << 3s.
    const ac = new AbortController()
    const kill = setTimeout(() => ac.abort(), 30000)
    try {
      const res = await fetch('/nl/seed/persist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entities: ents,
          // Server already overwrites; flag is for logs / future selective write
          mergeApproved: this.seedMergeApproved || [],
        }),
        signal: ac.signal,
      })
      let data = null
      try {
        data = await res.json()
      } catch {
        data = { error: res.statusText || 'invalid JSON response' }
      }
      if (!res.ok) throw new Error(data.error || res.statusText)
      const results = data.results || []
      const okRows = results.filter((r) => r.ok && r.slug)
      const failRows = results.filter((r) => !r.ok)
      const okSlugs = okRows.map((r) => r.slug)
      // Prefer server results; fall back to draft slugs if results omit slug
      const savedSlugs =
        okSlugs.length > 0
          ? okSlugs
          : ents.map((e) => e.slug).filter(Boolean)

      if (!savedSlugs.length && failRows.length) {
        this.error =
          failRows.map((r) => `${r.slug || '?'}: ${r.error || 'failed'}`).join('; ') ||
          'save failed'
        this.status = 'seed save failed'
        this.seedResult = { ...this.seedResult, results, persisted: false }
        return
      }

      // Sticky banner until full page refresh (accumulate if user saves again)
      const prev = this.seedSaved?.slugs || []
      const merged = [...new Set([...prev, ...savedSlugs])]
      this.seedSaved = {
        slugs: merged,
        failed: failRows.map((r) => ({
          slug: r.slug || '',
          error: r.error || 'failed',
        })),
        at: Date.now(),
      }

      // Clear A · B · C so the page is ready for the next seed
      this.clearSeedDraft()

      const n = savedSlugs.length
      this.status =
        n === 1
          ? `saved ${savedSlugs[0]}`
          : `saved ${n} entities` +
            (failRows.length ? ` (${failRows.length} failed)` : '')
      // Warm labels for the sticky pills
      void this.prefetchEntityLabels(merged)
    } catch (err) {
      const msg =
        err?.name === 'AbortError'
          ? 'save timed out after 30s (put_entity should be ms with embed:none; check brain/LM Studio)'
          : String(err.message || err)
      this.setError(msg)
      this.status = 'seed save failed'
    } finally {
      clearTimeout(kill)
      this.seedSaving = false
    }
  },

  /** One-shot create (preview + persist) for bulk seed button. */
  async runSeed() {
    if (!String(this.seedText).trim()) {
      this.error = 'Enter a sentence first'
      return
    }
    this.abortSeedPreview('superseded by runSeed')
    const ac = new AbortController()
    seedAbort = ac
    const gen = ++seedGen
    this.seedBusy = true
    this.error = ''
    this.status = 'imagining entities…'
    try {
      const res = await fetch('/nl/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: this.seedText,
          persist: true,
          lockedSlug: this.seedLockedSlug || undefined,
          latestYaml: this.seedPreviewYaml || '',
          latestSummary: this.seedResult?.summary || '',
          validationFeedback: this.seedValidationText || '',
        }),
        signal: ac.signal,
      })
      let data = null
      try {
        data = await res.json()
      } catch {
        data = { error: res.statusText || 'invalid JSON response' }
      }
      if (gen !== seedGen) return
      if (!res.ok) throw new Error(data?.error || res.statusText || `HTTP ${res.status}`)
      this.applySeedResult(data)
      this.error = ''
      const ok = (data.results || []).filter((r) => r.ok).length
      const fail = (data.results || []).filter((r) => !r.ok).length
      this.status = `seeded ${ok} entit${ok === 1 ? 'y' : 'ies'}${fail ? ` (${fail} failed)` : ''}`
    } catch (err) {
      if (gen !== seedGen) return
      if (err?.name === 'AbortError' || ac.signal.aborted) return
      this.error = String(err.message || err)
      this.status = 'seed failed'
    } finally {
      if (seedAbort === ac) seedAbort = null
      if (gen === seedGen) this.seedBusy = false
    }
  },

  seedEntityOk(e) {
    const slug = sanitizeSlug(e?.slug || '')
    const res = (this.seedResult?.results || []).find(
      (r) => r.slug === e.slug || sanitizeSlug(r.slug) === slug,
    )
    return res?.ok !== false
  },
  seedEntityError(e) {
    const slug = sanitizeSlug(e?.slug || '')
    const res = (this.seedResult?.results || []).find(
      (r) => r.slug === e.slug || sanitizeSlug(r.slug) === slug,
    )
    return res && !res.ok ? res.error : ''
  },

  /** Class name for a draft seed entity (badge). */
  seedEntityClass(e) {
    if (!e) return ''
    if (e.class || e.cls) return String(e.class || e.cls)
    const slug = sanitizeSlug(e.slug || '')
    const i = slug.indexOf('/')
    return i > 0 ? slug.slice(0, i) : ''
  },

  /**
   * Human label for a draft entity head pill.
   * Prefer resolved display name; fall back to id tail (Class shown separately).
   */
  seedEntityDisplay(e) {
    void this._labelTick
    if (!e) return ''
    const slug = sanitizeSlug(e.slug || '')
    const cached = this._entityLabels?.[slug] || this._entityLabels?.[e.slug]
    if (cached) return String(cached).replace(/\*+/g, '')
    // Prefer agent-provided name fields when labels not loaded yet
    const comps = e.components || {}
    const naming = comps.naming || comps.identity || comps.info || {}
    if (naming.name) return String(naming.name).replace(/\*+/g, '')
    if (naming.givenName || naming.surname) {
      return [naming.givenName, naming.surname].filter(Boolean).join(' ')
    }
    const s = String(slug)
    const i = s.lastIndexOf('/')
    return i >= 0 ? s.slice(i + 1) : s
  },

  /** Outgoing relation groups for one draft entity. */
  seedRelsOut(e) {
    return (e?.relationTree || []).filter((r) => r.dir === 'out')
  },

  /** Incoming relation groups for one draft entity. */
  seedRelsIn(e) {
    return (e?.relationTree || []).filter((r) => r.dir === 'in')
  },

  /**
   * Relation-row tooltip: who · edge · direction · targets.
   * e.g. "Product/atlas → OWNS → Franchise/northwind, Franchise/contoso"
   */
  seedRelTitle(e, r) {
    if (!r) return ''
    const self = e?.slug || 'this entity'
    const targets = (r.targets || []).map((t) => t.slug).filter(Boolean)
    const list = targets.length ? targets.join(', ') : '(none)'
    if (r.dir === 'in') {
      return `${list} → ${r.rel} → ${self}`
    }
    return `${self} → ${r.rel} → ${list}`
  },

  /**
   * Target pill label in seed relation trees.
   * Display name or id-tail only — full Class/id is on the hover title.
   */
  seedTargetLabel(slug) {
    void this._labelTick
    if (!slug) return ''
    const s = sanitizeSlug(slug)
    const id = slugIdLabel(s)
    const name = (this._entityLabels?.[s] || this._entityLabels?.[slug] || '')
      .toString()
      .replace(/\*+/g, '')
    if (name && name !== id) return name
    return id || s
  },

  /**
   * Expand/collapse a relation group (entity inspector or seed tree).
   * Prefetches display labels for target pills when opening.
   * @param {{ open?: boolean, targets?: Array<{ slug: string }> }} r
   */
  toggleEntityRel(r) {
    if (!r) return
    // Treat undefined as open (default expanded)
    r.open = r.open === false
    if (r.open && r.targets?.length) {
      void this.prefetchEntityLabels(r.targets.map((t) => t?.slug).filter(Boolean))
    }
  },

  /** Expand/collapse a seed proposed-entity branch in section C. */
  toggleSeedEntityTree(e) {
    if (!e) return
    e.treeOpen = e.treeOpen === false
  },

  /**
   * Seed C forest roots: draft entities that are NOT also relation targets of
   * another draft entity. Prevents "atlas_product" appearing both under OWNS and
   * again as an orphan root.
   * Order preserved from seedResult.entities.
   */
  seedRootEntities() {
    const ents = this.seedResult?.entities || []
    if (!ents.length) return []
    const referenced = new Set()
    for (const e of ents) {
      for (const g of e.relationTree || []) {
        for (const t of g.targets || []) {
          if (t?.slug) referenced.add(sanitizeSlug(t.slug))
        }
      }
      for (const targets of Object.values(e.relations || {})) {
        for (const t of targets || []) {
          const raw = typeof t === 'string' ? t : t?._to
          if (raw) referenced.add(sanitizeSlug(raw))
        }
      }
    }
    return ents.filter((e) => {
      const slug = sanitizeSlug(e.slug || '')
      return slug && !referenced.has(slug)
    })
  },

  /** Total related-entity edges across all relation groups. */
  entityRelationEdgeCount() {
    return (this.entityRelations || []).reduce(
      (n, g) => n + (g.targets?.length || 0),
      0,
    )
  },

  /** Best-effort label prefetch via /labels (used by relation tree expand). */
  async prefetchEntityLabels(slugs) {
    const need = [...new Set((slugs || []).filter(Boolean))]
    if (!need.length) return
    try {
      const q = need.map(encodeURIComponent).join(',')
      const res = await fetch(`/labels?slugs=${q}`)
      if (!res.ok) return
      const data = await res.json()
      const labels = data.labels || data || {}
      // Stash on store so reactive pills can read via entityLabel()
      const cache = { ...(this._entityLabels || {}) }
      for (const [slug, name] of Object.entries(labels)) {
        if (slug && name) cache[slug] = name
      }
      this._entityLabels = cache
      this._labelTick = (this._labelTick || 0) + 1
    } catch {
      /* ignore */
    }
  },

  /** Display label for a slug (relation pills / entity chips). */
  entityLabel(slug) {
    void this._labelTick
    if (!slug) return ''
    const cached = this._entityLabels?.[slug]
    if (cached) return cached
    // id tail as fallback until labels resolve
    const s = String(slug)
    const i = s.lastIndexOf('/')
    return i >= 0 ? s.slice(i + 1) : s
  },
})

export default store
