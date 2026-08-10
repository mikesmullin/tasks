# score.coffee — scoring + topo sort + longest-path CPM over DEPENDS_ON.
# Port of tasks.md/src/score.js (itself from gdedit), with age creep from createdAt.
import { isOpenStatus } from './workunit.coffee'

toDateOrNull = (v) ->
  return null unless v
  d = new Date(v)
  if Number.isNaN(d.getTime()) then null else d

estimateDurationDays = (wu) ->
  o = toDateOrNull(wu.estimateOptimistic)
  l = toDateOrNull(wu.estimateLikely)
  if o and l
    return Math.max(1, Math.round((l.getTime() - o.getTime()) / (24 * 60 * 60 * 1000)))
  1

export topoSortTasks = (workunits) ->
  idSet = new Set(workunits.map (t) -> t.id)
  inDegree = new Map()
  children = new Map()
  for task in workunits
    inDegree.set(task.id, 0)
    children.set(task.id, [])
  for task in workunits
    parents = (task.dependsOn or []).filter (id) -> idSet.has(id)
    inDegree.set(task.id, parents.length)
    for parentId in parents
      children.get(parentId).push(task.id)
  queue = (workunits.map (t) -> t.id).filter((id) -> inDegree.get(id) is 0).sort()
  sorted = []
  while queue.length > 0
    id = queue.shift()
    sorted.push(id)
    for childId in (children.get(id) or [])
      next = (inDegree.get(childId) or 0) - 1
      inDegree.set(childId, next)
      if next is 0
        queue.push(childId)
        queue.sort()
  if sorted.length isnt workunits.length
    return workunits.map((t) -> t.id).sort()
  sorted

# True critical path: longest path through dependsOn DAG (duration sum).
export criticalPath = (workunits) ->
  byId = new Map(workunits.map (t) -> [t.id, t])
  children = new Map(workunits.map (t) -> [t.id, []])
  inDegree = new Map(workunits.map (t) -> [t.id, 0])
  for task in workunits
    for parentId in (task.dependsOn or [])
      continue unless byId.has(parentId)
      children.get(parentId).push(task.id)
      inDegree.set(task.id, (inDegree.get(task.id) or 0) + 1)
  roots = workunits.map((t) -> t.id).filter (id) -> (inDegree.get(id) or 0) is 0
  return [] unless roots.length
  dist = new Map(workunits.map (t) -> [t.id, Number.NEGATIVE_INFINITY])
  prev = new Map()
  for r in roots
    dist.set(r, estimateDurationDays(byId.get(r)))
  ordered = topoSortTasks(workunits)
  for id in ordered
    base = dist.get(id)
    continue unless Number.isFinite(base)
    for childId in (children.get(id) or [])
      cand = base + estimateDurationDays(byId.get(childId))
      if cand > dist.get(childId)
        dist.set(childId, cand)
        prev.set(childId, id)
  leaves = workunits.map((t) -> t.id).filter (id) -> (children.get(id) or []).length is 0
  return [roots.sort()[0]] unless leaves.length
  bestLeaf = leaves[0]
  for leaf in leaves
    current = dist.get(bestLeaf)
    value = dist.get(leaf)
    if (Number.isFinite(value) and value > current) or not Number.isFinite(current)
      bestLeaf = leaf
  path = []
  cursor = bestLeaf
  while cursor
    path.push(cursor)
    cursor = prev.get(cursor)
  path.reverse()

export buildDependencyMaps = (workunits) ->
  byId = new Map(workunits.map (t) -> [t.id, t])
  dependents = new Map(workunits.map (t) -> [t.id, []])
  for task in workunits
    for parentId in (task.dependsOn or [])
      continue unless byId.has(parentId)
      dependents.get(parentId).push(task.id)
  { byId, dependents }

