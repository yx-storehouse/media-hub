<script setup>
import { computed } from 'vue'
import ABtn from '../../components/ABtn.vue'
import AIcon from '../../components/AIcon.vue'
import { toast, toastError } from '../../components/toast'
import { fmtNum } from '../../utils/format'
import { useImportStore, IMPORT_CHUNK } from './store'
import ResultsTable from './ResultsTable.vue'
import SummaryTiles from './SummaryTiles.vue'
import { downloadErrorReport, downloadResults } from './report'

/*
 * 第 4 步：正式导入，每批 1000 行。取消只在两批之间生效（已提交的批次已经写入）；
 * 取消或出错后可以从断点继续。断网 / 超时时这一批可能已经写入：重试带同样的批次编号，服务端会认出来，不会重复写。
 */
const emit = defineEmits(['again'])
const store = useImportStore()
const { state } = store

const r = computed(() => state.run)
const running = computed(() => r.value.status === 'running')
const stopping = computed(() => running.value && r.value.cancelRequested)
const percent = computed(() => (r.value.total ? Math.round((r.value.processed / r.value.total) * 100) : 0))
const remaining = computed(() => Math.max(0, r.value.total - r.value.next))
const link = computed(() => store.info.value.list)

const cancel = () => store.cancelImport()
const resume = () => store.startImport({ resume: true })

async function dlResults() {
  try {
    const n = await downloadResults(store, r.value)
    toast(`已下载导入结果（${fmtNum(n)} 行）`, { type: 'ok' })
  } catch (e) {
    toastError(e, '生成结果文件失败')
  }
}
async function dlErrors() {
  try {
    const n = await downloadErrorReport(store, r.value)
    toast(`已下载错误报告（${fmtNum(n)} 行）`, { type: 'ok' })
  } catch (e) {
    toastError(e, '生成错误报告失败')
  }
}

const autoTopics = computed(() => { void r.value.version; return [...r.value.autoTopics] })
const autoCreators = computed(() => { void r.value.version; return [...r.value.autoCreators] })
const list = arr => (arr.length > 20 ? arr.slice(0, 20).join('、') + ` 等 ${arr.length} 个` : arr.join('、'))
</script>

<template>
  <div class="step4">
    <section class="card">
      <div class="card-hd">
        <h2 class="hd-t">
          <template v-if="running">{{ stopping ? '正在停止…' : '正在导入…' }}</template>
          <template v-else-if="r.status === 'done'">导入完成</template>
          <template v-else-if="r.status === 'cancelled'">导入已取消</template>
          <template v-else-if="r.status === 'error'">导入中断</template>
          <template v-else>准备导入</template>
        </h2>
        <span class="muted small">{{ store.info.value.label }} · {{ fmtNum(r.total) }} 行 · 每批 {{ fmtNum(IMPORT_CHUNK) }} 行</span>
      </div>
      <div class="card-bd">
        <div class="prog" :role="running ? 'status' : undefined">
          <div class="row">
            <span v-if="running" class="spinner" />
            <AIcon v-else-if="r.status === 'done'" name="check-circle" :size="18" class="ok-text" />
            <AIcon v-else-if="r.status === 'error'" name="warning" :size="18" class="danger-text" />
            <span>已处理 <b class="num">{{ fmtNum(r.processed) }}</b> / {{ fmtNum(r.total) }} 行</span>
            <span class="grow" />
            <span class="num muted">{{ percent }}%</span>
          </div>
          <div class="progress" :class="{ done: r.status === 'done' }"><i :style="{ width: percent + '%' }" /></div>
        </div>

        <p v-if="r.status === 'error' && r.maybeWritten" class="banner danger" role="alert">
          <AIcon name="warning" :size="15" />
          <span>
            第 {{ fmtNum(r.next + 1) }} 行开始的这一批没有收到结果：{{ r.error }}。这一批可能已经写入。
            点「重试，继续导入」会带上同一个批次编号重发：服务端已经写入的话直接返回上次的结果，不会重复导入（1 小时内有效）。
          </span>
        </p>
        <p v-else-if="r.status === 'error'" class="banner danger" role="alert">
          <AIcon name="warning" :size="15" />
          <span>第 {{ fmtNum(r.next + 1) }} 行开始的这一批没有导入：{{ r.error }}。之前的批次已经写入；可以重试，从这一批继续。</span>
        </p>
        <p v-else-if="r.status === 'cancelled'" class="banner">
          <AIcon name="info" :size="15" />
          <span>已停止：前 {{ fmtNum(r.processed) }} 行已处理并写入，剩余 {{ fmtNum(remaining) }} 行没有导入。</span>
        </p>

        <p v-if="r.replayed" class="banner">
          <AIcon name="info" :size="15" />
          <span>有 {{ r.replayed }} 批在中断前其实已经写入，重试时服务端直接返回了当时的结果，没有重复导入。</span>
        </p>

        <SummaryTiles :run="r" />

        <p v-if="autoTopics.length || autoCreators.length" class="auto">
          <AIcon name="info" :size="14" />
          <span>
            <template v-if="autoTopics.length">已自动创建专题：{{ list(autoTopics) }}。</template>
            <template v-if="autoCreators.length">已自动创建创作者：{{ list(autoCreators) }}。</template>
          </span>
        </p>

        <div class="acts">
          <ABtn v-if="running" variant="danger" icon="x" :disabled="stopping" @click="cancel">{{ stopping ? '本批完成后停止' : '取消导入' }}</ABtn>
          <template v-else>
            <ABtn v-if="r.status === 'error'" variant="primary" icon="refresh" @click="resume">重试，继续导入</ABtn>
            <ABtn v-else-if="r.status === 'cancelled' && remaining" variant="primary" icon="import" @click="resume">继续导入剩余 {{ fmtNum(remaining) }} 行</ABtn>
            <ABtn :variant="r.status === 'done' ? 'primary' : 'default'" :icon="store.info.value.icon" :to="{ path: link.path, query: link.query }">{{ link.text }}</ABtn>
            <ABtn icon="download" :disabled="!r.results.length" @click="dlResults">下载结果</ABtn>
            <ABtn v-if="r.failed" icon="download" @click="dlErrors">下载错误报告</ABtn>
            <ABtn icon="plus" @click="emit('again')">再导入一批</ABtn>
          </template>
        </div>

        <ResultsTable :run="r" class="results" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.step4 { display: flex; flex-direction: column; gap: 16px; }
.card-hd { gap: 10px; font-size: 13.5px; }
.hd-t { font-size: 13.5px; font-weight: 600; }
.card-bd { display: flex; flex-direction: column; gap: 14px; }
.prog { display: flex; flex-direction: column; gap: 10px; }
.prog .progress { height: 6px; }
.progress.done > i { background: var(--ok); }
.banner { display: flex; align-items: flex-start; gap: 8px; padding: 9px 12px; border-radius: 7px; background: var(--panel-2); color: var(--t2); line-height: 1.6; }
.banner.danger { background: rgba(255, 107, 107, .08); color: var(--danger); }
.banner :deep(svg), .auto :deep(svg) { flex: none; margin-top: 3px; }
.auto { display: flex; align-items: flex-start; gap: 6px; color: var(--t2); line-height: 1.6; }
.acts { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
