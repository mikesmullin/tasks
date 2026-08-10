/**
 * shorthand.js — pure WorkUnit ↔ task.md-style text (render + tokenize).
 * Runs in both Bun (CLI) and the browser (pane D). No brain/RPC deps.
 *
 * Grammar (superset of tasks.md/TASK.ABNF):
 *   workunit-line  = "-" SP [priority] [status] *mention *tag [title] *inline-kv
 *   continuation   = 2SP (inline-kv / checklist-item / block-key)
 *   checklist-item = "-" SP "[" (" "/"x"/"~"/"-") "]" SP text  → description
 *   needs:         → DEPENDS_ON edges (not a field)
 */

const STATUS_TO_BOX = {
  idle: '[_]',
  running: '[r]',
  success: '[x]',
  fail: '[-]',
}

const BOX_TO_STATUS = {
  '[_]': 'idle',
  '[r]': 'running',
  '[x]': 'success',
  '[-]': 'fail',
  x: 'success',
  r: 'running',
  '-': 'fail',
}

const CHECKLIST_BOX = {
  ' ': 'todo',
  x: 'done',
  X: 'done',
  '~': 'progress',
  '-': 'skipped',
}

/** A=I+U, B=I, C=U, D=neither */
export function priorityOf(wu) {
  const i = !!wu.important
  const u = !!wu.urgent
  if (i && u) return 'A'
  if (i) return 'B'
  if (u) return 'C'
  return 'D'
}

export function applyPriority(priority, wu = {}) {
  const out = { ...wu }
  switch (String(priority || '').toUpperCase()) {
    case 'A':
      out.important = true
      out.urgent = true
      break
    case 'B':
      out.important = true
      out.urgent = false
      break
    case 'C':
      out.important = false
      out.urgent = true
      break
    case 'D':
      out.important = false
      out.urgent = false
      break
  }
  return out
}

function asArray(v) {
  if (v == null || v === '') return []
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean)
  return [v]
}

/**
 * Canonical tag for storage / YAML: strip leading `#` (and extra whitespace).
 * Display in shorthand re-adds `#` via tagDisplay().
 */
function tagNorm(t) {
  let s = String(t ?? '').trim()
  if (!s) return s
  // Strip one or more leading # (LLM often emits #crispy or ##foo)
  s = s.replace(/^#+/, '').trim()
  return s
}

/** task.md-style display form for shorthand pane D. */
function tagDisplay(t) {
  const s = tagNorm(t)
  if (!s) return s
  return s.startsWith('#') ? s : `#${s}`
}

function personSlug(s) {
  const t = String(s).trim()
  if (!t) return t
  if (t.includes('/')) return t
  return `Person/${t.replace(/^@/, '')}`
}

function workunitSlug(s) {
  const t = String(s).trim()
  if (!t) return t
  if (t.includes('/')) return t
  return `WorkUnit/${t}`
}

// ── wikilinks → WorkUnit.correlations (computed) ─────────────────
// tasks-only form: {{Class/id}} or {{Class/id|Label}}
// (brain [[…]] / bare Class/id are intentionally NOT recognized here)
const WIKI_SLUG_RE = /^[A-Za-z][\w]*\/[^\|{}]+$/

/**
 * Parse one {{…}} wiki-link inner (Class/id, optional |label).
 * @returns {string | null} canonical Class/id slug
 */
export function parseWikiLinkTarget(raw) {
  let target = String(raw || '').trim()
  if (!target) return null
  const pipe = target.indexOf('|')
  if (pipe >= 0) target = target.slice(0, pipe).trim()
  target = target.replace(/\s+/g, ' ').trim()
  if (!WIKI_SLUG_RE.test(target)) return null
  if (!target.slice(target.indexOf('/') + 1).trim()) return null
  return target
}

/**
 * Unique entity slugs from {{Class/id}} wikilinks in free text (document order).
 * Does not include bare Class/id, @mentions, or brain [[…]] forms.
 * @param {string} text
 * @returns {string[]}
 */
export function extractWikiLinkSlugs(text) {
  const out = []
  const seen = new Set()
  if (!text) return out
  const add = (slug) => {
    if (!slug || seen.has(slug)) return
    seen.add(slug)
    out.push(slug)
  }
  const re = /\{\{\s*([^}]+?)\s*\}\}/g
  let m
  while ((m = re.exec(String(text)))) {
    const slug = parseWikiLinkTarget(m[1])
    if (slug) add(slug)
  }
  return out
}

