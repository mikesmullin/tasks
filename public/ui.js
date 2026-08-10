/**
 * ui.js — single static m.js template over the named `tasks` store.
 *
 * m.js v3 rendering model (see brain viz / m-js README):
 *   template → AST (once) → VNodes per redraw → keyed diff → DOM
 * Reactive store writes schedule ONE coalesced rAF redraw.
 * Do NOT use hyperscript M('div', …) — that is not the m.js API.
 *
 * Icons: Phosphor Bold (`ph-bold ph-*`) loaded from CDN in index.html.
 */
import M, { Router } from '/m.min.js'
import { store } from './store.js'

/** Bold Phosphor icon (default weight for the app). */
const ic = (name) => `<i class="ph-bold ph-${name}" aria-hidden="true"></i>`

/**
 * Entity leaf/link inside a relation tree.
 * @param {string} slugExpr
 * @param {string} labelExpr
 * @param {{ xFor?: string, keyExpr?: string }} [opts]
 */
function relTreeEntityLink(slugExpr, labelExpr, opts = {}) {
  const xFor = opts.xFor ? ` x-for="${opts.xFor}"` : ''
  const key = opts.keyExpr ? ` :key="${opts.keyExpr}"` : ''
  return `<a class="entity-pill entity-link rel-tree-entity"${xFor}${key}
     :data-entity="${slugExpr}" data-label-bound="1"
     :href="'/browse/' + ${slugExpr}"
     :title="${slugExpr}"
     @click.prevent="goEntity(${slugExpr})">
    ${ic('cube')}
    <span class="entity-pill-label" x-text="${labelExpr}"></span>
  </a>`
}

/**
 * Nested relation tree: edge branches → entity leaves.
 *
 *   - → OWNS (1)
 *     - □ target
 *   - ← REPORTS_TO (2)
 *     - □ source
 *
 * Twisty: caret on branches (collapse); static bullet on leaves.
 *
 * @param {string} listExpr m.js list of { key, rel, dir, open, targets:[{slug}] }
 * @param {{ labelExpr?: string }} [opts] target label expression (default entityLabel)
 */
function relEdgeTreeHtml(listExpr, opts = {}) {
  const labelExpr = opts.labelExpr || '$store.tasks.entityLabel(t.slug)'
  // Optional trash on draft targets (Seed C) — only when target is a proposed entity
  const trash = opts.seedTrash
    ? `
              <button type="button" class="seed-entity-trash"
                      title="Remove from draft"
                      x-show="$store.tasks.seedIsDraftSlug(t.slug)"
                      @click.stop="$store.tasks.seedExcludeEntity(t.slug)">
                ${ic('trash')}
              </button>`
    : ''
  return `
    <ul class="rel-tree">
      <li class="rel-tree-node is-branch" x-for="r in (${listExpr} || [])" :key="r.key"
          :class="{ open: r.open !== false }">
        <div class="rel-tree-row">
          <button type="button" class="rel-tree-twisty"
                  @click.stop="$store.tasks.toggleEntityRel(r)"
                  :aria-expanded="r.open !== false ? 'true' : 'false'"
                  :title="(r.dir === 'in' ? '← ' : '→ ') + r.rel + ' (' + r.targets.length + ')'">
            <i class="ph-bold"
               :class="r.open !== false ? 'ph-caret-down' : 'ph-caret-right'"
               aria-hidden="true"></i>
          </button>
          <i class="ph-bold rel-tree-dir"
             :class="r.dir === 'in' ? 'ph-arrow-left' : 'ph-arrow-right'"
             role="img"
             :aria-label="r.dir === 'in' ? 'incoming' : 'outgoing'"></i>
          <span class="rel-tree-rel" x-text="r.rel"></span>
          <span class="rel-tree-count" x-text="r.targets.length"></span>
        </div>
        <ul class="rel-tree" x-show="r.open !== false">
          <li class="rel-tree-node is-leaf" x-for="t in r.targets" :key="t.slug">
            <div class="rel-tree-row">
              <span class="rel-tree-twisty is-bullet" aria-hidden="true"></span>
              ${relTreeEntityLink('t.slug', labelExpr)}
              ${trash}
            </div>
          </li>
          <li class="rel-tree-node is-leaf" x-show="!r.targets.length">
            <div class="rel-tree-row">
              <span class="rel-tree-twisty is-bullet" aria-hidden="true"></span>
              <span class="rel-tree-empty muted">none</span>
            </div>
          </li>
        </ul>
      </li>
    </ul>`
}

