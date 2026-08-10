/**
 * @-mention autocomplete for contenteditable composers (search + chat).
 *
 * - Type `@` → typeahead against /search (keyword)
 * - ↑↓ navigate, Enter select, Escape dismiss
 * - Inserts a contenteditable=false entity link (same as markdown chips)
 * - Serializes to wiki-links: {{Class/id}} or {{Class/id|Label}} (tasks form)
 * - Backspace removes whole chip; click uses delegated entity-link selection
 */

// Wiki / UI slug shape: `Class/id`. Class is word-like; id may include spaces
// (LLMs often write [[LawFirm/Mossack Fonseca|…]]). Stricter brain IDs still match.
// Rejects | [ ] so pipe-display and nested brackets stay out of the slug.
const SLUG_RE = /^[A-Za-z][\w]*\/[^\|\[\]]+$/
// Bare Class/id in prose (no spaces in id — avoids eating "Entity/1 is cool")
const BARE_SLUG_RE = /\b([A-Z][A-Za-z0-9]*\/[A-Za-z0-9][A-Za-z0-9._-]*)\b/g
const REL_KEY_RE = /^[A-Z][A-Z0-9_]*$/
const DEBOUNCE_MS = 120
const LIMIT = 8

/** @type {HTMLElement | null} */
let menuEl = null
/** @type {ReturnType<typeof attachMentionEditor> | null} */
let activeEditorApi = null
/** @type {Set<() => void>} */
const mentionOpenListeners = new Set()
/** True while any composer’s @-mention menu is open */
let mentionMenuOpen = false

/** @returns {boolean} */
export function isMentionMenuOpen() {
  return mentionMenuOpen
}

/**
 * Subscribe to mention-menu open/close (for NL debounce pause).
 * @param {(open: boolean) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onMentionMenuOpenChange(fn) {
  if (typeof fn !== 'function') return () => {}
  const wrap = () => fn(mentionMenuOpen)
  mentionOpenListeners.add(wrap)
  return () => mentionOpenListeners.delete(wrap)
}

function setMentionMenuOpen(next) {
  const v = !!next
  if (v === mentionMenuOpen) return
  mentionMenuOpen = v
  for (const fn of mentionOpenListeners) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Decode common HTML entities so we can re-escape once for safe HTML. */