/**
 * Computed WorkUnit.correlations from summary + description (+ optional source text).
 * Include `extra` (e.g. raw pane A) so pills still count if the LLM drops them from description.
 * @returns {string[]} unique Class/id list (Set semantics)
 */
export function computeCorrelations(summary, description, extra = '') {
  return extractWikiLinkSlugs(
    `${extra || ''}\n${summary || ''}\n${description || ''}`,
  )
}

/**
 * Attach/recompute correlations on a workunit field bag (mutates and returns it).
 * @param {object} wu
 * @param {string} [extraText] optional English/source text (pane A) with {{…}} pills
 */
export function applyComputedCorrelations(wu, extraText = '') {
  if (!wu || typeof wu !== 'object') return wu
  const correlations = computeCorrelations(wu.summary, wu.description, extraText)
  if (correlations.length) wu.correlations = correlations
  else delete wu.correlations
  return wu
}

/**
 * If source/sketch has {{Class/id}} that description/summary lost, restore them.
 * Prefers the sketch checklist when it still has the links; otherwise appends
 * source lines that contain the missing wikilinks as checklist items.
 */
export function ensureWikilinksInDescription(fields, baseline, sourceText = '') {
  if (!fields || typeof fields !== 'object') return fields
  const have = new Set(
    extractWikiLinkSlugs(`${fields.summary || ''}\n${fields.description || ''}`),
  )
  const want = extractWikiLinkSlugs(
    `${sourceText || ''}\n${baseline?.description || ''}\n${baseline?.summary || ''}`,
  )
  const missing = want.filter((s) => !have.has(s))
  if (!missing.length) return fields

  const baseDesc = String(baseline?.description || '')
  const baseLinks = extractWikiLinkSlugs(baseDesc)
  // Prefer sketch description wholesale when it still holds the missing links
  if (
    baseDesc &&
    missing.every((s) => baseLinks.includes(s)) &&
    /-\s\[[ xX~\-]\]/.test(baseDesc)
  ) {
    fields.description = baseDesc
    return fields
  }

  // Append source lines that still carry missing {{…}} tokens
  const src = String(sourceText || baseDesc)
  const extraLines = []
  const seenLine = new Set()
  for (const rawLine of src.split(/\r?\n/)) {
    const links = extractWikiLinkSlugs(rawLine)
    if (!links.some((s) => missing.includes(s))) continue
    let body = rawLine.replace(/^\s*-\s+/, '').trim()
    if (!body) continue
    // Drop priority/status/@/# macros if this was a head line
    body = body
      .replace(/^(?:[A-D]\s+)?(?:\[(?:_|x|X|r|\-| )\]\s+)?/, '')
      .replace(/^(?:@\S+\s+|\#\S+\s+)*/, '')
      .trim()
    if (!body) continue
    const item = /^\[([ xX~\-])\]/.test(body)
      ? `- ${body.replace(/^\[X\]/, '[x]')}`
      : `- [ ] ${body}`
    if (seenLine.has(item)) continue
    seenLine.add(item)
    extraLines.push(item)
  }
  if (extraLines.length) {
    const cur = String(fields.description || '').replace(/\s+$/, '')
    fields.description = cur ? `${cur}\n${extraLines.join('\n')}` : extraLines.join('\n')
  }
  return fields
}

function quoteTitle(title) {
  const t = String(title ?? '')
  if (t.includes('`')) return `"${t.replace(/"/g, '\\"')}"`
  if (t.includes('"') || t.includes("'")) return `\`${t}\``
  return `\`${t}\``
}

/** Split description into prose body + GFM checklist lines. */
export function splitDescription(description) {
  const text = String(description || '')
  if (!text) return { prose: '', checklist: [] }
  const lines = text.split(/\r?\n/)
  const checklist = []
  const proseLines = []
  const re = /^\s*-\s*\[([ xX~\-])\]\s*(.*)$/
  for (const line of lines) {
    const m = line.match(re)
    if (m) {
      checklist.push({ state: CHECKLIST_BOX[m[1]] || 'todo', text: m[2] })
    } else {
      proseLines.push(line)
    }
  }
  // trim trailing blank prose lines
  while (proseLines.length && proseLines[proseLines.length - 1].trim() === '') proseLines.pop()
  while (proseLines.length && proseLines[0].trim() === '') proseLines.shift()
  return { prose: proseLines.join('\n'), checklist }
}

export function joinDescription(prose, checklist) {
  const parts = []
  if (prose && String(prose).trim()) parts.push(String(prose).replace(/\s+$/, ''))
  for (const item of checklist || []) {
    const box =
      item.state === 'done' ? 'x' : item.state === 'progress' ? '~' : item.state === 'skipped' ? '-' : ' '
    parts.push(`- [${box}] ${item.text || ''}`)
  }
  return parts.join('\n')
}

/**
 * Render a WorkUnit (+ optional dependsOn slugs) to shorthand text.
 * @param {object} wu  flat workunit fields
 * @param {{ dependsOn?: string[] }} opts
 */
export function render(wu, opts = {}) {
  if (!wu) return ''
  const dependsOn = opts.dependsOn ?? wu.dependsOn ?? []
  const pri = priorityOf(wu)
  const box = STATUS_TO_BOX[wu.status] || '[_]'
  const parts = ['-', pri, box]

  for (const s of asArray(wu.stakeholders)) {
    const id = String(s).includes('/') ? String(s).split('/').pop() : String(s).replace(/^@/, '')
    parts.push(`@${id}`)
  }
  for (const t of asArray(wu.tags)) {
    parts.push(tagDisplay(t))
  }
  if (wu.summary) parts.push(quoteTitle(wu.summary))

  const lines = [parts.join(' ')]
  const indent = '  '

  if (wu.due) lines.push(`${indent}due: ${wu.due}`)
  const est = [wu.estimateOptimistic, wu.estimateLikely, wu.estimatePessimistic]
  if (est.some(Boolean)) {
    const o = wu.estimateOptimistic || ''
    const l = wu.estimateLikely || ''
    const p = wu.estimatePessimistic || ''
    lines.push(`${indent}est: ${o}/${l}/${p}`)
  }
  if (wu.weight != null && wu.weight !== '' && Number(wu.weight) !== 0) {
    lines.push(`${indent}w: ${wu.weight}`)
  }
  if (wu.worker) lines.push(`${indent}worker: ${wu.worker}`)
  const deps = asArray(dependsOn).map(String).filter(Boolean)
  if (deps.length) lines.push(`${indent}needs: ${deps.join(', ')}`)
  for (const c of asArray(wu.correlations)) {
    lines.push(`${indent}url: ${c}`)
  }

  const { prose, checklist } = splitDescription(wu.description)
  if (prose) {
    lines.push(`${indent}description: |`)
    for (const pl of prose.split('\n')) {
      lines.push(`${indent}  ${pl}`)
    }
  }
  for (const item of checklist) {
    const boxc =
      item.state === 'done' ? 'x' : item.state === 'progress' ? '~' : item.state === 'skipped' ? '-' : ' '
    lines.push(`${indent}- [${boxc}] ${item.text || ''}`)
  }

  const journal = asArray(wu.journal)
  if (journal.length) {
    lines.push(`${indent}journal: |`)
    for (const j of journal) {
      lines.push(`${indent}  ${j}`)
    }
  }

  if (wu.id) lines.push(`${indent}id: ${wu.id}`)

  return lines.join('\n')
}

/**
 * Tokenize shorthand for syntax highlighting.
 * Returns [{ type, text }] spans covering the full input.
 */
export function tokenize(text) {
  const src = String(text ?? '')
  if (!src) return []
  const spans = []
  const push = (type, t) => {
    if (t) spans.push({ type, text: t })
  }

  // line-oriented tokenizer (good enough for pane D)
  const lines = src.split(/(\n)/)
  for (const line of lines) {
    if (line === '\n') {
      push('punct', '\n')
      continue
    }
    if (!line) continue

    // checklist line
    const cl = line.match(/^(\s*)(-\s*)(\[[ xX~\-]\])(\s*)(.*)$/)
    if (cl && cl[1].length >= 2) {
      push('punct', cl[1] + cl[2])
      push('checkbox', cl[3])
      push('punct', cl[4])
      push('value', cl[5])
      continue
    }

    // key: value continuation
    const kv = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*)(:)(\s*)(.*)$/)
    if (kv && kv[1].length >= 2) {
      push('punct', kv[1])
      push('key', kv[2])
      push('punct', kv[3] + kv[4])
      const rest = kv[5]
      if (kv[2] === 'id') push('id', rest)
      else if (kv[2] === 'needs' || kv[2] === 'dependsOn') {
        // refs
        let i = 0
        const re = /WorkUnit\/[A-Za-z0-9._-]+|[A-Za-z0-9][A-Za-z0-9._-]*/g
        let m
        let last = 0
        while ((m = re.exec(rest))) {
          if (m.index > last) push('punct', rest.slice(last, m.index))
          push('ref', m[0])
          last = m.index + m[0].length
        }
        if (last < rest.length) push('value', rest.slice(last))
      } else if (kv[2] === 'due' || kv[2] === 'est') push('date', rest)
      else if (rest === '|') push('punct', rest)
      else push('value', rest)
      continue
    }

    // workunit bullet
    if (/^\s*-\s/.test(line)) {
      let i = 0
      const lead = line.match(/^(\s*-\s*)/)
      if (lead) {
        push('punct', lead[1])
        i = lead[1].length
      }
      const rest = line.slice(i)
      // tokenize prefixes + title + inline kv
      const tokens = tokenizeInline(rest)
      for (const t of tokens) spans.push(t)
      continue
    }

    // block content (description body)
    push('value', line)
  }
  return spans
}

