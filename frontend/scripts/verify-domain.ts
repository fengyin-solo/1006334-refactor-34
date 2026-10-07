import assert from 'node:assert'
import { SEED_ROWS } from '../src/data/seed'
import {
  applyEntryAction,
  completeWorkOrderFromLedger,
  deriveStatus,
  inferPost,
  migrateLegacy,
  submitEntry,
  validateDraft,
  viewRow,
  MATERIAL_PENDING,
} from '../src/domain/entry-approval'
import type { EntryRow } from '../src/data/types'

const actor = (crew = '给排水作业班') => ({ name: '值班管理员', crew, post: '给排水值班岗' })
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

let passed = 0
const ok = (name: string) => { passed += 1; console.log('PASS', name) }

// ---- 存量回填 --------------------------------------------------------------
let state = migrateLegacy(clone(SEED_ROWS.entryapprove), clone(SEED_ROWS.maintenance))

{
  const codes = Object.fromEntries(state.entryRows.map((r) => [r.申请编号, r]))
  // 1. 在途/历史结论不变
  assert.equal(deriveStatus(codes['ENTR-2018']), '已完工')
  assert.equal(deriveStatus(codes['ENTR-2024']), '已批准')
  assert.equal(deriveStatus(codes['ENTR-3301']), '已驳回')
  assert.equal(deriveStatus(codes['ENTR-4102']), '待审批')
  assert.equal(deriveStatus(codes['ENTR-4108']), '待审批') // 空措施的在途行保留原结论
  assert.match(codes['ENTR-4108'].缺项说明, /安全措施缺项/)
  ok('存量回填：结论与在途状态保持原样')

  // 2. 缺审批人员按值班岗位推定
  assert.match(codes['ENTR-2018'].审批人员, /给排水值班岗（值班推定）/)
  assert.match(codes['ENTR-2024'].审批人员, /热力值班岗（值班推定）/)
  assert.equal(codes['ENTR-4115'].审批人员, '周慕云') // 真人签批不覆盖
  ok('存量回填：早年缺审批人员按舱室推定岗位，真人不覆盖')

  // 3. 按提交日期回填，轨迹只追加
  assert.equal(codes['ENTR-2018'].轨迹[0].at, '2019-03-11')
  assert.equal(codes['ENTR-2018'].轨迹.length, 3)
  assert.ok(codes['ENTR-2018'].轨迹.every((e) => e.legacy))
  ok('存量回填：按提交日期追加轨迹，标记 legacy')

  // 4. 已批准/已完工落维保台账，缺项留空
  const order2018 = state.maintRows.find((r) => r.检修编号 === 'WORK-2018')
  const order2024 = state.maintRows.find((r) => r.检修编号 === 'WORK-2024')
  assert.ok(order2018 && order2024)
  assert.equal(order2018.status, '已完工')
  assert.equal(order2018.完工日期, '')
  assert.match(order2018.缺项说明, /缺项留空/)
  assert.equal(order2024.status, '检修中')
  ok('存量回填：审批结论落维保台账，早期缺项留空注明')

  // 5. 迁移幂等
  const again = migrateLegacy(clone(state.entryRows), clone(state.maintRows))
  assert.equal(again.entryRows[0].轨迹.length, state.entryRows[0].轨迹.length)
  ok('存量回填：重复执行幂等')
}

// ---- 校验 ------------------------------------------------------------------
{
  assert.equal(validateDraft({ 申请编号: 'ENTR-1234', 申请单位: 'u', 作业舱室: 'c', 安全措施: 's' }).ok, true)
  const badCode = validateDraft({ 申请编号: 'XX', 申请单位: 'u', 作业舱室: 'c', 安全措施: 's' })
  assert.equal(badCode.ok, false)
  const emptyMeasure = validateDraft({ 申请编号: 'ENTR-1234', 申请单位: 'u', 作业舱室: 'c', 安全措施: '' })
  assert.equal(emptyMeasure.ok, false)
  if (!emptyMeasure.ok) assert.equal((emptyMeasure as any).field, '安全措施')
  ok('校验：编号格式与必填项同一处，空安全措施识别为待补材料')
  assert.equal(inferPost('电力舱'), '电气值班岗')
  assert.equal(inferPost('燃气舱'), '燃气值班岗')
  assert.equal(inferPost('随便舱'), '管廊运行值班岗')
  ok('岗位推定：按舱室专业兜底')
}