function unesc(s) {
  return String(s ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function escapePlainSegment(s) {
  return esc(s).replace(/\r\n/g, '\n').replace(/\n/g, '<br>')
}

/**
 * Build a safe entity-link anchor from slug + display label.
 * @param {string} slug
 * @param {string} label
 * @param {(slug: string) => string} hrefFor
 * @param {{ fixedLabel?: boolean, rel?: string | null }} [opts]
 *   fixedLabel: wiki `|display text` was provided — hydrate must not overwrite
 */
/** Short display id from Class/id (e.g. Product/atlas → atlas). */
export function entityIdFromSlug(slug) {
  const s = String(slug || '').trim()
  if (!s) return s
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

function entityLinkHtml(slug, label, hrefFor, opts = {}) {
  const hrefFn = hrefFor || ((s) => '/browse/' + String(s || ''))
  const path = hrefFn(slug)
  const fixed = opts.fixedLabel ? ' data-fixed-label="1"' : ''
  const rel =
    opts.rel != null && opts.rel !== ''
      ? ` data-rel="${esc(opts.rel)}"`
      : ''
  // UI label is always the entity id; full slug stays in title/tooltip
  const display = entityIdFromSlug(slug)
  void label
  // Same classes as inspector/relation entity-pill — one document click handler
  return (
    `<a class="entity-pill md-entity entity-link" data-entity="${esc(slug)}" ` +
    `href="${esc(path)}" title="${esc(slug)}"${fixed}${rel}>` +
    `<i class="ph-bold ph-cube entity-link-icon entity-link-icon-ready" aria-hidden="true"></i>` +
    `<span class="entity-pill-label">${esc(display)}</span></a>`
  )
}

/**
 * Format a wiki-link for LLM / storage.
 * @param {string} slug
 * @param {string} [label]
 */
export function formatWikiLink(slug, label) {
  if (!slug) return ''
  const lab = (label || '').trim()
  if (lab && lab !== slug) return `{{${slug}|${lab}}}`
  return `{{${slug}}}`
}

/**
 * Parse one raw wiki inner (full grammar):
 *   Class/id | Class/id|Label | REL:Class/id | REL:Class/id|Label
 * @param {string} raw
 * @returns {{ slug: string, label: string, rel: string | null, explicitLabel: boolean } | null}
 */
export function parseWikiInner(raw) {
  let target = String(raw || '').trim()
  if (!target) return null
  let rel = null
  const ci = target.indexOf(':')
  if (ci > 0 && REL_KEY_RE.test(target.slice(0, ci))) {
    rel = target.slice(0, ci)
    target = target.slice(ci + 1).trim()
  }
  let label = ''
  let explicitLabel = false
  const pipe = target.indexOf('|')
  if (pipe >= 0) {
    label = target.slice(pipe + 1).trim()
    target = target.slice(0, pipe).trim()
    // `|display text` present and non-empty → lock anchor text against /labels
    explicitLabel = label.length > 0
  }
  // Collapse internal whitespace in the slug (soft normalize for LLM output)
  target = target.replace(/\s+/g, ' ').trim()
  if (!SLUG_RE.test(target)) return null
  // id must be non-empty after Class/
  if (!target.slice(target.indexOf('/') + 1).trim()) return null
  return {
    slug: target,
    label: explicitLabel ? label : target,
    rel,
    explicitLabel,
  }
}

/**
 * Unique Class/id targets from free text (tasks form only):
 *   {{Class/id}} / {{Class/id|Label}}
 * @param {string} text
 * @returns {string[]}
 */
export function extractWikiSlugs(text) {
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
    const parsed = parseWikiInner(m[1])
    if (parsed?.slug) add(parsed.slug)
  }
  return out
}

function linkFromParsed(parsed, hrefFor) {
  return entityLinkHtml(parsed.slug, parsed.label, hrefFor, {
    fixedLabel: parsed.explicitLabel,
    rel: parsed.rel,
  })
}

/** Placeholder wrap so marked won't escape our entity-link HTML. */
const PH_START = '\uE000' // private-use
const PH_END = '\uE001'

/**
 * Expand entity refs to anchors. Prefer {@link promoteEntityRefsInMarkdown}
 * for GFM (placeholder-safe). This form is for plain HTML text nodes.
 *
 * tasks form only: {{Class/id}} / {{Class/id|label}}
 *
 * @param {string} html
 * @param {{ hrefFor?: (slug: string) => string, bare?: boolean }} [opts]
 */
export function expandWikilinks(html, opts = {}) {
  if (!html) return ''
  const hrefFor =
    opts.hrefFor || ((slug) => '/e/' + encodeURIComponent(slug))
  let s = String(html)

  s = s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, inner) => {
    const parsed = parseWikiInner(unesc(inner))
    if (!parsed) return full
    return linkFromParsed(parsed, hrefFor)
  })

  return s
}

/**
 * Markdown-safe promote: replace entity refs with private-use placeholders,
 * run `marked`, then restore real anchor HTML. Avoids the bug where marked
 * escapes pre-inserted <a> tags and a second expand injects nested garbage.
 *
 * @param {string} src  raw markdown / assistant text
 * @param {(md: string) => string} parseMd  e.g. (s) => marked.parse(s, { async: false })
 * @param {{ hrefFor?: (slug: string) => string }} [opts]
 */
export function promoteEntityRefsInMarkdown(src, parseMd, opts = {}) {
  const hrefFor =
    opts.hrefFor || ((slug) => '/e/' + encodeURIComponent(slug))
  /** @type {string[]} */
  const slots = []
  const put = (html) => {
    const i = slots.length
    slots.push(html)
    return `${PH_START}${i}${PH_END}`
  }

  let md = String(src ?? '')

  // tasks form: {{Class/id}} / {{Class/id|label}}
  md = md.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, inner) => {
    const parsed = parseWikiInner(inner)
    if (!parsed) return full
    return put(linkFromParsed(parsed, hrefFor))
  })

  let html = typeof parseMd === 'function' ? parseMd(md) : md
  // Restore anchors (marked leaves private-use chars as text)
  html = String(html).replace(
    new RegExp(`${PH_START}(\\d+)${PH_END}`, 'g'),
    (_, i) => slots[Number(i)] ?? '',
  )
  // Safety: any leftover wiki forms in HTML text
  html = expandWikilinks(html, { hrefFor })
  return html
}

/**
 * Replace bare Class/id tokens in HTML text nodes (not inside anchors/tags).
 * @param {string} html
 * @param {(slug: string) => string} hrefFor
 */
function expandBareSlugsInHtml(html, hrefFor) {
  let depthA = 0
  return String(html).replace(
    /(<\/?a\b[^>]*>)|([^<]+)|(<[^>]+>)/gi,
    (full, aTag, text, otherTag) => {
      if (aTag) {
        if (/^<a\b/i.test(aTag)) depthA++
        else if (/^<\/a/i.test(aTag)) depthA = Math.max(0, depthA - 1)
        return aTag
      }
      if (otherTag) return otherTag
      if (depthA > 0 || text == null) return text
      // Skip escaped/raw HTML residue (broken prior expands)
      if (
        /&lt;|&gt;|data-entity\s*=|class\s*=\s*["']md-entity|href\s*=/.test(
          text,
        )
      ) {
        return text
      }
      return text.replace(new RegExp(BARE_SLUG_RE.source, 'g'), (m, slug) => {
        if (!SLUG_RE.test(slug)) return m
        return entityLinkHtml(slug, slug, hrefFor, { fixedLabel: false })
      })
    },
  )
}

