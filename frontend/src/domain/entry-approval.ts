/**
 * 入廊作业审批 —— 唯一的业务判定实现（审批域引擎）。
 *
 * 背景：跳转判定过去散在四处（列表按审批状态算一遍、确认批准/驳回各算一遍、
 * 导出再算一遍），规则还不一致，同一份申请列表里是已驳回、导出后变成已完工。
 * 本文件把以下规则收拢成一份，列表（含待办）、动作、导出、维保台账同步都只准调这里：
 *
 *   1. 申请编号 / 申请单位 / 作业舱室 / 安全措施 的校验（validateDraft）；
 *   2. 待审批 → 已批准 → 已完工（主链）、→ 已驳回（分支）、待补材料（门禁态）
 *      的推进关系（TRANSITIONS / advance）；
 *   3. 安全措施为空 → 待补材料（同一处校验给出说明）；
 *   4. 重复提交同一申请编号不新增记录（createDraft 按申请编号幂等）；
 *   5. 审批人员落名与早年缺审批人员时的值班岗位推定（inferApprover）；
 *   6. 责任班组归属校验（非责任班组的提交与越权改动一律驳回，只读不受限）；
 *   7. 动作幂等：同一动作连着触发多回，台账只落一条，后续几回并入该条轨迹；
 *   8. 审批结论落维保台账（syncLedger）：一个申请编号一条台账，更新并入同一条；
 *   9. 待办与台账的同源读数（todoSummary / reconcileTodo）。
 *
 * 「审批流」与「台账流」两条路径的先后与冲突兜底（见文件末尾设计依据）：
 *   - 先落审批结论，再同步维保台账，两步在一次本地事务（saveAll）内提交，
 *     任何一步失败整体回滚，保证两边读数始终一致；
 *   - 台账侧对「由审批结论生成」的联批条目只允许只读，通用检修动作一律拒绝，
 *     冲突一律以审批域为准——因为审批域是该条生命周期的权威来源，台账只是投影。
 */
import type { DomainEvent, EntryRow, Identity } from '@/data/types'

/* ============================================================
 * 常量：状态、动作、归属
 * ============================================================ */

export const ENTRY_KEY = 'entryapprove'
export const MAINTENANCE_KEY = 'maintenance'

/** 入廊作业审批的责任班组：只有本班提交/改动，外单位与其他班组只读。 */
export const RESPONSIBLE_TEAM = '廊内运维一班'

/** 表单状态名（顺序即推进关系，供列表/图例/统计共用，不允许在页面另写）。 */
export const S_PENDING_MATERIAL = '待补材料'
export const S_PENDING = '待审批'
export const S_APPROVED = '已批准'
export const S_REJECTED = '已驳回'
export const S_FINISHED = '已完工'

/** 四个正式审批状态（待审批/已批准/已驳回/已完工），门禁态待补材料是申请门禁不是审批结论。 */
export const CANONICAL_STATUSES = [S_PENDING, S_APPROVED, S_REJECTED, S_FINISHED] as const
/** 列表、图例、状态小结使用的完整状态集合（门禁态在前）。 */
export const ALL_STATUSES = [S_PENDING_MATERIAL, ...CANONICAL_STATUSES] as const

export const A_SUBMIT = '提交审批'
export const A_APPROVE = '确认批准'
export const A_REJECT = '驳回申请'
export const A_FINISH = '确认完工'
export const A_SUPPLEMENT = '补齐材料'

/**
 * 唯一的状态推进关系（以前页面/映射/导出各算一遍，现在只留这一份）：
 *   待补材料 -- 补齐材料 --> 待审批        （材料补齐后回到正常待审批队列）
 *   待审批   -- 确认批准 --> 已批准
 *   待审批   -- 驳回申请 --> 已驳回
 *   待补材料 -- 驳回申请 --> 已驳回        （材料都补不上的，可直接驳回）
 *   已批准   -- 确认完工 --> 已完工
 * 注：登记入口点「提交审批」不直接给结论——材料不全转待补材料，材料齐全才转待审批。
 */
