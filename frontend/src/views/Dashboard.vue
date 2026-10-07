<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <section class="todo-panel">
      <h3>入廊作业待办 · 与维保台账同步</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>申请编号</th>
            <th>责任班组</th>
            <th>作业舱室</th>
            <th>申请侧状态</th>
            <th>维保工单</th>
            <th>台账侧状态</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="todo in todos" :key="todo.id">
            <td>{{ todo.code }}</td>
            <td>{{ todo.crew }}</td>
            <td>{{ todo.cabin }}</td>
            <td>{{ todo.status }}</td>
            <td>{{ todo.linkedOrderCode || '—' }}</td>
            <td>{{ todo.orderStatus || '—' }}</td>
            <td>
              <template v-if="todo.materialMissing">安全措施为空，按待补材料处理</template>
              <template v-else-if="todo.note">{{ todo.note }}</template>
              <template v-else-if="todo.status === '已批准'">在途作业，等待登记完工</template>
            </td>
          </tr>
          <tr v-if="!todos.length">
            <td colspan="7" class="empty-state">暂无作业待办</td>
          </tr>
        </tbody>
      </table>
      <p :class="syncMessage === '' ? '' : syncOk ? 'sync-ok' : 'sync-bad'">{{ syncMessage }}</p>
    </section>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadEntryTodos, loadOverview } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'

type EntryTodo = Awaited<ReturnType<typeof loadEntryTodos>>['todos'][number]

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const todos = ref<EntryTodo[]>([])
const syncOk = ref(true)
const syncMessage = ref('')

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  const todoPayload = loadEntryTodos()
  todos.value = todoPayload.todos
  syncOk.value = todoPayload.syncOk
  syncMessage.value = todoPayload.message
}

onMounted(refresh)
</script>
