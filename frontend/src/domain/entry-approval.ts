/**
 * 入廊作业审批：唯一的一份状态判定与推进实现。
 *
 * 列表展示、确认批准 / 驳回 / 完工动作、CSV 导出全部只允许通过本文件读取状态，
 * 不再在页面或服务层各算一遍。维保台账（设施检修）的派单、完工也以这里为准。
 *
 * 设计依据（见 README「入廊作业审批口径」一节）：
 *  1. 申请编号、申请单位、作业舱室、安全措施在同一处校验（validateDraft）。
 *  2. 状态只认审批轨迹里「最后一条带状态的事件」（deriveStatus），轨迹只追加不改写。
 *  3. 推进关系只有一份（TRANSITIONS）：
 *       提交审批: 待审批/已驳回 → 待审批（驳回后可补正重新提交）
 *       确认批准: 待审批 → 已批准，同时在维保台账落一条作业工单
 *       驳回申请: 待审批 → 已驳回
 *       登记完工: 已批准 → 已完工，联动工单同步完工
 *  4. 安全措施为空 → 待补材料（不进入审批流），补齐后重新提交仍并入原申请编号。
 *  5. 同一申请编号重复提交不新增记录：待补材料的补正更新原行，其余在轨迹里追加一次
 *     「重复提交」备注，台账与列表读数不变。
 *  6. 审批结论落维保台账：批准即派单，同一动作连发多回只落一条工单，后续触发只向
 *     同一条工单的轨迹追加备注。
 *  7. 两条完工路径（审批页登记完工 / 维保台账确认完工）同写一条「完工」语义事件，
 *     先到者定状态，后到者并入轨迹；最终态（已完工、已驳回）冻结，不被后到路径覆盖。
 *  8. 归属：仅责任班组可写，其他班组入口只读；越权写入按归属驳回。
 *  9. 存量数据按提交日期回填轨迹，早年缺审批人员的按值班岗位推定，缺项留空注明。
 */

import type { EntryEvent, EntryRow } from '@/data/types'

export const ENTRY_KEY = 'entryapprove'
export const MAINTENANCE_KEY = 'maintenance'

export const ENTRY_FIELDS = [
  '申请编号',
  '申请单位',
  '作业舱室',
  '作业类型',
  '作业人数',
  '安全措施',
  '审批人员',
  '审批状态',
] as const

/** 四个正式审批状态 + 缺材料的收件态。待补材料不参与流转，只等补正。 */
export const ENTRY_STATUSES = ['待审批', '已批准', '已驳回', '已完工'] as const
export const MATERIAL_PENDING = '待补材料'

export const ENTRY_ACTIONS = ['提交审批', '确认批准', '驳回申请', '登记完工'] as const

/** 唯一的一份推进关系：动作 → (前置状态集合, 目标状态, 轨迹语义)。 */
export const TRANSITIONS: Record<
  string,
  { from: string[]; to: string; kind: EntryEvent['kind']; negative?: boolean }
> = {
  提交审批: { from: ['待审批', '已驳回', MATERIAL_PENDING], to: '待审批', kind: '提交' },
  确认批准: { from: ['待审批'], to: '已批准', kind: '批准' },
  驳回申请: { from: ['待审批'], to: '已驳回', kind: '驳回', negative: true },
  登记完工: { from: ['已批准'], to: '已完工', kind: '完工' },
}

/** 工单状态与申请状态的映射依据：批准即检修中，完工即已完工，驳回/未批不派单。 */
export const WORK_ORDER_PREFIX = 'WORK'

export type Actor = {
  /** 当前值班人员姓名（推定/落账用）。 */
  name: string
  /** 当前值班班组，与申请的「责任班组」比对做归属控制。 */
  crew: string
  /** 值班岗位，缺审批人员的存量记录按此回填。 */
  post: string
}

export type DraftInput = {
  申请编号: string
  申请单位: string
  作业舱室: string
  作业类型: string
  作业人数: string
  安全措施: string
}

export type ApplyResult = {
  ok: boolean
  message: string
  /** 本次事务涉及的全部行（申请 + 可能的工单），调用方一次写回，保证待办与台账同事务。 */
  rows?: { entryKey: string; rows: EntryRow[] }[]
}