export const TRANSITIONS: Record<string, Record<string, string>> = {
  [S_PENDING_MATERIAL]: { [A_SUPPLEMENT]: S_PENDING, [A_REJECT]: S_REJECTED },
  [S_PENDING]: { [A_APPROVE]: S_APPROVED, [A_REJECT]: S_REJECTED },
  [S_APPROVED]: { [A_FINISH]: S_FINISHED },
  [S_REJECTED]: {},
  [S_FINISHED]: {},
}

/** 内部持久化字段：永远不出现在导出列与表格列里。 */
export const F_SUBMIT_DATE = '_提交日期'
export const F_OWNER_TEAM = '_归属班组'
export const F_SOURCE_APPLY = '_来源申请编号'
export const F_MISSING_NOTE = '_缺项缘由'
export const F_LEDGER_NOTE = '_台账说明'

/* ============================================================
 * 1. 表单校验：申请编号 / 申请单位 / 作业舱室 / 安全措施 只在此一处
 * ============================================================ */

export type DraftInput = {
  applyNo: string
  unit: string
  cabin: string
  workType: string
  workerCount: string
  safety: string
}

export type DraftCheck =
  | { ok: true }
  | { ok: false; code: 'FIELD_MISSING' | 'BAD_NO' | 'NEED_MATERIAL'; field?: string; message: string }

/** 申请编号统一格式：ENTR-XXXX（与存量 ENTR-0001 体系一致）。 */
const APPLY_NO_PATTERN = /^ENTR-\d{4,}$/

export function validateDraft(draft: DraftInput): DraftCheck {
  const no = draft.applyNo.trim()
  const unit = draft.unit.trim()
  const cabin = draft.cabin.trim()
  const safety = draft.safety.trim()
  // 四项主项校验同在此处，列表/登记/重新提交共用，不再各写一遍。
  if (!no) {
    return { ok: false, code: 'FIELD_MISSING', field: '申请编号', message: '申请编号不能为空' }
  }
  if (!APPLY_NO_PATTERN.test(no)) {
    return { ok: false, code: 'BAD_NO', field: '申请编号', message: `申请编号「${no}」不符合 ENTR-XXXX 格式` }
  }
  if (!unit) {
    return { ok: false, code: 'FIELD_MISSING', field: '申请单位', message: '申请单位不能为空' }
  }
  if (!cabin) {
    return { ok: false, code: 'FIELD_MISSING', field: '作业舱室', message: '作业舱室不能为空，无法核对入廊范围' }
  }
  if (!safety) {
    // 安全措施为空：不进入审批队列，按待补材料处理并给出说明。
    return {
      ok: false,
      code: 'NEED_MATERIAL',
      field: '安全措施',
      message: '安全措施为空：按待补材料处理，补齐通风、防火、监护等安全措施后重新提交方可进入待审批',
    }
  }
  return { ok: true }
}

/* ============================================================
 * 2. 状态派生：待审批/已批准/已驳回/已完工 的待办与异常口径只此一份
 * ============================================================ */

/** 待办口径：待补材料、待审批、已批准（等完工确认）在办；已驳回、已完工办结。 */
export function isPendingStatus(status: string): boolean {
  return status === S_PENDING_MATERIAL || status === S_PENDING || status === S_APPROVED
}

/** 异常口径：只有已驳回算异常；待补材料是材料门禁不是异常，已完工是正常办结。 */
export function isAbnormalStatus(status: string): boolean {
  return status === S_REJECTED
}

/**
 * 存量状态归一化（不回写、只在读时判定，保证历史审批记录不被改写）：
 * 历史库里若出现四个正式状态之外的值，一律按待审批对待——申请确实在途、
 * 只是旧系统记法不一，保守地放回队列让人重新判；能认的结论原样保留，
 * 这就是「在途的申请仍按原来的结论走」的兜底。
 */
export function normalizeStatus(raw: unknown): string {
  const value = String(raw ?? '').trim()
  return (ALL_STATUSES as readonly string[]).includes(value) ? value : S_PENDING
}

