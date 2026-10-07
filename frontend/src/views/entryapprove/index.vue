<template>
  <section class="page" data-module="entryapprove">
    <header class="page-head">
      <div>
        <h2>入廊作业审批管理</h2>
        <p class="page-desc">
          登记作业申请并按「待审批 → 已批准 → 已完工」推进，驳回可补正重提；
          状态判定、校验与台账联动统一由审批口径模块计算，列表、动作、导出同源。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记作业申请</button>
        <button class="btn" type="button" @click="exportRows">导出入廊作业审批清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ warn: item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item muted">当前班组：{{ store.crew }}（非本班组申请只读）</span>
    </p>

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
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            {{ row[column] || '—' }}
            <p v-if="column === '安全措施' && !row[column]" class="cell-note">缺项：{{ row.缺项说明 || '安全措施为空，按待补材料处理' }}</p>
          </td>
          <td>
            {{ row.status }}
            <p v-if="row.缺项说明" class="cell-note">{{ row.缺项说明 }}</p>
          </td>
          <td class="row-actions">
            <template v-if="canWrite(row)">
              <button
                v-for="action in availableActions(row.status)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
              <span v-if="!availableActions(row.status).length" class="muted">无</span>
            </template>
            <span v-else class="muted">只读（归属{{ row.责任班组 }}）</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无入廊作业审批数据，可先登记作业申请</td>
        </tr>
      </tbody>
    </table>

    <section v-if="selected" class="detail-panel" :data-open="String(Boolean(selected))">
      <header class="detail-head">
        <h3>审批轨迹 · {{ selected.申请编号 }}</h3>
        <button class="link" type="button" @click="selected = null">关闭</button>
      </header>
      <ol class="trace-list">
        <li v-for="(event, idx) in (selected.轨迹 ?? [])" :key="idx" class="trace-item">
          <span class="trace-at">{{ event.at }}</span>
          <span class="trace-kind" :data-kind="event.kind">{{ event.kind }} → {{ event.status }}</span>
          <span class="trace-by">{{ event.by }}<em v-if="event.legacy">（存量回填）</em></span>
          <span v-if="event.note" class="trace-note">{{ event.note }}</span>
        </li>
      </ol>
    </section>

    <div v-if="creating" class="modal-mask" @click.self="closeCreate">
      <form class="modal-card" @submit.prevent="submitDraft">
        <h3>登记作业申请</h3>
        <p class="modal-hint">归属班组为当前值班班组「{{ store.crew }}」；编号格式 ENTR-0001，重复编号不会生成第二条记录。</p>
        <label v-for="field in draftFields" :key="field.key" class="modal-field">
          <span>{{ field.label }}<i v-if="field.required">*</i></span>
          <input
            v-model="draft[field.key]"
            :placeholder="field.placeholder"
            :type="field.key === '作业人数' ? 'number' : 'text'"
          />
        </label>
        <p class="modal-hint">安全措施允许暂不填写：系统会收件并按「待补材料」挂起，补齐后重新提交并入本申请。</p>
        <footer class="modal-actions">
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="submit">提交登记</button>
        </footer>
      </form>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条入廊作业审批记录</span>
      <button v-if="rows.length" class="link" type="button" @click="toggleTrace">
        {{ selected ? '关闭轨迹' : '查看首条轨迹' }}
      </button>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  createEntry,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  ENTRY_STATUSES,
  MATERIAL_PENDING,
  type DraftInput,
} from '@/domain/entry-approval'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('entryapprove')
const columns = ['申请编号', '申请单位', '作业舱室', '作业类型', '作业人数', '安全措施', '审批人员', '审批状态']
// 页面不再自带状态机：每一行可做哪些动作，直接由唯一推进关系反推。
const ACTIONS_BY_STATUS: Record<string, string[]> = {
  [MATERIAL_PENDING]: ['提交审批'],
  待审批: ['确认批准', '驳回申请'],
  已批准: ['登记完工'],
  已驳回: ['提交审批'],
  已完工: [],
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selected = ref<EntryRow | null>(null)
const creating = ref(false)

const draftFields: { key: keyof DraftInput; label: string; required: boolean; placeholder: string }[] = [
  { key: '申请编号', label: '申请编号', required: true, placeholder: 'ENTR-0001' },
  { key: '申请单位', label: '申请单位', required: true, placeholder: '申请入廊的作业单位' },
  { key: '作业舱室', label: '作业舱室', required: true, placeholder: '如 给水舱 K1+200' },
  { key: '作业类型', label: '作业类型', required: false, placeholder: '如 阀门更换' },
  { key: '作业人数', label: '作业人数', required: false, placeholder: '如 4' },
  { key: '安全措施', label: '安全措施', required: false, placeholder: '可暂缺，缺项按待补材料挂起' },
]

const emptyDraft = (): DraftInput => ({
  申请编号: '',
  申请单位: '',
  作业舱室: '',
  作业类型: '',
  作业人数: '',
  安全措施: '',
})
const draft = reactive<DraftInput>(emptyDraft())

const statusSummary = computed(() =>
  [...ENTRY_STATUSES, MATERIAL_PENDING].map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待审批申请', value: countBy('待审批'), warn: false },
  { label: '待补材料', value: countBy(MATERIAL_PENDING), warn: true },
  { label: '已批准（在途作业）', value: countBy('已批准'), warn: false },
  { label: '已完工申请', value: countBy('已完工'), warn: false },
  { label: '已驳回申请', value: countBy('已驳回'), warn: true },
])

function countBy(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function availableActions(status: string): string[] {
  return ACTIONS_BY_STATUS[status] ?? []
}

function canWrite(row: EntryRow): boolean {
  return String(row.责任班组 ?? '') === store.crew
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  Object.assign(draft, emptyDraft())
  creating.value = true
}

function closeCreate() {
  creating.value = false
}

function submitDraft() {
  errorMessage.value = ''
  const result = createEntry({ ...draft })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  creating.value = false
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  selected.value = null
  reload()
}

function toggleTrace() {
  selected.value = selected.value ? null : rows.value[0]
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (selected.value) {
      selected.value = payload.items.find((row) => row.id === selected.value?.id) ?? null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '入廊作业审批列表读取失败'
  }
}

onMounted(reload)
</script>
