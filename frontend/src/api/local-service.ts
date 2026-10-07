import {
  ENTRY_KEY,
  F_SOURCE_APPLY,
  MAINTENANCE_KEY,
  RESPONSIBLE_TEAM,
  applyEntryAction,
  availableActions,
  createDraft,
  isLedgerLinked,
  mergeLedger,
  projectEntry,
  reconcileTodo,
  resolveApprover,
  todoSummary,
} from '@/domain/entry-approval'
import type { DraftInput } from '@/domain/entry-approval'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type { ActionResult, EntryRow, Identity, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

function currentIdentity(): Identity {
  const session = useSessionStore()
  return { operator: session.operator, team: session.team, post: session.post }
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

/**
 * 列表读取：入廊作业审批先经审批域引擎统一判定（状态/待办/异常/审批状态展示字段/
 * 审批人员推定都在 projectEntry 一处完成），再筛选。其他模块维持原读法。
 */
export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const raw = listRows(key)
  const rows = key === ENTRY_KEY ? raw.map(projectEntry).map(withResolvedApprover) : raw
  const matched = filterRows(rows, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 审批人员缺项在展示时按值班岗位推定（不回写历史记录）。 */
function withResolvedApprover(row: EntryRow): EntryRow {
  const shown = resolveApprover(row)
  return shown && shown !== String(row['审批人员'] ?? '') ? { ...row, 审批人员: shown } : row
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === ENTRY_KEY) {
    return runEntryAction(id, action)
  }
  if (key === MAINTENANCE_KEY) {
    return runMaintenanceAction(id, action)
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

/**
 * 入廊作业审批动作：全部交给审批域引擎判定（归属 → 推进关系 → 幂等），
 * 审批结论与维保台账在同一次 saveAll 里落库，保证两边读数一致。
 */
function runEntryAction(id: number, action: string): ActionResult {
  const rows = listRows(ENTRY_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的作业申请` }
  }
  const outcome = applyEntryAction(rows[index], action, currentIdentity())
  if (!outcome.result.ok) {
    return { ok: false, forbidden: outcome.result.forbidden, message: outcome.result.message }
  }

  const nextEntries = [...rows]
  nextEntries[index] = outcome.entry

  const patch: Record<string, EntryRow[]> = { [ENTRY_KEY]: nextEntries }
  if (outcome.ledger) {
    const ledgers = listRows(MAINTENANCE_KEY)
    const ledgerIndex = ledgers.findIndex(
      (row) => String(row[F_SOURCE_APPLY] ?? '') === String(outcome.entry['申请编号']),
    )
    const merged = mergeLedger(
      outcome.ledger,
      ledgerIndex >= 0 ? ledgers[ledgerIndex] : undefined,
    )
    const nextLedgers =
      ledgerIndex >= 0
        ? ledgers.map((row, i) => (i === ledgerIndex ? { ...merged, id: row.id } : row))
        : [...ledgers, { ...merged, id: nextLedgerId(ledgers) }]
    patch[MAINTENANCE_KEY] = nextLedgers
  }
  // 一次本地事务：申请与台账同时落，任何一边没准备好就整组不写。
  saveAll(patch)
  const finished = outcome.result
  return {
    ok: true,
    idempotent: finished.ok ? finished.idempotent : false,
    message: finished.message,
  }
}

/**
 * 维保台账动作：由审批结论生成的联批条目只允许只读——它的生命周期归审批域管，
 * 通用检修动作（提交开工/确认完工/申请延期）一律拒绝，冲突以审批域为准。
 */
function runMaintenanceAction(id: number, action: string): ActionResult {
  const rows = listRows(MAINTENANCE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修记录` }
  }
  const target = rows[index]
  if (isLedgerLinked(target)) {
    return {
      ok: false,
      message: `检修记录 ${target['检修编号']} 由作业申请 ${target[F_SOURCE_APPLY]} 的审批结论联动生成，台账侧只读，请在入廊作业审批页办理（冲突以审批域为准）`,
    }
  }
  return runGenericAction(MAINTENANCE_KEY, rows, index, action)
}

function runGenericAction(
  key: string,
  rows: EntryRow[],
  index: number,
  action: string,
): ActionResult {
  const meta = moduleMeta(key)
  const targetStatus = meta.actionTargets[action]
  if (!targetStatus) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const current = String(rows[index].status)
  if (current === targetStatus) {
    return { ok: false, message: `${meta.entity}已经是「${targetStatus}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: targetStatus,
    pending: targetStatus !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${targetStatus}」` }
}

/** 登记作业申请：归属校验、四项校验、安全措施待补材料、按编号去重全在引擎一处。 */
export function createEntry(draftInput: DraftInput): ActionResult {
  const rows = listRows(ENTRY_KEY)
  const outcome = createDraft(draftInput, rows, currentIdentity(), () =>
    rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
  )
  if (!outcome.result.ok) {
    return { ok: false, forbidden: outcome.result.forbidden, message: outcome.result.message }
  }
  if (!outcome.entry) {
    return { ok: false, message: '登记未生成记录，请核对后重试' }
  }
  const applyNo = String(outcome.entry['申请编号'])
  const existingIndex = rows.findIndex((row) => String(row['申请编号']) === applyNo)
  const nextEntries =
    existingIndex >= 0
      ? rows.map((row, i) => (i === existingIndex ? outcome.entry! : row))
      : [...rows, outcome.entry]
  saveRows(ENTRY_KEY, nextEntries)
  return { ok: true, idempotent: outcome.result.idempotent, message: outcome.result.message }
}

/** 当前身份是否属于责任班组：页面据此把入口切成只读。 */
export function sessionCanWriteEntry(): boolean {
  return currentIdentity().team === RESPONSIBLE_TEAM
}

/** 每条申请当前可执行的动作（由唯一推进关系导出，页面不另写动作表）。 */
export function entryActionsFor(row: EntryRow): string[] {
  return availableActions(String(row.status))
}

/** 待办清单与台账的统一读数（两边同源，页面各自展示但不各自计算）。 */
export function entryTodo() {
  return todoSummary(listRows(ENTRY_KEY), listRows(MAINTENANCE_KEY))
}

/** 差异兜底：缺台账的按审批结论补登；悬挂台账保留留存。 */
export function reconcileEntryTodo(): ActionResult {
  if (!sessionCanWriteEntry()) {
    return { ok: false, forbidden: true, message: `仅${RESPONSIBLE_TEAM}可执行对账补登` }
  }
  const entries = listRows(ENTRY_KEY)
  const ledgers = listRows(MAINTENANCE_KEY)
  const appended = reconcileTodo(entries, ledgers, currentIdentity(), () =>
    nextLedgerId(ledgers),
  )
  if (appended.length === 0) {
    return { ok: true, message: '待办与台账读数一致，没有需要补登的差异' }
  }
  saveRows(MAINTENANCE_KEY, [...ledgers, ...appended])
  return { ok: true, message: `已按审批结论补登 ${appended.length} 条维保台账，两边读数已对齐` }
}

function nextLedgerId(ledgers: EntryRow[]): number {
  return ledgers.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

/**
 * 导出：列与字段保持不变（编号 + 模块登记的 8 个字段 + 当前状态）。
 * 入廊作业审批导出的状态走引擎 projectEntry 同一份判定——
 * 列表里是已驳回，导出就是已驳回，不再出现「列表已驳回、导出已完工」。
 */
export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  const raw = listRows(key)
  const rows = key === ENTRY_KEY ? raw.map(projectEntry) : raw
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
    const entries = meta.key === ENTRY_KEY ? (rows[meta.key] ?? []).map(projectEntry) : rows[meta.key] ?? []
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
