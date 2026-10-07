<template>
  <section class="page" data-module="entryapprove">
    <header class="page-head">
      <div>
        <h2>入廊作业审批管理</h2>
        <p class="page-desc">作业申请的状态判定收拢为一份实现：申请编号、申请单位、作业舱室与安全措施同一处校验，待审批→已批准→已完工、驳回分支只留一份推进关系，列表、动作、导出与维保台账共用。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="!canWrite" @click="openCreate">登记作业申请</button>
        <button class="btn" type="button" @click="exportRows">导出入廊作业审批清单</button>
      </div>
    </header>

    <div class="identity-bar">
      <label class="filter-item">
        <span>当前身份（归属校验）</span>
        <select :value="identityPreset" @change="switchIdentity">
          <option v-for="(item, index) in identityPresets" :key="item.label" :value="index">
            {{ item.label }}
          </option>
        </select>
      </label>
      <span v-if="!canWrite" class="error-text">当前为 {{ store.team }}：入口只读，提交与越权改动按归属驳回。</span>
      <span v-else class="ok-text">当前为责任班组 {{ store.team }}，可办理审批。</span>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 待办与台账同源读数：两边数量与差异都来自引擎 todoSummary。 -->
    <div class="todo-panel">
      <div class="todo-line">
        <span>申请待办：<strong>{{ todo.pendingEntries }}</strong> 件</span>
        <span>联批台账条目：<strong>{{ todo.linkedLedgers }}</strong> 条</span>
        <span>台账自身待办（非联批）：<strong>{{ todo.pendingLedgers }}</strong> 条</span>
        <span :class="todo.drift ? 'error-text' : 'ok-text'">账与审批差异：<strong>{{ todo.drift }}</strong></span>
        <button class="btn" type="button" :disabled="!canWrite" @click="reconcile">按审批结论对账补登</button>
      </div>
      <ul v-if="todo.details.length" class="todo-drift">
        <li v-for="item in todo.details" :key="`${item.kind}-${item.applyNo}`">
          {{ item.applyNo }}：{{ item.kind }}（当前结论「{{ item.status }}」）
        </li>
      </ul>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form v-if="showForm" class="create-form" @submit.prevent="submitCreate">
      <h3>登记作业申请</h3>
      <p class="page-desc">同一申请编号重复提交不会生成第二条记录；安全措施为空按待补材料处理并给出说明。</p>
      <div class="form-grid">
        <label v-for="field in formFields" :key="field.key" class="filter-item">
          <span>{{ field.label }}{{ field.required ? ' *' : '' }}</span>
          <input v-model="form[field.key]" :placeholder="field.placeholder" />
        </label>
      </div>
      <div class="form-actions">
        <button class="btn primary" type="submit">提交审批</button>
        <button class="btn ghost" type="button" @click="showForm = false">取消</button>
      </div>
    </form>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
          <th>审批轨迹</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ displayCell(row, column) }}</td>
          <td>
            {{ row.status }}
            <span v-if="materialText(row)" class="cell-note">{{ materialText(row) }}</span>
          </td>
          <td class="row-actions">
            <template v-if="canWrite">
              <button
                v-for="action in entryActionsFor(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
              <span v-if="!entryActionsFor(row).length" class="cell-note">已办结</span>
            </template>
            <span v-else class="cell-note">只读</span>
          </td>
          <td>
            <button class="link" type="button" @click="toggleTrack(row)">轨迹 ({{ (row.events ?? []).length }})</button>
          </td>
        </tr>
        <tr v-if="expandedNo">
          <td :colspan="columns.length + 3" class="track-cell">
            <ul class="track-list">
              <li v-for="(event, i) in trackOf(expandedNo)" :key="i">
                <strong>{{ event.at }}</strong> · {{ event.action }}
                <template v-if="event.from || event.to">（{{ event.from || '登记' }} → {{ event.to || '—' }}）</template>
                · {{ event.operator }}/{{ event.team }}
                <em v-if="event.repeat" class="repeat-tag">重复触发·并入同条</em>
                <span v-if="event.note" class="cell-note">（{{ event.note }}）</span>
              </li>
            </ul>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无入廊作业审批数据，可先登记作业申请</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条入廊作业审批记录</span>
      <span v-if="infoMessage" class="ok-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  createEntry,
  downloadEntries,
  entryActionsFor,
  entryTodo,
  listEntries,
  moduleMeta,
  reconcileEntryTodo,
  runAction as applyAction,
  sessionCanWriteEntry,
} from '@/api/local-service'
import { F_MISSING_NOTE } from '@/domain/entry-approval'
import { IDENTITY_PRESETS, useSessionStore } from '@/stores/session'
import type { DomainEvent, EntryRow } from '@/data/types'