const REQUIRED_FIELDS: (keyof DraftInput)[] = ['申请编号', '申请单位', '作业舱室', '安全措施']

const CODE_PATTERN = /^ENTR-\d{4}$/

export type DraftValidation = {
  ok: boolean
  field: keyof DraftInput | null
  message: string
}

/** 校验在同一处：编号格式、申请单位、作业舱室，以及安全措施缺项判定。 */
export function validateDraft(draft: Partial<DraftInput>): DraftValidation {
  for (const field of REQUIRED_FIELDS) {
    if (!String(draft[field] ?? '').trim()) {
      if (field === '安全措施') {
        // 安全措施为空不是录入失败：收件但按待补材料挂起，并给出说明。
        return { ok: false, field, message: '安全措施为空：已收件并按「待补材料」挂起，请补齐后重新提交' }
      }
      return { ok: false, field, message: `${field}不能为空` }
    }
  }
  if (!CODE_PATTERN.test(String(draft.申请编号).trim())) {
    return { ok: false, field: '申请编号', message: '申请编号格式应为 ENTR-0001（ENTR- 加 4 位数字）' }
  }
  return { ok: true, field: null, message: '' }
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

/** 唯一的状态推导：取轨迹中最后一条带状态的事件；无轨迹即未提交，按待补材料收件。 */
export function deriveStatus(row: Pick<EntryRow, '轨迹'>): string {
  const events = row.轨迹 ?? []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].status) {
      return events[i].status
    }
  }
  return MATERIAL_PENDING
}

/** 待办口径只此一份：待审批、待补材料、已批准（在途作业待完工）挂待办；终态不挂。 */
export function isPendingStatus(status: string): boolean {
  return status === '待审批' || status === MATERIAL_PENDING || status === '已批准'
}

/** 异常口径：已驳回为负向结论。列表、看板共用。 */
export function isAbnormalStatus(status: string): boolean {
  return status === '已驳回'
}

/** 把领域推导结果同步回行上的冗余字段：看板/旧代码读 pending、abnormal 时口径一致。 */
export function syncFlags(row: EntryRow): EntryRow {
  const status = deriveStatus(row)
  row.status = status
  row.pending = isPendingStatus(status)
  row.abnormal = isAbnormalStatus(status)
  // 「审批状态」字段与独立状态列同源，杜绝「列表已驳回、导出已完工」式分歧。
  row.审批状态 = status
  return row
}

/** 归属判定：仅责任班组可写。申请编号本身也记录归属，便于驳回越权改动。 */
export function ownedBy(row: EntryRow, actor: Actor): boolean {
  const crew = String(row.责任班组 ?? '').trim()
  return crew !== '' && crew === actor.crew
}

