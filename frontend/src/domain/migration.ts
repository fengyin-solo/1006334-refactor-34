/**
 * 存量数据一次性回填迁移（版本化、幂等）。
 *
 * 只在本地存储首次被新代码读取时执行一次，版本号随 key 落盘，刷新不重跑；
 * 「重置模块」回到示例数据后会重新走一遍，保证演示与开发环境一致。
 *
 * 回填边界（历史审批记录不被改写）：
 *   1. status 是四个正式状态之一的，结论原样保留，只重算 pending/abnormal 派生标记；
 *      非正规记法读时归一到待审批（见 normalizeStatus），迁移本身不回写历史状态。
 *   2. 提交日期：存量没有「提交日期」这个字段，按登记时刻回填——
 *      以 id 顺序对基准日 2026-09-01 逐日递增；同序同日，保证先登记的日期更早。
 *   3. 审批人员：空值或示例占位值视为早年未录入，按提交日期的值班岗位推定
 *      （规则在 inferApprover），落「岗位（推定）」，并在轨迹里注明缘由。
 *   4. 归属班组缺失的，回填为责任班组（入廊作业审批历史上即该班归口）。
 *   5. 已有批准/完工结论的存量申请，按结论补登维保台账；早期台账条目的缺项
 *      （更换部件、完工日期等）一律空着，在内部「台账说明」里注明缘由，不杜撰。
 *   6. 所有回填动作都以一条迁移轨迹事件留痕（action: '存量回填'），可审计、可回查，
 *      但不进入任何导出列。
 */
import {
  ENTRY_KEY,
  F_MISSING_NOTE,
  F_OWNER_TEAM,
  F_SOURCE_APPLY,
  F_SUBMIT_DATE,
  F_LEDGER_NOTE,
  MAINTENANCE_KEY,
  RESPONSIBLE_TEAM,
  inferApprover,
  isAbnormalStatus,
  isPendingStatus,
  normalizeStatus,
  projectEntry,
  S_APPROVED,
  S_FINISHED,
  S_PENDING_MATERIAL,
  S_REJECTED,
} from './entry-approval'
import type { DomainEvent, EntryRow } from '../data/types'

export const MIGRATION_KEY = 'urban-utility-tunnel:migration-version'
/** 回填版本：规则调整时升版，已回填的环境会按新版本再补一次（只补不删）。 */
export const MIGRATION_VERSION = 1

const BACKFILL_BASE_DATE = '2026-09-01'

const PLACEHOLDER_PATTERN = /^入廊作业审批样例\d*$/

function isMissingValue(value: unknown): boolean {
  const text = String(value ?? '').trim()
  return text === '' || PLACEHOLDER_PATTERN.test(text)
}

/** 按登记时刻（id 顺序）回填提交日期：基准日逐日递增。 */
export function backfillSubmitDate(id: number): string {
  const base = new Date(`${BACKFILL_BASE_DATE}T00:00:00`)
  base.setDate(base.getDate() + Math.max(0, id - 1))
  return base.toISOString().slice(0, 10)
}

function migrationEvent(note: string): DomainEvent {
  return {
    at: new Date(`${BACKFILL_BASE_DATE}T00:00:00`).toISOString(),
    action: '存量回填',
    from: '',
    to: '',
    operator: '系统迁移',
    team: RESPONSIBLE_TEAM,
    note,
  }
}

/** 回填单条作业申请。纯函数：输入旧行，输出新行（无缺项时原样返回，引用相等）。 */
export function migrateEntry(row: EntryRow): EntryRow {
  const events = [...(row.events ?? [])]
  const notes: string[] = []

  // 1) 提交日期按登记时刻回填。
  let submitDate = String(row[F_SUBMIT_DATE] ?? '').trim()
  if (!submitDate) {
    submitDate = backfillSubmitDate(Number(row.id))
    notes.push(`提交日期缺失，按登记时刻（id=${row.id}）回填为 ${submitDate}`)
  }

  // 2) 归属班组回填。
  let ownerTeam = String(row[F_OWNER_TEAM] ?? '').trim()
  if (!ownerTeam) {
    ownerTeam = RESPONSIBLE_TEAM
    notes.push('归属班组缺失，按历史归口回填为责任班组')
  }

  // 3) 审批人员推定：仅在已有审批结论但人员未登记时；待审批/待补材料留空。
  const status = normalizeStatus(row.status)
  let approver = String(row['审批人员'] ?? '').trim()
  const needsApprover =
    status === S_APPROVED || status === S_REJECTED || status === S_FINISHED
  if (needsApprover && isMissingValue(approver)) {
    const inferred = inferApprover(submitDate)
    approver = inferred.name
    notes.push(inferred.note)
  }
  if (isMissingValue(approver)) {
    approver = ''
  }

  // 4) 待补材料的存量行补一条缺项说明（安全措施为空时）。
  let missingNote = String(row[F_MISSING_NOTE] ?? '').trim()
  if (status === S_PENDING_MATERIAL && !missingNote) {
    missingNote = '安全措施为空，待补齐通风、防火、监护措施（存量回填注明）'
    notes.push('安全措施为空，按待补材料处理')
  }

  // 5) 历史状态一律不回写（含非正规记法）；归一化交给读时 projectEntry。
  //    迁移只按归一化口径重算 pending/abnormal 派生标记，原 status 字段原样保留。
  const pending = isPendingStatus(status)
  const abnormal = isAbnormalStatus(status)

  if (notes.length === 0) {
    // 无缺项：仅当派生标记不一致才动，且不追加迁移事件。
    if (row.pending === pending && row.abnormal === abnormal) {
      return row
    }
    return { ...row, pending, abnormal }
  }

  events.push(migrationEvent(notes.join('；')))
  return {
    ...row,
    pending,
    abnormal,
    审批人员: approver,
    [F_SUBMIT_DATE]: submitDate,
    [F_OWNER_TEAM]: ownerTeam,
    [F_MISSING_NOTE]: missingNote,
    events,
  }
}

