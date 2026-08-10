# theme.coffee — Vivacious palette + ANSI 24-bit helpers for CLI output.
#
# Source palette (COLOURlovers "vivacious"):
#   Kaaskop Pink   #CC0C39  crimson
#   Orange Sakura  #E6781E  orange
#   spring wind    #C8CF02  lime
#   Polpa di Pera  #F8FCC1  cream
#   blue lagoon    #1693A7  teal
#
# Keep in sync with public/styles.css :root tokens.

export RESET = '\x1b[0m'
export BOLD = '\x1b[1m'
export DIM = '\x1b[2m'

export palette =
  crimson: [204, 12, 57]
  orange: [230, 120, 30]
  lime: [200, 207, 2]
  cream: [248, 252, 193]
  teal: [22, 147, 167]
  text: [235, 232, 224]
  muted: [138, 144, 140]
  # priority map
  A: [204, 12, 57]
  B: [230, 120, 30]
  C: [22, 147, 167]
  D: [106, 112, 112]

export rgb = (r, g, b) -> "\x1b[38;2;#{r};#{g};#{b}m"

export bgRgb = (r, g, b) -> "\x1b[48;2;#{r};#{g};#{b}m"

export fg = (name) ->
  c = palette[name]
  return '' unless c
  rgb(c[0], c[1], c[2])

export useColor = ->
  return false if process.env.NO_COLOR? and process.env.NO_COLOR isnt ''
  return true if process.env.FORCE_COLOR? and process.env.FORCE_COLOR isnt '0'
  !!(process.stdout.isTTY)

# Paint text with a named palette color (no-op when color off).
export paint = (name, text, colorOn = useColor()) ->
  s = String(text ? '')
  return s unless colorOn and s
  open = fg(name)
  return s unless open
  open + s + RESET

export paintPriority = (pri, colorOn = useColor()) ->
  p = String(pri or 'D').toUpperCase()
  paint(p, p, colorOn)

export paintTeal = (text, colorOn = useColor()) -> paint('teal', text, colorOn)
export paintLime = (text, colorOn = useColor()) -> paint('lime', text, colorOn)
export paintOrange = (text, colorOn = useColor()) -> paint('orange', text, colorOn)
export paintCrimson = (text, colorOn = useColor()) -> paint('crimson', text, colorOn)
export paintMuted = (text, colorOn = useColor()) -> paint('muted', text, colorOn)
export paintCream = (text, colorOn = useColor()) -> paint('cream', text, colorOn)

# Colorize task.md-style shorthand (priority / checkbox / @ / # / `code`).
export colorizeShorthand = (text, colorOn = useColor()) ->
  s = String(text ? '')
  return s unless colorOn and s
  s
    .replace /\b([A-D])\b/g, (_, p) -> paintPriority(p, true)
    .replace /(\[[_rx\-]\])/g, (_, m) -> paint('orange', m, true)
    .replace /(@[A-Za-z0-9._\-\/]+)/g, (_, m) -> paint('teal', m, true)
    .replace /(#[A-Za-z0-9._-]+)/g, (_, m) -> paint('lime', m, true)
    .replace /(`[^`]+`)/g, (_, m) -> BOLD + paint('cream', m, true) + RESET

# Colorize a WorkUnit list line: id · status · priority · summary · tags
export colorizeWorkLine = (parts, colorOn = useColor()) ->
  # parts: { id, status, pri, summary, due, worker, tags, score?, index? }
  return plainWorkLine(parts) unless colorOn
  bits = []
  if parts.index?
    bits.push paintMuted(String(parts.index).padStart(2) + '.', true)
  if parts.score?
    bits.push paintCream(String(parts.score).padStart(6), true)
  bits.push paintTeal(parts.id, true) if parts.id?
  if parts.status?
    st = String(parts.status)
    stCol = switch st
      when 'done', 'completed' then 'lime'
      when 'active', 'in_progress', 'doing' then 'teal'
      when 'blocked', 'skipped' then 'crimson'
      else 'muted'
    bits.push paint(stCol, "[#{st}]", true)
  bits.push paintPriority(parts.pri or 'D', true) if parts.pri? or parts.pri is ''
  bits.push paint('text', parts.summary or '(untitled)', true)
  bits.push paintOrange("due:#{parts.due}", true) if parts.due
  bits.push paintTeal("@#{parts.worker}", true) if parts.worker
  if parts.tags
    tagStr = if Array.isArray(parts.tags) then parts.tags.join(' ') else String(parts.tags)
    bits.push paintLime(tagStr, true) if tagStr
  bits.join(' ')

plainWorkLine = (parts) ->
  bits = []
  bits.push String(parts.index).padStart(2) + '.' if parts.index?
  bits.push String(parts.score).padStart(6) if parts.score?
  bits.push parts.id if parts.id?
  bits.push "[#{parts.status}]" if parts.status?
  bits.push parts.pri if parts.pri?
  bits.push parts.summary or '(untitled)'
  bits.push "due:#{parts.due}" if parts.due
  bits.push "@#{parts.worker}" if parts.worker
  if parts.tags
    tagStr = if Array.isArray(parts.tags) then parts.tags.join(' ') else String(parts.tags)
    bits.push tagStr if tagStr
  bits.join(' ')