const TEMPLATE = `
<div class="app" :data-route="$store.tasks.route || '/'">
  <!-- Global pending-request indicator (fetch + entity-ws) -->
  <div class="net-activity"
       :class="($store.tasks.netPending || 0) > 0 ? 'is-active' : ''"
       aria-hidden="true"></div>
  <header class="topbar">
    <!-- Brain server LED — far left, before brand; tooltip has full detail -->
    <span class="brain-status"
          :class="$store.tasks.brainStatusClass()"
          :title="$store.tasks.brainStatusTitle()"
          role="status"
          :aria-label="$store.tasks.brainStatusTitle()"></span>
    <div class="brand" @click.prevent="go('/')">
      <!-- Database cylinders — inline SVG so route/theme rules cannot dim it -->
      <svg class="brand-icon" width="1.15em" height="1.15em" viewBox="0 0 256 256"
           aria-hidden="true" focusable="false">
        <ellipse cx="128" cy="56" rx="80" ry="28" fill="none"
                 stroke="currentColor" stroke-width="16"/>
        <path d="M48 56v40c0 15.46 35.82 28 80 28s80-12.54 80-28V56" fill="none"
              stroke="currentColor" stroke-width="16"/>
        <path d="M48 96v40c0 15.46 35.82 28 80 28s80-12.54 80-28V96" fill="none"
              stroke="currentColor" stroke-width="16"/>
        <path d="M48 136v40c0 15.46 35.82 28 80 28s80-12.54 80-28v-40" fill="none"
              stroke="currentColor" stroke-width="16"/>
        <ellipse cx="128" cy="176" rx="80" ry="28" fill="none"
                 stroke="currentColor" stroke-width="16"/>
      </svg>
      <span class="brand-label">Data Editor</span>
    </div>
    <nav class="nav">
      <!-- @click.prevent: SPA via Router — never full browser navigation -->
      <a href="/" :class="$store.tasks.navClass('/')"
         @click.prevent="go('/')">${ic('list-checks')}WorkUnits</a>
      <a :href="$store.tasks.schemaTabHref()"
         :class="$store.tasks.navClass('/browse')"
         @click.prevent="goSchema()">${ic('tree-structure')}Schema</a>
      <a href="/seed" :class="$store.tasks.navClass('/seed')"
         @click.prevent="go('/seed')">${ic('plant')}Seed</a>
    </nav>
    <div class="status">
      <!-- Debounce wait (before LLM) — donut cooldown + label -->
      <span class="debounce-cooldown"
            x-show="$store.tasks.nlDebounceActive"
            :title="'Inference starts in ' + $store.tasks.nlDebounceSec + 's'">
        <span class="debounce-countdown" aria-hidden="true">
          <span class="debounce-countdown-ring"
                :style="$store.tasks.nlDebouncePieStyle()"></span>
          <span class="debounce-countdown-num" x-text="$store.tasks.nlDebounceSec"></span>
        </span>
        <span class="debounce-cooldown-label">cooldown</span>
      </span>
      <span class="spin" x-show="$store.tasks.translating || $store.tasks.seedBusy || $store.tasks.saving || $store.tasks.loading"></span>
      <span x-text="$store.tasks.status || ($store.tasks.loading ? 'loading…' : '')"></span>
    </div>
    <div class="error"
         x-show="$store.tasks.topbarError()"
         x-text="$store.tasks.topbarError()"></div>
    <div class="git-control">
      <button type="button"
              :class="$store.tasks.gitStatusClass()"
              :title="$store.tasks.git && $store.tasks.git.dbDir || 'git status'"
              :disabled="$store.tasks.gitBusy"
              @click="$store.tasks.openGitDialog()">
        ${ic('git-branch')}<span x-text="$store.tasks.gitLabel()"></span>
      </button>
      <button type="button" class="btn small primary"
              :disabled="$store.tasks.gitBusy || ($store.tasks.git && $store.tasks.git.repo === false)"
              title="Export live index to .md and commit"
              @click="$store.tasks.openGitDialog()">
        ${ic('camera')}<span x-text="$store.tasks.gitBusy ? '…' : 'Snapshot'"></span>
      </button>
    </div>
  </header>

  <!-- ═══════════ WorkUnits ═══════════ -->
  <div class="page page-tasks" x-show="$store.tasks.isWorkUnits()">
    <div class="page-toolbar">
      <!-- Selected WorkUnit toolbar (like Schema entity toolbar) -->
      <div class="wu-selection-toolbar" x-show="$store.tasks.selectedId">
        <code class="wu-selected-id muted small"
              x-text="'WorkUnit/' + String($store.tasks.selectedId || '').slice(0, 8)"></code>
        <button type="button" class="btn small danger"
                :disabled="$store.tasks.workUnitDeleting || $store.tasks.saving"
                @click="$store.tasks.openDeleteWorkUnitDialog()">
          ${ic('trash')}<span x-text="$store.tasks.workUnitDeleting ? 'Deleting…' : 'Delete'"></span>
        </button>
      </div>
      <!-- Save: float right, small — hide when nothing to save -->
      <button type="button" class="btn primary small page-toolbar-save"
              x-show="$store.tasks.canSaveWorkUnit()"
              :disabled="$store.tasks.saving"
              @click="$store.tasks.saveDraft()">
        ${ic('floppy-disk')}<span x-text="$store.tasks.saving ? 'Saving…' : 'Save'"></span>
      </button>
    </div>
    <div class="layout" :style="$store.tasks.layoutStyle()">
      <aside class="pane pane-c">
        <div class="pane-header">
          <span class="pane-header-title">${ic('queue')}<span x-text="'WorkUnits (' + ($store.tasks.tasks || []).length + ')'"></span></span>
        </div>
        <!-- Click blank area (not a row) → deselect -->
        <ul class="task-list" @click="onWorkUnitsSidebarBlank($event)">
          <li x-for="t in $store.tasks.tasks" :key="t.id"
              :class="$store.tasks.taskRowClass(t)"
              @click="$store.tasks.loadTask(t.id)">
            <span :class="$store.tasks.priClass(t)" x-text="$store.tasks.pri(t)"></span>
            <span :class="'st st-' + (t.status || 'idle')" x-text="t.status || 'idle'"></span>
            <span class="sum" x-text="t.summary || '(untitled)'"></span>
            <span class="due" x-show="t.due" x-text="$store.tasks.dueShort(t)"></span>
          </li>
        </ul>
      </aside>
      <div class="split split-v"
           title="Drag to resize sidebar"
           @pointerdown="$store.tasks.startResizeSidebar($event)"></div>
      <div class="main" :style="$store.tasks.mainStyle()">
        <div class="pane-a-row"
             :class="$store.tasks.hasClarifyingQuestions() ? 'with-questions' : ''">
          <section class="pane pane-a">
            <div class="pane-header">
              <span class="pane-header-title">${ic('chat-text')}A · English</span>
              <span class="debounce-countdown"
                    x-show="$store.tasks.nlDebounceActive && $store.tasks.isWorkUnits()"
                    :title="'Inference starts in ' + $store.tasks.nlDebounceSec + 's'"
                    aria-hidden="true">
                <span class="debounce-countdown-ring"
                      :style="$store.tasks.nlDebouncePieStyle()"></span>
                <span class="debounce-countdown-num" x-text="$store.tasks.nlDebounceSec"></span>
              </span>
              <span class="muted small" x-show="$store.tasks.translating">
                <span class="spin inline"></span>
                <span x-text="$store.tasks.translatePhase === 'llm'
                  ? 'waiting on LLM…'
                  : ($store.tasks.translatePhase || 'working…')"></span>
              </span>
              <span class="muted small"
                    x-show="($store.tasks.pendingEntities || []).length && !$store.tasks.translating"
                    x-text="($store.tasks.pendingEntities || []).length + ' staged for Save'"></span>
              <button type="button" class="btn small" x-show="$store.tasks.dirty"
                      @click="$store.tasks.retranslate()">
                ${ic('arrows-clockwise')}Re-translate
              </button>
            </div>
            <div id="pane-a"
                 class="composer mention-editor mention-editor-multi"
                 contenteditable="true"
                 data-placeholder="Describe the work…"
                 data-empty="1"></div>
          </section>
          <section class="pane pane-q" x-show="$store.tasks.hasClarifyingQuestions()">
            <div class="pane-header">
              <span class="pane-header-title">${ic('chat-circle-dots')}Q · Clarifying</span>
              <span class="muted small"
                    x-text="$store.tasks.unansweredCount()
                      ? ($store.tasks.unansweredCount() + ' open')
                      : 'all answered'"></span>
            </div>
            <ul class="clarify-list">
              <li class="clarify-item" x-for="q in $store.tasks.clarifyingQuestions" :key="q.id">
                <label class="clarify-q">
                  <span class="clarify-id" x-text="'Q' + q.id"></span>
                  <span class="clarify-text" x-text="q.text"></span>
                </label>
                <input type="text" class="clarify-a"
                       :placeholder="'Answer Q' + q.id + '…'"
                       :value="q.answer"
                       @input="$store.tasks.onClarifyingAnswer(q.id, $event)">
              </li>
            </ul>
          </section>
        </div>
        <div class="split split-h"
             title="Drag to resize A / D"
             @pointerdown="$store.tasks.startResizeRow('ad', $event)"></div>
        <section class="pane pane-d">
          <div class="pane-header">
            <span class="pane-header-title">${ic('text-aa')}D · Shorthand</span>
            <span class="muted small">read-only</span>
          </div>
          <pre class="shorthand" x-html="$store.tasks.paneDHtml"></pre>
        </section>
        <div class="split split-h"
             title="Drag to resize D / B"
             @pointerdown="$store.tasks.startResizeRow('db', $event)"></div>
        <section class="pane pane-b">
          <div class="bv-split" :style="$store.tasks.bvSplitStyle()">
            <div class="bv-col bv-col-yaml">
              <div class="pane-header">
                <span class="pane-header-title">${ic('code')}B · YAML</span>
                <button type="button" class="btn small" @click="$store.tasks.undoYaml()">
                  ${ic('arrow-u-up-left')}Undo
                </button>
              </div>
              <div class="yaml-editor">
                <!-- Highlight is painted imperatively (store.paintPaneBHighlight) — do NOT
                     bind x-html here; reactive re-renders reset pre.scrollTop and desync the caret. -->
                <pre id="pane-b-hl" class="yaml-hl" aria-hidden="true"></pre>
                <textarea id="pane-b-input" class="yaml yaml-input" spellcheck="false"
                          autocomplete="off" autocapitalize="off"
                          :value="$store.tasks.paneB"
                          @input="$store.tasks.onPaneBInput($event)"
                          @scroll="$store.tasks.onPaneBScroll($event)"></textarea>
              </div>
            </div>
            <div class="split split-v bv-gutter"
                 title="Drag to resize B / V"
                 @pointerdown="$store.tasks.startResizeBv($event)"></div>
            <div class="bv-col bv-col-v">
              <div class="pane-header">
                <span class="pane-header-title">${ic('seal-check')}V · Validation</span>
                <span class="muted small" x-show="$store.tasks.wuValidationBusy">
                  <span class="spin inline"></span>checking…
                </span>
                <span class="muted small"
                      x-show="!$store.tasks.wuValidationBusy && $store.tasks.paneB && $store.tasks.wuValidationValid && !$store.tasks.wuValidationText"
                      >ok</span>
              </div>
              <pre class="validation-pane"
                   :class="{
                     'validation-ok': $store.tasks.wuValidationValid && !$store.tasks.wuValidationText,
                     'validation-fail': !$store.tasks.wuValidationValid || !!$store.tasks.wuValidationText
                   }"
                   x-text="$store.tasks.wuValidationText
                     || ($store.tasks.paneB ? ($store.tasks.wuValidationBusy ? '…' : 'valid') : '—')"></pre>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>

  <!-- ═══════════ Schema browser ═══════════ -->
  <div class="page page-browse" x-show="$store.tasks.isBrowse()">
    <aside class="schema-tree">
      <div class="pane-header schema-tree-header">
        <span class="pane-header-title">${ic('tree-structure')}Schema</span>
        <div class="schema-tree-actions">
          <button type="button" class="btn small icon-btn"
                  :title="$store.tasks.schemaTreeExpandTitle()"
                  @click="$store.tasks.expandSchemaTree()">
            ${ic('caret-double-down')}
          </button>
          <button type="button" class="btn small icon-btn"
                  :title="$store.tasks.schemaTreeCollapseTitle()"
                  @click="$store.tasks.collapseSchemaTree()">
            ${ic('caret-double-up')}
          </button>
        </div>
      </div>
      <!-- Click empty space (not a node) → select none; expand/collapse-all then covers whole tree -->
      <ul class="class-tree" @click="onSchemaTreeBlank($event)">
        <li x-for="c in ($store.tasks.schemaTree && $store.tasks.schemaTree.classes) || []"
            :key="c.name" :class="$store.tasks.classNodeClass(c)">
          <div class="class-row" @click="goClass(c.name)">
            <span class="twisty" x-text="$store.tasks.twisty(c)"></span>
            <!-- blueprint = class, cube = entity: the tree now says which is which -->
            <i class="ph-bold ph-blueprint cls-icon" aria-hidden="true"></i>
            <span class="cls-name" x-text="c.name"></span>
            <span class="count" x-show="(c.count || 0) > 0" x-text="c.count"></span>
          </div>
          <!-- Multi-expand: any open class shows its own cached children -->
          <ul class="entity-tree" x-show="$store.tasks.isExpanded(c)">
            <li x-for="ent in $store.tasks.classEntities(c)" :key="ent.slug"
                :class="$store.tasks.entityNodeClass(ent)"
                :title="ent.slug"
                @click="goEntity(ent.slug)">
              ${ic('cube')}
              <span class="entity-node-label" x-text="ent.label || ent.id"></span>
            </li>
          </ul>
        </li>
      </ul>
    </aside>
    <main class="browse-main">
      <div class="class-def" x-show="$store.tasks.showClassDef()"
           x-html="$store.tasks.classDefHtml"></div>
      <div class="entity-detail" x-show="$store.tasks.showEntityDetail()">
        <div class="entity-head">
          <h2>
            ${ic('cube')}
            <span x-text="($store.tasks.entity && $store.tasks.entity.label) || ''"></span>
          </h2>
          <code class="slug" x-text="($store.tasks.entity && $store.tasks.entity.slug) || ''"></code>
          <div class="entity-toolbar">
            <button type="button" class="btn primary small"
                    :disabled="$store.tasks.saving || $store.tasks.entityDeleting || !$store.tasks.entityDirty"
                    @click="$store.tasks.saveEntity()">
              ${ic('floppy-disk')}<span x-text="$store.tasks.saving ? 'Saving…' : 'Save'"></span>
            </button>
            <button type="button" class="btn small danger"
                    :disabled="$store.tasks.saving || $store.tasks.entityDeleting || !$store.tasks.entity"
                    @click="$store.tasks.openDeleteEntityDialog()">
              ${ic('trash')}<span x-text="$store.tasks.entityDeleting ? 'Deleting…' : 'Delete'"></span>
            </button>
          </div>
        </div>
        <div class="entity-cols">
          <section class="entity-yaml">
            <div class="pane-header">
              <span class="pane-header-title">${ic('code')}YAML</span>
              <span class="muted small">components + relations</span>
            </div>
            <div class="yaml-editor entity-yaml-editor">
              <!-- Imperative highlight (same as pane B) — avoid x-html scroll desync -->
              <pre id="entity-yaml-hl" class="yaml-hl" aria-hidden="true"></pre>
              <textarea id="entity-yaml-input" class="yaml yaml-input" spellcheck="false"
                        autocomplete="off" autocapitalize="off"
                        :value="$store.tasks.entityYaml"
                        @input="$store.tasks.onEntityYamlInput($event)"
                        @scroll="$store.tasks.onEntityYamlScroll($event)"></textarea>
            </div>
            <!-- V · brain validation (user-facing; edit YAML to fix) -->
            <div class="entity-validation-block">
              <div class="pane-header entity-validation-header">
                <span class="pane-header-title">${ic('seal-check')}V · Validation</span>
                <span class="muted small" x-show="$store.tasks.entityValidationBusy">
                  <span class="spin inline"></span>checking…
                </span>
                <span class="muted small"
                      x-show="!$store.tasks.entityValidationBusy && $store.tasks.entityYaml && $store.tasks.entityValidationValid && !$store.tasks.entityValidationText"
                      >ok</span>
              </div>
              <pre class="validation-pane entity-validation-pane"
                   :class="{
                     'validation-ok': $store.tasks.entityValidationValid && !$store.tasks.entityValidationText,
                     'validation-fail': !$store.tasks.entityValidationValid || !!$store.tasks.entityValidationText
                   }"
                   x-text="$store.tasks.entityValidationText
                     || ($store.tasks.entityYaml ? ($store.tasks.entityValidationBusy ? '…' : 'valid') : '—')"></pre>
            </div>
          </section>
          <section class="entity-graph">
            <div class="pane-header">
              <span class="pane-header-title">${ic('graph')}<span x-text="'Relationships (' + $store.tasks.entityRelationEdgeCount() + ')'"></span></span>
            </div>
            <div class="insp-rel-body entity-rel-scroll" x-show="($store.tasks.entityRelations || []).length">
              ${relEdgeTreeHtml('$store.tasks.entityRelations')}
            </div>
            <p class="muted pad" x-show="!($store.tasks.entityRelations || []).length">No relationships.</p>
            <div class="pane-header entity-comp-header">
              <span class="pane-header-title">${ic('diamonds-four')}Components</span>
              <span class="muted small">read</span>
            </div>
            <pre class="comp-json" x-text="$store.tasks.entityComponentsJson"></pre>
          </section>
        </div>
      </div>
      <div class="muted pad"
           x-show="!$store.tasks.showClassDef() && !$store.tasks.showEntityDetail()">
        ${ic('hand-pointing')}Pick a class in the schema tree.
      </div>
    </main>
  </div>

  <!-- ═══════════ Seed ═══════════ -->
  <div class="page page-seed" x-show="$store.tasks.isSeed()">
    <div class="page-toolbar seed-toolbar">
      <!-- Busy / LLM progress lives in top nav (spin + cooldown) — no duplicate here -->
      <span class="error seed-error-inline"
            x-show="$store.tasks.topbarError()"
            x-text="$store.tasks.topbarError()"></span>
      <!-- Save: float right, small — hide when nothing to save -->
      <button type="button" class="btn primary small page-toolbar-save"
              x-show="$store.tasks.canSaveSeed()"
              :disabled="$store.tasks.seedSaving || $store.tasks.seedBusy"
              @click="$store.tasks.saveSeed()">
        ${ic('floppy-disk')}<span x-text="$store.tasks.seedSaving ? 'Saving…' : 'Save'"></span>
      </button>
    </div>
    <!-- Sticky “saved …” banner: survives draft clear until full page refresh -->
    <div class="seed-saved-bar"
         x-show="($store.tasks.seedSaved && $store.tasks.seedSaved.slugs || []).length">
      <span class="seed-saved-label">${ic('check-circle')}Saved</span>
      <div class="seed-saved-pills">
        <a class="entity-pill entity-link insp-rel-pill"
           x-for="slug in ($store.tasks.seedSaved && $store.tasks.seedSaved.slugs) || []"
           :key="slug"
           :data-entity="slug"
           data-label-bound="1"
           :href="'/browse/' + slug"
           :title="slug"
           @click.prevent="goEntity(slug)">
          ${ic('cube')}
          <span class="entity-pill-label" x-text="$store.tasks.entityLabel(slug)"></span>
        </a>
      </div>
      <span class="error seed-saved-fail"
            x-show="($store.tasks.seedSaved && $store.tasks.seedSaved.failed || []).length"
            x-text="(($store.tasks.seedSaved && $store.tasks.seedSaved.failed) || []).length + ' failed'"></span>
    </div>
    <div class="seed-layout" :style="$store.tasks.seedMainStyle()">
      <!-- A · English input -->
      <section class="pane seed-pane seed-pane-in">
        <div class="pane-header">
          <span class="pane-header-title">${ic('chat-text')}A · Description</span>
        </div>
        <div class="seed-locked-bar" x-show="$store.tasks.isSeedCreateMode()">
          ${ic('lock-simple')}
          <span class="muted small">Locked slug</span>
          <code class="seed-locked-slug" x-text="$store.tasks.seedLockedSlug"
                :title="$store.tasks.seedLockedSlug"></code>
          <span class="muted small" x-text="'(' + $store.tasks.seedLockedClass() + ' · id forced after LLM)'"></span>
          <button type="button" class="btn small" @click="$store.tasks.clearSeedCreateMode()">
            ${ic('lock-open')}Clear lock
          </button>
        </div>
        <!-- Same mention/wiki composer as WorkUnits pane A (chips + @ autocomplete) -->
        <div id="seed-a"
             class="composer mention-editor mention-editor-multi seed-composer"
             contenteditable="true"
             :data-placeholder="$store.tasks.isSeedCreateMode()
               ? 'Describe this entity in plain English…'
               : 'Describe people, teams, products… preview updates as you type'"
             data-empty="1"></div>
      </section>
      <div class="split split-h" title="Drag to resize"
           @pointerdown="$store.tasks.startResizeSeedRow('in-yaml', $event)"></div>
      <!-- B · YAML + V · Validation (two columns inside the yaml row) -->
      <section class="pane seed-pane seed-pane-yaml">
        <div class="bv-split" :style="$store.tasks.bvSplitStyle()">
          <div class="bv-col bv-col-yaml">
            <div class="pane-header">
              <span class="pane-header-title">${ic('code')}B · YAML preview</span>
            </div>
            <pre class="yaml-hl seed-yaml" x-show="$store.tasks.seedPreviewHtml"
                 x-html="$store.tasks.seedPreviewHtml"></pre>
            <p class="muted pad" x-show="!$store.tasks.seedPreviewHtml">
              YAML appears here after the model finishes.
            </p>
          </div>
          <div class="split split-v bv-gutter"
               title="Drag to resize B / V"
               @pointerdown="$store.tasks.startResizeBv($event)"></div>
          <div class="bv-col bv-col-v">
            <div class="pane-header">
              <span class="pane-header-title">${ic('seal-check')}V · Validation</span>
              <span class="muted small" x-show="$store.tasks.seedValidationBusy">
                <span class="spin inline"></span>checking…
              </span>
              <span class="muted small"
                    x-show="!$store.tasks.seedValidationBusy && $store.tasks.seedPreviewYaml && $store.tasks.seedValidationValid && !$store.tasks.seedValidationText"
                    >ok</span>
            </div>
            <pre class="validation-pane"
                 :class="{
                   'validation-ok': $store.tasks.seedValidationValid && !$store.tasks.seedValidationText,
                   'validation-fail': !$store.tasks.seedValidationValid || !!$store.tasks.seedValidationText
                 }"
                 x-text="$store.tasks.seedValidationText
                   || ($store.tasks.seedPreviewYaml ? ($store.tasks.seedValidationBusy ? '…' : 'valid') : '—')"></pre>
          </div>
        </div>
      </section>
      <div class="split split-h" title="Drag to resize"
           @pointerdown="$store.tasks.startResizeSeedRow('yaml-sum', $event)"></div>
      <!-- C · Summary + proposed entities/relations (one scroll surface; not a 4th row) -->
      <section class="pane seed-pane seed-pane-sum">
        <div class="pane-header">
          <span class="pane-header-title">${ic('article')}C · Summary</span>
          <span class="muted small"
                x-show="($store.tasks.seedResult && $store.tasks.seedResult.entities || []).length"
                x-text="(($store.tasks.seedResult && $store.tasks.seedResult.entities) || []).length + ' entit' + ((($store.tasks.seedResult && $store.tasks.seedResult.entities) || []).length === 1 ? 'y' : 'ies')"></span>
        </div>
        <div class="seed-c-body">
          <div class="seed-summary wiki-prose md-prose"
               x-show="$store.tasks.seedSummaryHtml"
               x-html="$store.tasks.seedSummaryHtml"
               @click="onWikiClick($event)"></div>
          <p class="muted pad" x-show="!$store.tasks.seedSummaryHtml && !$store.tasks.seedBusy">
            Narrative summary appears here after preview.
          </p>
          <!-- Draft entities + edges live inside C; scroll this pane to see them -->
          <div class="seed-entities-block"
               x-show="($store.tasks.seedResult && $store.tasks.seedResult.entities || []).length">
            <h4 class="seed-c-subhead">Proposed entities</h4>
            <!--
              Forest: only roots that are not also relation targets of another draft entity
              (avoids atlas_product at root AND under OWNS). Fully expanded by default.
            -->
            <ul class="rel-tree seed-entity-tree">
              <li class="rel-tree-node"
                  x-for="e in $store.tasks.seedRootEntities()"
                  :key="e.slug"
                  :class="{
                    'is-branch': (e.relationTree || []).length,
                    'is-leaf': !(e.relationTree || []).length,
                    open: e.treeOpen !== false,
                    fail: !$store.tasks.seedEntityOk(e)
                  }">
                <div class="rel-tree-row">
                  <button type="button" class="rel-tree-twisty"
                          x-show="(e.relationTree || []).length"
                          @click.stop="$store.tasks.toggleSeedEntityTree(e)"
                          :aria-expanded="e.treeOpen !== false ? 'true' : 'false'">
                    <i class="ph-bold"
                       :class="e.treeOpen !== false ? 'ph-caret-down' : 'ph-caret-right'"
                       aria-hidden="true"></i>
                  </button>
                  <span class="rel-tree-twisty is-bullet"
                        x-show="!(e.relationTree || []).length"
                        aria-hidden="true"></span>
                  <a class="entity-pill entity-link rel-tree-entity"
                     :data-entity="e.slug"
                     :title="e.slug"
                     href="#"
                     @click.prevent="goEntity(e.slug)">
                    ${ic('cube')}
                    <span class="entity-pill-label"
                          x-text="$store.tasks.seedEntityDisplay(e)"></span>
                  </a>
                  <button type="button" class="seed-entity-trash"
                          title="Remove from draft"
                          @click.stop="$store.tasks.seedExcludeEntity(e.slug)">
                    ${ic('trash')}
                  </button>
                  <span class="error" x-show="!$store.tasks.seedEntityOk(e)"
                        x-text="$store.tasks.seedEntityError(e)"></span>
                </div>
                <div x-show="e.treeOpen !== false && (e.relationTree || []).length">
                  ${relEdgeTreeHtml('e.relationTree', {
                    labelExpr: '$store.tasks.seedTargetLabel(t.slug)',
                    seedTrash: true,
                  })}
                </div>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  </div>

  <!-- ═══════════ Delete entity confirm ═══════════ -->
  <div class="modal-backdrop" x-show="$store.tasks.deleteEntityDialog"
       @click.self="$store.tasks.closeDeleteEntityDialog()">
    <div class="modal modal-danger" @click.stop>
      <h3>${ic('trash')}Delete entity</h3>
      <p>
        Permanently remove
        <strong x-text="($store.tasks.deleteEntityTarget && $store.tasks.deleteEntityTarget.slug) || ''"></strong>
        from the live index?
      </p>
      <p class="muted">
        This cannot be undone from the UI. Related links on other entities are not cascade-deleted.
        Run <code>brain export --prune</code> later if you also want the <code>.md</code> file removed.
      </p>
      <div class="error" x-show="$store.tasks.deleteEntityError"
           x-text="$store.tasks.deleteEntityError"></div>
      <div class="modal-actions">
        <button type="button" class="btn"
                :disabled="$store.tasks.entityDeleting"
                @click="$store.tasks.closeDeleteEntityDialog()">
          ${ic('x')}Cancel
        </button>
        <button type="button" class="btn danger"
                :disabled="$store.tasks.entityDeleting"
                @click="$store.tasks.confirmDeleteEntity()">
          ${ic('trash')}<span x-text="$store.tasks.entityDeleting ? 'Deleting…' : 'Delete entity'"></span>
        </button>
      </div>
    </div>
  </div>

  <!-- ═══════════ Delete WorkUnit confirm ═══════════ -->
  <div class="modal-backdrop" x-show="$store.tasks.deleteWorkUnitDialog"
       @click.self="$store.tasks.closeDeleteWorkUnitDialog()">
    <div class="modal modal-danger" @click.stop>
      <h3>${ic('trash')}Delete WorkUnit</h3>
      <p>
        Permanently remove
        <strong x-text="'WorkUnit/' + String($store.tasks.selectedId || '')"></strong>
        from the live index?
      </p>
      <p class="muted">
        This cannot be undone from the UI. Dependency links on other WorkUnits are not cascade-deleted.
      </p>
      <div class="error" x-show="$store.tasks.deleteWorkUnitError"
           x-text="$store.tasks.deleteWorkUnitError"></div>
      <div class="modal-actions">
        <button type="button" class="btn"
                :disabled="$store.tasks.workUnitDeleting"
                @click="$store.tasks.closeDeleteWorkUnitDialog()">
          ${ic('x')}Cancel
        </button>
        <button type="button" class="btn danger"
                :disabled="$store.tasks.workUnitDeleting"
                @click="$store.tasks.confirmDeleteWorkUnit()">
          ${ic('trash')}<span x-text="$store.tasks.workUnitDeleting ? 'Deleting…' : 'Delete WorkUnit'"></span>
        </button>
      </div>
    </div>
  </div>

  <!-- ═══════════ Git modal ═══════════ -->
  <div class="modal-backdrop" x-show="$store.tasks.gitDialog" @click.self="$store.tasks.closeGitDialog()">
    <div class="modal" @click.stop>
      <h3>${ic('git-commit')}Commit brain snapshot</h3>
      <p class="muted">Runs brain export (pglite → .md) then git commit in db/. Local only — never pushes.</p>
      <div class="error" x-show="$store.tasks.git && $store.tasks.git.repo === false"
           x-text="($store.tasks.git && $store.tasks.git.error) || 'No git repo'"></div>
      <div class="git-summary" x-show="!$store.tasks.git || $store.tasks.git.repo !== false">
        <div x-text="'branch: ' + (($store.tasks.git && $store.tasks.git.branch) || '?')"></div>
        <div x-text="($store.tasks.git && $store.tasks.git.clean) ? 'working tree clean' : (($store.tasks.git && $store.tasks.git.dirty) || 0) + ' uncommitted change(s)'"></div>
        <ul class="file-list" x-show="$store.tasks.git && $store.tasks.git.files && $store.tasks.git.files.length">
          <li x-for="f in ($store.tasks.git && $store.tasks.git.files) || []" :key="f.path"
              x-text="f.code + ' ' + f.path"></li>
        </ul>
        <p class="muted" x-show="$store.tasks.git && $store.tasks.git.lastCommit"
           x-text="$store.tasks.git && $store.tasks.git.lastCommit
             ? ('last: ' + $store.tasks.git.lastCommit.subject + ' (' + String($store.tasks.git.lastCommit.hash).slice(0,7) + ')')
             : ''"></p>
      </div>
      <label>
        Message
        <input type="text" placeholder="snapshot"
               :value="$store.tasks.gitMessage"
               @input="$store.tasks.gitMessage = $event.target.value"
               @keydown.enter="$store.tasks.commitSnapshot()">
      </label>
      <div class="modal-actions">
        <button type="button" class="btn" @click="$store.tasks.closeGitDialog()">
          ${ic('x')}Cancel
        </button>
        <button type="button" class="btn primary"
                :disabled="$store.tasks.gitBusy || ($store.tasks.git && $store.tasks.git.repo === false)"
                @click="$store.tasks.commitSnapshot()">
          ${ic('check')}<span x-text="$store.tasks.gitBusy ? 'Committing…' : 'Commit snapshot'"></span>
        </button>
      </div>
    </div>
  </div>
</div>
`