/** 维保台账里由审批结论生成的联批条目的缺项说明前缀。 */
const LEDGER_BACKFILL_NOTE = '存量台账按审批结论补登，早期条目缺项空着，未杜撰补录'

/**
 * 为已有结论的存量申请补登维保台账（与引擎里的 upsert 同构，供迁移专用）。
 * 已存在同编号联批条目的不重复生成。
 */
export function migrateLedgers(entries: EntryRow[], ledgers: EntryRow[]): EntryRow[] {
  const linkedNos = new Set(
    ledgers
      .filter((row) => String(row[F_SOURCE_APPLY] ?? '').trim() !== '')
      .map((row) => String(row[F_SOURCE_APPLY]).trim()),
  )
  let nextId = ledgers.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  const appended: EntryRow[] = []

  for (const raw of entries) {
    const entry = projectEntry(raw)
    const status = entry.status
    if (status !== S_APPROVED && status !== S_REJECTED && status !== S_FINISHED) {
      continue
    }
    const applyNo = String(entry['申请编号']).trim()
    if (!applyNo || linkedNos.has(applyNo)) {
      continue
    }
    nextId += 1
    const submitDate = String(entry[F_SUBMIT_DATE] ?? '')
    const finishDate = status === S_FINISHED ? submitDate : ''
    const rejected = status === S_REJECTED
    const ledger: EntryRow = {
      id: nextId,
      status: status === S_FINISHED ? '已完工' : status === S_REJECTED ? '待开工' : '检修中',
      pending: status !== S_FINISHED,
      abnormal: false,
      检修编号: `MNT-${applyNo.replace(/^ENTR-/, '')}`,
      检修对象: isMissingValue(entry['作业舱室']) ? '' : String(entry['作业舱室']),
      检修类别: isMissingValue(entry['作业类型']) ? '' : String(entry['作业类型']),
      检修班组: String(entry[F_OWNER_TEAM] ?? RESPONSIBLE_TEAM),
      计划工期: submitDate,
      完工日期: finishDate,
      更换部件: '',
      检修状态: status === S_FINISHED ? '已完工' : status === S_REJECTED ? '待开工' : '检修中',
      [F_SOURCE_APPLY]: applyNo,
      [F_LEDGER_NOTE]: rejected
        ? `${LEDGER_BACKFILL_NOTE}；申请被驳回，维保任务暂不安排`
        : LEDGER_BACKFILL_NOTE,
      events: [
        {
          at: new Date(`${BACKFILL_BASE_DATE}T00:00:00`).toISOString(),
          action: '存量回填',
          from: '',
          to: status === S_FINISHED ? '已完工' : status === S_REJECTED ? '待开工' : '检修中',
          operator: '系统迁移',
          team: RESPONSIBLE_TEAM,
          note: rejected
            ? '申请已驳回，台账补登为待开工并空着缺项'
            : `申请结论为「${status}」，按审批域为准补登${status === S_FINISHED ? '，完工日期取申请提交日期' : ''}`,
        },
      ],
    }
    appended.push(ledger)
    linkedNos.add(applyNo)
  }
  return appended
}

export type MigrationInput = Record<string, EntryRow[]>

/** 执行一次完整迁移，返回新的全量数据（未发生变化的模块保持原引用）。 */
export function runMigration(data: MigrationInput): MigrationInput {
  const entries = (data[ENTRY_KEY] ?? []).map(migrateEntry)
  const ledgers = [...(data[MAINTENANCE_KEY] ?? [])]
  const appendedLedgers = migrateLedgers(entries, ledgers)
  return {
    ...data,
    [ENTRY_KEY]: entries,
    [MAINTENANCE_KEY]: [...ledgers, ...appendedLedgers],
  }
}
