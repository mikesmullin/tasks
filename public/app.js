/**
 * app.js — HMR boot entry.
 *
 * m.js intended use (m-js-docs + brain viz):
 *   1. M.store('name', { state + methods })  — survives HMR
 *   2. Router.register routes (title only; factory unused for SPA shell)
 *   3. M.mount('#app', () => ({ template: ONE_STATIC_SHELL, …handlers }))
 *   4. AFTER mount: replace Router.onChange so routes only write the store
 *      (M.mount's default onChange nulls rootInstance → full tree rebuild)
 *
 * Tab switches must NOT remount the shell or reload stylesheets — only
 * patch nav `.active` + x-show on the three page panes.
 */
import M, { Router } from '/m.min.js'
// m.js HMR client — connects to /__m_hmr (m-js-docs / m-js/hot-client protocol)
import '/hmr-client.js'
import { store } from './store.js'
import { mountApp } from './ui.js'
import { attachMentionEditor, setEditorText } from './mentions.js'
import { installNetActivity } from './net-activity.js'

function parsePath(path) {
  const p = (path || '/').replace(/\/+$/, '') || '/'
  if (p === '/') return { route: '/', params: {} }
  if (p === '/seed') return { route: '/seed', params: {} }
  if (p === '/browse') return { route: '/browse', params: {} }
  const m2 = p.match(/^\/browse\/([^/]+)\/([^/]+)$/)
  if (m2) {
    const cls = decodeURIComponent(m2[1])
    const id = decodeURIComponent(m2[2])
    return { route: '/browse/:cls/:id', params: { cls, id, slug: `${cls}/${id}` } }
  }
  const m1 = p.match(/^\/browse\/([^/]+)$/)
  if (m1) return { route: '/browse/:cls', params: { cls: decodeURIComponent(m1[1]) } }
  return { route: p, params: {} }
}

/** Entity pill links → schema browser */
function entityHref(slug) {
  return '/browse/' + String(slug || '')
}

/**
 * Shared wiki + @-mention composer (WorkUnits A · English, Seed A · Description).
 * One implementation for both tabs — chips, autocomplete, wiki serialize.
 *
 * @param {string} elId host element id
 * @param {{
 *   onChange: (text: string) => void,
 *   getText?: () => string,
 * }} cfg
 * @returns {object|null} mention API or null
 */
function attachWikiComposer(elId, cfg) {
  const el = document.getElementById(elId)
  if (!el) return null
  if (el.__mentionApi) return el.__mentionApi
  try {
    el.classList.add('mention-editor', 'mention-editor-multi', 'composer')
    const api = attachMentionEditor(el, {
      multiline: true,
      // Enter = newline (not chat-style submit)
      submitOnEnter: false,
      hrefFor: entityHref,
      onChange: (text) => {
        cfg.onChange?.(text)
      },
      onEntityClick: (slug) => {
        // Existing → Schema; missing → Seed create (locked slug)
        void store.openEntityOrSeed(slug)
      },
    })
    // Hydrate chips from store without scheduling NL (caller may also sync)
    const want = cfg.getText?.() ?? ''
    if (String(want).trim()) {
      setEditorText(el, want, { hrefFor: entityHref })
      el.dataset.empty = '0'
    } else {
      el.dataset.empty = '1'
    }
    return api
  } catch (err) {
    console.warn(`wiki composer attach failed (${elId})`, err)
    return null
  }
}

/** Programmatic fill of a wiki composer (no caret jump if already matching). */
function setWikiComposerText(elId, text) {
  const el = document.getElementById(elId)
  if (!el) return
  setEditorText(el, text || '', { hrefFor: entityHref })
  const empty =
    !String(text || '').trim() && !el.querySelector('a.entity-link[data-entity]')
  el.dataset.empty = empty ? '1' : '0'
}

/**
 * Bind WorkUnits pane A (idempotent).
 */
function attachWorkUnitsComposer() {
  return attachWikiComposer('pane-a', {
    onChange: (text) => store.onPaneAWikiChange(text),
    getText: () => store.paneA || '',
  })
}

/**
 * Bind Seed section A (idempotent).
 */
function attachSeedComposer() {
  return attachWikiComposer('seed-a', {
    onChange: (text) => store.onSeedWikiChange(text),
    getText: () => store.seedText || '',
  })
}

// Expose for store.sync*Dom without circular imports at module init
store._entityHref = entityHref
store._setPaneAEditorText = (text) => setWikiComposerText('pane-a', text)
store._setSeedAEditorText = (text) => setWikiComposerText('seed-a', text)

