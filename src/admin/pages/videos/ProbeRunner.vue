<script setup>
import { ref, computed, watch } from 'vue'
import AModal from '../../components/AModal.vue'
import ABtn from '../../components/ABtn.vue'
import { useVideoProbe } from '../../composables/useVideoProbe'

/*
 * 批量「提取时长和封面」：在浏览器里逐个打开视频（一次一个，免得同时解码几十个视频把页面拖死），
 * 读出时长、截一帧上传成 covers/v<id>.jpg（覆盖同名文件），再 PATCH 回视频。具体做法在 useVideoProbe.runAll 里：
 *   - 只改探测到的字段；已有封面默认不动，勾了「覆盖已有封面」才替换
 *   - 没有播放地址的跳过；读不出来的记为失败并写明原因
 *   - 可以中途停止：正在读的那个立即放弃（不等它超时），已经处理的不会回滚
 *   - 页面被切走（组件卸载）时自动停止，不在后台继续跑
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  /** 要处理的视频 id（打开时的快照） */
  ids: { type: Array, default: () => [] },
  /** 当前页里已有的行（不在当前页的由 runAll 单独请求） */
  getRow: { type: Function, default: () => null }
})
const emit = defineEmits(['update:open', 'finished'])

const vp = useVideoProbe()
const phase = ref('setup') // setup | running | done
const overwrite = ref(false)
const items = ref([]) // { id, title, state: wait|run|ok|fail|skip, msg }

const known = computed(() => props.ids.map(id => props.getRow(id)).filter(Boolean))
const noUrl = computed(() => known.value.filter(v => !v.playbackUrl).length)
const unknown = computed(() => props.ids.length - known.value.length)
/* 选中的都在当前页、又都没有播放地址：开始了也只是全部跳过 */
const allSkipped = computed(() => props.ids.length > 0 && !unknown.value && noUrl.value === props.ids.length)
const canStart = computed(() => props.ids.length > 0 && !allSkipped.value)

const count = state => items.value.filter(i => i.state === state).length
const finished = computed(() => items.value.filter(i => !['wait', 'run'].includes(i.state)).length)
const percent = computed(() => (items.value.length ? Math.round((finished.value / items.value.length) * 100) : 0))
const current = computed(() => items.value.find(i => i.state === 'run'))

watch(() => props.open, v => {
  if (!v || phase.value === 'running') return
  phase.value = 'setup'
  overwrite.value = false
  items.value = props.ids.map(id => ({ id, title: props.getRow(id)?.title || `视频 #${id}`, state: 'wait', msg: '' }))
})

async function start() {
  if (phase.value !== 'setup' || !canStart.value) return
  phase.value = 'running'
  // 当前页里有的直接用行数据（含播放地址 / 封面），其余传 id 由 runAll 先查一次
  const entries = items.value.map(it => props.getRow(it.id) || it.id)
  const itemOf = new Map(entries.map((e, i) => [e, items.value[i]]))
  const markNext = () => { const next = items.value.find(i => i.state === 'wait'); if (next) next.state = 'run' }
  markNext()
  await vp.runAll(entries, {
    overwriteCover: overwrite.value,
    onItem: (entry, r) => {
      const it = itemOf.get(entry)
      if (!it) return
      if (r.video?.title) it.title = r.video.title
      it.state = r.state
      it.msg = r.msg
      if (!r.stopped) markNext()
    }
  })
  // 停止后没轮到的（以及万一还标着「处理中」的）都记为「已停止」
  for (const it of items.value) if (it.state === 'wait' || it.state === 'run') { it.state = 'skip'; it.msg = '已停止' }
  phase.value = 'done'
  emit('finished', { ok: count('ok'), fail: count('fail'), skip: count('skip') })
}

const stop = () => vp.cancel()

const STATE = { wait: ['等待', ''], run: ['处理中', ''], ok: ['完成', 'ok'], fail: ['失败', 'danger'], skip: ['跳过', 'warn'] }
</script>