function tokenizeInline(s) {
  const spans = []
  const push = (type, t) => {
    if (t) spans.push({ type, text: t })
  }
  // crude: walk tokens split by space, respecting quotes
  let i = 0
  while (i < s.length) {
    if (s[i] === ' ') {
      let j = i
      while (j < s.length && s[j] === ' ') j++
      push('punct', s.slice(i, j))
      i = j
      continue
    }
    // quoted title
    if (s[i] === '`' || s[i] === '"' || s[i] === "'") {
      const q = s[i]
      let j = i + 1
      while (j < s.length && s[j] !== q) {
        if (s[j] === '\\') j++
        j++
      }
      if (j < s.length) j++
      push('title', s.slice(i, j))
      i = j
      continue
    }
    // token until space
    let j = i
    while (j < s.length && s[j] !== ' ') j++
    const tok = s.slice(i, j)
    if (/^[A-D]$/.test(tok)) push('priority', tok)
    else if (BOX_TO_STATUS[tok] || tok === '[_]' || tok === '[r]' || tok === '[x]' || tok === '[-]')
      push('checkbox', tok)
    else if (tok.startsWith('@')) push('mention', tok)
    else if (tok.startsWith('#')) push('tag', tok)
    else if (tok.includes(':')) {
      const ci = tok.indexOf(':')
      push('key', tok.slice(0, ci))
      push('punct', ':')
      const val = tok.slice(ci + 1)
      if (val) push('value', val)
    } else push('value', tok)
    i = j
  }
  return spans
}