export async function boot() {
  // Store is created on import (named store survives HMR).
  void store
  store._navigate = (path) => Router.set(path)
  // Pause NL debounce while @-mention suggest is open
  store.installMentionDebounceGuard?.()

  // Top loading bar: wrap fetch + bind netPending (idempotent; HMR re-binds store)
  installNetActivity(store)

  // Schema expand map + last path before first route apply
  store.loadSchemaStateFromStorage?.()
  store.loadLayoutFromStorage()

  Router.setMode('path')
  Router.setBase('')

  // Register so deep links match; factories unused (static shell template).
  const noop = () => ({ template: '' })
  Router.register('/', 'Data Editor — WorkUnits', noop)
  Router.register('/seed', 'Data Editor — Seed', noop)
  Router.register('/browse', 'Data Editor — Schema', noop)
  Router.register('/browse/:cls', 'Data Editor — Class', noop)
  Router.register('/browse/:cls/:id', 'Data Editor — Entity', noop)

  // Route → store only (never remount). Installed inside mountApp so it
  // immediately replaces M.mount's clearInstances-on-route handler.
  const syncRoute = async () => {
    const path = Router.uri || location.pathname || '/'
    const { route, params } = parsePath(path)
    await store.onRoute(route, params)
    // WorkUnits page: (re)bind mentions if the contenteditable host was recreated
    if (route === '/') {
      queueMicrotask(() => {
        attachWorkUnitsComposer()
        store.ensurePaneAHydrated?.()
        store.paintPaneBHighlight?.()
      })
    }
    // Seed page: same wiki composer as WorkUnits A
    if (route === '/seed') {
      queueMicrotask(() => {
        attachSeedComposer()
        store.ensureSeedAHydrated?.()
      })
    }
    // Schema: paint dual-layer YAML if entity detail is open; warm expanded lists
    if (String(route || '').startsWith('/browse')) {
      queueMicrotask(() => {
        store.paintEntityYamlHighlight?.()
        void store.prefetchExpandedClassEntities?.()
      })
    }
  }

  mountApp(syncRoute)

  // M.mount already called Router.start() — do not start twice (duplicate listeners).
  // Apply current URL once (start() does not invoke onChange).
  await syncRoute()

  // Initial YAML highlight paint (pre is not x-html-bound)
  queueMicrotask(() => store.paintPaneBHighlight?.())

  // Restore unsaved New WorkUnit draft after mount (survives refresh/HMR).
  // Do NOT re-run NL/LLM here — A/B/D/Q were persisted; only user edits to A
  // (or answering Q / Re-translate) should schedule parse.
  if (store.route === '/' && !store.selectedId) {
    if (store.restoreDraftFromStorage()) {
      queueMicrotask(() => {
        attachWorkUnitsComposer()
        store.syncPaneADom()
      })
    } else {
      queueMicrotask(attachWorkUnitsComposer)
    }
  } else if (store.route === '/') {
    queueMicrotask(attachWorkUnitsComposer)
  }

  // Seed A/B/V/C draft from localStorage (no LLM re-run on refresh)
  if (store.route === '/seed') {
    store.restoreSeedFromStorage?.()
    queueMicrotask(() => {
      attachSeedComposer()
      store.syncSeedADom?.()
    })
  }

  void store.refreshGit()
  if (!window.__TASKS_GIT_POLL__) {
    window.__TASKS_GIT_POLL__ = setInterval(() => void store.refreshGit(), 15000)
  }

  // Brain server LED — persistent WebSocket (push on change / instant disconnect)
  if (window.__TASKS_BRAIN_POLL__) {
    clearInterval(window.__TASKS_BRAIN_POLL__)
    window.__TASKS_BRAIN_POLL__ = null
  }
  store.startBrainStatusWs?.()
}

/**
 * m.js HMR contract (docs):
 *   window.__M_BOOT__ = boot   // same function HMR will call
 *   await boot()               // exactly once on first evaluation
 *
 * On JS change, hot-client preloads the changed module then calls
 * __M_BOOT__(t). For static import graphs we re-import this entry with ?t=
 * so store/ui pick up, but only the *fresh* module's boot runs — re-imports
 * with ?t= must not auto-await boot() again (that was the double-boot wipe).
 */
window.__M_BOOT__ = async (bust) => {
  if (bust != null && bust !== false) {
    const base = import.meta.url.split('?')[0]
    const mod = await import(`${base}?t=${bust}`)
    await mod.boot()
    return
  }
  await boot()
}

// First document load only (bare /app.js, no HMR cache-bust query)
const _isHmrReimport = /[?&]t=/.test(import.meta.url)
if (!_isHmrReimport) {
  await boot()
}