function normalizeAppPath(path) {
  const p = (path || '/').replace(/\/+$/, '') || '/'
  return p
}

/**
 * SPA navigate via m.js Router (never location.assign / full reload).
 * Call from @click.prevent on <a> so the browser does not follow href.
 */
function go(path, ev) {
  if (ev && typeof ev.preventDefault === 'function') ev.preventDefault()
  const next = normalizeAppPath(path)
  const cur = normalizeAppPath(Router.uri || location.pathname || '/')
  // No-op if already here — avoids needless store writes / layout thrash
  if (next === cur) return
  Router.set(next)
}

/** Schema tab: restore last path (selection + view) from localStorage-backed store. */
function goSchema(ev) {
  if (ev && typeof ev.preventDefault === 'function') ev.preventDefault()
  const path = normalizeAppPath(store.schemaTabHref?.() || store.lastSchemaPath || '/browse')
  const cur = normalizeAppPath(Router.uri || location.pathname || '/')
  if (path === cur) return
  Router.set(path)
}

/**
 * Class-tree row click (folder / non-leaf):
 *  - Always show that class’s detail when not already on it
 *    (including when an entity under this class is selected — browseClass
 *    still matches the parent, so we must not treat that as “collapse only”)
 *  - Re-click while already on this class’s detail + expanded → collapse branch
 *  - Re-click while on this class’s detail + collapsed → re-expand (keep detail)
 */