export scoreTask = (task, ctx, now, memo = new Map(), stack = new Set()) ->
  return memo.get(task.id) if memo.has(task.id)
  return 0 if stack.has(task.id)
  stack.add(task.id)
  wu = task
  score = 0

  if wu.important and wu.urgent then score += 18
  else if wu.important then score += 9
  else if wu.urgent then score += 3
  score += 4 if wu.important and wu.urgent
  score += (Number(wu.weight) or 0) * 0.3

  due = toDateOrNull(wu.due)
  if due
    daysToDue = (due.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
    daysOverdue = Math.max(0, -daysToDue)
    duePressure = 0
    if daysOverdue > 0
      duePressure = 12 + (daysOverdue ** 1.8) * 5
    else
      duePressure = 12 * (1 / (1 + Math.exp(0.7 * daysToDue))) * 1.5
    duePressure *= 1.4 if wu.urgent
    score += duePressure

  if not due and (wu.estimateOptimistic or wu.estimateLikely or wu.estimatePessimistic)
    likely = toDateOrNull(wu.estimateLikely)
    pessimistic = toDateOrNull(wu.estimatePessimistic)
    if likely
      daysToLikely = (likely.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
      if daysToLikely >= 0 and daysToLikely <= 14
        score += 6 * (1 - daysToLikely / 14) ** 2
    if likely and pessimistic
      overrunRisk = (pessimistic.getTime() - likely.getTime()) / (24 * 60 * 60 * 1000)
      score += Math.min(8, overrunRisk * 0.8)

  dependents = ctx.dependents.get(task.id) or []
  if dependents.length > 0
    maxBlockedScore = 0
    for depId in dependents
      depTask = ctx.byId.get(depId)
      continue unless depTask
      maxBlockedScore = Math.max(maxBlockedScore, scoreTask(depTask, ctx, now, memo, stack))
    score = Math.max(score, maxBlockedScore * 0.95)

  isBlocked = (wu.dependsOn or []).some (depId) ->
    depTask = ctx.byId.get(depId)
    depTask and depTask.status isnt 'success'
  score += -7 if isBlocked

  tagCoefficients =
    '#today': 14
    '#blocked': -8
    '#research': 2
    '#someday': -10
    '#critical': 12
  for tag in (wu.tags or [])
    coeff = tagCoefficients[tag]
    score += coeff if typeof coeff is 'number'

  score += (wu.stakeholders or []).length * 0.8

  if wu.status is 'running' then score += 5
  else if wu.status in ['success', 'fail'] then score -= 20

  # age creep from required createdAt
  created = toDateOrNull(wu.createdAt)
  if created
    ageDays = Math.max(0, (now.getTime() - created.getTime()) / (24 * 60 * 60 * 1000))
    score += 1.2 * Math.sqrt(ageDays)

  stack.delete(task.id)
  memo.set(task.id, score)
  score

export rankNext = (workunits, opts = {}) ->
  limit = opts.limit ? 10
  includeDone = opts.includeDone is true
  now = opts.now or new Date()
  ctx = buildDependencyMaps(workunits)
  pool = if includeDone then workunits else workunits.filter (w) -> isOpenStatus(w.status)
  memo = new Map()
  scored = pool.map (w) ->
    Object.assign({}, w, { score: scoreTask(w, ctx, now, memo, new Set()) })
  scored.sort (a, b) ->
    b.score - a.score or String(a.summary).localeCompare(String(b.summary))
  scored.slice(0, limit)

export formatTree = (workunits, opts = {}) ->
  byId = new Map(workunits.map (t) -> [t.id, t])
  critSet = new Set(if opts.crit then criticalPath(workunits) else [])
  ordered = topoSortTasks(workunits)
  lines = []
  for id in ordered
    w = byId.get(id)
    continue unless w
    mark = if critSet.has(id) then ' *CRIT*' else ''
    deps = if (w.dependsOn or []).length then " deps:[#{w.dependsOn.join(',')}]" else ''
    st = w.status or 'idle'
    lines.push "[#{st}] #{id} #{w.summary or '(untitled)'}#{deps}#{mark}"
  if opts.crit and critSet.size
    lines.push ''
    lines.push "critical path (longest): #{[...critSet].join(' → ')}"
  lines.join('\n')

export { estimateDurationDays }
