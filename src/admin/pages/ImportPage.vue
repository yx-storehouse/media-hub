<script setup>
import { ref, computed, watch, provide, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import ABtn from '../components/ABtn.vue'
import AIcon from '../components/AIcon.vue'
import { toast, toastError } from '../components/toast'
import { openLayers } from '../components/layers'
import { useSchema } from '../composables/useSchema'
import { useLeaveGuard } from '../composables/useLeaveGuard'
import { fmtNum } from '../utils/format'
import { createImportStore } from './import/store'
import { isType } from './import/types'
import SourceStep from './import/SourceStep.vue'
import MappingStep from './import/MappingStep.vue'
import PreviewStep from './import/PreviewStep.vue'
import RunStep from './import/RunStep.vue'

defineOptions({ name: 'ImportPage' })

/*
 * 批量导入向导：① 选择数据 → ② 对应字段 → ③ 预检（dryRun）→ ④ 导入。
 * ?type=videos|posts|topics|creators|keywords 预选类型（各列表页的「导入」按钮带着它）。
 * 状态在 import/store.js；几万行的数据只解析一次，结果表分页渲染。
 */
const route = useRoute()
const router = useRouter()
const store = createImportStore(provide)
const { state } = store
const { schemaError, loadSchema } = useSchema()

const initial = isType(route.query.type) ? route.query.type : 'videos'
store.setType(initial, { force: true })

/* 预检 / 导入进行中；正式导入开始后（无论是否结束）不能再回去改 */
const busy = computed(() => state.preview.status === 'running' || state.run.status === 'running')
const runStarted = computed(() => state.run.status !== 'idle')

/* 地址栏 ?type 变了（比如从别的列表页的「导入」按钮过来）→ 跟着切换；导入进行中不切 */
watch(() => route.query.type, t => {
  if (isType(t) && t !== state.type && !busy.value) {
    store.setType(t)
    if (state.step > 1) state.step = 1
  }
})

function chooseType(t) {
  if (t === state.type) return
  store.setType(t)
  router.replace({ query: { ...route.query, type: t } })
}

const STEPS = [
  { n: 1, label: '选择数据' },
  { n: 2, label: '对应字段' },
  { n: 3, label: '预检' },
  { n: 4, label: '导入' }
]
/* 步骤条只能往回点；已开始正式导入后不能再回去改（数据已写入），导入结束后用「再导入一批」重新开始 */
function canGo(n) {
  if (n >= state.step || busy.value || runStarted.value) return false
  return n === 1 || !!store.table.value?.rows.length
}

async function goMapping() {
  try {
    await store.ensureMapping()
    state.step = 2
  } catch (e) {
    toastError(e, '字段定义加载失败')
  }
}

function go(n) {
  if (!canGo(n)) return
  if (n === 2) return goMapping()
  state.step = n
}

function toPreview() {
  store.remember()
  state.step = 3
}

function startImport() {
  state.step = 4
  store.startImport()
}

function again() {
  store.reset()
}

/*
 * 预检 / 导入进行中离开页面（或刷新、关标签页）：先确认。确认离开后页面卸载，
 * onBeforeUnmount 里取消 —— 正在进行的这一批结束就停止。
 */
useLeaveGuard(busy, {
  title: '导入还没完成',
  message: '正在预检或导入。离开后，进行中的这一批结束就停止：预检结果作废；导入时已经写入的批次会保留，剩下的行不会导入。',
  confirmText: '离开'
})

/* 文件拖到页面任何位置都接住（否则浏览器会直接打开这个文件、离开后台）：第 1 步当作选择文件，其他步骤提示先回去 */
const sourceStep = ref(null)
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files')
function onWinDragOver(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  // 拖放区自己设置；其他位置：有弹窗或正在预检 / 导入时显示「不能放」
  if (e.target?.closest?.('.drop-wrap')) return
  e.dataTransfer.dropEffect = openLayers.value > 0 || busy.value ? 'none' : 'copy'
}
function onWinDrop(e) {
  if (!hasFiles(e)) return
  // 已经被第 1 步的拖放区处理过
  if (e.defaultPrevented) return
  e.preventDefault()
  if (openLayers.value > 0 || busy.value) return
  if (state.step !== 1 || !sourceStep.value) { toast('要换数据请先回到第 1 步「选择数据」'); return }
  sourceStep.value.loadFiles([...(e.dataTransfer.files || [])])
}
onMounted(() => {
  window.addEventListener('dragover', onWinDragOver)
  window.addEventListener('drop', onWinDrop)
})

onBeforeUnmount(() => {
  window.removeEventListener('dragover', onWinDragOver)
  window.removeEventListener('drop', onWinDrop)
  store.cancelPreview()
  store.cancelImport()
})

const subtitle = computed(() => {
  const t = store.table.value
  return t ? `${store.info.value.label} · ${fmtNum(t.rows.length)} 行` : 'CSV / Excel / JSON / 粘贴表格，导入前先预检'
})
</script>

<template>
  <div class="import-page">
    <PageHeader title="批量导入" :subtitle="subtitle">
      <template #actions>
        <ABtn v-if="state.step > 1 && !busy && !runStarted" variant="ghost" icon="refresh" @click="again">重新开始</ABtn>
      </template>
    </PageHeader>

    <div class="page-body">
      <ol class="stepper" aria-label="导入步骤">
        <li
          v-for="s in STEPS"
          :key="s.n"
          class="st"
          :class="{ cur: state.step === s.n, done: state.step > s.n }"
          :aria-current="state.step === s.n ? 'step' : undefined"
        >
          <button type="button" class="st-btn" :disabled="!canGo(s.n)" @click="go(s.n)">
            <span class="st-n">
              <AIcon v-if="state.step > s.n" name="check" :size="13" :stroke="2.2" />
              <template v-else>{{ s.n }}</template>
            </span>
            <span class="st-l">{{ s.label }}</span>
          </button>
          <span v-if="s.n < 4" class="st-line" aria-hidden="true" />
        </li>
      </ol>

      <div v-if="schemaError && state.step > 1" class="banner" role="alert">
        <AIcon name="warning" :size="15" />
        <span>字段定义加载失败：{{ schemaError }}</span>
        <button type="button" class="link" @click="loadSchema().catch(() => {})">重试</button>
      </div>

      <SourceStep v-if="state.step === 1" ref="sourceStep" @type="chooseType" @next="goMapping" />
      <MappingStep v-else-if="state.step === 2" @back="state.step = 1" @next="toPreview" />
      <PreviewStep v-else-if="state.step === 3" @back="goMapping" @start="startImport" />
      <RunStep v-else @again="again" />
    </div>
  </div>
</template>

<style scoped>
.import-page { min-height: 100%; }
.page-body { max-width: 1200px; }

.stepper { display: flex; align-items: center; gap: 0; margin: 2px 0 18px; padding: 10px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); overflow-x: auto; }
.st { display: flex; flex: 1; align-items: center; min-width: 0; }
.st:last-child { flex: none; }
.st-btn { display: inline-flex; flex: none; align-items: center; gap: 8px; height: 32px; padding: 0 8px; border-radius: 6px; color: var(--t3); }
.st-btn:not(:disabled):hover { background: var(--hover); color: var(--t1); }
.st-btn:disabled { cursor: default; }
.st-n { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px currentColor; font-size: 12px; font-weight: 650; }
.st-l { font-weight: 500; white-space: nowrap; }
.st.cur .st-btn { color: var(--t1); }
.st.cur .st-n { background: var(--accent); color: var(--on-accent); box-shadow: none; }
.st.done .st-btn { color: var(--t2); }
.st.done .st-n { background: #2a2a2a; color: var(--t1); box-shadow: none; }
.st-line { flex: 1; min-width: 16px; height: 1px; margin: 0 8px; background: var(--line-2); }
.st.done .st-line { background: #555; }

.banner { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; padding: 9px 12px; border-radius: 7px; background: rgba(255, 107, 107, .08); color: var(--danger); }
@media (max-width: 640px) {
  .st-l { display: none; }
  .st.cur .st-l { display: inline; }
}
</style>