const meta = moduleMeta('entryapprove')
const store = useSessionStore()
const columns = meta.fields
const filterFields = columns.slice(0, 3)
const identityPresets = IDENTITY_PRESETS
const identityPreset = ref(0)

const formFields = [
  { key: 'applyNo', label: '申请编号', required: true, placeholder: 'ENTR-XXXX' },
  { key: 'unit', label: '申请单位', required: true, placeholder: '如：远东管道施工队' },
  { key: 'cabin', label: '作业舱室', required: true, placeholder: '如：北环综合舱 K1+200' },
  { key: 'workType', label: '作业类型', required: false, placeholder: '如：燃气管线接驳' },
  { key: 'workerCount', label: '作业人数', required: false, placeholder: '如：6' },
  { key: 'safety', label: '安全措施', required: true, placeholder: '通风、防火、气体检测、监护安排等；为空按待补材料' },
] as const

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const todo = ref(returnTodoZero())
const showForm = ref(false)
const expandedNo = ref('')

const emptyForm = () => ({ applyNo: '', unit: '', cabin: '', workType: '', workerCount: '', safety: '' })
const form = reactive(emptyForm())

const canWrite = computed(() => sessionCanWriteEntry())

const statusSummary = computed(() =>
  ['待补材料', '待审批', '已批准', '已驳回', '已完工'].map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 统计卡与台账/待办同源：全部从引擎读数，页面不再硬编码 0。
const stats = computed(() => [
  { label: '待补材料申请', value: countBy('待补材料') },
  { label: '待审批申请', value: countBy('待审批') },
  { label: '已批准申请', value: countBy('已批准') },
  { label: '已驳回申请', value: countBy('已驳回') },
  { label: '已完工申请', value: countBy('已完工') },
])

function countBy(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function returnTodoZero() {
  return { pendingEntries: 0, pendingLedgers: 0, linkedLedgers: 0, drift: 0, details: [] as ReturnType<typeof entryTodo>['details'] }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  if (!canWrite.value) {
    errorMessage.value = `入廊作业审批由${store.team}之外的责任班组归口，当前身份只读`
    return
  }
  Object.assign(form, emptyForm())
  showForm.value = true
}

function submitCreate() {
  errorMessage.value = ''
  const result = createEntry({ ...form })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  showForm.value = false
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
  } else {
    infoMessage.value = result.message
  }
  reload()
}

function reconcile() {
  errorMessage.value = ''
  const result = reconcileEntryTodo()
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function switchIdentity(event: Event) {
  const index = Number((event.target as HTMLSelectElement).value)
  identityPreset.value = index
  store.useIdentity(identityPresets[index].value)
  infoMessage.value = `已切换身份：${store.operator} · ${store.team} · ${store.post}`
  reload()
}

function materialText(row: EntryRow): string {
  return String(row[F_MISSING_NOTE] ?? '')
}

function displayCell(row: EntryRow, column: string): string | number {
  const value = row[column]
  if (column === '审批人员') {
    return String(value ?? '') || '—'
  }
  return (value as string | number) ?? '—'
}

function trackOf(applyNo: string): DomainEvent[] {
  const row = rows.value.find((item) => String(item['申请编号']) === applyNo)
  return row?.events ?? []
}

function toggleTrack(row: EntryRow) {
  const no = String(row['申请编号'])
  expandedNo.value = expandedNo.value === no ? '' : no
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    todo.value = entryTodo()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '入廊作业审批列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.identity-bar {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  font-size: 13px;
}
.ok-text { color: #067647; }
.todo-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  font-size: 13px;
}
.todo-line { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
.todo-drift { margin: 8px 0 0; padding-left: 18px; color: var(--muted); }
.create-form {
  background: #fff;
  border: 1px solid var(--brand);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 8px 0; }
.form-actions { display: flex; gap: 8px; }
.cell-note { display: block; color: var(--muted); font-size: 12px; }
.track-cell { background: #f8fafc; }
.track-list { margin: 0; padding-left: 16px; font-size: 12px; color: var(--muted); }
.track-list li { margin-bottom: 4px; }
.repeat-tag { color: #b54708; font-style: normal; margin-left: 6px; }
</style>
