<script setup>
import { ref, computed } from 'vue'
import ABtn from '../../components/ABtn.vue'
import AIcon from '../../components/AIcon.vue'
import { fmtSize, fmtNum } from '../../utils/format'

/*
 * 上传队列面板：每个文件的名称、大小、进度、速度、状态和取消 / 重试。
 * 只渲染最近的 200 个（一次拖进几千个文件时界面不卡），统计数字按全部文件算。
 */
const props = defineProps({
  queue: { type: Object, required: true }
})

const collapsed = ref(false)
const SHOW = 200
const stats = computed(() => props.queue.stats.value)
/* 进行中的排前面，其余按加入顺序 */
const shown = computed(() => {
  const all = props.queue.items
  const live = all.filter(i => i.state === 'up' || i.state === 'wait')
  const rest = all.filter(i => i.state !== 'up' && i.state !== 'wait')
  return [...live, ...rest].slice(0, SHOW)
})
const totalPercent = computed(() => (stats.value.bytes ? Math.round((stats.value.loaded / stats.value.bytes) * 100) : 0))

const STATE = { wait: '等待', up: '上传中', done: '完成', fail: '失败', cancel: '已取消' }
const speedText = b => (b > 0 ? fmtSize(b) + '/s' : '')
const eta = it => (it.speed > 0 ? Math.max(1, Math.round((it.size - it.loaded) / it.speed)) : 0)
const etaText = s => (s >= 3600 ? `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分` : s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`)
const renamed = it => it.state === 'done' && it.result && it.result.path !== it.path
</script>

<template>
  <section class="up-panel card" aria-label="上传队列">
    <header class="up-hd">
      <button type="button" class="up-toggle" :aria-expanded="collapsed ? 'false' : 'true'" @click="collapsed = !collapsed">
        <AIcon :name="collapsed ? 'chevron-right' : 'chevron-down'" :size="14" />
        <b>上传队列</b>
      </button>
      <span class="muted small num">
        <template v-if="stats.running">
          正在上传 {{ stats.up }} 个，等待 {{ stats.wait }} 个 · {{ totalPercent }}%
          <template v-if="stats.speed"> · {{ speedText(stats.speed) }}</template>
        </template>
        <template v-else>共 {{ fmtNum(stats.total) }} 个文件</template>
        · 完成 {{ stats.done }}<template v-if="stats.fail"> · <span class="danger-text">失败 {{ stats.fail }}</span></template><template v-if="stats.cancel"> · 取消 {{ stats.cancel }}</template>
      </span>
      <span class="grow" />
      <ABtn v-if="stats.running" size="sm" variant="ghost" icon="x" @click="queue.cancelAll()">全部取消</ABtn>
      <ABtn size="sm" variant="ghost" :disabled="stats.total === stats.running" @click="queue.clearFinished()">清除已结束</ABtn>
    </header>
    <div v-if="stats.running" class="progress total"><i :style="{ width: totalPercent + '%' }" /></div>

    <ul v-show="!collapsed" class="up-list">
      <li v-for="it in shown" :key="it.id" class="up-item" :class="it.state">
        <AIcon class="st-ico" :name="it.state === 'done' ? 'check-circle' : it.state === 'fail' ? 'x-circle' : it.state === 'cancel' ? 'ban' : 'upload'" :size="16" />
        <div class="up-main">
          <div class="row up-line">
            <span class="up-name ellipsis" :title="it.path">{{ it.name }}</span>
            <span class="dim small num nowrap">{{ fmtSize(it.size) }}</span>
          </div>
          <div v-if="it.state === 'up' || it.state === 'wait'" class="row up-line">
            <div class="progress grow"><i :style="{ width: it.percent + '%' }" /></div>
            <span class="small num nowrap prog-txt">
              {{ it.state === 'wait' ? '等待' : `上传中 ${it.percent}%` }}
              <template v-if="it.state === 'up' && it.speed"> · {{ speedText(it.speed) }} · 剩余 {{ etaText(eta(it)) }}</template>
            </span>
          </div>
          <div v-else class="small up-msg" :class="{ 'danger-text': it.state === 'fail' }">
            <template v-if="it.state === 'done'">
              {{ STATE.done }}<template v-if="renamed(it)">，有同名文件，已存为「{{ it.result.path }}」</template>
            </template>
            <template v-else>{{ STATE[it.state] }}<template v-if="it.error && it.state === 'fail'">：{{ it.error }}</template></template>
          </div>
        </div>
        <div class="up-acts">
          <ABtn v-if="it.state === 'up' || it.state === 'wait'" size="sm" variant="ghost" icon="x" :aria-label="`取消上传「${it.name}」`" title="取消" @click="queue.cancel(it)" />
          <ABtn v-else-if="(it.state === 'fail' || it.state === 'cancel') && !it.final" size="sm" variant="ghost" icon="refresh" :aria-label="`重试上传「${it.name}」`" title="重试" @click="queue.retry(it)" />
        </div>
      </li>
      <li v-if="queue.items.length > SHOW" class="dim small more">还有 {{ fmtNum(queue.items.length - SHOW) }} 个文件未列出</li>
    </ul>
  </section>
</template>

<style scoped>
.up-panel { overflow: hidden; }
.up-hd { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-height: 42px; padding: 4px 10px 4px 12px; }
.up-toggle { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 6px; border-radius: 6px; }
.up-toggle:hover { background: var(--hover); }
.progress.total { height: 2px; border-radius: 0; }
.up-list { max-height: 260px; overflow-y: auto; border-top: 1px solid var(--line); }
.up-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.up-item:last-child { border-bottom: 0; }
.st-ico { flex: none; color: var(--t3); }
.up-item.up .st-ico { color: var(--t1); }
.up-item.done .st-ico { color: var(--ok); }
.up-item.fail .st-ico { color: var(--danger); }
.up-main { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
.up-line { gap: 10px; }
.up-name { flex: 1; min-width: 0; }
.prog-txt { min-width: 64px; color: var(--t2); text-align: right; }
@media (max-width: 640px) {
  .up-line { flex-wrap: wrap; }
  .prog-txt { min-width: 0; text-align: left; }
}
.up-msg { color: var(--t2); line-height: 1.5; word-break: break-all; }
.up-acts { flex: none; width: 26px; }
.more { padding: 8px 12px; }
</style>
