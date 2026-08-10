# schema-def.coffee — emits the `brain def …` argv list; does NOT write schema.yaml.
# Driver data for `tasks init` and the expected shape for `tasks doctor`.

export WORKUNIT_FIELDS =
  id: { type: 'string', required: true }
  important: { type: 'bool' }
  urgent: { type: 'bool' }
  weight: { type: 'int' }
  tags: { type: 'string', list: true }
  stakeholders: { type: 'ref', list: true, allowedTypes: ['Person'] }
  status: { type: 'enum', values: ['idle', 'running', 'success', 'fail'] }
  summary: { type: 'string', required: true }
  description: { type: 'string' }
  worker: { type: 'string' }
  due: { type: 'date' }
  estimateOptimistic: { type: 'date' }
  estimateLikely: { type: 'date' }
  estimatePessimistic: { type: 'date' }
  # Computed (tasks): unique entity slugs from {{Class/id}} wikilinks in summary + description.
  correlations: { type: 'string', list: true }
  journal: { type: 'string', list: true }
  createdAt: { type: 'date', required: true }
  updatedAt: { type: 'date', required: true }

export EXPECTED_FIELD_COUNT = 18
export EXPECTED_STATUS_VALUES = ['idle', 'running', 'success', 'fail']
export FORBIDDEN_CLASSES = ['Queue', 'Task']
export FORBIDDEN_COMPONENTS = ['Notification', 'TestComponent']
export FORBIDDEN_RELATIONS = ['TEST_REL']
export REQUIRED_RELATION = 'DEPENDS_ON'

# YAML-flow string for `brain def component WorkUnit --fields '…'`
export workunitFieldsFlow = ->
  # compact yaml-flow
  parts = []
  for own name, def of WORKUNIT_FIELDS
    inner = ["type: #{def.type}"]
    inner.push 'required: true' if def.required
    inner.push 'list: true' if def.list
    if def.values
      inner.push "values: [#{def.values.join(', ')}]"
    if def.allowedTypes
      inner.push "allowedTypes: [#{def.allowedTypes.join(', ')}]"
    parts.push "#{name}: {#{inner.join(', ')}}"
  "{#{parts.join(', ')}}"

# Ordered list of argv arrays for `brain def …` (each is process argv after `brain`).
export defArgvList = ->
  fields = workunitFieldsFlow()
  [
    ['def', 'component', 'WorkUnit', '--fields', fields]
    ['def', 'class', 'WorkUnit', '--components', 'workunit:WorkUnit', '--top', '--display-field', 'workunit.summary']
    ['def', 'relation', 'DEPENDS_ON', 'WorkUnit', 'mtm', 'WorkUnit']
  ]

# Doctor: compare schema_info RPC result against expectations.
export doctorReport = (schemaInfo) ->
  missing = []
  notes = []
  comps = schemaInfo?.components or schemaInfo?.schema?.components or {}
  classes = schemaInfo?.classes or schemaInfo?.schema?.classes or {}
  relations = schemaInfo?.relations or schemaInfo?.schema?.relations or {}

  # schema_info may return a flat shape — also accept raw schema
  if schemaInfo?.schema
    comps = schemaInfo.schema.components or comps
    classes = schemaInfo.schema.classes or classes
    relations = schemaInfo.schema.relations or relations

  unless comps.WorkUnit?
    missing.push "brain def component WorkUnit --fields '#{workunitFieldsFlow()}'"
  else
    fields = comps.WorkUnit.fields or {}
    for own name, def of WORKUNIT_FIELDS
      unless fields[name]?
        missing.push "WorkUnit field missing: #{name}"
      else if def.type is 'enum'
        vals = fields[name].values or []
        for v in EXPECTED_STATUS_VALUES
          unless vals.includes(v)
            missing.push "WorkUnit.status enum missing value: #{v}"
    if fields.dependsOn?
      notes.push 'WorkUnit.dependsOn field still present — should be relation DEPENDS_ON only (D3)'
    count = Object.keys(fields).length
    notes.push "WorkUnit has #{count} fields (expected #{EXPECTED_FIELD_COUNT})" if count isnt EXPECTED_FIELD_COUNT

  unless classes.WorkUnit?
    missing.push 'brain def class WorkUnit --components workunit:WorkUnit --top --display-field workunit.summary'
  else
    notes.push 'WorkUnit.top is not set' unless classes.WorkUnit.top
    unless classes.WorkUnit.displayField is 'workunit.summary'
      notes.push "WorkUnit.displayField is #{classes.WorkUnit.displayField or '(unset)'} (expected workunit.summary)"

  unless relations.DEPENDS_ON?
    missing.push 'brain def relation DEPENDS_ON WorkUnit mtm WorkUnit'
  else
    r = relations.DEPENDS_ON
    unless r.domain is 'WorkUnit' and r.range is 'WorkUnit'
      notes.push "DEPENDS_ON domain/range is #{r.domain}/#{r.range} (expected WorkUnit/WorkUnit)"

  for c in FORBIDDEN_CLASSES when classes[c]?
    notes.push "forbidden class still present: #{c}"
  for c in FORBIDDEN_COMPONENTS when comps[c]?
    notes.push "forbidden component still present: #{c}"
  for r in FORBIDDEN_RELATIONS when relations[r]?
    notes.push "forbidden relation still present: #{r}"

  {
    ok: missing.length is 0
    missing
    notes
  }
