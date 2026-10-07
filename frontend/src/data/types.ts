/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

/** 一条审批/台账轨迹事件。只随记录持久化，不进入任何导出列。 */
export type DomainEvent = {
  at: string
  action: string
  from: string
  to: string
  operator: string
  team: string
  note?: string
  /** 同一动作重复触发时为 true：不另落台账，只并入本条轨迹。 */
  repeat?: boolean
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  events?: DomainEvent[]
  // 以下划线开头的都是内部字段（提交日期、归属班组、来源申请、缺项缘由等），
  // 页面与导出只认 modules.ts 里登记的字段，内部字段永不进入导出 CSV。
  [field: string]: string | number | boolean | DomainEvent[] | undefined
}

/** 操作人身份：责任班组与值班岗位用于归属校验和审批人员落名。 */
export type Identity = {
  operator: string
  team: string
  post: string
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
  /** 幂等命中：动作此前已执行过，本次只并入轨迹，没有产生新记录。 */
  idempotent?: boolean
  /** 归属校验未过：不是本责任班组的提交/改动。 */
  forbidden?: boolean
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