// ---- 登记：空措施 → 待补材料，不产生重复记录 ----------------------------------
{
  const entries = clone(state.entryRows)
  const draft = { 申请编号: 'ENTR-9001', 申请单位: '某单位', 作业舱室: '综合舱 K1', 作业类型: '检测', 作业人数: '2', 安全措施: '' }
  const r1 = submitEntry(entries, draft, actor())
  assert.equal(r1.ok, true)
  let rows = r1.rows![0].rows
  assert.equal(rows.length, entries.length + 1)
  assert.equal(deriveStatus(rows.at(-1)!), MATERIAL_PENDING)
  assert.match(r1.message, /待补材料/)
  ok('登记：安全措施为空按待补材料收件并说明')

  // 补齐后重新提交：并入原行
  const r2 = submitEntry(rows, { ...draft, 安全措施: '先通风后作业' }, actor())
  assert.equal(r2.ok, true)
  rows = r2.rows![0].rows
  assert.equal(rows.filter((r) => r.申请编号 === 'ENTR-9001').length, 1)
  assert.equal(deriveStatus(rows.find((r) => r.申请编号 === 'ENTR-9001')!), '待审批')
  ok('登记：补齐后并入同一条，不生成第二条记录')

  // 再重复提交一次：仍一条
  const r3 = submitEntry(rows, { ...draft, 安全措施: '先通风后作业' }, actor())
  rows = r3.rows![0].rows
  assert.equal(rows.filter((r) => r.申请编号 === 'ENTR-9001').length, 1)
  const t = rows.find((r) => r.申请编号 === 'ENTR-9001')!.轨迹
  assert.ok(t.at(-1)!.note!.includes('重复提交'))
  ok('登记：重复提交只追加轨迹备注')
}

// ---- 归属控制 ----------------------------------------------------------------
{
  const entries = clone(state.entryRows)
  const target = entries.find((r) => r.申请编号 === 'ENTR-4102')! // 燃气作业班
  // 给排水班组替燃气班组登记同编号 → 拒绝
  const r = submitEntry(entries, {
    申请编号: 'ENTR-4102', 申请单位: 'x', 作业舱室: '燃气舱', 作业类型: 'x', 作业人数: '1', 安全措施: 'm',
  }, actor('给排水作业班'))
  assert.equal(r.ok, false)
  assert.match(r.message, /一律拒绝/)
  // 非归属班组点批准 → 按归属驳回
  const a = applyEntryAction(entries, clone(state.maintRows), Number(target.id), '确认批准', actor('给排水作业班'))
  assert.equal(a.ok, false)
  assert.match(a.message, /只读|归属/)
  ok('归属：非责任班组提交被拒绝、动作入口只读、越权按归属驳回')
}

