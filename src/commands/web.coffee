# web.coffee — tasks web: Bun.serve four-pane SPA (brain viz pattern).
import { readFile, readdir, stat } from 'fs/promises'
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, readdirSync, watch } from 'fs'
import { join, dirname, extname, normalize, basename } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'
import { parseArgs } from '../args.coffee'
import { paths, loadConfig } from 'brain/config'
import { request, requestStream, serverRunning, noServerError } from '../rpc.coffee'
import { listWorkUnits, getWorkUnit, putWorkUnit, setWorkUnitFields, deleteWorkUnit, toScoreShape } from '../workunits.coffee'
import { rankNext } from '../score.coffee'
import { parseNl } from '../agents/nl-to-workunit.coffee'
import { persistDraft } from '../agents/persist-draft.coffee'
import { parseNlEntities, persistEntities, buildContext } from '../agents/nl-to-entities.coffee'
import { judgeMerge, judgeMerges } from '../agents/merge-judge.coffee'
import { render as renderShorthand, parse as parseShorthand } from '../../public/shorthand.js'
import { toContentObject, normalizeFields, stampNew, shortId } from '../workunit.coffee'
import { listClasses, listEntities, getEntity, putEntity, deleteEntity, entityToYaml, relationCounts } from '../entities.coffee'
import { gitStatus, gitSnapshot } from '../git-db.coffee'
import { formatSlug, parseSlug } from 'brain/slug'

MIME =
  '.html': 'text/html; charset=utf-8'
  '.js': 'text/javascript; charset=utf-8'
  '.mjs': 'text/javascript; charset=utf-8'
  '.css': 'text/css; charset=utf-8'
  '.json': 'application/json'
  '.svg': 'image/svg+xml'
  '.png': 'image/png'
  '.woff2': 'font/woff2'
  '.map': 'application/json'

json = (obj, status = 200) ->
  new Response JSON.stringify(obj),
    status: status
    headers: { 'content-type': 'application/json; charset=utf-8' }

text = (s, status = 200, type = 'text/plain; charset=utf-8') ->
  new Response s, status: status, headers: { 'content-type': type }

# @-mention fallback: keyword FTS often misses short prefixes ("di", "D")
# or bare "@". Scan class ids via ls (capped) and match slug/id substring.
prefixEntitySearch = (cwd, query, limit = 8) ->
  raw = String(query or '').trim()
  # Client may send "*" for empty @ query
  q = if raw is '*' then '' else raw.toLowerCase()
  info = null
  try
    info = await request(cwd, 'schema_info', {})
  catch
    return []
  classes = Object.keys(info?.classes or {})
  hits = []
  seen = new Set()
  for cls in classes
    break if hits.length >= limit
    try
      await requestStream cwd, 'ls', { class: cls }, (item) ->
        return if hits.length >= limit
        id = String(item?.id or '')
        return unless id
        slug = "#{cls}/#{id}"
        key = slug.toLowerCase()
        return if seen.has(key)
        idL = id.toLowerCase()
        match = if not q
          true
        else
          idL.includes(q) or key.includes(q) or cls.toLowerCase().includes(q)
        return unless match
        seen.add(key)
        hits.push {
          slug: slug
          score: if q and idL.startsWith(q) then 1 else 0.5
          preview: { naming: { name: id } }
        }
    catch then continue
  # Enrich previews for top hits (best-effort labels)
  for h in hits.slice(0, limit)
    try
      e = await request(cwd, 'get_entity', { slug: h.slug, include_links: false })
      h.preview = e.components or h.preview
    catch then undefined
  hits.slice(0, limit)

