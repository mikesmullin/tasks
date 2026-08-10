/**
 * wiki.js — render prose with {{Class/id|Label}} wiki links as clickable chips.
 * tasks uses {{…}} only (not brain [[…]]).
 */
import { Router } from '/m.min.js'

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const WIKI_RE = /\{\{\s*([^}|#]+)(?:\|([^}]+))?\s*\}\}/g

/**
 * Scrub markdown bold markers and junk that LLMs leak into slugs/ids
 * (e.g. product_atlas_suite**). Class stays as-is when present.
 */
export function sanitizeSlug(slug) {
  let s = String(slug ?? '').trim()
  if (!s) return ''
  // strip markdown emphasis left in or around the token
  s = s.replace(/\*+/g, '').replace(/`+/g, '').trim()
  const i = s.indexOf('/')
  if (i <= 0) {
    return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || s
  }
  const cls = s.slice(0, i)
  let id = s.slice(i + 1).replace(/\*+/g, '').replace(/[^A-Za-z0-9._-]+/g, '-')
  id = id.replace(/^-+|-+$/g, '')
  return id ? `${cls}/${id}` : cls
}

/** Display id tail for a slug (after sanitize). */
export function slugIdLabel(slug) {
  const s = sanitizeSlug(slug)
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

/** Inline wiki chips only (no block markdown). */
export function renderWikiHtml(text) {
  const src = String(text ?? '')
  let out = ''
  let last = 0
  let m
  WIKI_RE.lastIndex = 0
  while ((m = WIKI_RE.exec(src))) {
    out += esc(src.slice(last, m.index)).replace(/\n/g, '<br>')
    const slug = sanitizeSlug(m[1] || '')
    const id = slugIdLabel(slug)
    out +=
      `<a class="entity-link entity-pill" href="/browse/${esc(slug)}" data-entity="${esc(slug)}" title="${esc(slug)}">` +
      `${esc(id)}</a>`
    last = m.index + m[0].length
  }
  out += esc(src.slice(last)).replace(/\n/g, '<br>')
  return out
}

/**
 * Lightweight markdown → HTML, then wiki chips.
 * Supports: paragraphs, blank lines, **bold**, *italic*, `code`, lists (-/*), links.
 */
export function renderMarkdownHtml(text) {
  const src = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (!src) return ''

  const lines = src.split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++
      continue
    }
    // unordered list
    if (/^\s*[-*]\s+/.test(lines[i])) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
      }
      blocks.push(
        '<ul>' +
          items.map((it) => `<li>${inlineMd(it)}</li>`).join('') +
          '</ul>',
      )
      continue
    }
    // paragraph (until blank)
    const paras = []
    while (i < lines.length && lines[i].trim() && !/^\s*[-*]\s+/.test(lines[i])) {
      paras.push(lines[i])
      i++
    }
    blocks.push(`<p>${inlineMd(paras.join(' '))}</p>`)
  }
  return blocks.join('')
}

function inlineMd(s) {
  // wiki first → placeholders so ** etc. don't break chips
  const slots = []
  let t = String(s ?? '').replace(WIKI_RE, (_, slugRaw, labRaw) => {
    const slug = sanitizeSlug(slugRaw || '')
    // Prefer explicit label; scrub markdown junk from it too
    let label = labRaw != null && String(labRaw).trim()
      ? String(labRaw).trim().replace(/\*+/g, '')
      : slugIdLabel(slug)
    const html =
      `<a class="entity-link entity-pill" href="/browse/${esc(slug)}" data-entity="${esc(slug)}" title="${esc(slug)}">` +
      `${esc(label)}</a>`
    const i = slots.length
    slots.push(html)
    return `\uE000${i}\uE001`
  })
  t = esc(t)
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  // Balanced **bold** / *italic*
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  // Orphan markdown emphasis left by bad LLM output (e.g. id**)
  t = t.replace(/\*+/g, '')
  t = t.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  )
  t = t.replace(/\uE000(\d+)\uE001/g, (_, n) => slots[Number(n)] || '')
  return t
}

/** Click handler: entity chips → browse route. */
export function onWikiClick(e) {
  const a = e.target?.closest?.('a[data-entity]')
  if (!a) return
  e.preventDefault()
  const slug = a.getAttribute('data-entity')
  if (slug) Router.set(`/browse/${slug}`)
}
