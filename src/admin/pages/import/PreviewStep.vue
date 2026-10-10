<script setup>
import { computed, onMounted } from 'vue'
import ABtn from '../../components/ABtn.vue'
import AIcon from '../../components/AIcon.vue'
import { confirmDialog } from '../../components/confirm'
import { toast, toastError } from '../../components/toast'
import { fmtNum } from '../../utils/format'
import { useImportStore, PREVIEW_CHUNK } from './store'
import ResultsTable from './ResultsTable.vue'
import SummaryTiles from './SummaryTiles.vue'
import { downloadErrorReport } from './report'

/*
 * 第 3 步：预检。服务端把每批数据按真实导入跑一遍再回滚，所以同一批内「新增 / 更新 / 跳过 / 错误」和真导入一致；
 * 预检每批 5000 行、真导入每批 1000 行，跨批的文件内重复见下方提示。数据或选项没变时不重复预检。
 */
const emit = defineEmits(['back', 'start'])
const store = useImportStore()
const { state } = store

const p = computed(() => state.preview)
const running = computed(() => p.value.status === 'running')
const percent = computed(() => (p.value.total ? Math.round((p.value.processed / p.value.total) * 100) : 0))
const writable = computed(() => p.value.created + p.value.updated)
const chunks = computed(() => Math.ceil(store.rowCount.value / PREVIEW_CHUNK))

onMounted(() => { store.startPreview() })

const retry = () => store.startPreview({ force: true })

function back() {
  store.cancelPreview()
  emit('back')
}

async function start() {
  if (!writable.value) return
  if (p.value.failed) {
    const ok = await confirmDialog({
      title: '有错误的行',
      message: `${fmtNum(p.value.failed)} 行有错误，将被跳过。\n其余 ${fmtNum(writable.value)} 行会写入数据库（新增 ${fmtNum(p.value.created)}，更新 ${fmtNum(p.value.updated)}）。\n确定开始导入？`,
      confirmText: '开始导入'
    })
    if (!ok) return
  }
  emit('start')
}

async function errorReport() {
  try {
    const n = await downloadErrorReport(store, p.value)
    toast(`已下载错误报告（${fmtNum(n)} 行）`, { type: 'ok' })
  } catch (e) {
    toastError(e, '生成错误报告失败')
  }
}

const autoTopics = computed(() => { void p.value.version; return [...p.value.autoTopics] })
const autoCreators = computed(() => { void p.value.version; return [...p.value.autoCreators] })
const list = arr => (arr.length > 20 ? arr.slice(0, 20).join('、') + ` 等 ${arr.length} 个` : arr.join('、'))
</script>

<template>
  <div class="step3">
    <section class="card">
      <div class="card-hd">
        <h2 class="hd-t">预检结果</h2>
        <span class="muted small">只检查，不写入数据库</span>
        <span class="grow" />
        <ABtn v-if="!running" size="sm" variant="ghost" icon="refresh" @click="retry">重新预检</ABtn>
      </div>
      <div class="card-bd">
        <!-- 进行中 -->
        <div v-if="running" class="prog" role="status">
          <div class="row">
            <span class="spinner" />
            <span>正在预检… <b class="num">{{ fmtNum(p.processed) }}</b> / {{ fmtNum(p.total) }} 行</span>
            <span class="grow" />
            <span class="num muted">{{ percent }}%</span>
          </div>
          <div class="progress"><i :style="{ width: percent + '%' }" /></div>
        </div>

        <!-- 出错 -->
        <div v-else-if="p.status === 'error'" class="state">
          <AIcon name="warning" :size="22" />
          <p>预检失败：{{ p.error }}</p>
          <div class="row">
            <ABtn size="sm" icon="refresh" @click="retry">重试</ABtn>
            <ABtn size="sm" variant="ghost" @click="back">返回修改</ABtn>
          </div>
        </div>

        <div v-else-if="p.status === 'cancelled'" class="state">
          <p>预检已取消</p>
          <ABtn size="sm" icon="refresh" @click="retry">重新预检</ABtn>
        </div>

        <template v-if="p.status === 'done' || (running && p.results.length)">
          <SummaryTiles :run="p" dry />
          <p v-if="autoTopics.length || autoCreators.length" class="auto">
            <AIcon name="info" :size="14" />
            <span>
              <template v-if="autoTopics.length">将自动创建专题：{{ list(autoTopics) }}。</template>
              <template v-if="autoCreators.length">将自动创建创作者：{{ list(autoCreators) }}。</template>
            </span>
          </p>
          <p v-if="state.exampleRows.length" class="auto">
            <AIcon name="info" :size="14" />
            <span>第 {{ state.exampleRows.slice(0, 5).join('、') }} 行{{ state.exampleRows.length > 5 ? ` 等 ${state.exampleRows.length} 行` : '' }}是模板里的示例行，已跳过，不会导入。</span>
          </p>
          <p v-if="chunks > 1" class="dim small chunk-tip">
            数据较多，预检分 {{ chunks }} 批进行（每批 {{ fmtNum(PREVIEW_CHUNK) }} 行）：相隔很远、落在不同批里的重复行，预检时可能显示为「新增」，正式导入时会按「重复数据」选项处理。
          </p>
          <ResultsTable :run="p" dry class="results">
            <template #actions>
              <ABtn size="sm" icon="download" :disabled="!p.failed || running" @click="errorReport">下载错误报告</ABtn>
            </template>
          </ResultsTable>
        </template>
      </div>
    </section>

    <div class="foot">
      <ABtn icon="chevron-left" @click="back">返回修改</ABtn>
      <span class="grow" />
      <span v-if="p.status === 'done' && !writable" class="warn-text small">没有可以新增或更新的行</span>
      <ABtn variant="primary" icon="import" :disabled="running || p.status !== 'done' || !writable" @click="start">
        开始导入{{ p.status === 'done' && writable ? `（${fmtNum(writable)} 行）` : '' }}
      </ABtn>
    </div>
  </div>
</template>

<style scoped>
.step3 { display: flex; flex-direction: column; gap: 16px; }
.card-hd { gap: 10px; font-size: 13.5px; }
.hd-t { font-size: 13.5px; font-weight: 600; }
.card-bd { display: flex; flex-direction: column; gap: 14px; }
.prog { display: flex; flex-direction: column; gap: 10px; padding: 6px 0; }
.prog .progress { height: 6px; }
.auto { display: flex; align-items: flex-start; gap: 6px; color: var(--t2); line-height: 1.6; }
.auto :deep(svg) { margin-top: 3px; }
.chunk-tip { line-height: 1.6; }
.foot { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
</style>
