/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /** 审批/作业推进轨迹（只追加，不改写）。仅入廊作业审批及其维保台账使用，不进导出列。 */
  轨迹?: EntryEvent[]
  /** 存量回填或缺项的说明。不进导出列。 */
  缺项说明?: string
  [field: string]: string | number | boolean | EntryEvent[] | undefined
}

/**
 * 入廊作业审批的一次轨迹事件。
 * 状态结论由「最后一条带状态的事件」推导，列表、动作、导出共用同一份推导。
 */
export type EntryEvent = {
  /** 事件语义：提交 / 批准 / 驳回 / 完工，待补材料、重复触发并入「提交」轨迹。 */
  kind: '提交' | '批准' | '驳回' | '完工'
  status: string
  at: string
  by: string
  note?: string
  /** 存量回填的事件以此标记，只读不改写。 */
  legacy?: boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