/**
 * Parse shorthand text into WorkUnit-like objects + dependsOn.
 * Returns { workunits: [{ fields, dependsOn }] }
 */
export function parse(text) {
  const src = String(text ?? '')
  const lines = src.split(/\r?\n/)
  const workunits = []
  let i = 0

  while (i < lines.length) {
    const raw = lines[i]
    const line = raw.replace(/\t/g, '  ')
    const trimmed = line.trim()
    if (!trimmed.startsWith('-')) {
      i++
      continue
    }
    const indent = (line.match(/^(\s*)/) || ['', ''])[1].length
    // only column-0 (or near) bullets start a WorkUnit; indented checklists belong to parent
    if (indent >= 2) {
      i++
      continue
    }

    const node = { fields: {}, dependsOn: [] }
    parseBulletLine(trimmed.slice(1).trim(), node)
    i++

    // continuations
    while (i < lines.length) {
      const nextRaw = lines[i].replace(/\t/g, '  ')
      const nextTrim = nextRaw.trim()
      if (nextTrim === '') {
        i++
        continue
      }
      const nextIndent = (nextRaw.match(/^(\s*)/) || ['', ''])[1].length
      if (nextIndent < 2) break
      // checklist item under this workunit
      const cl = nextTrim.match(/^-\s*\[([ xX~\-])\]\s*(.*)$/)
      if (cl) {
        const box = cl[1]
        const itemText = cl[2]
        const gfm = `- [${box === 'X' ? 'x' : box}] ${itemText}`
        const prev = node.fields.description || ''
        node.fields.description = prev ? `${prev}\n${gfm}` : gfm
        i++
        continue
      }
      const kv = nextTrim.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
      if (kv) {
        const key = kv[1]
        let val = kv[2]
        if (val === '|') {
          const blockIndent = nextIndent
          const collected = []
          i++
          while (i < lines.length) {
            const contRaw = lines[i].replace(/\t/g, '  ')
            const contTrim = contRaw.trim()
            const contIndent = (contRaw.match(/^(\s*)/) || ['', ''])[1].length
            if (contTrim === '' && contIndent <= blockIndent) {
              i++
              continue
            }
            if (contTrim === '') {
              collected.push('')
              i++
              continue
            }
            if (contIndent <= blockIndent) break
            collected.push(contRaw.slice(Math.min(contIndent, blockIndent + 2)))
            i++
          }
          applyKv(node, key, collected.join('\n'))
          continue
        }
        applyKv(node, key, parseValueToken(val))
        i++
        continue
      }
      break
    }
    workunits.push(node)
  }
  return { workunits }
}