/** 存储行 → 页面/导出所见行。状态、待办、异常、审批状态显示字段全部由本函数统一派生。 */
export function projectEntry(row: EntryRow): EntryRow {
  const status = normalizeStatus(row.status)
  const note = materialNote(row)
  return {
    ...row,
    status,
    pending: isPendingStatus(status),
    abnormal: isAbnormalStatus(status),
    // 「审批状态」是展示字段：列表与导出都从同一份判定取值，杜绝两边不一致。
    审批状态: note ? `${status}（${note}）` : status,
  }
}

/** 待补材料的说明（安全措施缺项时校验阶段写入，列表/导出状态列一并带出）。 */
export function materialNote(row: EntryRow): string {
  if (normalizeStatus(row.status) !== S_PENDING_MATERIAL) {
    return ''
  }
  const stored = String(row[F_MISSING_NOTE] ?? '').trim()
  return stored || '安全措施待补'
}

/* ============================================================
 * 3. 审批人员落名与早年缺审批人员的值班岗位推定
 * ============================================================ */

/**
 * 值班岗位推定规则（依据写在函数尾）：
 * 按提交日期对应的星期取值班岗位，不杜撰具体人名——
 *   周一/三/五（奇数工作日，巡检任务重）→ 白班值班长
 *   周二/四/六                          → 夜班值班员
 *   周日（仅保留应急值守）              → 值班主管
 * 落名形式为「岗位（推定）」，并在轨迹里注明「早年纸质审批未录入，按值班岗位推定」，
 * 一旦补录到真实审批人员即可覆盖，推定值不视为责任认定。
 *
 * 选岗位而非人名的依据：早年只有排班表数字化、具体审批人不可考，
 * 按岗位推定可追溯、可解释，且不把责任落到无法核实的个人头上；
 * 按星期轮转是本平台白班/夜班固定排班的最小可复现规则，不依赖任何额外数据。
 */
export function inferApprover(submitDate: string): { name: string; note: string } {
  const date = new Date(`${submitDate}T00:00:00`)
  const day = Number.isNaN(date.getTime()) ? 1 : date.getDay() // 0=周日 … 6=周六
  const post = day === 0 ? '值班主管' : day % 2 === 1 ? '白班值班长' : '夜班值班员'
  return {
    name: `${post}（推定）`,
    note: `早年审批人员未录入，按 ${submitDate}（周${'日一二三四五六'[day]}）值班岗位${post}推定`,
  }
}

/** 样例数据里的占位值视为「未登记」，与空值一并参与推定。 */
const PLACEHOLDER_PATTERN = /^入廊作业审批样例\d*$/

function isMissing(value: unknown): boolean {
  const text = String(value ?? '').trim()
  return text === '' || PLACEHOLDER_PATTERN.test(text)
}

/**
 * 读出某条申请当前应显示的审批人员：
 * 有真人就用真人；进入批准/驳回/完工等已判结论但缺人，按提交日期推定；
 * 待审批/待补材料还没轮到审批，留空。
 */
export function resolveApprover(row: EntryRow): string {
  const raw = String(row['审批人员'] ?? '').trim()
  if (!isMissing(raw)) {
    return raw
  }
  const status = normalizeStatus(row.status)
  if (status === S_PENDING || status === S_PENDING_MATERIAL) {
    return ''
  }
  const date = String(row[F_SUBMIT_DATE] ?? '')
  return date ? inferApprover(date).name : '值班主管（推定）'
}

/* ============================================================
 * 4. 归属校验：不是本责任班组的提交一律拒绝，其他人的入口只读
 * ============================================================ */

export type Authorization = { ok: true } | { ok: false; message: string; forbidden: true }

/**
 * 写操作（登记、提交、批准、驳回、完工、补材料）统一过这道归属关。
 * 只读（列表、筛选、导出）不限身份；越权改动按归属驳回，前端入口对非责任班组置灰。
 */
export function authorize(identity: Identity): Authorization {
  if (identity.team !== RESPONSIBLE_TEAM) {
    return {
      ok: false,
      forbidden: true,
      message: `入廊作业审批由${RESPONSIBLE_TEAM}归口办理，${identity.team}仅有只读权限，提交与改动按归属驳回`,
    }
  }
  return { ok: true }
}

/* ============================================================
 * 5. 动作可用性、推进与幂等
 * ============================================================ */