function goClass(name) {
  const s = store
  const cls = String(name || '')
  if (!cls) return

  // True only on /browse/:cls — NOT when viewing /browse/:cls/:id (entity)
  const onClassDetail =
    s.browseClass === cls && !s.routeParams?.id && String(s.route || '') === '/browse/:cls'
  const open = !!s.expandedClasses?.[cls]

  if (onClassDetail && open) {
    // Already viewing this class’s schema detail → collapse children only
    s.setClassExpanded(cls, false)
    return
  }

  // Expand branch so children stay visible after navigation
  s.setClassExpanded(cls, true)

  if (onClassDetail && !open) {
    // Detail already showing; ensure this class’s children are loaded
    if (!s.classEntities(cls).length) {
      void s.loadClassEntities(cls, { clearEntity: true })
    }
    return
  }

  // From another class, from an entity under this class, or from /browse root
  // → navigate to class detail (loads def + entities, clears entity pane)
  Router.set(`/browse/${encodeURIComponent(cls)}`)
}

function goEntity(slug) {
  // Existing → Schema; missing → Seed create draft with locked slug
  void store.openEntityOrSeed?.(slug)
}

/**
 * Blank area of the schema tree (full-height list padding) → deselect.
 * Clicks on class rows / entity leaves bubble from children and are ignored.
 */