function appendEvent(row: EntryRow, event: EntryEvent): EntryRow {
  row.轨迹 = [...(row.轨迹 ?? []), event]
  return syncFlags(row)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/** 深拷贝一行（轨迹逐事件复制），供事务内改草稿用。 */
function cloneRow(row: EntryRow): EntryRow {
  return { ...row, 轨迹: (row.轨迹 ?? []).map((event) => ({ ...event })) }
}

/** 深拷贝整表：显式标注 EntryRow[]，避免展开后丢失索引签名。 */
function cloneRows(rows: EntryRow[]): EntryRow[] {
  return rows.map(cloneRow)
}

function findByCode(rows: EntryRow[], code: string): EntryRow | undefined {
  return rows.find((row) => String(row.申请编号 ?? '') === code)
}

/**
 * 登记 / 提交作业申请（同一个入口，幂等）。
 * - 非本责任班组的提交一律拒绝：谁登记就挂在谁的班组名下，不能替别班组提交。
 * - 安全措施为空：收件为待补材料，不生成第二条记录。
 * - 编号重复：待补材料允许补正更新原行；其余重复提交在原行轨迹并一条备注。
 */
export function submitEntry(
  entryRows: EntryRow[],
  draft: DraftInput,
  actor: Actor,
): ApplyResult {
  const code = draft.申请编号.trim()
  const rows = cloneRows(entryRows)
  const existing = findByCode(rows, code)

  const validation = validateDraft(draft)
  const missingMeasure = validation.field === '安全措施'

  if (existing && !ownedBy(existing, actor)) {
    return {
      ok: false,
      message: `申请编号 ${code} 归属${existing.责任班组}，非本责任班组提交一律拒绝（当前班组：${actor.crew}）`,
    }
  }

  const notePrefix = existing ? '补正提交' : '登记申请'

  if (!validation.ok && !missingMeasure) {
    return { ok: false, message: validation.message }
  }

  if (existing) {
    // 幂等：同一申请编号永远只维护一条记录。
    const current = deriveStatus(existing)
    const fields: (keyof DraftInput)[] = ['申请单位', '作业舱室', '作业类型', '作业人数', '安全措施']
    for (const field of fields) {
      existing[field] = draft[field].trim()
    }
    if (missingMeasure) {
      existing.缺项说明 = '安全措施为空，按待补材料挂起；补齐后重新提交即并入本申请'
      appendEvent(existing, {
        kind: '提交',
        status: MATERIAL_PENDING,
        at: today(),
        by: actor.name,
        note: `${notePrefix}：安全措施仍为空，按待补材料处理`,
      })
      return {
        ok: true,
        message: '安全措施为空，已按「待补材料」收件挂起，未新增记录；补齐后重新提交即并入本申请',
        rows: [{ entryKey: ENTRY_KEY, rows }],
      }
    }
    delete existing.缺项说明
    if (current === MATERIAL_PENDING || current === '已驳回' || current === '待审批') {
      appendEvent(existing, {
        kind: '提交',
        status: '待审批',
        at: today(),
        by: actor.name,
        note: current === MATERIAL_PENDING ? '补齐安全措施，转入待审批' : '重复提交，已并入同一条申请轨迹',
      })
      return {
        ok: true,
        message: `申请 ${code} 已并入原记录，当前状态「待审批」，未生成第二条记录`,
        rows: [{ entryKey: ENTRY_KEY, rows }],
      }
    }
    // 已批准/已完工再提交：不改结论，只在轨迹留痕。
    appendEvent(existing, {
      kind: '提交',
      status: current,
      at: today(),
      by: actor.name,
      note: '重复提交：申请已有结论，不改变状态，并入轨迹',
    })
    return {
      ok: true,
      message: `申请 ${code} 当前为「${current}」，重复提交未生成新记录，已并入轨迹`,
      rows: [{ entryKey: ENTRY_KEY, rows }],
    }
  }

  const base: EntryRow = {
    id: nextId(rows),
    status: MATERIAL_PENDING,
    pending: true,
    abnormal: false,
    申请编号: code,
    申请单位: draft.申请单位.trim(),
    作业舱室: draft.作业舱室.trim(),
    作业类型: draft.作业类型.trim(),
    作业人数: draft.作业人数.trim(),
    安全措施: draft.安全措施.trim(),
    审批人员: '',
    审批状态: MATERIAL_PENDING,
    责任班组: actor.crew,
    提交日期: today(),
    轨迹: [],
  }

  if (missingMeasure) {
    base.缺项说明 = '登记时安全措施为空，按待补材料挂起；补齐后重新提交即并入本申请'
    appendEvent(base, {
      kind: '提交',
      status: MATERIAL_PENDING,
      at: today(),
      by: actor.name,
      note: '登记申请：安全措施为空，按待补材料处理',
    })
    rows.push(base)
    return {
      ok: true,
      message: '安全措施为空，已按「待补材料」收件挂起；补齐后重新提交即可进入待审批',
      rows: [{ entryKey: ENTRY_KEY, rows }],
    }
  }

  appendEvent(base, {
    kind: '提交',
    status: '待审批',
    at: today(),
    by: actor.name,
    note: '登记申请并提交审批',
  })
  rows.push(base)
  return {
    ok: true,
    message: `作业申请 ${code} 已登记并提交审批`,
    rows: [{ entryKey: ENTRY_KEY, rows }],
  }
}

function workOrderCode(entryCode: string): string {
  return `${WORK_ORDER_PREFIX}-${entryCode.replace(/^ENTR-/, '')}`
}

/**
 * 在维保台账上定位（或新建）与申请对应的唯一工单。
 * 同一申请无论批准动作触发几回，都只对应这一条；重复触发只追加轨迹。
 */
function ensureWorkOrder(
  maintRows: EntryRow[],
  entry: EntryRow,
  actor: Actor,
  at: string,
): { row: EntryRow; created: boolean; rows: EntryRow[] } {
  const code = workOrderCode(String(entry.申请编号))
  const rows = cloneRows(maintRows)
  let row = rows.find((item) => String(item.检修编号 ?? '') === code)
  if (row) {
    return { row, created: false, rows }
  }
  row = {
    id: nextId(rows),
    status: '检修中',
    pending: true,
    abnormal: false,
    检修编号: code,
    检修对象: `入廊作业 ${entry.申请编号}（${entry.作业舱室}）`,
    检修类别: '入廊作业',
    检修班组: String(entry.责任班组 ?? actor.crew),
    计划工期: at,
    完工日期: '',
    更换部件: '',
    检修状态: '检修中',
    来源申请编号: String(entry.申请编号),
    轨迹: [
      {
        kind: '批准',
        status: '检修中',
        at,
        by: actor.name,
        note: `作业申请 ${entry.申请编号} 已批准，审批结论落维保台账`,
      },
    ],
  }
  rows.push(row)
  return { row, created: true, rows }
}

/** 批准/驳回/完工三个审批动作，加上从维保台账侧触发的完工，全部走这一个入口。 */
export function applyEntryAction(
  entryRows: EntryRow[],
  maintRows: EntryRow[],
  id: number,
  action: string,
  actor: Actor,
): ApplyResult {
  const rule = TRANSITIONS[action]
  if (!rule) {
    return { ok: false, message: `作业申请没有登记「${action}」这个动作` }
  }
  const rows = cloneRows(entryRows)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的作业申请` }
  }
  const entry = rows[index]

  // 其他人的入口只读：越权改动按归属驳回。
  if (!ownedBy(entry, actor)) {
    return {
      ok: false,
      message: `申请 ${entry.申请编号} 归属${entry.责任班组}，${actor.crew}为只读，越权改动按归属驳回`,
    }
  }

  const current = deriveStatus(entry)

  // 终态幂等：批准 / 完工重复触发时结论不变，只向同一条轨迹并入留痕、绝不重复落账。
  if (action === '确认批准' && current === '已批准') {
    const at = today()
    const maintenance = cloneRows(maintRows)
    const ensured = ensureWorkOrder(maintenance, entry, actor, at)
    ensured.row.轨迹 = [
      ...(ensured.row.轨迹 ?? []),
      { kind: '批准', status: String(ensured.row.status), at, by: actor.name, note: '批准动作重复触发：工单已存在，并入同一条轨迹，未重复落账' },
    ]
    entry.审批人员 = actor.name
    appendEvent(entry, {
      kind: '批准',
      status: '已批准',
      at,
      by: actor.name,
      note: '重复批准：结论不变，沿用已派工单，已并入同一条轨迹',
    })
    return {
      ok: true,
      message: `作业申请 ${entry.申请编号} 已处于「已批准」，重复触发已并入轨迹，未重复落账`,
      rows: [
        { entryKey: ENTRY_KEY, rows },
        { entryKey: MAINTENANCE_KEY, rows: ensured.rows },
      ],
    }
  }

  if (action === '登记完工' && current === '已完工') {
    const at = today()
    const maintenance = cloneRows(maintRows)
    const code = workOrderCode(String(entry.申请编号))
    const order = maintenance.find((row) => String(row.检修编号 ?? '') === code)
    if (order) {
      order.轨迹 = [
        ...(order.轨迹 ?? []),
        { kind: '完工', status: '已完工', at, by: actor.name, note: '完工动作重复触发：并入同一条工单轨迹，未重复落账' },
      ]
    }
    appendEvent(entry, {
      kind: '完工',
      status: '已完工',
      at,
      by: actor.name,
      note: '重复登记完工：结论不变，已并入同一条轨迹',
    })
    return {
      ok: true,
      message: `作业申请 ${entry.申请编号} 已处于「已完工」，重复触发已并入轨迹，未重复落账`,
      rows: [
        { entryKey: ENTRY_KEY, rows },
        { entryKey: MAINTENANCE_KEY, rows: maintenance },
      ],
    }
  }

  if (!rule.from.includes(current)) {
    return {
      ok: false,
      message: `作业申请当前为「${current}」，不能执行「${action}」（允许的前置状态：${rule.from.join('、')}）`,
    }
  }

  const at = today()
  let maintenance = cloneRows(maintRows)

  if (action === '确认批准') {
    const order = ensureWorkOrder(maintenance, entry, actor, at)
    maintenance = order.rows
    if (!order.created) {
      // 同一动作连发多回：账上只一条，往后几回并入同一条轨迹，不落新单。
      order.row.轨迹 = [
        ...(order.row.轨迹 ?? []),
        {
          kind: '批准',
          status: String(order.row.status),
          at,
          by: actor.name,
          note: '批准动作重复触发：工单已存在，并入同一条轨迹，未重复落账',
        },
      ]
    }
    entry.审批人员 = actor.name
    appendEvent(entry, {
      kind: '批准',
      status: '已批准',
      at,
      by: actor.name,
      note: order.created
        ? `已批准，维保台账已派单 ${workOrderCode(String(entry.申请编号))}`
        : '重复批准：沿用已派工单，未重复落账',
    })
  } else if (action === '登记完工') {
    const code = workOrderCode(String(entry.申请编号))
    const order = maintenance.find((row) => String(row.检修编号 ?? '') === code)
    if (order) {
      order.完工日期 = at
      order.检修状态 = '已完工'
      order.status = '已完工'
      order.pending = false
      order.abnormal = false
      order.轨迹 = [
        ...(order.轨迹 ?? []),
        { kind: '完工', status: '已完工', at, by: actor.name, note: '入廊作业完工，台账同步登记' },
      ]
    }
    appendEvent(entry, {
      kind: '完工',
      status: '已完工',
      at,
      by: actor.name,
      note: order ? `维保工单 ${code} 同步完工` : '入廊作业完工（未找到对应工单，按现场结论登记）',
    })
  } else {
    // 驳回申请
    entry.审批人员 = actor.name
    appendEvent(entry, {
      kind: '驳回',
      status: '已驳回',
      at,
      by: actor.name,
      note: rule.negative ? '审批驳回，可补正后重新提交' : undefined,
    })
  }

  return {
    ok: true,
    message: `作业申请 ${entry.申请编号} 已${action.replace('申请', '')}，当前状态「${deriveStatus(entry)}」`,
    rows: [
      { entryKey: ENTRY_KEY, rows },
      { entryKey: MAINTENANCE_KEY, rows: maintenance },
    ],
  }
}

/**
 * 维保台账侧的「确认完工」：工单若来源于入廊申请，则反向把申请推到已完工。
 * 两条路径先后与冲突兜底（依据）：
 *  - 两条路径写的是同一条「完工」语义事件，以先到者定状态；
 *  - 申请已完工时台账再完工 → 只给工单并轨迹，不改申请结论；
 *  - 申请尚未批准/工单不存在 → 台账按自身流程走，不替申请下结论；
 *  - 已驳回是终态冻结，任何后到的完工路径都不得覆盖（applyEntryAction 前置校验拦截）。
 */
export function completeWorkOrderFromLedger(
  entryRows: EntryRow[],
  maintRows: EntryRow[],
  orderId: number,
  actor: Actor,
): ApplyResult {
  const maintenance = cloneRows(maintRows)
  const order = maintenance.find((row) => Number(row.id) === orderId)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${orderId} 的检修记录` }
  }
  const sourceCode = String(order.来源申请编号 ?? '')
  if (!sourceCode) {
    // 普通检修记录：不由入廊审批口径接管，交回通用动作处理。
    return { ok: false, message: 'NOT_ENTRY_ORDER' }
  }

  if (String(order.检修班组 ?? '') !== actor.crew) {
    return {
      ok: false,
      message: `工单 ${order.检修编号} 归属${order.检修班组}，${actor.crew}为只读，越权改动按归属驳回`,
    }
  }

  const at = today()
  if (String(order.status) === '已完工') {
    order.轨迹 = [
      ...(order.轨迹 ?? []),
      { kind: '完工', status: '已完工', at, by: actor.name, note: '完工动作重复触发：并入同一条工单轨迹' },
    ]
    return {
      ok: true,
      message: `工单 ${order.检修编号} 已完工，重复触发已并入轨迹，未重复落账`,
      rows: [{ entryKey: MAINTENANCE_KEY, rows: maintenance }],
    }
  }

  order.完工日期 = at
  order.检修状态 = '已完工'
  order.status = '已完工'
  order.pending = false
  order.abnormal = false
  order.轨迹 = [
    ...(order.轨迹 ?? []),
    { kind: '完工', status: '已完工', at, by: actor.name, note: '台账侧确认完工' },
  ]

  const entries = cloneRows(entryRows)
  const entry = findByCode(entries, sourceCode)
  const changedKeys: { entryKey: string; rows: EntryRow[] }[] = [
    { entryKey: MAINTENANCE_KEY, rows: maintenance },
  ]

  if (entry) {
    const current = deriveStatus(entry)
    if (current === '已批准') {
      appendEvent(entry, {
        kind: '完工',
        status: '已完工',
        at,
        by: actor.name,
        note: `维保工单 ${order.检修编号} 台账侧确认完工，申请同步收口`,
      })
      changedKeys.push({ entryKey: ENTRY_KEY, rows: entries })
    } else {
      // 冲突兜底：申请侧还没批准或是其他状态，台账先完工也不替审批下结论，留痕说明。
      entry.轨迹 = [
        ...(entry.轨迹 ?? []),
        {
          kind: '完工',
          status: current,
          at,
          by: actor.name,
          note: `工单 ${order.检修编号} 已完工，但申请为「${current}」，审批结论不被台账路径覆盖`,
        },
      ]
      changedKeys.push({ entryKey: ENTRY_KEY, rows: entries })
    }
  }

  return {
    ok: true,
    message: `维保工单 ${order.检修编号} 已确认完工${entry ? '，作业申请同步更新' : ''}`,
    rows: changedKeys,
  }
}