// ---- 完整推进 + 台账联动 + 幂等 ----------------------------------------------
let liveEntries: EntryRow[] = clone(state.entryRows)
let liveMaint: EntryRow[] = clone(state.maintRows)
{
  const target = () => liveEntries.find((r) => r.申请编号 === 'ENTR-4102')!
  const orderCount = () => liveMaint.filter((r) => r.来源申请编号 === 'ENTR-4102').length

  // 燃气班组批准
  let r = applyEntryAction(liveEntries, liveMaint, Number(target().id), '确认批准', actor('燃气作业班'))
  assert.equal(r.ok, true); liveEntries = r.rows!.find((p) => p.entryKey === 'entryapprove')!.rows
  liveMaint = r.rows!.find((p) => p.entryKey === 'maintenance')!.rows
  assert.equal(deriveStatus(target()), '已批准')
  assert.equal(orderCount(), 1)
  assert.equal(liveMaint.find((x) => x.检修编号 === 'WORK-4102')!.status, '检修中')
  ok('推进：批准后申请已批准、维保台账落唯一工单')

  // 同一批准动作再连发两回
  for (let i = 0; i < 2; i += 1) {
    r = applyEntryAction(liveEntries, liveMaint, Number(target().id), '确认批准', actor('燃气作业班'))
    liveEntries = r.rows!.find((p) => p.entryKey === 'entryapprove')!.rows
    liveMaint = r.rows!.find((p) => p.entryKey === 'maintenance')!.rows
  }
  assert.equal(orderCount(), 1)
  const order = liveMaint.find((x) => x.检修编号 === 'WORK-4102')!
  assert.equal((order.轨迹 ?? []).length, 3) // 派单 1 + 重复并入 2
  ok('幂等：批准连发多回账上只一条，后续并入同一条轨迹')

  // 列表视图与导出同源
  const v = viewRow(target())
  assert.equal(v.status, '已批准')
  assert.equal(v.审批状态, '已批准')
  assert.equal(v.pending, true)
  ok('同源：视图行状态/审批状态/待办口径一致')

  // 非法前置：待审批才能驳回（已批准驳回应被拒）
  const bad = applyEntryAction(liveEntries, liveMaint, Number(target().id), '驳回申请', actor('燃气作业班'))
  assert.equal(bad.ok, false)
  assert.match(bad.message, /不能执行/)
  ok('流转：前置状态不满足时拒绝并说明')
}

// ---- 两条完工路径：先后与冲突兜底 --------------------------------------------
{
  // 路径A：台账侧先完工 → 申请同步已完工；审批侧再完工并入轨迹
  const e = clone(liveEntries), m = clone(liveMaint)
  const order = m.find((r) => r.检修编号 === 'WORK-4102')!
  let r = completeWorkOrderFromLedger(e, m, Number(order.id), actor('燃气作业班'))
  assert.equal(r.ok, true)
  const ee = r.rows!.find((p) => p.entryKey === 'entryapprove')!.rows
  const mm = r.rows!.find((p) => p.entryKey === 'maintenance')!.rows
  assert.equal(deriveStatus(ee.find((x) => x.申请编号 === 'ENTR-4102')!), '已完工')
  assert.equal(String(mm.find((x) => x.检修编号 === 'WORK-4102')!.完工日期).length, 10)

  // 审批侧再登记完工：终态不变，重复触发并入轨迹（幂等成功）
  const entryId = Number(ee.find((x) => x.申请编号 === 'ENTR-4102')!.id)
  const r2 = applyEntryAction(ee, mm, entryId, '登记完工', actor('燃气作业班'))
  assert.equal(r2.ok, true)
  const ee2 = r2.rows!.find((p) => p.entryKey === 'entryapprove')!.rows
  assert.equal(deriveStatus(ee2.find((x) => x.申请编号 === 'ENTR-4102')!), '已完工')
  ok('完工路径：台账先完工申请同步收口，审批侧重提并入轨迹不改结论')

  // 路径B：审批侧先完工 → 台账同步；台账再完工并入轨迹
  let e2 = clone(state.entryRows), m2 = clone(state.maintRows)
  const target = e2.find((r) => r.申请编号 === 'ENTR-4115')! // 综合维修班、已批准
  let x = applyEntryAction(e2, m2, Number(target.id), '登记完工', actor('综合维修班'))
  e2 = x.rows!.find((p) => p.entryKey === 'entryapprove')!.rows
  m2 = x.rows!.find((p) => p.entryKey === 'maintenance')!.rows
  assert.equal(deriveStatus(e2.find((r) => r.申请编号 === 'ENTR-4115')!), '已完工')
  assert.equal(m2.find((r) => r.检修编号 === 'WORK-4115')!.status, '已完工')
  const o2 = m2.find((r) => r.检修编号 === 'WORK-4115')!
  const again = completeWorkOrderFromLedger(e2, m2, Number(o2.id), actor('综合维修班'))
  assert.equal(again.ok, true)
  const m3 = again.rows!.find((p) => p.entryKey === 'maintenance')!.rows
  assert.equal(m3.filter((r) => r.检修编号 === 'WORK-4115').length, 1)
  assert.equal(String(m3.find((r: any) => r.检修编号 === 'WORK-4115')!.轨迹.at(-1).note).includes('重复触发'), true)
  ok('完工路径：审批先完工台账同步，台账重复完工并入同一条轨迹')

  // 冲突兜底：工单已完工但申请还停在待审批（未批准）→ 不替审批下结论
  let e3 = clone(state.entryRows), m3b = clone(state.maintRows)
  // 手工构造一张工单对应待审批申请
  const pend = e3.find((r) => r.申请编号 === 'ENTR-4102')!
  m3b.push({
    id: 999, status: '检修中', pending: true, abnormal: false,
    检修编号: 'WORK-4102', 检修班组: '燃气作业班', 来源申请编号: 'ENTR-4102',
    完工日期: '', 检修状态: '检修中', 轨迹: [],
  } as EntryRow)
  const c = completeWorkOrderFromLedger(e3, m3b, 999, actor('燃气作业班'))
  assert.equal(c.ok, true)
  const e3b = c.rows!.find((p) => p.entryKey === 'entryapprove')!.rows
  assert.equal(deriveStatus(e3b.find((r) => r.申请编号 === 'ENTR-4102')!), '待审批')
  ok('冲突兜底：台账完工不覆盖未生效的审批结论，留痕说明')
}