<template>
  <AModal
    :open="open"
    title="提取时长和封面"
    :width="620"
    :persistent="phase === 'running'"
    :closable="phase !== 'running'"
    @update:open="v => emit('update:open', v)"
  >
    <div v-if="phase === 'setup'" class="setup">
      <p>将在浏览器里逐个打开选中的 <b class="num">{{ ids.length }}</b> 个视频，读取时长并截取一帧作为封面（保存为 <span class="mono">covers/v&lt;ID&gt;.jpg</span>）。</p>
      <p v-if="allSkipped" class="warn-text">选中的视频都没有播放地址，没有可以读取的内容。请先在编辑里填写播放地址。</p>
      <ul class="notes muted small">
        <li v-if="noUrl && !allSkipped">其中 {{ noUrl }} 个没有播放地址，会被跳过。</li>
        <li v-if="unknown">有 {{ unknown }} 个不在当前页，开始后再读取它们的信息。</li>
        <li>外链视频如果不允许跨域，只能读到时长，截不了封面。</li>
        <li>处理期间请不要关闭页面；可以随时停止，已处理的不会撤销。</li>
      </ul>
      <label class="ck">
        <input v-model="overwrite" type="checkbox" :disabled="allSkipped">
        <span>覆盖已有封面<span class="dim">（默认只给没有封面的视频补上）</span></span>
      </label>
    </div>

    <div v-else class="run">
      <div class="bar">
        <div class="progress grow"><i :style="{ width: percent + '%' }" /></div>
        <span class="num">{{ finished }} / {{ items.length }}</span>
      </div>
      <p class="sum">
        <span class="ok-text">完成 <b class="num">{{ count('ok') }}</b></span>
        <span class="danger-text">失败 <b class="num">{{ count('fail') }}</b></span>
        <span class="warn-text">跳过 <b class="num">{{ count('skip') }}</b></span>
        <span v-if="phase === 'running' && current" class="muted ellipsis cur">正在处理：{{ current.title }}</span>
        <span v-else-if="phase === 'done'" class="muted">已结束</span>
      </p>
      <ul class="list" aria-live="polite">
        <li v-for="it in items" :key="it.id" class="it" :class="it.state">
          <span v-if="it.state === 'run'" class="spinner" aria-hidden="true" />
          <span v-else class="chip" :class="STATE[it.state][1]">{{ STATE[it.state][0] }}</span>
          <span class="t ellipsis" :title="it.title">{{ it.title }}</span>
          <span class="m small muted ellipsis" :title="it.msg">{{ it.msg }}</span>
        </li>
      </ul>
    </div>

    <template #footer>
      <template v-if="phase === 'setup'">
        <ABtn @click="emit('update:open', false)">取消</ABtn>
        <ABtn variant="primary" icon="play" :disabled="!canStart" :title="allSkipped ? '先填写播放地址' : ''" @click="start">开始</ABtn>
      </template>
      <ABtn v-else-if="phase === 'running'" variant="danger" icon="x" @click="stop">停止</ABtn>
      <ABtn v-else variant="primary" @click="emit('update:open', false)">关闭</ABtn>
    </template>
  </AModal>
</template>

<style scoped>
.setup { display: flex; flex-direction: column; gap: 12px; line-height: 1.65; }
.notes { display: flex; flex-direction: column; gap: 2px; padding-left: 16px; list-style: disc; }
.ck { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.run { display: flex; flex-direction: column; gap: 10px; }
.bar { display: flex; align-items: center; gap: 10px; color: var(--t2); }
.bar .progress { height: 6px; }
.sum { display: flex; align-items: center; gap: 14px; min-width: 0; }
.cur { flex: 1; min-width: 0; }
.list { max-height: 46vh; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
.it { display: grid; grid-template-columns: 56px minmax(0, 1fr) minmax(0, 1.2fr); align-items: center; gap: 10px; min-height: 36px; padding: 6px 12px; border-bottom: 1px solid var(--line); }
.it:last-child { border-bottom: 0; }
.it.wait { color: var(--t3); }
.it .spinner { width: 14px; height: 14px; margin-left: 4px; }
.t { min-width: 0; }
.m { min-width: 0; text-align: right; }
</style>
