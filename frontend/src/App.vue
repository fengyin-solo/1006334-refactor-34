<template>
  <div class="app-shell">
    <aside class="app-side">
      <h1 class="app-title">城市地下综合管廊运行维护管理平台</h1>
      <nav class="nav-list">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>
    <main class="app-main">
      <header class="app-head">
        <span class="head-desc">面向管廊主体台账、入廊管线登记、廊内环境监测、通风排水消防、结构沉降与渗漏处置、巡检检修与隐患整改、入廊作业审批和运维值班的一体化城市地下综合管廊运行维护管理工作台。</span>
        <span class="head-user">
          当前值班：{{ store.operator }} · {{ store.shiftLabel }} ·
          <label class="crew-switch">
            责任班组
            <select :value="store.crew" @change="store.setCrew(($event.target as HTMLSelectElement).value)">
              <option v-for="crew in crews" :key="crew" :value="crew">{{ crew }}</option>
            </select>
          </label>
        </span>
      </header>
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { DUTY_CREWS, useSessionStore } from '@/stores/session'

const store = useSessionStore()
const crews = DUTY_CREWS

const navItems = [{ label: "运营概览", path: "/" }, { label: "管廊主体台账", path: "/tunnel" }, { label: "入廊管线登记", path: "/pipeline" }, { label: "廊内环境监测", path: "/envmonitor" }, { label: "通风系统运维", path: "/ventilation" }, { label: "廊内排水运维", path: "/drainage" }, { label: "消防系统运维", path: "/firecontrol" }, { label: "廊内照明运维", path: "/lighting" }, { label: "门禁安防运维", path: "/access" }, { label: "廊内巡检任务", path: "/patrol" }, { label: "结构沉降监测", path: "/settlement" }, { label: "渗漏水处置", path: "/leak" }, { label: "设施检修管理", path: "/maintenance" }, { label: "隐患整改管理", path: "/hazard" }, { label: "应急演练管理", path: "/emergency" }, { label: "廊内能耗计量", path: "/energy" }, { label: "设备台账管理", path: "/device" }, { label: "入廊作业审批", path: "/entryapprove" }, { label: "运维值班交接", path: "/duty" }]
</script>