/** 列表上每条记录可执行的动作也由唯一推进关系导出，页面不再自带动作表。 */
export function availableActions(status: string): string[] {
  return Object.keys(TRANSITIONS[normalizeStatus(status)] ?? {})
}

function appendEvent(row: EntryRow, event: DomainEvent): EntryRow {
  return { ...row, events: [...(row.events ?? []), event] }
}

function nowStamp(): string {
  return new Date().toISOString()
}

export type ApplyOutcome = {
  result: { ok: true; idempotent: boolean; message: string } | { ok: false; forbidden: boolean; message: string }
  entry: EntryRow
  ledger?: EntryRow
}

/**
 * 执行一个审批动作。三层判定顺序固定：先归属（越权驳回）→ 再推进关系
 * （状态不允许就拒绝）→ 最后幂等（同一动作已在同一条轨迹末，只并入，不另落台账）。
 */
export function applyEntryAction(
  row: EntryRow,
  action: string,
  identity: Identity,
): ApplyOutcome {
  const auth = authorize(identity)
  if (!auth.ok) {
    return { result: { ok: false, forbidden: true, message: auth.message }, entry: row }
  }
  const status = normalizeStatus(row.status)

  // 幂等优先于推进关系：同一申请上同一动作连着触发多回（哪怕申请已到终态、
  // 转移表已无出口），也要认出它是重复——账上只落一条，后续几回并入同一条轨迹。
  // 判定：末条轨迹是同一动作，且当前状态仍停在该动作落到的目标状态上。
  const events = row.events ?? []
  const last = events[events.length - 1]
  if (last && last.action === action && last.to === status) {
    const repeated: DomainEvent = {
      at: nowStamp(),
      action,
      from: status,
      to: status,
      operator: identity.operator,
      team: identity.team,
      repeat: true,
      note: '同一动作重复触发，并入本条轨迹，不另落台账',
    }
    const entry = appendEvent(row, repeated)
    const ledger = touchLedger(entry, repeated)
    return {
      result: {
        ok: true,
        idempotent: true,
        message: `「${action}」此前已执行过，本次未重复记账，已并入同一条轨迹`,
      },
      entry,
      ledger,
    }
  }

  const target = TRANSITIONS[status]?.[action]
  if (!target) {
    return {
      result: { ok: false, forbidden: false, message: `「${status}」状态不允许执行「${action}」` },
      entry: row,
    }
  }

  // 审批人员只在批准/驳回这两个审批动作上落操作人；确认完工不覆盖原审批人，
  // 缺人时按提交日期推定；补材料回到待审批，审批人员留空。
  const approver =
    target === S_APPROVED || target === S_REJECTED
      ? identity.operator
      : target === S_FINISHED
        ? resolveApprover(row)
        : ''
  const event: DomainEvent = {
    at: nowStamp(),
    action,
    from: status,
    to: target,
    operator: identity.operator,
    team: identity.team,
  }
  const entry = appendEvent(
    {
      ...row,
      status: target,
      pending: isPendingStatus(target),
      abnormal: isAbnormalStatus(target),
      审批人员: approver,
      // 离开待补材料即清掉门禁说明字段；其余字段一律不动，历史记录不被改写。
      ...(target !== S_PENDING_MATERIAL ? { [F_MISSING_NOTE]: '' } : {}),
    },
    event,
  )
  const ledger = syncLedger(entry, event, action, target)
  return {
    result: {
      ok: true,
      idempotent: false,
      message: `作业申请已${action}，当前状态「${target}」${ledger ? '，结论已并入维保台账' : ''}`,
    },
    entry,
    ledger,
  }
}

/* ============================================================
 * 6. 登记：重复提交同一申请不生成两条记录
 * ============================================================ */

export type CreateOutcome = {
  result:
    | { ok: true; idempotent: boolean; message: string }
    | { ok: false; forbidden: boolean; message: string }
  entry?: EntryRow
}

