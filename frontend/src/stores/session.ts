import { defineStore } from 'pinia'

import { RESPONSIBLE_TEAM } from '@/domain/entry-approval'

/**
 * 演示用身份切换：入廊作业审批由「廊内运维一班」归口，
 * 切到外单位/其他班组后入口自动变只读，写操作在服务层仍会被归属校验拦下。
 */
export type SessionIdentity = {
  operator: string
  team: string
  post: string
}

export const IDENTITY_PRESETS: { label: string; value: SessionIdentity }[] = [
  { label: '运维一班 · 值班长（责任班组）', value: { operator: '周建国', team: RESPONSIBLE_TEAM, post: '白班值班长' } },
  { label: '运维一班 · 值班员（责任班组）', value: { operator: '李卫东', team: RESPONSIBLE_TEAM, post: '夜班值班员' } },
  { label: '外单位施工员（只读）', value: { operator: '陈阿明', team: '远东管道施工队', post: '外协人员' } },
  { label: '运维二班（只读）', value: { operator: '赵晓琳', team: '廊内运维二班', post: '值班主管' } },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '周建国',
    team: RESPONSIBLE_TEAM,
    post: '白班值班长',
    shiftLabel: '白班 08:00-20:00',
    scope: '城市地下综合管廊运行维护管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    /** 是否为入廊作业审批的责任班组：决定入口可写还是只读。 */
    isResponsibleTeam(): boolean {
      return this.team === RESPONSIBLE_TEAM
    },
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    useIdentity(identity: SessionIdentity) {
      this.operator = identity.operator
      this.team = identity.team
      this.post = identity.post
    },
  },
})