// ---- 驳回后补正重提 -----------------------------------------------------------
{
  let e = clone(state.entryRows)
  const rejected = e.find((r) => r.申请编号 === 'ENTR-3301')! // 电气作业班
  let r = submitEntry(e, {
    申请编号: 'ENTR-3301', 申请单位: '盛能电气检修队', 作业舱室: '电力舱 K0+880',
    作业类型: '电缆接头', 作业人数: '5', 安全措施: '停电验电挂牌重做',
  }, actor('电气作业班'))
  assert.equal(r.ok, true)
  e = r.rows![0].rows
  assert.equal(deriveStatus(e.find((x) => x.申请编号 === 'ENTR-3301')!), '待审批')
  assert.equal(e.filter((x) => x.申请编号 === 'ENTR-3301').length, 1)
  ok('驳回补正：责任班组重新提交回到待审批且仍是同一条')
}

// ---- v1 旧版数据升级：无轨迹、无责任班组也能安全回填，不丢行 -------------------
{
  const oldEntries: EntryRow[] = [
    { id: 1, status: '待审批', pending: true, abnormal: false, 申请编号: 'ENTR-0007' },
    { id: 2, status: '已批准', pending: true, abnormal: false, 申请编号: 'ENTR-0008', 作业舱室: '电力舱' },
  ]
  const v1 = migrateLegacy(clone(oldEntries), [])
  assert.equal(v1.entryRows.length, 2)
  assert.equal(deriveStatus(v1.entryRows[0]), '待审批')
  assert.equal(deriveStatus(v1.entryRows[1]), '已批准')
  assert.match(String(v1.entryRows[1].审批人员), /电气值班岗（值班推定）/)
  assert.ok(v1.maintRows.some((r) => r.检修编号 === 'WORK-0008'))
  ok('v1 旧数据：缺班组/舱室/审批人员也能安全升级，结论不变并补工单')
}

console.log(`\n全部 ${passed} 项断言通过`)