function onSchemaTreeBlank(ev) {
  if (ev.target !== ev.currentTarget) return
  store.clearSchemaSelection?.()
}

/**
 * Blank area of the WorkUnits sidebar list → clear selection
 * (same pattern as schema tree blank deselect).
 */
function onWorkUnitsSidebarBlank(ev) {
  if (ev.target !== ev.currentTarget) return
  store.clearWorkUnitSelection?.()
}

function onWikiClick(ev) {
  const a = ev.target?.closest?.('a[data-entity]')
  if (!a) return
  ev.preventDefault()
  const slug = a.getAttribute('data-entity')
  if (slug) goEntity(slug)
}

/**
 * Mount the app shell. Call once per boot (HMR-safe via m.js root remount).
 *
 * m.js intended SPA pattern (see m-js-docs + brain viz):
 *   ONE static template + named store. Route changes only write store fields.
 *
 * Critical: M.mount installs Router.onChange that nulls rootInstance and
 * rebuilds the whole tree (correct for Router.render() apps). We must replace
 * that handler immediately so tab switches never tear down the shell/topbar.
 *
 * @param {() => void | Promise<void>} [onRouteChange] store-only route sync
 */
export function mountApp(onRouteChange) {
  void store

  // HMR: drop previous VDOM so a new TEMPLATE AST is used; named store survives
  try {
    if (M.root || document.getElementById('app')?.childNodes?.length) {
      M.unmount()
    }
  } catch {
    /* first boot */
  }
  const appEl = document.getElementById('app')
  if (appEl?.childNodes?.length) appEl.replaceChildren()

  M.mount('#app', () => ({
    template: TEMPLATE,
    go,
    goSchema,
    goClass,
    goEntity,
    onSchemaTreeBlank,
    onWorkUnitsSidebarBlank,
    onWikiClick,
  }))

  // Replace destroy-on-route handler installed by M.mount (see m.js mount()).
  Router.onChange(() => {
    if (typeof onRouteChange === 'function') {
      void onRouteChange()
    }
  })
}