/**
 * 值班岗位推定（早年没有审批人员的存量记录）。
 * 依据：按作业舱室的专业归属对应当日值班岗位，岗位是审批责任的最小可追溯单元；
 * 推定值统一加「（值班推定）」后缀并在轨迹注明，真人签批过的一律不覆盖。
 */
const POST_BY_CABIN: { test: RegExp; post: string }[] = [
  { test: /电|缆|高压/, post: '电气值班岗' },
  { test: /给水|排水|水舱|泵/, post: '给排水值班岗' },
  { test: /燃气|天然气/, post: '燃气值班岗' },
  { test: /热力|蒸汽|温/, post: '热力值班岗' },
  { test: /综合|主舱/, post: '综合管廊值班岗' },
]

export function inferPost(cabin: string): string {
  const hit = POST_BY_CABIN.find((rule) => rule.test.test(cabin))
  return hit ? hit.post : '管廊运行值班岗'
}

/**
 * 存量回填（只跑一次，只追加不改写）：
 *  - 按提交日期（没有登记时刻则按 id 顺序落到 2021 年之前的月初）排定轨迹时间；
 *  - 在途申请保持原结论：原 status 作为最后一条带状态事件回填，列表读出来还是它；
 *  - 早年缺审批人员的，按作业舱室推定值班岗位，仅回填推定岗位，不伪造姓名；
 *  - 已批准的存量申请同步补一条历史工单到维保台账，缺项（完工日期等）留空并注明。
 * 返回迁移后的全量数据（含可能新增的历史工单）。
 */
