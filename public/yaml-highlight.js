/**
 * yaml-highlight.js — lightweight YAML syntax highlighter (no deps).
 * Used for pane B dual-layer editor (highlighted pre + transparent textarea).
 */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Highlight a single YAML line (no trailing newline).
 * @returns {string} HTML
 */
function highlightLine(line) {
  if (!line) return ''

  // Full-line comment
  if (/^\s*#/.test(line)) {
    return `<span class="yk-comment">${esc(line)}</span>`
  }

  // Preserve leading indent
  const mIndent = line.match(/^(\s*)(.*)$/)
  const indent = mIndent[1]
  let rest = mIndent[2]
  let html = esc(indent)

  // Document markers
  if (rest === '---' || rest === '...') {
    return html + `<span class="yk-doc">${esc(rest)}</span>`
  }

  // List item: - value  OR  - key: value
  let listPrefix = ''
  const listM = rest.match(/^(- )(.*)$/)
  if (listM) {
    listPrefix = `<span class="yk-punct">-</span> `
    rest = listM[2]
  }

  // key: value  (key may be quoted)
  const kv = rest.match(
    /^((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][\w.-]*))\s*(:)\s*(.*)$/,
  )
  if (kv) {
    const key = kv[1]
    const colon = kv[2]
    const val = kv[3]
    // UPPERCASE keys = brain relations
    const keyCls = /^[A-Z][A-Z0-9_]*$/.test(key) ? 'yk-rel' : 'yk-key'
    html += listPrefix + `<span class="${keyCls}">${esc(key)}</span>`
    html += `<span class="yk-punct">${esc(colon)}</span>`
    if (val) {
      html += highlightValue(val.startsWith(' ') ? val : ' ' + val)
    }
    return html
  }

  // Bare list value or scalar
  if (listPrefix) {
    return html + listPrefix + (rest ? highlightValue(' ' + rest).replace(/^\s/, '') || esc(rest) : '')
  }

  // Inline comment after content (naive: # not in quotes)
  const hash = findUnquotedHash(rest)
  if (hash >= 0) {
    return (
      html +
      esc(rest.slice(0, hash)) +
      `<span class="yk-comment">${esc(rest.slice(hash))}</span>`
    )
  }

  return html + esc(rest)
}

function findUnquotedHash(s) {
  let inSq = false
  let inDq = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && (inSq || inDq)) {
      i++
      continue
    }
    if (c === "'" && !inDq) inSq = !inSq
    else if (c === '"' && !inSq) inDq = !inDq
    else if (c === '#' && !inSq && !inDq) return i
  }
  return -1
}

function highlightValue(val) {
  // val usually starts with a space after colon
  const lead = val.match(/^(\s*)/)[1]
  const body = val.slice(lead.length)
  if (!body) return esc(val)

  // trailing comment
  const hash = findUnquotedHash(body)
  let main = body
  let comment = ''
  if (hash >= 0) {
    main = body.slice(0, hash)
    comment = body.slice(hash)
  }

  let inner = ''
  if (main === '|' || main === '>' || main === '|-' || main === '>-' || main === '|+' || main === '>+') {
    inner = `<span class="yk-punct">${esc(main)}</span>`
  } else if (/^(true|false|null|True|False|Null|TRUE|FALSE|NULL|~)$/.test(main.trim())) {
    inner = `<span class="yk-bool">${esc(main)}</span>`
  } else if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(main.trim())) {
    inner = `<span class="yk-number">${esc(main)}</span>`
  } else if (
    (main.startsWith('"') && main.endsWith('"')) ||
    (main.startsWith("'") && main.endsWith("'"))
  ) {
    inner = `<span class="yk-string">${esc(main)}</span>`
  } else if (/^[A-Z][A-Za-z0-9]*\/[A-Za-z0-9._-]+$/.test(main.trim())) {
    // brain slug Class/id
    inner = `<span class="yk-ref">${esc(main)}</span>`
  } else if (/^\d{4}-\d{2}-\d{2}/.test(main.trim())) {
    inner = `<span class="yk-date">${esc(main)}</span>`
  } else if (main.trim() === '[]' || main.trim() === '{}') {
    inner = `<span class="yk-punct">${esc(main)}</span>`
  } else {
    inner = `<span class="yk-value">${esc(main)}</span>`
  }

  let out = esc(lead) + inner
  if (comment) out += `<span class="yk-comment">${esc(comment)}</span>`
  return out
}

/**
 * Full-document YAML highlight → HTML (newlines preserved as <br> or \n in pre).
 * @param {string} text
 * @returns {string}
 */
export function highlightYaml(text) {
  const src = String(text ?? '')
  if (!src) return ''
  // Keep trailing newline for scroll alignment with textarea
  const endsWithNl = src.endsWith('\n')
  const lines = src.split('\n')
  // If ends with \n, last split element is ''; keep it for a final empty line
  const parts = lines.map((line, i) => {
    // last empty from trailing newline
    if (i === lines.length - 1 && line === '' && endsWithNl) return ''
    return highlightLine(line)
  })
  return parts.join('\n') + (endsWithNl && parts[parts.length - 1] !== '' ? '' : '')
}

export default highlightYaml