function parseValueToken(val) {
  const v = String(val ?? '').trim()
  if (!v) return ''
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) || (v.startsWith('`') && v.endsWith('`'))) {
    return v.slice(1, -1)
  }
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+$/.test(v)) return parseInt(v, 10)
  return v
}

function applyKv(node, key, value) {
  switch (key) {
    case 'title':
    case 'summary':
      node.fields.summary = String(value)
      break
    case 'id':
      node.fields.id = String(value)
      break
    case 'due':
      node.fields.due = String(value)
      break
    case 'w':
    case 'weight':
      node.fields.weight = Number(value) || 0
      break
    case 'worker':
      node.fields.worker = String(value)
      break
    case 'status':
      node.fields.status = String(value)
      break
    case 'important':
      node.fields.important = value === true || value === 'true'
      break
    case 'urgent':
      node.fields.urgent = value === true || value === 'true'
      break
    case 'est': {
      // o/l/p or o/l/p with dates
      const parts = String(value).split('/')
      if (parts[0]) node.fields.estimateOptimistic = parts[0].trim()
      if (parts[1]) node.fields.estimateLikely = parts[1].trim()
      if (parts[2]) node.fields.estimatePessimistic = parts[2].trim()
      break
    }
    case 'estimateOptimistic':
      node.fields.estimateOptimistic = String(value)
      break
    case 'estimateLikely':
      node.fields.estimateLikely = String(value)
      break
    case 'estimatePessimistic':
      node.fields.estimatePessimistic = String(value)
      break
    case 'needs':
    case 'dependsOn': {
      const ids = asArray(value).map(workunitSlug)
      node.dependsOn.push(...ids)
      break
    }
    case 'url':
    case 'correlations': {
      const arr = asArray(value)
      node.fields.correlations = [...asArray(node.fields.correlations), ...arr]
      break
    }
    case 'tags':
      node.fields.tags = asArray(value).map(tagNorm)
      break
    case 'stakeholders':
      node.fields.stakeholders = asArray(value).map(personSlug)
      break
    case 'description': {
      const prev = node.fields.description || ''
      node.fields.description = prev ? `${prev}\n${value}` : String(value)
      break
    }
    case 'journal': {
      if (typeof value === 'string' && value.includes('\n')) {
        node.fields.journal = value.split('\n').map((s) => s.trim()).filter(Boolean)
      } else {
        node.fields.journal = [...asArray(node.fields.journal), ...asArray(value)]
      }
      break
    }
    default:
      node.fields[key] = value
  }
}