/**
 * Escape plain text and turn entity refs into chips (for user bubbles).
 * Escape ONCE via parseMd on placeholder text, then restore already-escaped
 * anchors — never re-escape inside <a>…</a> (that doubled &amp; for "M & M").
 * @param {string} text
 * @param {{ hrefFor?: (slug: string) => string }} [opts]
 */
export function renderPlainWithMentions(text, opts = {}) {
  if (!text) return ''
  const hrefFor =
    opts.hrefFor || ((slug) => '/e/' + encodeURIComponent(slug))
  // Placeholders are private-use digits; escapePlainSegment leaves them intact.
  // entityLinkHtml already esc()s labels — do not run a second global escape.
  return promoteEntityRefsInMarkdown(
    String(text),
    (md) => escapePlainSegment(md),
    { hrefFor },
  )
}

/**
 * Best-effort display name from a search preview (components bag).
 * @param {any} preview
 * @param {string} slug
 */
export function nameFromPreview(preview, slug) {
  if (!preview || typeof preview !== 'object') return slug
  for (const key of ['info', 'meta', 'profile', 'identity', 'naming', 'workunit']) {
    const bag = preview[key]
    if (!bag || typeof bag !== 'object') continue
    for (const fname of ['name', 'title', 'summary', 'label', 'display_name', 'full_name']) {
      const v = bag[fname]
      if (v != null && String(v).trim()) return String(v).trim()
    }
  }
  for (const fields of Object.values(preview)) {
    if (!fields || typeof fields !== 'object') continue
    for (const fname of [
      'name',
      'title',
      'summary',
      'label',
      'display_name',
      'full_name',
      'address',
    ]) {
      const v = fields[fname]
      if (v != null && typeof v !== 'object' && String(v).trim()) {
        return String(v).trim()
      }
    }
  }
  // Fallback: last path segment of Class/id
  const s = String(slug || '')
  const slash = s.lastIndexOf('/')
  return slash >= 0 ? s.slice(slash + 1) : s
}

/**
 * @param {string} query
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<Array<{ slug: string, label: string, score?: number }>>}
 */
export async function suggestEntities(query, opts = {}) {
  // Empty query after @ → still hit /search so prefix fallback can list recent-ish ids
  const q = String(query || '').trim()
  const url =
    '/search?q=' +
    encodeURIComponent(q || '*') +
    '&limit=' +
    LIMIT +
    '&strategy=keyword&expand=false'
  try {
    const res = await fetch(url, { signal: opts.signal })
    if (!res.ok) return []
    const hits = await res.json()
    if (!Array.isArray(hits)) return []
    return hits
      .filter((h) => h && h.slug)
      .map((h) => ({
        slug: h.slug,
        label: nameFromPreview(h.preview, h.slug),
        score: h.score,
      }))
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    return []
  }
}

function ensureMenu() {
  if (menuEl && document.body.contains(menuEl)) return menuEl
  menuEl = document.createElement('div')
  menuEl.className = 'mention-menu'
  menuEl.hidden = true
  menuEl.setAttribute('role', 'listbox')
  menuEl.id = 'mention-menu'
  document.body.appendChild(menuEl)
  return menuEl
}

/**
 * True if node is an in-app entity chip (composer or transcript).
 * @param {Element | null | undefined} el
 */
function isEntityChip(el) {
  return Boolean(
    el &&
      el.nodeType === Node.ELEMENT_NODE &&
      el.matches?.(
        'a.entity-pill[data-entity], a.entity-link[data-entity], a.md-entity[data-entity]',
      ),
  )
}

/**
 * Create the same entity-pill chip used in markdown / inspector / relations.
 * contenteditable=false so it acts as an atomic token in the composer.
 * Clicks are handled by the document-level entity-pill adapter in ui.js
 * (select / Shift multi / dblclick frame without changing selection).
 * @param {string} slug
 * @param {string} label
 * @param {{ hrefFor?: (slug: string) => string }} [opts]
 */