export run = (argv, cwd = process.cwd()) ->
  { flags } = parseArgs(argv, {})
  throw noServerError(cwd) unless serverRunning(cwd)
  port = if flags.port then parseInt(flags.port, 10) else 4322

  tasksLock = join(paths(cwd).root, '.tasksweb.lock')
  if existsSync(tasksLock)
    existing = try JSON.parse(readFileSync(tasksLock, 'utf-8')) catch then null
    alive = existing?.pid and (try process.kill(existing.pid, 0); true catch then false)
    if alive
      console.error "tasks web already running for #{paths(cwd).root} (PID #{existing.pid}, port #{existing.port ? '?'})."
      return 1
    console.log "tasks web: removing stale lock (PID #{existing?.pid ? '?'} is not alive)"
    unlinkSync(tasksLock)
  writeFileSync(tasksLock, JSON.stringify({ pid: process.pid, started: Date.now(), port }))
  releaseLock = ->
    try unlinkSync(tasksLock) if existsSync(tasksLock)
  process.on 'exit', releaseLock
  for sig in ['SIGINT', 'SIGTERM']
    process.on sig, ->
      releaseLock()
      process.exit(0)

  publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public')
  # m.js from linked package
  mJsDir = null
  try
    mJsDir = dirname(Bun.resolveSync('m-js/package.json', import.meta.dir))
  catch
    try
      mJsDir = dirname(fileURLToPath(await import.meta.resolve('m-js/package.json')))
    catch
      mJsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', 'm-js')

  # Dev-server asset headers.
  #
  # `no-store` is NOT optional here. Without an explicit cache directive these
  # responses also carried no ETag and no Last-Modified, so the browser could
  # neither judge freshness nor revalidate — it simply reused whatever copy it
  # had. The visible symptom was styles.css randomly rendering an older theme
  # depending on how the page was refreshed (normal reload = stale copy from
  # cache, hard reload = fresh fetch). `brain viz` sets the same header on
  # every static response for exactly this reason.
  assetHeaders = (ext) ->
    'content-type': MIME[ext] or 'application/octet-stream'
    'cache-control': 'no-store, must-revalidate'

  # Cache-bust token for the entry-point assets, derived from their mtime.
  #
  # `no-store` (above) only governs responses fetched AFTER it was added. A copy
  # the browser stored EARLIER — under a response with no cache-control, no
  # ETag and no Last-Modified — stays usable and cannot be revalidated, so a
  # plain reload may keep serving it indefinitely. That is the "every 3rd
  # refresh shows the old theme" symptom, and it survives fixing the header.
  #
  # Changing the URL is what actually retires those entries: /styles.css?v=<mtime>
  # cannot match a cache key stored for /styles.css. The token is the file's
  # mtime, so it is stable while the file is and changes the moment it is edited.
  assetToken = (rel) ->
    try String(Math.floor(statSync(join(publicDir, rel)).mtimeMs)) catch then '0'

  serveIndex = ->
    fp = join(publicDir, 'index.html')
    return null unless existsSync(fp)
    html = readFileSync(fp, 'utf-8')
      # Cache-bust CSS only. Do NOT rewrite __M_BOOT__() — m.js HMR expects a
      # single boot on load; injecting a busted re-import caused a second boot
      # that wiped restored draft state after first paint.
      .replace(/(href=")(\/styles\.css)(")/g, "$1$2?v=#{assetToken('styles.css')}$3")
    new Response html, headers: assetHeaders('.html')

  serveStatic = (urlPath) ->
    rel = decodeURIComponent(urlPath.split('?')[0])
    return serveIndex() if rel in ['/', '', '/index.html']
    # prevent path escape
    clean = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '')
    fp = join(publicDir, clean)
    return null unless fp.startsWith(publicDir)
    return null unless existsSync(fp) and statSync(fp).isFile()
    ext = extname(fp)
    new Response Bun.file(fp), headers: assetHeaders(ext)

  # m.js HMR protocol: { type: 'connected' } on open, { type: 'change', path } on file save
  # (see m-js-docs “Adding HMR to a server you already have” / m-js/hot-client)
  hmrClients = new Set()
  broadcastHmr = (path) ->
    # path must be URL-style absolute from site root, e.g. /styles.css
    rel = if String(path).startsWith('/') then path else "/#{path}"
    msg = JSON.stringify({ type: 'change', path: rel })
    for ws from hmrClients
      try ws.send(msg) catch then undefined

  # poll public/ mtimes (ignoreInitial equivalent: first scan only seeds the map)
  mtimes = new Map()
  pollPublic = ->
    try
      walk = (dir, base = '') ->
        for name in readdirSyncSafe(dir)
          fp = join(dir, name)
          rel = if base then "#{base}/#{name}" else name
          try
            st = statSync(fp)
            if st.isDirectory()
              walk(fp, rel)
            else
              prev = mtimes.get(rel)
              mtimes.set(rel, st.mtimeMs)
              if prev? and prev isnt st.mtimeMs
                broadcastHmr("/#{rel.replace(/\\\\/g, '/')}")
          catch then undefined
      walk(publicDir)
    catch then undefined

  readdirSyncSafe = (d) ->
    try
      readdirSync(d)
    catch
      []

  setInterval pollPublic, 300

  # ── Brain liveness → push to SPA over WebSocket (no client poll) ──
  brainStatusClients = new Set()
  lastBrainSnapKey = null
  brainStatusInflight = null  # coalesce: never pile schema RPCs if one hangs

  # Bound health RPC so a wedged brain cannot pin tasks-web event loop forever.
  # Save/put should be ms; if status needs >3s, treat as down for the LED.
  withTimeout = (promise, ms, label) ->
    new Promise (resolve, reject) ->
      settled = false
      timer = setTimeout ->
        return if settled
        settled = true
        reject new Error("#{label} timed out after #{ms}ms")
      , ms
      promise.then(
        (v) ->
          return if settled
          settled = true
          clearTimeout(timer)
          resolve(v)
        (err) ->
          return if settled
          settled = true
          clearTimeout(timer)
          reject(err)
      )

  snapshotBrainHealth = ->
    dbRoot = paths(cwd).root
    unless serverRunning(cwd)
      return {
        ok: false
        brain: false
        detail: noServerError(cwd).message
        db: dbRoot
      }
    try
      # Prefer cheap `status` over schema_info — same liveness, less pglite work
      # during concurrent put_entity (health runs every 2s).
      st = await withTimeout(request(cwd, 'status', {}), 3000, 'brain status')
      nCls = st.classes or 0
      nEnt = st.entities ? '?'
      return {
        ok: true
        brain: true
        detail: "brain server running · #{nCls} classes · #{nEnt} entities · #{dbRoot}"
        db: dbRoot
        classes: nCls
        entities: st.entities
        embed: st.embed
      }
    catch err
      return {
        ok: false
        brain: false
        detail: String(err.message or err)
        db: dbRoot
      }

  broadcastBrainStatus = (snap, force = false) ->
    key = "#{snap.brain}|#{snap.detail or ''}"
    return if not force and key is lastBrainSnapKey
    lastBrainSnapKey = key
    msg = JSON.stringify(Object.assign({ type: 'brain_status', at: Date.now() }, snap))
    for client from brainStatusClients
      try client.send(msg) catch then undefined

  pushBrainStatus = (force = false) ->
    # One in-flight snapshot at a time — avoids N hung schema_info when brain wedges
    return brainStatusInflight if brainStatusInflight
    brainStatusInflight = do ->
      try
        snap = await snapshotBrainHealth()
        broadcastBrainStatus(snap, force)
      catch err
        broadcastBrainStatus({
          ok: false
          brain: false
          detail: String(err.message or err)
          db: paths(cwd).root
        }, force)
      finally
        brainStatusInflight = null
    brainStatusInflight

  # Instant-ish detection: sock/lock create/remove under the brain db root
  try
    watcher = watch paths(cwd).root, { persistent: true }, (event, filename) ->
      name = if filename then String(filename) else ''
      base = basename(name)
      if base in ['.sock', '.lock'] or name in ['.sock', '.lock']
        pushBrainStatus(false)  # fire-and-forget promise
    # sock unlink/recreate (brain restart) emits ENXIO — must not crash web
    watcher.on? 'error', (err) ->
      console.warn "tasks web: db watch error (#{err?.code or err?.message or err})"
  catch
    # watch unsupported — interval below still covers it
    undefined

  # Fallback + recovery when sock reappears after crash (watch can miss races)
  setInterval (-> pushBrainStatus(false)), 2000
  # idleTimeout: Bun default is 10s. 30s covers short LLM tool turns / RPC
  # without letting hung handlers sit for minutes. Writes should be << 3s;
  # NL runs may need a bit longer between stream chunks.
  server = Bun.serve
    port: port
    idleTimeout: 30
    fetch: (req, server) ->
      url = new URL(req.url)
      pathname = url.pathname
      try
        # WebSocket upgrades
        if pathname in ['/__m_hmr', '/__entity_ws', '/__brain_ws']
          ok = server.upgrade req, data: { path: pathname }
          return if ok then undefined else new Response('WS upgrade failed', status: 400)

        if pathname is '/m.min.js'
          fp = join(mJsDir, 'dist', 'm.min.js')
          unless existsSync(fp)
            fp = join(mJsDir, 'dist', 'm.js')
          return new Response Bun.file(fp), headers: assetHeaders('.js')

        if pathname is '/m.js'
          fp = join(mJsDir, 'dist', 'm.js')
          return new Response Bun.file(fp), headers: assetHeaders('.js')

        # Official m.js HMR client (docs: import 'm-js/hot-client')
        if pathname in ['/m-js/hot-client', '/m-js/hot-client.js']
          fp = join(mJsDir, 'src', 'hot-client.js')
          if existsSync(fp)
            return new Response Bun.file(fp), headers: assetHeaders('.js')

        # entity-model.js lives in brain (shared SPA model); serve from linked package
        if pathname is '/entity-model.js'
          brainPublic = null
          try
            brainPublic = join(dirname(Bun.resolveSync('brain/package.json', import.meta.dir)), 'public')
          catch
            brainPublic = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', 'brain', 'public')
          fp = join(brainPublic, 'entity-model.js')
          if existsSync(fp)
            return new Response Bun.file(fp), headers: assetHeaders('.js')

        # --- API ---
        # One-shot brain health (WS is primary for the SPA LED)
        if pathname is '/health' and req.method is 'GET'
          return json await snapshotBrainHealth()

        if pathname is '/tasks' and req.method is 'GET'
          list = toScoreShape(await listWorkUnits(cwd))
          ranked = rankNext(list, { limit: list.length or 1, includeDone: true })
          # include done at end with scores
          scoredIds = new Set(ranked.map (w) -> w.id)
          for w in list when not scoredIds.has(w.id)
            ranked.push Object.assign({}, w, { score: 0 })
          return json ranked.map (w) ->
            {
              id: w.id
              shortId: shortId(w.id)
              summary: w.summary
              status: w.status
              important: w.important
              urgent: w.urgent
              tags: w.tags
              due: w.due
              worker: w.worker
              score: w.score
              dependsOn: w.dependsOn
            }

        if pathname.startsWith('/task/') and req.method is 'GET'
          id = decodeURIComponent(pathname.slice('/task/'.length))
          wu = await getWorkUnit(cwd, id)
          return json wu

        if pathname is '/task' and req.method is 'POST'
          body = await req.json()
          fields = body.workunit or body.fields or body
          dependsOn = body.DEPENDS_ON or body.dependsOn or []
          pending = body.pendingEntities or body.pending_entities or []
          if pending.length
            result = await persistDraft(cwd, {
              fields
              dependsOn
              pendingEntities: pending
              isNew: true
              overwrite: true
            })
            return json Object.assign({}, result.workunit, {
              _persist: {
                created: result.created
                skipped: result.skipped
                failed: result.failed
              }
            })
          wu = await putWorkUnit(cwd, fields, dependsOn, { isNew: true, overwrite: true })
          return json wu

        if pathname.startsWith('/task/') and req.method is 'PATCH'
          id = decodeURIComponent(pathname.slice('/task/'.length))
          if id.endsWith('/checklist')
            realId = id.slice(0, -'/checklist'.length)
            body = await req.json()
            wu = await getWorkUnit(cwd, realId)
            # body: { index, state } toggle checklist line in description
            lines = String(wu.description or '').split('\n')
            idx = Number(body.index)
            re = /^(\s*-\s*\[)[ xX~\-](\]\s*.*)$/
            count = -1
            for line, i in lines
              if re.test(line)
                count++
                if count is idx
                  box = body.state or 'x'
                  box = if box is 'done' or box is true then 'x' else if box is 'progress' then '~' else if box is 'skipped' then '-' else ' '
                  lines[i] = line.replace(re, "$1#{box}$2")
                  break
            await setWorkUnitFields(cwd, realId, ["description=#{lines.join('\n')}"])
            return json await getWorkUnit(cwd, realId)
          body = await req.json()
          if body.fields or body.workunit
            fields = Object.assign({}, (await getWorkUnit(cwd, id)), body.workunit or body.fields)
            dependsOn = body.DEPENDS_ON or body.dependsOn or fields.dependsOn or []
            wu = await putWorkUnit(cwd, fields, dependsOn, { isNew: false, overwrite: true })
            return json wu
          if body.assignments
            wu = await setWorkUnitFields(cwd, id, body.assignments)
            return json wu
          # flat patch
          assignments = ("#{k}=#{v}" for own k, v of body when k not in ['id', 'dependsOn', 'DEPENDS_ON', 'slug'])
          wu = await setWorkUnitFields(cwd, id, assignments)
          return json wu

        if pathname.startsWith('/task/') and req.method is 'DELETE'
          id = decodeURIComponent(pathname.slice('/task/'.length))
          # deps delete: /task/:id/deps/:target
          m = id.match(/^(.+)\/deps\/(.+)$/)
          if m
            # re-put without that dep
            wu = await getWorkUnit(cwd, m[1])
            target = m[2]
            target = "WorkUnit/#{target}" unless target.includes('/')
            deps = (wu.dependsOn or []).filter (d) -> d isnt target and not d.endsWith("/#{target.split('/').pop()}")
            fields = Object.assign({}, wu)
            delete fields.dependsOn
            await putWorkUnit(cwd, fields, deps, { isNew: false, overwrite: true })
            return json await getWorkUnit(cwd, m[1])
          r = await deleteWorkUnit(cwd, id)
          return json r

        if pathname.match(/^\/task\/[^/]+\/deps$/) and req.method is 'POST'
          id = decodeURIComponent(pathname.split('/')[2])
          body = await req.json()
          to = body.to or body.target
          throw new Error('to required') unless to
          to = "WorkUnit/#{to}" unless String(to).includes('/')
          wu = await getWorkUnit(cwd, id)
          deps = [...(wu.dependsOn or [])]
          deps.push(to) unless deps.includes(to)
          fields = Object.assign({}, wu)
          delete fields.dependsOn
          await putWorkUnit(cwd, fields, deps, { isNew: false, overwrite: true })
          return json await getWorkUnit(cwd, id)

        if pathname is '/nl/parse' and req.method is 'POST'
          body = await req.json()
          # req.signal aborts when browser fetch is cancelled (typing supersedes)
          result = await parseNl body.text or '',
            cwd: cwd
            today: body.today
            nowLong: body.nowLong
            knownPeople: body.knownPeople
            knownTags: body.knownTags
            existing: body.existing or body.context
            clarifyingQuestions: body.clarifyingQuestions or body.questions or []
            pendingEntities: body.pendingEntities or []
            latestShorthand: body.latestShorthand or body.shorthand or ''
            latestYaml: body.latestYaml or body.yaml or ''
            validationFeedback: body.validationFeedback or body.validation or ''
            forceLlm: body.forceLlm is true
            signal: req.signal
          return json
            workunit: result.fields
            dependsOn: result.dependsOn
            source: result.source
            clarifyingQuestions: result.clarifyingQuestions or []
            pendingEntities: result.pendingEntities or []
            warning: result.warning
            yaml: yaml.dump(toContentObject(result.fields, result.dependsOn), { lineWidth: 100, noRefs: true, sortKeys: false })

        # Dry-run brain validate (no write). Single: {slug, content}; batch: {entities:[{slug,content}]}
        if pathname is '/validate' and req.method is 'POST'
          body = await req.json()
          if Array.isArray(body.entities) and body.entities.length
            res = await request(cwd, 'validate_entities', { entities: body.entities })
            return json res
          slug = body.slug
          content = body.content ? body.yaml ? ''
          throw new Error('slug and content required') unless slug
          res = await request(cwd, 'validate_entity', { slug, content })
          return json res

        if pathname is '/shorthand/render' and req.method is 'POST'
          body = await req.json()
          fields = body.workunit or body.fields or body
          deps = body.dependsOn or body.DEPENDS_ON or []
          return json { text: renderShorthand(normalizeFields(fields), { dependsOn: deps }) }

        if pathname is '/shorthand/parse' and req.method is 'POST'
          body = await req.json()
          { workunits } = parseShorthand(body.text or '')
          docs = workunits.map (n) ->
            f = stampNew(n.fields)
            { workunit: f, dependsOn: n.dependsOn }
          return json { workunits: docs }

        if pathname is '/search' and req.method is 'GET'
          q = url.searchParams.get('q') or url.searchParams.get('query') or ''
          strategy = url.searchParams.get('strategy') or 'keyword'
          limit = parseInt(url.searchParams.get('limit') or '8', 10)
          res = await request(cwd, 'search', { query: q, strategy, limit })
          # Normalize to array; keyword FTS often returns [] for short prefixes
          hits = if Array.isArray(res) then res else (res?.results or res?.hits or [])
          unless hits.length
            # Prefix / substring fallback for @-mention typeahead (short queries)
            hits = await prefixEntitySearch(cwd, q, limit)
          return json hits

        # LLM-as-judge: may a seed proposal overwrite an existing slug?
        if pathname is '/nl/seed/merge-judge' and req.method is 'POST'
          body = await req.json()
          sketch = body.sketch or body.text or body.seedText or ''
          if Array.isArray(body.conflicts) and body.conflicts.length
            results = await judgeMerges({
              cwd
              sketch
              conflicts: body.conflicts
              signal: req.signal
            })
            return json { results }
          slug = body.slug or ''
          throw new Error('slug required') unless slug
          j = await judgeMerge({
            cwd
            sketch
            slug
            existing: body.existing
            proposed: body.proposed
            signal: req.signal
          })
          return json j

        if pathname is '/labels' and req.method is 'GET'
          slugs = (url.searchParams.get('slugs') or '').split(',').filter(Boolean)
          labels = {}
          for slug in slugs
            try
              e = await request(cwd, 'get_entity', { slug, include_links: false })
              # best-effort display
              labels[slug] = e.components?.identity?.name or e.components?.workunit?.summary or e.components?.naming?.name or slug.split('/').pop()
            catch
              labels[slug] = slug.split('/').pop()
          return json { labels }

        if pathname is '/display-fields' and req.method is 'GET'
          info = await request(cwd, 'schema_info', {})
          classes = info.classes or info.schema?.classes or {}
          out = {}
          for own cls, def of classes
            out[cls] = def.displayField if def?.displayField
          return json out

        if pathname is '/nodes' and req.method is 'GET'
          slugs = (url.searchParams.get('slugs') or '').split(',').filter(Boolean)
          entities = []
          for slug in slugs
            try
              e = await request(cwd, 'get_entity', { slug, include_links: false })
              entities.push e
            catch then undefined
          return json { entities }

        if pathname is '/entity/set' and req.method is 'POST'
          body = await req.json()
          slug = body.slug
          assignments = body.assignments or []
          res = await request(cwd, 'set_instance', { slug, assignments })
          return json res

        if pathname is '/schema' and req.method is 'GET'
          info = await request(cwd, 'schema_info', {})
          return json info

        if pathname is '/schema/tree' and req.method is 'GET'
          return json await listClasses(cwd)

        # Live per-relation edge counts for one class (class-definition view).
        if pathname is '/schema/relcounts' and req.method is 'GET'
          cls = url.searchParams.get('class') or url.searchParams.get('cls')
          throw new Error('?class= required') unless cls
          return json await relationCounts(cwd, cls)

        if pathname is '/entities' and req.method is 'GET'
          cls = url.searchParams.get('class') or url.searchParams.get('cls')
          throw new Error('?class= required') unless cls
          return json { class: cls, entities: await listEntities(cwd, cls) }

        if pathname.startsWith('/entity/') and req.method is 'GET'
          slug = decodeURIComponent(pathname.slice('/entity/'.length))
          # allow /entity/Person/alice
          ent = await getEntity(cwd, slug)
          return json Object.assign({}, ent, { yaml: entityToYaml(ent) })

        if pathname.startsWith('/entity/') and req.method in ['PUT', 'POST']
          slug = decodeURIComponent(pathname.slice('/entity/'.length))
          body = await req.json()
          content = body.content or body.yaml or body
          if typeof content is 'string'
            content = yaml.load(content) or {}
          # strip meta keys
          delete content.slug
          delete content.cls
          delete content.id
          delete content.label
          delete content.incoming
          delete content.yaml
          ent = await putEntity(cwd, slug, content, { overwrite: true })
          return json Object.assign({}, ent, { yaml: entityToYaml(ent) })

        if pathname.startsWith('/entity/') and req.method is 'DELETE'
          slug = decodeURIComponent(pathname.slice('/entity/'.length))
          throw new Error('slug required') unless slug and slug.includes('/')
          return json await deleteEntity(cwd, slug)

        if pathname is '/nl/seed' and req.method is 'POST'
          body = await req.json()
          textIn = body.text or ''
          throw new Error('text required') unless String(textIn).trim()
          dryRun = body.dryRun is true or body.persist is false
          lockedSlug = body.lockedSlug or body.slug or null
          # Abort LLM when browser cancels the fetch (superseded preview / navigation)
          parsed = await parseNlEntities(textIn, {
            cwd
            lockedSlug
            signal: req.signal
            # Prior B · YAML + V · Validation so redrives refine instead of reshuffle
            latestYaml: body.latestYaml or body.yaml or body.previewYaml or ''
            latestSummary: body.latestSummary or body.summary or ''
            validationFeedback: body.validationFeedback or body.validation or ''
            additionalUserInstructions: body.additionalUserInstructions or body.additional_user_instructions or ''
          })
          results = []
          unless dryRun
            results = await persistEntities(cwd, parsed.entities, { overwrite: true })
          return json
            summary: parsed.summary
            entities: parsed.entities
            results: results
            source: parsed.source
            persisted: not dryRun
            lockedSlug: parsed.lockedSlug

        # Persist a previously previewed seed (no re-LLM)
        if pathname is '/nl/seed/persist' and req.method is 'POST'
          body = await req.json()
          ents = body.entities or []
          throw new Error('entities required') unless ents.length
          # re-attach yaml content bags if client only sent structured entities
          results = await persistEntities(cwd, ents, { overwrite: true })
          return json { results, persisted: true }

        if pathname is '/git/status' and req.method is 'GET'
          return json await gitStatus(cwd)

        if pathname is '/git/commit' and req.method is 'POST'
          body = await req.json().catch(-> {})
          msg = body?.message or body?.msg or 'snapshot'
          return json await gitSnapshot(cwd, msg)

        # static assets + SPA fallback (client routes: /, /seed, /browse, …)
        res = serveStatic(pathname)
        return res if res
        if req.method is 'GET' and not pathname.startsWith('/api') and not pathname.includes('.')
          idx = serveIndex()
          return idx if idx
        return text 'not found', 404
      catch err
        # Client disconnected / fetch AbortController (typing superseded NL)
        if req.signal?.aborted
          return new Response null, status: 499
        console.error "tasks web error #{pathname}:", err.message
        return json { error: err.message }, 500

    websocket:
      open: (ws) ->
        if ws.data?.path is '/__m_hmr'
          hmrClients.add(ws)
          try ws.send JSON.stringify({ type: 'connected' }) catch then undefined
          return
        if ws.data?.path is '/__brain_ws'
          brainStatusClients.add(ws)
          # Immediate snapshot so LED paints without waiting for a change
          do ->
            try
              snap = await snapshotBrainHealth()
              ws.send JSON.stringify(Object.assign({ type: 'brain_status', at: Date.now() }, snap))
            catch then undefined
          return
      message: (ws, message) ->
        if ws.data?.path is '/__brain_ws'
          # Client can request a fresh snapshot (e.g. after reconnect)
          try
            msg = JSON.parse(String(message))
          catch
            msg = {}
          if not msg.type or msg.type in ['ping', 'refresh']
            do ->
              try
                snap = await snapshotBrainHealth()
                ws.send JSON.stringify(Object.assign({ type: 'brain_status', at: Date.now() }, snap))
              catch then undefined
          return
        return unless ws.data?.path is '/__entity_ws'
        try
          msg = JSON.parse(String(message))
        catch
          return
        id = msg.id
        try
          if msg.type is 'nodes'
            entities = []
            for slug in (msg.slugs or [])
              try
                entities.push await request(cwd, 'get_entity', { slug, include_links: false })
              catch then undefined
            ws.send JSON.stringify({ id, type: 'nodes_result', entities })
          else if msg.type is 'labels'
            labels = {}
            for slug in (msg.slugs or [])
              try
                e = await request(cwd, 'get_entity', { slug, include_links: false })
                labels[slug] = e.components?.identity?.name or e.components?.workunit?.summary or e.components?.naming?.name or slug.split('/').pop()
              catch
                labels[slug] = slug.split('/').pop()
            ws.send JSON.stringify({ id, type: 'labels_result', labels })
        catch err
          try ws.send JSON.stringify({ id, type: 'error', error: err.message }) catch then undefined
      close: (ws) ->
        hmrClients.delete(ws)
        brainStatusClients.delete(ws)

  console.log "tasks web: http://127.0.0.1:#{port}  (db #{paths(cwd).root})"
  console.log '  Ctrl-C to stop'
  # keep alive
  await new Promise(->)
  0