const INLINE_KV_KEYS = new Set([
  'id', 'due', 'weight', 'w', 'dependsOn', 'needs', 'status', 'worker', 'description',
  'important', 'urgent', 'title', 'summary', 'tags', 'stakeholders',
  'estimateOptimistic', 'estimateLikely', 'estimatePessimistic', 'est',
  'correlations', 'journal', 'url', 'completed', 'skipped', 'priority',
])

function parseBulletLine(afterDash, node) {
  const tokens = tokenizeRespectingQuotes(afterDash)
  let i = 0
  const bareTitle = []
  for (; i < tokens.length; i++) {
    const tok = tokens[i]
    if (isQuoted(tok)) {
      if (!node.fields.summary) node.fields.summary = stripQuotes(tok)
      continue
    }
    if (isKnownKv(tok)) break
    if (tok === 'x' || tok === '[x]') {
      node.fields.status = 'success'
      continue
    }
    if (tok === 'r' || tok === '[r]') {
      node.fields.status = 'running'
      continue
    }
    if (tok === '[-]') {
      node.fields.status = 'fail'
      continue
    }
    if (tok === '[_]') {
      node.fields.status = 'idle'
      continue
    }
    if (/^[A-D]$/.test(tok)) {
      Object.assign(node.fields, applyPriority(tok))
      continue
    }
    if (tok.startsWith('@')) {
      node.fields.stakeholders = node.fields.stakeholders || []
      node.fields.stakeholders.push(personSlug(tok))
      continue
    }
    if (tok.startsWith('#')) {
      node.fields.tags = node.fields.tags || []
      node.fields.tags.push(tagNorm(tok))
      continue
    }
    bareTitle.push(tok)
  }
  // remaining = inline kv
  while (i < tokens.length) {
    const tok = tokens[i]
    if (!tok.includes(':')) {
      bareTitle.push(tok)
      i++
      continue
    }
    const ci = tok.indexOf(':')
    const key = tok.slice(0, ci)
    let val = tok.slice(ci + 1)
    if (val === '' && i + 1 < tokens.length && !tokens[i + 1].includes(':') && !isQuoted(tokens[i + 1]) === false) {
      // value may be next token
    }
    if (val === '' && i + 1 < tokens.length) {
      // gather until next key
      const parts = []
      i++
      while (i < tokens.length && !isKnownKv(tokens[i])) {
        parts.push(isQuoted(tokens[i]) ? stripQuotes(tokens[i]) : tokens[i])
        i++
      }
      val = parts.join(' ')
      applyKv(node, key, parseValueToken(val))
      continue
    }
    applyKv(node, key, parseValueToken(val))
    i++
  }
  if (!node.fields.summary && bareTitle.length) {
    node.fields.summary = bareTitle.join(' ')
  }
  if (!node.fields.status) node.fields.status = 'idle'
  if (node.fields.important == null) node.fields.important = false
  if (node.fields.urgent == null) node.fields.urgent = false
}