export function createMentionPill(slug, label, opts = {}) {
  const hrefFor =
    opts.hrefFor || ((s) => '/browse/' + String(s || ''))
  const a = document.createElement('a')
  // Same surface as entityLinkHtml / entityPillHtml in ui.js
  a.className = 'entity-pill md-entity entity-link'
  a.contentEditable = 'false'
  a.dataset.entity = slug
  // Short id is presentation-only; serialize as bare {{slug}}
  a.dataset.labelBound = '1'
  a.href = hrefFor(slug)
  a.title = slug // native tooltip: full Class/id
  a.draggable = false
  void label

  const icon = document.createElement('i')
  icon.className = 'ph-bold ph-cube entity-link-icon entity-link-icon-ready'
  icon.setAttribute('aria-hidden', 'true')

  const lab = document.createElement('span')
  lab.className = 'entity-pill-label'
  lab.textContent = entityIdFromSlug(slug)

  a.appendChild(icon)
  a.appendChild(lab)
  return a
}

/**
 * Serialize a root's children → wiki text (pills → {{Class/id}}).
 * @param {ParentNode | null | undefined} root
 */
export function serializeRoot(root) {
  if (!root) return ''
  const parts = []

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push((node.textContent || '').replace(/\u00a0/g, ' '))
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = /** @type {HTMLElement} */ (node)
    if (isEntityChip(el)) {
      const slug = el.dataset.entity || ''
      // Always emit full wikilink — never the short visible id alone
      parts.push(formatWikiLink(slug))
      return
    }
    if (el.tagName === 'BR') {
      parts.push('\n')
      return
    }
    // Block-ish elements: newline before subsequent siblings' content
    const block =
      el.tagName === 'DIV' ||
      el.tagName === 'P' ||
      el.tagName === 'LI'
    if (block && parts.length && !parts[parts.length - 1].endsWith('\n')) {
      parts.push('\n')
    }
    for (const child of el.childNodes) walk(child)
    if (block && parts.length && !parts[parts.length - 1].endsWith('\n')) {
      // trailing newline for mid-document blocks is handled by next block
    }
  }

  for (const child of root.childNodes) walk(child)
  return parts.join('').replace(/\n{3,}/g, '\n\n').trimEnd()
}

/**
 * Serialize editor DOM → wiki text for LLM / store.
 * @param {HTMLElement} editor
 */
export function serializeEditor(editor) {
  return serializeRoot(editor)
}

/**
 * Serialize the current selection inside `editor` to wiki text.
 * Pills become {{Class/id}} (not the short label shown in the UI).
 * @param {HTMLElement} editor
 * @returns {string | null} wiki text, or null if no usable selection
 */
export function serializeSelection(editor) {
  if (!editor) return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  const startIn = editor.contains(range.startContainer) || range.startContainer === editor
  const endIn = editor.contains(range.endContainer) || range.endContainer === editor
  if (!startIn || !endIn) return null

  // Whole-editor select → same as serializeEditor (stable newlines)
  try {
    const full = document.createRange()
    full.selectNodeContents(editor)
    if (
      range.compareBoundaryPoints(Range.START_TO_START, full) === 0 &&
      range.compareBoundaryPoints(Range.END_TO_END, full) === 0
    ) {
      return serializeEditor(editor)
    }
  } catch {
    /* fall through to cloneContents */
  }

  const tmp = document.createElement('div')
  try {
    tmp.appendChild(range.cloneContents())
  } catch {
    return serializeEditor(editor)
  }
  return serializeRoot(tmp)
}

/**
 * Hydrate editor from plain/wiki text.
 * @param {HTMLElement} editor
 * @param {string} text
 * @param {{ hrefFor?: (slug: string) => string }} [opts]
 */
export function setEditorText(editor, text, opts = {}) {
  if (!editor) return
  editor.innerHTML = ''
  const src = String(text || '')
  if (!src) {
    // empty — leave a zero-width space? empty is fine for placeholder CSS
    return
  }
  // Split on tasks {{…}} wiki links while keeping them
  const re = /\{\{\s*([^}]+?)\s*\}\}/g
  let last = 0
  let m
  const frag = document.createDocumentFragment()
  while ((m = re.exec(src))) {
    if (m.index > last) {
      appendTextWithBreaks(frag, src.slice(last, m.index))
    }
    const parsed = parseWikiInner(m[1])
    if (parsed) {
      frag.appendChild(
        createMentionPill(parsed.slug, parsed.label, opts),
      )
    } else {
      appendTextWithBreaks(frag, m[0])
    }
    last = m.index + m[0].length
  }
  if (last < src.length) appendTextWithBreaks(frag, src.slice(last))
  editor.appendChild(frag)
}

function appendTextWithBreaks(parent, text) {
  const parts = String(text).split('\n')
  parts.forEach((part, i) => {
    if (part) parent.appendChild(document.createTextNode(part))
    if (i < parts.length - 1) parent.appendChild(document.createElement('br'))
  })
}

