/**
 * net-activity.js — global pending-request counter for the top loading bar.
 *
 * - Patches window.fetch once (all SPA XHR-style traffic)
 * - entity-ws calls begin/end around WS RPC
 * - Depth → store.netPending so the shell can react
 */

/** @type {{ netPending?: number } | null} */
let storeRef = null
let depth = 0

function sync() {
  if (!storeRef) return
  // Always assign so m.js schedules a redraw when activity starts/stops
  storeRef.netPending = depth
}

/** Increment pending depth (safe to call before install). */
export function beginNet() {
  depth += 1
  sync()
}

/** Decrement pending depth (clamped at 0). */
export function endNet() {
  depth = Math.max(0, depth - 1)
  sync()
}

/**
 * Bind the reactive store and install the fetch patch (idempotent).
 * Call on every boot so HMR re-binds storeRef; fetch is only wrapped once.
 * @param {{ netPending?: number }} store
 */
export function installNetActivity(store) {
  storeRef = store
  if (store && typeof store.netPending !== 'number') {
    store.netPending = depth
  } else if (store) {
    store.netPending = depth
  }

  if (typeof window === 'undefined') return
  if (window.__tasksNetActivityInstalled) return
  window.__tasksNetActivityInstalled = true

  const origFetch = window.fetch.bind(window)
  window.fetch = function tasksTrackedFetch(input, init) {
    beginNet()
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      endNet()
    }
    try {
      const p = origFetch(input, init)
      return Promise.resolve(p).then(
        (res) => {
          done()
          return res
        },
        (err) => {
          done()
          throw err
        },
      )
    } catch (err) {
      done()
      throw err
    }
  }
}
