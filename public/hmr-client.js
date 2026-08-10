/**
 * HMR client — m.js protocol (m-js-docs / node_modules/m-js/src/hot-client.js).
 *
 * Server:  WS /__m_hmr
 *   { type: 'connected' }
 *   { type: 'change', path: '/file.js' }
 *
 * Client:
 *   .css  → cache-bust matching <link>
 *   .js   → preload changed module, then window.__M_BOOT__(t)  [exactly one boot]
 *   .html → full reload
 */
const HMR_PROTO = location.protocol === 'https:' ? 'wss' : 'ws'
const HMR_URL = `${HMR_PROTO}://${location.host}/__m_hmr`

/** @type {((path: string) => void|Promise<void>) | null} */
let customHandler = null

/** @param {(path: string) => void|Promise<void>} fn */
export function onHotReload(fn) {
  customHandler = fn
}

function reloadCss(href) {
  const clean = href.split('?')[0]
  const links = document.querySelectorAll('link[rel="stylesheet"]')
  let found = false
  for (const link of links) {
    const url = new URL(/** @type {HTMLLinkElement} */ (link).href, location.href)
    if (
      url.pathname === clean ||
      url.pathname.endsWith(clean) ||
      clean.endsWith(url.pathname)
    ) {
      const next = /** @type {HTMLLinkElement} */ (link.cloneNode())
      next.href = `${url.pathname}?t=${Date.now()}`
      next.onload = () => link.remove()
      link.parentNode?.insertBefore(next, link.nextSibling)
      found = true
    }
  }
  if (!found) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = `${clean}?t=${Date.now()}`
    document.head.appendChild(link)
  }
  console.debug('[hmr] css', clean)
}

async function reloadJs(path) {
  console.debug('[hmr] js', path)
  if (customHandler) {
    await customHandler(path)
    return
  }
  const bust = Date.now()
  // Preload the changed module (helps when boot re-imports the graph)
  if (path && (path.startsWith('/') || path.startsWith('./'))) {
    const url = path.startsWith('/') ? path : `/${path}`
    try {
      await import(`${url}?t=${bust}`)
    } catch {
      /* boot will re-import */
    }
  }
  if (typeof window.__M_BOOT__ === 'function') {
    try {
      // Single boot — __M_BOOT__ is boot (or re-imports entry then boot once)
      await window.__M_BOOT__(bust)
      console.debug('[hmr] boot ok', bust)
    } catch (err) {
      console.error('[hmr] boot failed, full reload', err)
      location.reload()
    }
  } else {
    const entry = document.querySelector('script[data-hmr-entry]')
    const src =
      entry?.getAttribute('src') ||
      entry?.getAttribute('data-src') ||
      '/app.js'
    try {
      await import(`${src.split('?')[0]}?t=${bust}`)
    } catch (err) {
      console.error('[hmr] import failed, full reload', err)
      location.reload()
    }
  }
}

function connect() {
  let ws
  try {
    ws = new WebSocket(HMR_URL)
  } catch (err) {
    console.warn('[hmr] websocket unavailable', err)
    return
  }

  ws.addEventListener('open', () => {
    console.debug('[hmr] connected')
    document.documentElement.dataset.hmr = 'connected'
  })

  ws.addEventListener('message', async (ev) => {
    let msg
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (msg.type === 'connected') {
      console.debug('[hmr] server hello')
      return
    }
    // Official protocol is type: 'change' only (ignore legacy noise)
    if (msg.type !== 'change') return

    const file = msg.path || ''
    if (!file) return
    const path = file.startsWith('/') ? file : `/${file}`

    document.documentElement.dataset.hmr = 'updating'
    document.documentElement.dataset.hmrFile = path
    try {
      if (/\.css$/i.test(path)) {
        reloadCss(path)
      } else if (/\.(js|mjs)$/i.test(path)) {
        await reloadJs(path)
      } else if (/\.html$/i.test(path)) {
        location.reload()
        return
      }
    } finally {
      document.documentElement.dataset.hmr = 'connected'
      window.dispatchEvent(new CustomEvent('m:hmr', { detail: { path } }))
    }
  })

  ws.addEventListener('close', () => {
    document.documentElement.dataset.hmr = 'disconnected'
    setTimeout(connect, 1000)
  })

  ws.addEventListener('error', () => {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  })
}

if (typeof window !== 'undefined' && !window.__M_HMR_STARTED__) {
  window.__M_HMR_STARTED__ = true
  connect()
}

export default { onHotReload, connect }