function isQuoted(tok) {
  return (
    (tok.startsWith('`') && tok.endsWith('`') && tok.length >= 2) ||
    (tok.startsWith('"') && tok.endsWith('"') && tok.length >= 2) ||
    (tok.startsWith("'") && tok.endsWith("'") && tok.length >= 2)
  )
}

function stripQuotes(tok) {
  return tok.slice(1, -1)
}

function isKnownKv(tok) {
  if (!tok || !tok.includes(':')) return false
  const key = tok.slice(0, tok.indexOf(':'))
  return INLINE_KV_KEYS.has(key) || (tok.endsWith(':') && INLINE_KV_KEYS.has(tok.slice(0, -1)))
}

function tokenizeRespectingQuotes(s) {
  const tokens = []
  let i = 0
  while (i < s.length) {
    while (i < s.length && s[i] === ' ') i++
    if (i >= s.length) break
    if (s[i] === '`' || s[i] === '"' || s[i] === "'") {
      const q = s[i]
      let j = i + 1
      while (j < s.length && s[j] !== q) {
        if (s[j] === '\\') j++
        j++
      }
      if (j < s.length) j++
      tokens.push(s.slice(i, j))
      i = j
      continue
    }
    let j = i
    while (j < s.length && s[j] !== ' ') j++
    tokens.push(s.slice(i, j))
    i = j
  }
  return tokens
}

/**
 * Count top-level (column-0) bullet lines.
 */
export function countTopLevelBullets(text) {
  let n = 0
  for (const raw of String(text || '').replace(/\t/g, '  ').split(/\r?\n/)) {
    if (/^-\s+\S/.test(raw)) n++
  }
  return n
}

/**
 * Sketch → one WorkUnit field bag.
 * - Multiple column-0 bullets: first line may carry priority/@/#; rest → checklist.
 * - Nested indented bullets under the first also become checklist items.
 * - Single bullet: still extracts priority/@/# if present.
 *
 * @returns {null | object} fields suitable for WorkUnit (not stamped)
 */
export function plainBulletListToFields(text) {
  const lines = String(text || '')
    .replace(/\t/g, '  ')
    .split(/\r?\n/)
  const bullets = []
  for (const raw of lines) {
    const m = raw.match(/^(\s*)-\s+(.*)$/)
    if (!m) continue
    const indent = m[1].length
    let body = m[2].trim()
    // keep GFM checkbox state if present
    const cl = body.match(/^\[([ xX~\-])\]\s*(.*)$/)
    let box = ' '
    if (cl) {
      box = cl[1] === 'X' ? 'x' : cl[1]
      body = cl[2].trim()
    }
    if (!body) continue
    bullets.push({ indent, body, box })
  }
  if (!bullets.length) return null

  // First top-level bullet is the head; everything else is checklist content.
  const head = bullets[0]
  const rest = bullets.slice(1)
  // If only one top-level and no nested, allow single-line sketch
  if (!rest.length && head.indent === 0) {
    // still parse head for macros; description empty
  } else if (!rest.length) {
    return null
  }

  // Parse first line as task.md-ish prefixes + free title
  const headFields = parseHeadBullet(head.body)
  const checklist = rest.map((b) => {
    const box = b.box === 'x' || b.box === 'X' ? 'x' : b.box === '~' ? '~' : b.box === '-' ? '-' : ' '
    // strip leading priority macros from checklist lines if user put them only on head
    const text = b.body.replace(/^(?:[A-D]\s+)?(?:\[(?:_|x|X|r|\-| )\]\s+)?/, '')
    return `- [${box}] ${text}`
  })

  const out = {
    summary: headFields.summary || head.body,
    description: checklist.join('\n'),
    status: headFields.status || 'idle',
    important: !!headFields.important,
    urgent: !!headFields.urgent,
  }
  if (headFields.tags?.length) out.tags = headFields.tags
  if (headFields.stakeholders?.length) out.stakeholders = headFields.stakeholders
  if (headFields.worker) out.worker = headFields.worker
  applyComputedCorrelations(out)
  return out
}