export function migrateLegacy(
  entryRows: EntryRow[],
  maintRows: EntryRow[],
): { entryRows: EntryRow[]; maintRows: EntryRow[] } {
  const already = entryRows.some((row) => (row.轨迹 ?? []).length > 0)
  if (already) {
    return { entryRows, maintRows }
  }

  const legacyDate = (id: number): string => {
    // 存量清单按登记时刻落库：没有日期字段的早期条目，按序号排在 2021 年以前各月月初。
    const year = 2018 + Math.floor((id - 1) / 4)
    const month = ((id - 1) % 4) * 3 + 1
    return `${year}-${String(month).padStart(2, '0')}-01`
  }

  const entries = cloneRows(entryRows)
    .map((row) => { row.轨迹 = []; return row })
    .sort((a, b) => Number(a.id) - Number(b.id))

  const maintenance = cloneRows(maintRows)

  for (const row of entries) {
    const submittedAt = String(row.提交日期 ?? '').trim() || legacyDate(Number(row.id))
    row.提交日期 = submittedAt
    const cabin = String(row.作业舱室 ?? '')
    const events: EntryEvent[] = [
      { kind: '提交', status: '待审批', at: submittedAt, by: '（存量登记）', note: '存量清单按登记时刻回填', legacy: true },
    ]

    const original = String(row.status ?? '')
    const approverMissing = isMissing(row.审批人员)
    const approver = approverMissing ? `${inferPost(cabin)}（值班推定）` : String(row.审批人员)

    if (approverMissing && ['已批准', '已驳回', '已完工'].includes(original)) {
      row.审批人员 = approver
      row.缺项说明 = `早年纸质单据未登记审批人员，按作业舱室「${cabin}」推定${approver}`
    }

    if (original === '已批准' || original === '已完工') {
      events.push({
        kind: '批准',
        status: '已批准',
        at: submittedAt,
        by: approver,
        note: approverMissing ? '历史批准记录，审批人员按值班岗位推定' : '历史批准记录回填',
        legacy: true,
      })
    } else if (original === '已驳回') {
      events.push({
        kind: '驳回',
        status: '已驳回',
        at: submittedAt,
        by: approver,
        note: approverMissing ? '历史驳回记录，审批人员按值班岗位推定' : '历史驳回记录回填',
        legacy: true,
      })
    }

    if (original === '已完工') {
      // 早期条目缺完工日期：空着并注明缘由，不臆造。
      row.缺项说明 = [row.缺项说明, '早期条目未登记完工日期，按存量原样留空'].filter(Boolean).join('；')
      events.push({
        kind: '完工',
        status: '已完工',
        at: submittedAt,
        by: approver,
        note: '历史完工记录回填，完工日期缺项留空',
        legacy: true,
      })
    }

    // 在途申请保持原结论：存量里安全措施为空但状态是待审批的，不降级为待补材料，
    // 只加注记说明新老口径的衔接（新登记空措施才按待补材料收件）。
    if (
      isMissing(row.安全措施) &&
      (original === '待审批' || original === '' || original === MATERIAL_PENDING)
    ) {
      const note = '存量在途申请安全措施缺项：按原结论保留待审批，请在补正环节补齐安全措施'
      row.缺项说明 = [row.缺项说明, note].filter(Boolean).join('；')
    }

    row.轨迹 = events
    syncFlags(row)

    // 历史审批结论同样落到维保台账；已完工的历史工单完工日期缺项留空。
    if (original === '已批准' || original === '已完工') {
      const code = workOrderCode(String(row.申请编号))
      if (!maintenance.some((item) => String(item.检修编号) === code)) {
        maintenance.push({
          id: nextId(maintenance),
          status: original === '已完工' ? '已完工' : '检修中',
          pending: original !== '已完工',
          abnormal: false,
          检修编号: code,
          检修对象: `入廊作业 ${row.申请编号}（${cabin}）`,
          检修类别: '入廊作业',
          检修班组: String(row.责任班组 ?? ''),
          计划工期: submittedAt,
          完工日期: original === '已完工' ? '' : '',
          更换部件: '',
          检修状态: original === '已完工' ? '已完工' : '检修中',
          来源申请编号: String(row.申请编号),
          缺项说明:
            original === '已完工'
              ? '历史工单按存量回填，完工日期等早期条目缺项留空'
              : '历史工单按存量审批结论回填',
          轨迹: [
            {
              kind: '批准',
              status: '检修中',
              at: submittedAt,
              by: approver,
              note: '存量审批结论补登台账',
              legacy: true,
            },
            ...(original === '已完工'
              ? [
                  {
                    kind: '完工' as const,
                    status: '已完工',
                    at: submittedAt,
                    by: approver,
                    note: '历史完工回填，完工日期缺项留空',
                    legacy: true,
                  },
                ]
              : []),
          ],
        })
      }
    }
  }

  return { entryRows: entries, maintRows: maintenance }
}

/** 导出与列表共用的只读视图：状态列永远来自 deriveStatus。 */
export function viewRow(row: EntryRow): EntryRow {
  return syncFlags({ ...row })
}