/**
 * 登记（提交）作业申请。
 * 重复提交同一申请编号不新增第二条：
 *   - 原申请处于待补材料且本次材料齐全 → 在原记录上「补齐材料」，并入同一条轨迹；
 *   - 原申请处于其他在途状态 → 拒绝（去重，不产生第二条）；
 *   - 已有终局结论 → 拒绝并提示走变更/重新申请，不覆盖历史审批记录。
 * 校验不过（含安全措施为空）不产生任何记录；安全措施为空时落成「待补材料」一条
 * （申请事实已发生），说明随记录走，补齐后凭同一编号继续，不另开新条。
 */
export function createDraft(
  draft: DraftInput,
  existing: EntryRow[],
  identity: Identity,
  nextId: () => number,
): CreateOutcome {
  const auth = authorize(identity)
  if (!auth.ok) {
    return { result: { ok: false, forbidden: true, message: auth.message } }
  }
  const check = validateDraft(draft)
  const no = draft.applyNo.trim()
  const duplicate = existing.find((row) => String(row['申请编号']).trim() === no)

  if (!check.ok && check.code !== 'NEED_MATERIAL') {
    // 编号/单位/舱室硬项不过：什么都不落。
    return { result: { ok: false, forbidden: false, message: check.message } }
  }

  const submitDate = new Date().toISOString().slice(0, 10)

  if (duplicate) {
    const status = normalizeStatus(duplicate.status)
    if (status === S_PENDING_MATERIAL && check.ok) {
      const outcome = applyEntryAction(
        {
          ...duplicate,
          ...draftFields(draft),
          安全措施: draft.safety.trim(),
          [F_MISSING_NOTE]: '',
        },
        A_SUPPLEMENT,
        identity,
      )
      return {
        result: {
          ok: true,
          idempotent: true,
          message: `申请编号 ${no} 已在待补材料队列，本次安全措施已补齐并回到待审批，未新增记录`,
        },
        entry: outcome.entry,
      }
    }
    if (status === S_PENDING_MATERIAL && check.ok === false && check.code === 'NEED_MATERIAL') {
      // 仍是材料不全的重复提交：原样保留，明确不新增。
      return {
        result: {
          ok: true,
          idempotent: true,
          message: `申请编号 ${no} 已登记并在待补材料队列，重复提交未生成新记录，请补齐安全措施后再提交`,
        },
        entry: duplicate,
      }
    }
    return {
      result: {
        ok: false,
        forbidden: false,
        message: `申请编号 ${no} 已存在（当前「${status}」），重复提交不生成第二条记录；如需变更请在原申请上办理`,
      },
    }
  }

  const needMaterial = !check.ok && check.code === 'NEED_MATERIAL'
  const status = needMaterial ? S_PENDING_MATERIAL : S_PENDING
  const event: DomainEvent = {
    at: nowStamp(),
    action: A_SUBMIT,
    from: '',
    to: status,
    operator: identity.operator,
    team: identity.team,
    note: needMaterial ? check.message : '材料齐全，进入待审批',
  }
  const row: EntryRow = {
    id: nextId(),
    status,
    pending: isPendingStatus(status),
    abnormal: false,
    申请编号: no,
    ...draftFields(draft),
    安全措施: draft.safety.trim(),
    审批人员: '',
    审批状态: status,
    [F_SUBMIT_DATE]: submitDate,
    [F_OWNER_TEAM]: RESPONSIBLE_TEAM,
    [F_MISSING_NOTE]: needMaterial ? '安全措施为空，待补齐通风、防火、监护措施' : '',
    events: [event],
  }
  return {
    result: {
      ok: true,
      idempotent: false,
      message: needMaterial
        ? check.message
        : `作业申请 ${no} 已登记，进入待审批`,
    },
    entry: row,
  }
}

function draftFields(draft: DraftInput): Record<string, string> {
  return {
    申请单位: draft.unit.trim(),
    作业舱室: draft.cabin.trim(),
    作业类型: draft.workType.trim(),
    作业人数: draft.workerCount.trim(),
  }
}

/* ============================================================
 * 7. 维保台账同步：审批结论落账，一个申请编号一条
 * ============================================================ */

/** 台账侧标记：由审批结论生成的联批条目，只允许只读，通用检修动作拒绝。 */
export function isLedgerLinked(row: EntryRow): boolean {
  return String(row[F_SOURCE_APPLY] ?? '').trim() !== ''
}