/** Parse priority / status / @ / # / free title from a single bullet body (no leading "- "). */
function parseHeadBullet(body) {
  const node = { fields: {}, dependsOn: [] }
  // reuse parseBulletLine logic via a lightweight reimplementation
  const tokens = []
  let i = 0
  const s = String(body || '')
  while (i < s.length) {
    while (i < s.length && s[i] === ' ') i++
    if (i >= s.length) break
    if (s[i] === '`' || s[i] === '"' || s[i] === "'") {
      const q = s[i]
      let j = i + 1
      while (j < s.length && s[j] !== q) {
        if (s[j] === '\\') j++
        j++
      }
      if (j < s.length) j++
      tokens.push(s.slice(i, j))
      i = j
      continue
    }
    let j = i
    while (j < s.length && s[j] !== ' ') j++
    tokens.push(s.slice(i, j))
    i = j
  }

  const fields = {
    important: false,
    urgent: false,
    status: 'idle',
    tags: [],
    stakeholders: [],
  }
  const bare = []
  let k = 0
  for (; k < tokens.length; k++) {
    const tok = tokens[k]
    if (
      (tok.startsWith('`') && tok.endsWith('`')) ||
      (tok.startsWith('"') && tok.endsWith('"')) ||
      (tok.startsWith("'") && tok.endsWith("'"))
    ) {
      fields.summary = tok.slice(1, -1)
      continue
    }
    if (tok === '[_]') {
      fields.status = 'idle'
      continue
    }
    if (tok === '[r]' || tok === 'r') {
      fields.status = 'running'
      continue
    }
    if (tok === '[x]' || tok === 'x') {
      fields.status = 'success'
      continue
    }
    if (tok === '[-]') {
      fields.status = 'fail'
      continue
    }
    if (/^[A-D]$/.test(tok)) {
      if (tok === 'A') {
        fields.important = true
        fields.urgent = true
      } else if (tok === 'B') fields.important = true
      else if (tok === 'C') fields.urgent = true
      continue
    }
    if (tok.startsWith('@')) {
      fields.stakeholders.push(personSlug(tok))
      continue
    }
    if (tok.startsWith('#')) {
      fields.tags.push(tagNorm(tok))
      continue
    }
    if (tok.includes(':') && INLINE_KV_KEYS.has(tok.slice(0, tok.indexOf(':')))) break
    bare.push(tok)
  }
  // remaining inline kv
  while (k < tokens.length) {
    const tok = tokens[k]
    if (!tok.includes(':')) {
      bare.push(tok)
      k++
      continue
    }
    const ci = tok.indexOf(':')
    const key = tok.slice(0, ci)
    let val = tok.slice(ci + 1)
    if (val === '' && k + 1 < tokens.length) {
      const parts = []
      k++
      while (k < tokens.length && !INLINE_KV_KEYS.has(tokens[k].split(':')[0])) {
        parts.push(tokens[k])
        k++
      }
      val = parts.join(' ')
      if (key === 'worker') fields.worker = val
      continue
    }
    if (key === 'worker') fields.worker = val
    k++
  }
  if (!fields.summary && bare.length) fields.summary = bare.join(' ')
  return fields
}

export { STATUS_TO_BOX, BOX_TO_STATUS, personSlug, workunitSlug, tagNorm, tagDisplay, asArray }
