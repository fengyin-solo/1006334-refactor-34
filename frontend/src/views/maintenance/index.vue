<template>
  <section class="page" data-module="maintenance">
    <header class="page-head">
      <div>
        <h2>设施检修管理</h2>
        <p class="page-desc">
          维护检修记录与入廊作业工单。作业申请经批准后自动在此派单（编号 WORK-xxxx），
          台账确认完工与审批页登记完工写同一条轨迹，两页读数一致。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检修记录</button>
        <button class="btn" type="button" @click="exportRows">导出设施检修管理清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item muted">当前班组：{{ store.crew }}</span>
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
            <p v-if="column === '完工日期' && row.来源申请编号 && !row[column]" class="cell-note">
              {{ row.缺项说明 || '在途工单，尚未完工' }}
            </p>
          </td>
          <td>
            {{ row.status }}
            <p v-if="row.缺项说明" class="cell-note">{{ row.缺项说明 }}</p>
          </td>
          <td class="row-actions">
            <template v-if="rowActions(row).length">
              <button
                v-for="action in rowActions(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else-if="isLinked(row) && !canWrite(row)" class="muted">只读（归属{{ row.检修班组 }}）</span>
            <span v-else-if="isLinked(row)" class="muted">
              <button class="link" type="button" @click="selected = row">查看工单轨迹</button>
            </span>
            <span v-else-if="row.status === '已完工'" class="muted">
              <button class="link" type="button" @click="selected = row">查看轨迹</button>
            </span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无设施检修数据，作业申请批准后会自动派单</td>
        </tr>
      </tbody>
    </table>

    <section v-if="selected" class="detail-panel">
      <header class="detail-head">
        <h3>工单轨迹 · {{ selected.检修编号 }}</h3>
        <button class="link" type="button" @click="selected = null">关闭</button>
      </header>
      <ol class="trace-list">
        <li v-for="(event, idx) in (selected.轨迹 ?? [])" :key="idx" class="trace-item">
          <span class="trace-at">{{ event.at }}</span>
          <span class="trace-kind" :data-kind="event.kind">{{ event.kind }} → {{ event.status }}</span>
          <span class="trace-by">{{ event.by }}<em v-if="event.legacy">（存量回填）</em></span>
          <span v-if="event.note" class="trace-note">{{ event.note }}</span>
        </li>
        <li v-if="!(selected.轨迹 ?? []).length" class="muted">该记录为通用检修条目，暂无轨迹。</li>
      </ol>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条设施检修记录（含入廊作业派单 {{ linkedCount }} 条）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('maintenance')
const columns = ['检修编号', '检修对象', '检修类别', '检修班组', '计划工期', '完工日期', '更换部件', '检修状态']
const statuses = ['待开工', '检修中', '已完工', '已延期']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selected = ref<EntryRow | null>(null)

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const linkedCount = computed(() => rows.value.filter((row) => row.来源申请编号).length)

const stats = computed(() => [
  { label: '待开工检修', value: rows.value.filter((row) => row.status === '待开工').length },
  { label: '检修中记录', value: rows.value.filter((row) => row.status === '检修中').length },
  { label: '本月完工数', value: rows.value.filter((row) => row.status === '已完工').length },
])

function isLinked(row: EntryRow): boolean {
  return Boolean(row.来源申请编号)
}

function canWrite(row: EntryRow): boolean {
  // 入廊作业派单按作业责任班组归属；普通检修记录沿用通用流程不做归属拦截。
  return !isLinked(row) || String(row.检修班组 ?? '') === store.crew
}

function rowActions(row: EntryRow): string[] {
  if (!canWrite(row)) {
    return []
  }
  if (isLinked(row)) {
    // 作业工单只有两态：批准即检修中，完工收口；其余动作不开放，避免两套流转打架。
    return String(row.status) === '检修中' ? ['确认完工'] : []
  }
  if (String(row.status) === '待开工') {
    return ['提交开工']
  }
  if (String(row.status) === '检修中') {
    return ['确认完工', '申请延期']
  }
  return []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '检修记录登记入口尚未接入审批流；入廊作业工单由作业申请批准后自动生成'
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
    errorMessage.value = error instanceof Error ? error.message : '设施检修管理列表读取失败'
  }
}

onMounted(reload)
</script>
