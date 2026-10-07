import {
  applyEntryAction,
  completeWorkOrderFromLedger,
  ENTRY_KEY,
  MAINTENANCE_KEY,
  submitEntry,
  viewRow,
  type Actor,
  type DraftInput,
} from '@/domain/entry-approval'
import { useSessionStore } from '@/stores/session'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetKeys, saveAll, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

function currentActor(): Actor {
  const store = useSessionStore()
  return { name: store.operator, crew: store.crew, post: store.post }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  // 入廊作业审批的列表状态不读存储快照，统一由领域层按审批轨迹现场推导。
  const source = key === ENTRY_KEY ? listRows(key).map(viewRow) : listRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 登记 / 提交作业申请（页面「登记作业申请」入口与重复提交共用）。 */
export function createEntry(draft: DraftInput): ActionResult {
  const result = submitEntry(listRows(ENTRY_KEY), draft, currentActor())
  if (!result.ok || !result.rows) {
    return { ok: false, message: result.message }
  }
  saveAll(Object.fromEntries(result.rows.map((patch) => [patch.entryKey, patch.rows])))
  return { ok: true, message: result.message }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  // 入廊作业审批的全部动作只走领域实现，通用流转不再碰它。
  if (key === ENTRY_KEY) {
    const result = applyEntryAction(
      listRows(ENTRY_KEY),
      listRows(MAINTENANCE_KEY),
      id,
      action,
      currentActor(),
    )
    if (!result.ok || !result.rows) {
      return { ok: false, message: result.message }
    }
    // 申请与维保台账一次事务写回：待办清单与台账读数始终一致。
    saveAll(Object.fromEntries(result.rows.map((patch) => [patch.entryKey, patch.rows])))
    return { ok: true, message: result.message }
  }

  // 维保台账侧：来源于入廊申请的工单完工要反向联动申请，其余维持通用流程。
  if (key === MAINTENANCE_KEY && action === '确认完工') {
    const linked = completeWorkOrderFromLedger(
      listRows(ENTRY_KEY),
      listRows(MAINTENANCE_KEY),
      id,
      currentActor(),
    )
    if (linked.ok && linked.rows) {
      saveAll(Object.fromEntries(linked.rows.map((patch) => [patch.entryKey, patch.rows])))
      return { ok: true, message: linked.message }
    }
    if (linked.message !== 'NOT_ENTRY_ORDER') {
      return { ok: false, message: linked.message }
    }
  }

  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  // 审批与维保工单同源：重置任一侧时，另一侧一并回到示例口径并只迁移一次。
  const linked = key === ENTRY_KEY ? [ENTRY_KEY, MAINTENANCE_KEY]
    : key === MAINTENANCE_KEY ? [MAINTENANCE_KEY, ENTRY_KEY]
    : [key]
  resetKeys(linked)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 导出与列表同源：入廊作业审批的「当前状态」也由领域层推导，
  // 列与字段保持不变（编号 + 8 个登记字段 + 当前状态）。
  const source = key === ENTRY_KEY ? listRows(key).map(viewRow) : listRows(key)
  const csvCell = (value: unknown): string => {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  for (const row of source) {
    lines.push(
      [row.id, ...meta.fields.map((field) => csvCell(row[field] ?? '')), csvCell(row.status)].join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }

}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    // 入廊作业审批的待办/异常由领域口径现算，与列表、台账一致。
    const entries = meta.key === ENTRY_KEY ? (rows[meta.key] ?? []).map(viewRow) : (rows[meta.key] ?? [])
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

export type EntryTodo = {
  id: number
  code: string
  crew: string
  cabin: string
  status: string
  materialMissing: boolean
  note: string
  linkedOrderCode: string
  orderStatus: string
}

/**
 * 作业审批待办清单：与维保台账在同一数据上现算。
 * 申请侧待办 = 待审批 + 待补材料；台账侧对应工单 = WORK-xxxx。
 * 两边的在途（已批准作业 ⇄ 检修中工单）必须一一对应，否则 syncOk 为 false。
 */
export function loadEntryTodos(): { todos: EntryTodo[]; syncOk: boolean; message: string } {
  const entries = listRows(ENTRY_KEY).map(viewRow)
  const maintenance = listRows(MAINTENANCE_KEY)
  const orderOf = (code: string) =>
    maintenance.find((row) => String(row.来源申请编号 ?? '') === code)

  const todos: EntryTodo[] = entries
    // 待审批、待补材料是审批侧待办；已批准是台账侧在途待办（对应检修中工单）。
    .filter((row) => row.pending || String(row.status) === '已批准')
    .map((row) => {
      const order = orderOf(String(row.申请编号))
      return {
        id: Number(row.id),
        code: String(row.申请编号),
        crew: String(row.责任班组 ?? ''),
        cabin: String(row.作业舱室 ?? ''),
        status: String(row.status),
        materialMissing: !String(row.安全措施 ?? '').trim(),
        note: String(row.缺项说明 ?? ''),
        linkedOrderCode: order ? String(order.检修编号) : '',
        orderStatus: order ? String(order.status) : '',
      }
    })

  // 一致性校验：每条已批准申请都有一张检修中/已完工工单；反之每张在途工单都有已批准申请。
  const approved = entries.filter((row) => String(row.status) === '已批准')
  const orphanOrders = maintenance.filter(
    (row) =>
      row.来源申请编号 &&
      String(row.status) === '检修中' &&
      !entries.some(
        (entry) =>
          String(entry.申请编号) === String(row.来源申请编号) &&
          ['已批准', '已完工'].includes(String(entry.status)),
      ),
  )
  const missingOrders = approved.filter((row) => !orderOf(String(row.申请编号)))
  const syncOk = orphanOrders.length === 0 && missingOrders.length === 0
  const message = syncOk
    ? `待办 ${todos.length} 条，已批准作业 ${approved.length} 条与台账工单一一对应，两边读数一致`
    : `待办与台账不一致：申请缺工单 ${missingOrders.length} 条，工单缺申请 ${orphanOrders.length} 条`

  return { todos, syncOk, message }
}