/**
 * Place caret after a node (e.g. after inserted entity chip).
 * @param {Node} node
 */
function placeCaretAfter(node) {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.setStartAfter(node)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

/**
 * Find active @query at the caret.
 * @param {HTMLElement} editor
 * @returns {{ query: string, textNode: Text, start: number, end: number } | null}
 */
export function findMentionAtCaret(editor) {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  if (!editor.contains(range.startContainer)) return null
  // Not inside an entity chip
  if (
    range.startContainer.nodeType === Node.ELEMENT_NODE &&
    /** @type {Element} */ (range.startContainer).closest?.(
      'a.entity-pill[data-entity], a.entity-link[data-entity], a.md-entity[data-entity]',
    )
  ) {
    return null
  }
  let textNode = range.startContainer
  let offset = range.startOffset
  if (textNode.nodeType === Node.ELEMENT_NODE) {
    // Caret in element — try previous text child
    const el = /** @type {Element} */ (textNode)
    if (offset === 0) return null
    const prev = el.childNodes[offset - 1]
    if (prev?.nodeType === Node.TEXT_NODE) {
      textNode = prev
      offset = prev.textContent?.length || 0
    } else return null
  }
  if (textNode.nodeType !== Node.TEXT_NODE) return null
  if (
    /** @type {Element} */ (textNode.parentElement)?.closest?.(
      'a.entity-pill[data-entity], a.entity-link[data-entity], a.md-entity[data-entity]',
    )
  ) {
    return null
  }
  const text = textNode.textContent || ''
  const before = text.slice(0, offset)
  // @query: allow Class/id-ish chars; stop at whitespace
  const m = before.match(/(^|[\s\u00a0(])@([^\s@]*)$/)
  if (!m) return null
  const query = m[2]
  const atStart = offset - query.length - 1
  return { query, textNode: /** @type {Text} */ (textNode), start: atStart, end: offset }
}

/**
 * Attach mention behavior to a contenteditable .mention-editor.
 * @param {HTMLElement} editor
 * @param {{
 *   onChange?: (wikiText: string) => void,
 *   onSubmit?: () => void,
 *   multiline?: boolean,
 *   submitOnEnter?: boolean,
 *     // multiline only: when true (default), Enter submits and Shift+Enter newlines
 *     // (chat-style). When false, Enter inserts a newline (task composer).
 *   hrefFor?: (slug: string) => string,
 *   onEntityClick?: (slug: string) => void,
 *     // pill click → navigate (SPA). Default: location assign via href only if unset.
 *   syncSelectionClass?: () => void,
 * }} [opts]
 */
export function attachMentionEditor(editor, opts = {}) {
  if (!editor) return null
  // Tear down prior binding on same element (HMR)
  if (editor.__mentionApi) {
    editor.__mentionApi.destroy()
  }

  const multiline = opts.multiline !== false
  const submitOnEnter = opts.submitOnEnter !== false
  const hrefFor =
    opts.hrefFor || ((s) => '/browse/' + String(s || ''))

  /** @type {{ query: string, textNode: Text, start: number, end: number } | null} */
  let mentionCtx = null
  /** @type {Array<{ slug: string, label: string }>} */
  let items = []
  let activeIdx = 0
  let open = false
  /** @type {AbortController | null} */
  let fetchAc = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let debounceTimer = null

  const menu = ensureMenu()

  /** True when editor has no real text and no entity pills. */
  function isEditorEmpty() {
    const text = serializeEditor(editor)
    return (
      !text.trim() && !editor.querySelector('a.entity-link[data-entity], a[data-entity]')
    )
  }

  /**
   * When empty, wipe residual <br>/divs browsers leave after delete-all so the
   * CSS placeholder isn't treated like a line the caret sits after.
   */
  function syncEmptyState() {
    if (isEditorEmpty()) {
      if (editor.innerHTML !== '') editor.innerHTML = ''
      editor.dataset.empty = '1'
      return true
    }
    editor.dataset.empty = '0'
    return false
  }

  function placeCaretAtStart() {
    try {
      const sel = window.getSelection()
      if (!sel) return
      const r = document.createRange()
      r.selectNodeContents(editor)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
    } catch {
      /* ignore */
    }
  }

  function emitChange() {
    const text = serializeEditor(editor)
    const empty = syncEmptyState()
    // Prefer serialized text after empty wipe (always '')
    opts.onChange?.(empty ? '' : text)
  }

  function onFocus() {
    if (syncEmptyState()) {
      // Next frame: after browser focus default caret placement
      requestAnimationFrame(() => {
        if (editor.dataset.empty === '1') placeCaretAtStart()
      })
    }
  }

  function closeMenu() {
    open = false
    items = []
    activeIdx = 0
    mentionCtx = null
    if (fetchAc) {
      try {
        fetchAc.abort()
      } catch {
        /* ignore */
      }
      fetchAc = null
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    menu.hidden = true
    menu.innerHTML = ''
    if (activeEditorApi === api) activeEditorApi = null
    setMentionMenuOpen(false)
  }

  function renderMenu() {
    if (!open) {
      menu.hidden = true
      return
    }
    activeEditorApi = api
    menu.hidden = false
    if (!items.length) {
      menu.innerHTML =
        '<div class="mention-empty">' +
        (mentionCtx?.query
          ? 'No matches'
          : 'Type to search entities') +
        '</div>'
    } else {
      menu.innerHTML = items
        .map((it, i) => {
          const cls =
            'mention-item' + (i === activeIdx ? ' is-active' : '')
          return (
            `<div class="${cls}" role="option" data-idx="${i}" ` +
            `aria-selected="${i === activeIdx}">` +
            `<i class="ph-bold ph-cube entity-link-icon" aria-hidden="true"></i>` +
            `<span class="mention-item-main">` +
            `<span class="mention-item-label">${esc(it.label)}</span>` +
            `<span class="mention-item-slug">${esc(it.slug)}</span>` +
            `</span></div>`
          )
        })
        .join('')
    }
    positionMenu()
  }

  function positionMenu() {
    if (!open) return
    const sel = window.getSelection()
    let rect = null
    if (sel && sel.rangeCount) {
      try {
        const r = sel.getRangeAt(0).cloneRange()
        r.collapse(true)
        const rects = r.getClientRects()
        if (rects && rects.length) rect = rects[0]
        else {
          // Collapsed caret often has empty client rects — use editor box
          const er = editor.getBoundingClientRect()
          rect = {
            top: er.bottom - 8,
            bottom: er.bottom,
            left: er.left + 12,
            right: er.left + 12,
            width: 0,
            height: 0,
          }
        }
      } catch {
        rect = null
      }
    }
    if (!rect) rect = editor.getBoundingClientRect()
    const menuH = Math.min(280, menu.scrollHeight || 200)
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < menuH + 12 && rect.top > menuH
    const top = openUp ? rect.top - menuH - 6 : rect.bottom + 6
    let left = rect.left
    const mw = Math.min(320, window.innerWidth - 16)
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8
    if (left < 8) left = 8
    menu.style.top = Math.max(8, top) + 'px'
    menu.style.left = left + 'px'
    menu.style.width = mw + 'px'
  }

  async function runSuggest(query) {
    if (fetchAc) {
      try {
        fetchAc.abort()
      } catch {
        /* ignore */
      }
    }
    fetchAc = new AbortController()
    const ac = fetchAc
    try {
      const results = await suggestEntities(query, { signal: ac.signal })
      if (ac.signal.aborted || !open) return
      items = results
      activeIdx = 0
      renderMenu()
    } catch (err) {
      if (err?.name === 'AbortError') return
      items = []
      renderMenu()
    }
  }

  function scheduleSuggest(query) {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void runSuggest(query)
    }, DEBOUNCE_MS)
  }

  function openMention(ctx) {
    mentionCtx = ctx
    open = true
    setMentionMenuOpen(true)
    scheduleSuggest(ctx.query)
    renderMenu()
  }

  function updateFromCaret() {
    const ctx = findMentionAtCaret(editor)
    if (!ctx) {
      if (open) closeMenu()
      return
    }
    mentionCtx = ctx
    open = true
    setMentionMenuOpen(true)
    scheduleSuggest(ctx.query)
    // Keep menu visible while typing; refresh empty state immediately
    if (!items.length) renderMenu()
    else positionMenu()
  }

  function insertSelected(item) {
    if (!item || !mentionCtx) return
    const { textNode, start, end } = mentionCtx
    // Validate text node still in tree
    if (!textNode.isConnected || !editor.contains(textNode)) {
      closeMenu()
      return
    }
    const full = textNode.textContent || ''
    const before = full.slice(0, start)
    const after = full.slice(end)
    const parent = textNode.parentNode
    if (!parent) {
      closeMenu()
      return
    }

    const beforeNode = document.createTextNode(before)
    const pill = createMentionPill(item.slug, item.label, { hrefFor })
    // Regular space after pill so the user can keep typing
    const afterNode = document.createTextNode('\u00a0' + after.replace(/^\u00a0/, ''))

    parent.insertBefore(beforeNode, textNode)
    parent.insertBefore(pill, textNode)
    parent.insertBefore(afterNode, textNode)
    parent.removeChild(textNode)

    placeCaretAfter(pill)
    // Move into the afterNode (after ZWSP/space)
    try {
      const sel = window.getSelection()
      if (sel && afterNode.textContent) {
        const r = document.createRange()
        // Place after first space
        r.setStart(afterNode, Math.min(1, afterNode.textContent.length))
        r.collapse(true)
        sel.removeAllRanges()
        sel.addRange(r)
      }
    } catch {
      /* ignore */
    }

    closeMenu()
    emitChange()
    opts.syncSelectionClass?.()
    editor.focus()
  }

  function onMenuClick(e) {
    if (activeEditorApi !== api) return
    const itemEl = e.target.closest?.('.mention-item')
    if (!itemEl || !menu.contains(itemEl)) return
    e.preventDefault()
    e.stopPropagation()
    const idx = Number(itemEl.dataset.idx)
    if (Number.isFinite(idx) && items[idx]) insertSelected(items[idx])
  }

  function onMenuMouseDown(e) {
    if (activeEditorApi !== api) return
    // Prevent stealing focus from the editor
    if (menu.contains(e.target)) e.preventDefault()
  }

  /**
   * Backspace: if caret is just after a pill, remove the whole pill.
   * @param {KeyboardEvent} e
   */
  function handleBackspace(e) {
    const sel = window.getSelection()
    if (!sel || !sel.isCollapsed || !sel.rangeCount) return false
    const range = sel.getRangeAt(0)
    if (!editor.contains(range.startContainer)) return false

    // Caret at start of a text node → previous sibling may be entity chip
    if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
      const prev = range.startContainer.previousSibling
      if (prev?.nodeType === Node.ELEMENT_NODE && isEntityChip(/** @type {Element} */ (prev))) {
        e.preventDefault()
        prev.remove()
        emitChange()
        return true
      }
    }

    // Caret directly in editor / element after chip
    if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
      const el = /** @type {Element} */ (range.startContainer)
      const idx = range.startOffset
      if (idx > 0) {
        const prev = el.childNodes[idx - 1]
        if (prev?.nodeType === Node.ELEMENT_NODE && isEntityChip(/** @type {Element} */ (prev))) {
          e.preventDefault()
          prev.remove()
          emitChange()
          return true
        }
        // Empty text node after chip
        if (
          prev?.nodeType === Node.TEXT_NODE &&
          !(prev.textContent || '').replace(/\u00a0/g, ' ').trim() &&
          prev.previousSibling &&
          isEntityChip(/** @type {Element} */ (prev.previousSibling))
        ) {
          e.preventDefault()
          prev.previousSibling.remove()
          emitChange()
          return true
        }
      }
    }
    return false
  }

  function onKeyDown(e) {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (!items.length) return
        activeIdx = (activeIdx + 1) % items.length
        renderMenu()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (!items.length) return
        activeIdx = (activeIdx - 1 + items.length) % items.length
        renderMenu()
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (items[activeIdx]) {
          e.preventDefault()
          e.stopPropagation()
          insertSelected(items[activeIdx])
          return
        }
        // No matches — dismiss menu; don't submit/send with a half-typed @query
        e.preventDefault()
        e.stopPropagation()
        closeMenu()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeMenu()
        return
      }
    }

    if (e.key === 'Backspace') {
      if (handleBackspace(e)) return
    }

    // Submit / run — only when menu closed
    // single-line: Enter always submits (never inserts a break)
    // multiline + submitOnEnter: Enter sends; Shift+Enter → newline (chat-style)
    // multiline + !submitOnEnter: Enter inserts newline (task composer)
    if (e.key === 'Enter' && !open) {
      if (!multiline) {
        e.preventDefault()
        if (!e.repeat) opts.onSubmit?.()
        return
      }
      if (submitOnEnter && !e.shiftKey) {
        e.preventDefault()
        if (!e.repeat) opts.onSubmit?.()
      }
    }
  }

  function onInput() {
    emitChange()
    updateFromCaret()
  }

  function onKeyUp(e) {
    if (
      open &&
      (e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'Home' ||
        e.key === 'End')
    ) {
      updateFromCaret()
    }
  }

  function onBlur() {
    // Delay so menu mousedown/click can fire first
    setTimeout(() => {
      if (
        !editor.contains(document.activeElement) &&
        !menu.contains(document.activeElement)
      ) {
        closeMenu()
      }
    }, 150)
  }

  function onPaste(e) {
    e.preventDefault()
    const text = e.clipboardData?.getData('text/plain') || ''
    if (/\{\{[^}]+\}\}/.test(text)) {
      const tmp = document.createElement('div')
      setEditorText(tmp, text, { hrefFor })
      const sel = window.getSelection()
      if (!sel || !sel.rangeCount) return
      const range = sel.getRangeAt(0)
      range.deleteContents()
      const frag = document.createDocumentFragment()
      while (tmp.firstChild) frag.appendChild(tmp.firstChild)
      const last = frag.lastChild
      range.insertNode(frag)
      if (last) placeCaretAfter(last)
      emitChange()
      return
    }
    document.execCommand('insertText', false, text)
  }

  /**
   * Copy/cut: put wiki text on the clipboard so pills become {{Class/id}},
   * not the short visible id (e.g. "atlas").
   */
  function writeWikiClipboard(e, wikiText) {
    if (!e.clipboardData || wikiText == null) return false
    e.preventDefault()
    e.clipboardData.setData('text/plain', wikiText)
    // HTML paste targets still get the wikilink form (escaped), not chip chrome
    e.clipboardData.setData(
      'text/html',
      `<meta charset="utf-8"><pre>${esc(wikiText)}</pre>`,
    )
    return true
  }

  function onCopy(e) {
    const wiki = serializeSelection(editor)
    if (wiki == null) return
    writeWikiClipboard(e, wiki)
  }

  function onCut(e) {
    const wiki = serializeSelection(editor)
    if (wiki == null) return
    if (!writeWikiClipboard(e, wiki)) return
    const sel = window.getSelection()
    if (sel?.rangeCount) {
      try {
        sel.getRangeAt(0).deleteContents()
      } catch {
        /* ignore */
      }
      emitChange()
    }
  }

  function onClick(e) {
    const chip = e.target?.closest?.('a[data-entity]')
    if (chip && editor.contains(chip)) {
      // SPA navigate to Schema entity (history push); keep draft in store
      e.preventDefault()
      e.stopPropagation()
      const slug = chip.getAttribute('data-entity') || chip.dataset?.entity
      if (slug) {
        if (typeof opts.onEntityClick === 'function') opts.onEntityClick(slug)
        else {
          // Fallback: full navigation via href
          const href = chip.getAttribute('href')
          if (href) window.location.assign(href)
        }
      }
      return
    }
    // Empty editor: click should not leave caret "after" the CSS placeholder
    if (syncEmptyState()) {
      placeCaretAtStart()
      return
    }
    setTimeout(updateFromCaret, 0)
  }

  editor.addEventListener('keydown', onKeyDown)
  editor.addEventListener('input', onInput)
  editor.addEventListener('keyup', onKeyUp)
  editor.addEventListener('blur', onBlur)
  editor.addEventListener('focus', onFocus)
  editor.addEventListener('paste', onPaste)
  editor.addEventListener('copy', onCopy)
  editor.addEventListener('cut', onCut)
  editor.addEventListener('click', onClick)
  menu.addEventListener('mousedown', onMenuMouseDown)
  menu.addEventListener('click', onMenuClick)

  // Initial empty flag only — do not emit onChange (would wipe store text on bind)
  syncEmptyState()

  const api = {
    editor,
    getText: () => serializeEditor(editor),
    setText: (text) => {
      setEditorText(editor, text, { hrefFor })
      emitChange()
      closeMenu()
    },
    clear: () => {
      editor.innerHTML = ''
      editor.dataset.empty = '1'
      emitChange()
      closeMenu()
    },
    focus: () => editor.focus(),
    closeMenu,
    isMenuOpen: () => open,
    destroy: () => {
      editor.removeEventListener('keydown', onKeyDown)
      editor.removeEventListener('input', onInput)
      editor.removeEventListener('keyup', onKeyUp)
      editor.removeEventListener('blur', onBlur)
      editor.removeEventListener('focus', onFocus)
      editor.removeEventListener('paste', onPaste)
      editor.removeEventListener('copy', onCopy)
      editor.removeEventListener('cut', onCut)
      editor.removeEventListener('click', onClick)
      menu.removeEventListener('mousedown', onMenuMouseDown)
      menu.removeEventListener('click', onMenuClick)
      if (activeEditorApi === api) closeMenu()
      delete editor.__mentionApi
    },
  }

  editor.__mentionApi = api
  return api
}

/**
 * Sync .is-selected on entity chips in composers (same as global entity links).
 * @param {ParentNode} [root]
 * @param {Set<string> | string[]} selected
 */
export function syncMentionSelection(root, selected) {
  const set =
    selected instanceof Set ? selected : new Set(selected || [])
  const scope = root || document
  scope
    .querySelectorAll?.(
      '.mention-editor a.entity-pill[data-entity], .mention-editor a.entity-link[data-entity], .mention-editor a.md-entity[data-entity]',
    )
    .forEach((a) => {
      const slug = a.dataset.entity
      a.classList.toggle('is-selected', Boolean(slug && set.has(slug)))
    })
}