/**
 * 把一次审批事件同步到维保台账。
 * 规则（两处共用，避免账与审批对不上）：
 *   - 首次出现终局/在办结论（确认批准/驳回/完工）时，按申请编号 upsert 一条；
 *   - 已批准 → 台账「检修中」（入廊作业即维保作业，批准即开工）；
 *   - 已完工 → 同一条更新为「已完工」，完工日期取事件日期；
 *   - 已驳回 → 同一条保留为「待开工」并把驳回缘由并入轨迹，不新开检修任务；
 *   - 待补材料/补齐材料不动台账（还没形成作业结论）；
 *   - 同一动作重复触发（event.repeat）只往该条轨迹追加，不改状态、不新增。
 */
function syncLedger(entry: EntryRow, event: DomainEvent, action: string, target: string): EntryRow | undefined {
  if (action === A_SUPPLEMENT) {
    return undefined
  }
  const applyNo = String(entry['申请编号']).trim()
  const eventDate = event.at.slice(0, 10)

  const ledgerStatus =
    target === S_APPROVED ? '检修中' : target === S_FINISHED ? '已完工' : target === S_REJECTED ? '待开工' : ''
  if (!ledgerStatus) {
    return undefined
  }

  const rejectedNote =
    target === S_REJECTED ? `申请被驳回，维保任务暂不安排（${event.operator}）` : ''

  return buildLedger(entry, event, {
    status: event.repeat ? undefined : ledgerStatus,
    完工日期: target === S_FINISHED && !event.repeat ? eventDate : undefined,
    extraNote: rejectedNote,
  })
}

/** 幂等重复动作对台账的触碰：只追加轨迹，不改任何状态字段。 */
function touchLedger(entry: EntryRow, event: DomainEvent): EntryRow | undefined {
  return buildLedger(entry, event, {})
}

function buildLedger(
  entry: EntryRow,
  event: DomainEvent,
  patch: { status?: string; 完工日期?: string; extraNote?: string },
): EntryRow {
  const applyNo = String(entry['申请编号']).trim()
  const ledgerEvent: DomainEvent = {
    ...event,
    note: [
      patch.extraNote,
      event.repeat ? '重复动作并入本台账轨迹' : `随作业申请 ${applyNo} 审批结论同步`,
      event.note,
    ]
      .filter(Boolean)
      .join('；') || undefined,
  }
  // 台账编号沿用申请编号，便于一眼对账；id 由服务层在 upsert 时指定。
  const base: EntryRow = {
    id: -1,
    status: patch.status ?? '检修中',
    pending: (patch.status ?? '检修中') !== '已完工',
    abnormal: false,
    检修编号: `MNT-${applyNo.replace(/^ENTR-/, '')}`,
    检修对象: String(entry['作业舱室'] ?? ''),
    检修类别: String(entry['作业类型'] ?? '入廊作业'),
    检修班组: String(entry[F_OWNER_TEAM] ?? RESPONSIBLE_TEAM),
    计划工期: String(entry[F_SUBMIT_DATE] ?? ''),
    完工日期: patch['完工日期'] ?? '',
    更换部件: '',
    检修状态: patch.status ?? '检修中',
    [F_SOURCE_APPLY]: applyNo,
    [F_LEDGER_NOTE]: patch.extraNote ?? '',
    events: [ledgerEvent],
  }
  return base
}

/** 服务层据此把引擎产出的台账基线合并进既有台账（已存在则只并入轨迹与可变字段）。 */
export function mergeLedger(base: EntryRow, existing: EntryRow | undefined): EntryRow {
  if (!existing) {
    return base
  }
  const incomingEvent = base.events?.[0]
  const events = [...(existing.events ?? []), ...(incomingEvent ? [incomingEvent] : [])]
  // 重复动作只追加轨迹；真实推进才更新状态/完工日期。缺项缘由等存量字段保留不覆盖。
  const isRepeat = incomingEvent?.repeat === true
  return {
    ...existing,
    status: isRepeat ? existing.status : base.status,
    pending: isRepeat ? existing.pending : base.pending,
    检修状态: isRepeat ? String(existing['检修状态'] ?? existing.status) : base['检修状态'],
    完工日期: !isRepeat && base['完工日期'] ? base['完工日期'] : existing['完工日期'] ?? '',
    [F_LEDGER_NOTE]: base[F_LEDGER_NOTE]
      ? base[F_LEDGER_NOTE]
      : existing[F_LEDGER_NOTE] ?? '',
    events,
  }
}

