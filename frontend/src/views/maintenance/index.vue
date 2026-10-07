<template>
  <section class="page" data-module="maintenance">
    <header class="page-head">
      <div>
        <h2>设施检修管理管理</h2>
        <p class="page-desc">维保台账分两类：本页登记的普通检修记录可流转；由入廊作业审批结论联动生成的条目（检修编号 MNT-申请序号）只读，其生命周期归审批域，冲突以审批结论为准。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检修记录</button>
        <button class="btn" type="button" @click="exportRows">导出设施检修管理清单</button>
      </div>
    </header>

    <div class="todo-panel">
      <span>普通检修待办：<strong>{{ pendingOwn }}</strong> 条</span>
      <span>入廊作业联批台账：<strong>{{ linkedCount }}</strong> 条（在办 {{ linkedPending }} / 已完工 {{ linkedFinished }}）</span>
      <span :class="todo.drift ? 'error-text' : 'ok-text'">与审批侧差异：<strong>{{ todo.drift }}</strong></span>
      <RouterLink class="link" to="/entryapprove">前往入廊作业审批对账</RouterLink>
    </div>

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
            {{ row[column] === '' || row[column] == null ? '—' : row[column] }}
            <span v-if="column === '检修编号' && isLinked(row)" class="linked-tag">联批</span>
          </td>
          <td>
            {{ row.status }}
            <span v-if="ledgerNote(row)" class="cell-note">{{ ledgerNote(row) }}</span>
          </td>
          <td class="row-actions">
            <template v-if="!isLinked(row)">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="cell-note">审批联动·只读</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无设施检修管理数据，可先登记检修记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条设施检修管理记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  entryTodo,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { F_LEDGER_NOTE, isLedgerLinked } from '@/domain/entry-approval'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('maintenance')
const columns = ["检修编号", "检修对象", "检修类别", "检修班组", "计划工期", "完工日期", "更换部件", "检修状态"]
const actions = ["提交开工", "确认完工", "申请延期"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const todo = ref(entryTodo())

const statusSummary = computed(() =>
  ["待开工", "检修中", "已完工", "已延期"].map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 统计与入廊作业页同源同口径，联批条目单列，避免「审批批准了账上没数」。
const linkedRows = computed(() => rows.value.filter(isLedgerLinked))
const ownRows = computed(() => rows.value.filter((row) => !isLedgerLinked(row)))
const linkedCount = computed(() => linkedRows.value.length)
const linkedPending = computed(() => linkedRows.value.filter((row) => row.pending).length)
const linkedFinished = computed(() => linkedRows.value.filter((row) => String(row.status) === '已完工').length)
const pendingOwn = computed(() => ownRows.value.filter((row) => row.pending).length)

const stats = computed(() => [
  { label: '待开工检修', value: countBy('待开工') },
  { label: '检修中记录', value: countBy('检修中') },
  { label: '本月完工数', value: countBy('已完工') },
  { label: '入廊作业联批条目', value: linkedCount.value },
])

function isLinked(row: EntryRow): boolean {
  return isLedgerLinked(row)
}
function countBy(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}
function ledgerNote(row: EntryRow): string {
  return String(row[F_LEDGER_NOTE] ?? '')
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '检修记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    todo.value = entryTodo()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设施检修管理列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.todo-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  font-size: 13px;
}
.ok-text { color: #067647; }
.error-text { color: #b42318; }
.linked-tag {
  display: inline-block;
  margin-left: 6px;
  background: #e0edff;
  color: #1f6feb;
  border-radius: 4px;
  padding: 0 6px;
  font-size: 11px;
}
.cell-note { display: block; color: var(--muted); font-size: 12px; }
</style>
