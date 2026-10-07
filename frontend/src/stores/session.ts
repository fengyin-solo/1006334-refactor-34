import { defineStore } from 'pinia'

// 责任班组清单：入廊作业申请只允许责任班组写，其他班组入口只读。
// 演示环境默认「给排水作业班」，可在顶栏切换验证越权驳回。
export const DUTY_CREWS = [
  '给排水作业班',
  '电气作业班',
  '热力作业班',
  '燃气作业班',
  '综合维修班',
] as const

export const POST_BY_CREW: Record<string, string> = {
  给排水作业班: '给排水值班岗',
  电气作业班: '电气值班岗',
  热力作业班: '热力值班岗',
  燃气作业班: '燃气值班岗',
  综合维修班: '综合管廊值班岗',
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    crew: '给排水作业班' as string,
    shiftLabel: '白班 08:00-20:00',
    scope: '城市地下综合管廊运行维护管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    post: (state) => POST_BY_CREW[state.crew] ?? '管廊运行值班岗',
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setCrew(crew: string) {
      this.crew = crew
    },
  },
})