/* ============================================================
 * 8. 待办与台账：同源读数
 * ============================================================ */

export type TodoSummary = {
  pendingEntries: number
  pendingLedgers: number
  linkedLedgers: number
  /** 审批侧已有结论但台账缺条，或台账有条但审批侧找不到申请的差异数。 */
  drift: number
  details: { applyNo: string; kind: '缺台账' | '台账悬挂'; status: string }[]
}

/**
 * 待办清单与台账同步的统一读数：两边都从同一份存储、同一套状态口径算，
 * 页面不各自统计。drift 明细供页面提示「账待同步」，正常事务下应为 0。
 */
export function todoSummary(entries: EntryRow[], ledgers: EntryRow[]): TodoSummary {
  const projected = entries.map(projectEntry)
  const linked = ledgers.filter(isLedgerLinked)
  const linkedByNo = new Map(linked.map((row) => [String(row[F_SOURCE_APPLY]).trim(), row]))

  const details: TodoSummary['details'] = []
  for (const entry of projected) {
    const status = entry.status
    const applyNo = String(entry['申请编号']).trim()
    // 有结论（批准/驳回/完工）就必须在台账有同编号一条；待补材料/待审批不产生台账。
    if ((status === S_APPROVED || status === S_REJECTED || status === S_FINISHED) && !linkedByNo.has(applyNo)) {
      details.push({ applyNo, kind: '缺台账', status })
    }
  }
  const entryNos = new Set(projected.map((row) => String(row['申请编号']).trim()))
  for (const ledger of linked) {
    const applyNo = String(ledger[F_SOURCE_APPLY]).trim()
    if (!entryNos.has(applyNo)) {
      details.push({ applyNo, kind: '台账悬挂', status: ledger.status })
    }
  }

  return {
    pendingEntries: projected.filter((row) => row.pending).length,
    pendingLedgers: ledgers.filter((row) => row.pending && !isLedgerLinked(row)).length,
    linkedLedgers: linked.length,
    drift: details.length,
    details,
  }
}

/**
 * 差异兜底（冲突时以审批域为准的修复动作）：
 * 缺台账的按当前结论补一条并注明「对账补登」；台账悬挂（审批侧已不存在）保留不动，
 * 只列入差异——可能是申请被物理清理，台账是合规留存不能跟着删。
 */
export function reconcileTodo(entries: EntryRow[], ledgers: EntryRow[], identity: Identity, nextLedgerId: () => number) {
  const projected = entries.map(projectEntry)
  const linkedByNo = new Map(
    ledgers.filter(isLedgerLinked).map((row) => [String(row[F_SOURCE_APPLY]).trim(), row]),
  )
  const appended: EntryRow[] = []
  for (const entry of projected) {
    const applyNo = String(entry['申请编号']).trim()
    const status = entry.status
    if (
      (status === S_APPROVED || status === S_REJECTED || status === S_FINISHED) &&
      !linkedByNo.has(applyNo)
    ) {
      const event: DomainEvent = {
        at: nowStamp(),
        action: '对账补登',
        from: '',
        to: status,
        operator: identity.operator,
        team: identity.team,
        note: `审批侧结论为「${status}」，台账缺条，按审批域为准补登`,
      }
      const base = buildLedger(
        entry,
        event,
        status === S_FINISHED
          ? { status: '已完工', 完工日期: String(entry[F_SUBMIT_DATE] ?? '') }
          : status === S_REJECTED
            ? { status: '待开工', extraNote: '申请被驳回，维保任务暂不安排（对账补登）' }
            : { status: '检修中' },
      )
      appended.push({ ...base, id: nextLedgerId() })
    }
  }
  return appended
}
