<script setup>
import { ref, reactive, computed, watch, shallowRef, onBeforeUnmount } from 'vue'
import AModal from '../../components/AModal.vue'
import ABtn from '../../components/ABtn.vue'
import AIcon from '../../components/AIcon.vue'
import Thumb from '../../components/Thumb.vue'
import APager from '../../components/APager.vue'
import FormField from '../../components/FormField.vue'
import SelectInput from '../../components/SelectInput.vue'
import TagsInput from '../../components/TagsInput.vue'
import SwitchInput from '../../components/SwitchInput.vue'
import { confirmDialog } from '../../components/confirm'
import { toastError } from '../../components/toast'
import { useMeta } from '../../composables/useMeta'
import { useVideoProbe } from '../../composables/useVideoProbe'
import { scanMedia, importRows } from '../../api'
import { fmtSize, fmtNum, fmtDuration } from '../../utils/format'

/*
 * 扫描导入视频：列出文件夹（可含子文件夹）里的视频文件 → 勾选、改标题、填公共字段 → 批量建视频记录
 * （播放地址 = 文件地址，同名图片当封面）→ 可选：逐个在浏览器里读时长、截封面并回写（kit 的 useVideoProbe）。
 * 已经入库的文件（同样的播放地址）默认不勾选，标「已导入」；勾上也只会被跳过，不会重复建。
 * 关掉对话框（或离开页面）就停：已经发出的那一批导入在服务端照常完成并保留，剩下的批次不再发，提取立即停止。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  /** 从哪个文件夹扫描（相对 media/） */
  dir: { type: String, default: '' }
})
const emit = defineEmits(['update:open', 'imported'])

const { topicOptions, categoryOptions, regionOptions, qualityOptions, statusOptions } = useMeta()

const phase = ref('scan') // scan | list | import | probe | done
const scanError = ref('')
const recursive = ref(true)
const files = shallowRef([])
const truncated = ref(false)
const selected = ref(new Set())
const titles = reactive({})
const onlyNew = ref(false)
const page = ref(1)
const pageSize = ref(100)
const formError = ref('')

const common = reactive({ topicId: null, category: null, region: null, quality: null, tags: [], status: 1, probe: true })

const importState = reactive({ processed: 0, total: 0, created: 0, skipped: 0, failed: 0, errors: [] })
/* 提取时长和封面：一次一个；vp.cancel() 或组件卸载时正在读的那个立即放弃 */
const vp = useVideoProbe()
/** total：要提取的个数；handled：已经处理完（不算被停止的那个）；items：最近 200 条明细 */
const probe = reactive({ total: 0, handled: 0, stopping: false, items: [] })
let created = [] // [{ id, title, url, coverUrl }]

/*
 * 每轮导入一个编号；关对话框、卸载时编号 +1。旧的那一轮发现编号变了就停下（不再发下一批、不提取），
 * 也不再改界面上的状态 —— 重新打开的对话框不会被上一轮的结果盖掉。
 */
let runId = 0
let scanSeq = 0
onBeforeUnmount(() => { runId++ })

const busy = computed(() => phase.value === 'scan' || phase.value === 'import' || phase.value === 'probe')
const working = computed(() => phase.value === 'import' || phase.value === 'probe')

/* ---------------- 扫描 ---------------- */

async function scan() {
  const my = ++scanSeq
  phase.value = 'scan'
  scanError.value = ''
  formError.value = ''
  try {
    const res = await scanMedia(props.dir, recursive.value)
    if (my !== scanSeq) return
    const list = res?.files || []
    files.value = list
    truncated.value = !!res?.truncated
    for (const k of Object.keys(titles)) delete titles[k]
    for (const f of list) titles[f.path] = f.title
    // 已导入的默认不勾
    selected.value = new Set(list.filter(f => !f.imported).map(f => f.path))
    page.value = 1
    phase.value = 'list'
  } catch (e) {
    if (my !== scanSeq) return
    scanError.value = e.message || '扫描失败'
    phase.value = 'list'
    files.value = []
  }
}

watch(() => props.open, v => {
  if (!v) return
  Object.assign(probe, { total: 0, handled: 0, stopping: false, items: [] })
  scan()
})
watch(recursive, () => { if (props.open && phase.value === 'list') scan() })

/* ---------------- 勾选 / 分页 ---------------- */

const newCount = computed(() => files.value.filter(f => !f.imported).length)
const visible = computed(() => (onlyNew.value ? files.value.filter(f => !f.imported) : files.value))
const pageList = computed(() => visible.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
watch(onlyNew, () => { page.value = 1 })
/* 改了标题 / 勾选就把上次的提示清掉 */
watch([titles, selected], () => { formError.value = '' })

const isOn = f => selected.value.has(f.path)
function toggle(f) {
  const s = new Set(selected.value)
  s.has(f.path) ? s.delete(f.path) : s.add(f.path)
  selected.value = s
}
const pageAllOn = computed(() => pageList.value.length > 0 && pageList.value.every(isOn))
function togglePage() {
  const s = new Set(selected.value)
  const on = !pageAllOn.value
  for (const f of pageList.value) on ? s.add(f.path) : s.delete(f.path)
  selected.value = s
}
const selectNew = () => { selected.value = new Set(files.value.filter(f => !f.imported).map(f => f.path)) }
const selectNone = () => { selected.value = new Set() }

const chosen = computed(() => files.value.filter(f => selected.value.has(f.path)))

/* ---------------- 导入 ---------------- */

const CHUNK = 1000

function buildRow(f) {
  const row = { title: String(titles[f.path] ?? '').trim(), playbackUrl: f.url }
  if (f.coverUrl) row.coverUrl = f.coverUrl
  if (common.topicId != null && common.topicId !== '') row.topic = String(common.topicId)
  if (common.category) row.category = common.category
  if (common.region) row.region = common.region
  if (common.quality) row.quality = common.quality
  if (common.tags.length) row.tags = common.tags.join(',')
  row.status = common.status
  return row
}

async function startImport() {
  formError.value = ''
  const list = chosen.value
  if (!list.length) return
  const noTitle = list.find(f => !String(titles[f.path] ?? '').trim())
  if (noTitle) { formError.value = `「${noTitle.name}」的标题不能为空`; return }
  const tooLong = list.find(f => [...String(titles[f.path])].length > 200)
  if (tooLong) { formError.value = `「${tooLong.name}」的标题超过 200 字`; return }

  const my = ++runId
  const live = () => my === runId
  phase.value = 'import'
  Object.assign(importState, { processed: 0, total: list.length, created: 0, skipped: 0, failed: 0, errors: [] })
  Object.assign(probe, { total: 0, handled: 0, stopping: false, items: [] })
  created = []
  let made = 0
  const options = { onDuplicate: 'skip', autoCreate: false, defaultStatus: common.status }
  for (let i = 0; i < list.length; i += CHUNK) {
    if (!live()) break
    const part = list.slice(i, i + CHUNK)
    try {
      const res = await importRows('videos', part.map((f, k) => ({ _row: i + k + 1, ...buildRow(f) })), options, false)
      made += res.created || 0
      // 对话框已经关了：这一批服务端已经写入，但不再更新界面、也不再发下一批
      if (!live()) break
      importState.created += res.created || 0
      importState.skipped += res.skipped || 0
      importState.failed += res.failed || 0
      ;(res.results || []).forEach((r, k) => {
        const f = part[k]
        if (!f) return
        if (r.status === 'created') created.push({ id: r.id, title: titles[f.path], url: f.url, coverUrl: f.coverUrl })
        else if (r.status === 'error') importState.errors.push({ name: f.path, message: r.message })
      })
    } catch (e) {
      if (!live()) break
      // 这一批整体失败（网络 / 服务端异常）：记下来，继续下一批（已导入的文件再扫一次会标「已导入」，重导不会重复建）
      importState.failed += part.length
      importState.errors.push({ name: `第 ${i + 1}–${i + part.length} 个文件`, message: e.message || '请求失败' })
    }
    importState.processed = Math.min(list.length, i + CHUNK)
  }
  // 建了视频就让素材列表刷新「被 N 个视频使用」（对话框关了也要刷新）
  if (made) emit('imported')
  if (!live()) return
  if (common.probe && created.length) await runProbe(my)
  if (live()) phase.value = 'done'
}

/* ---------------- 提取时长和封面 ---------------- */

/** 明细文字：沿用扫描导入自己的说法（同名图片当封面时说明一下） */
function probeNote(v, r) {
  if (r.state === 'fail' || r.stopped) return r.msg
  const d = r.patch?.durationSec
  const notes = [d ? `时长 ${fmtDuration(d)}` : '时长未知']
  if (v.coverUrl) notes.push('使用同名封面')
  else if (r.patch?.coverUrl) notes.push('已截取封面')
  else notes.push('没能截取封面（可能是格式或跨域限制）')
  return notes.join('，')
}

async function runProbe(my) {
  phase.value = 'probe'
  probe.total = created.length
  // 有同名图片的视频已经有封面，useVideoProbe 只补时长；没有的截一帧上传为 covers/v<id>.jpg
  const list = created.map(v => ({ id: v.id, title: v.title, playbackUrl: v.url, coverUrl: v.coverUrl || '' }))
  await vp.runAll(list, {
    onItem(v, r) {
      if (my !== runId) return
      if (!r.stopped) probe.handled++
      probe.items.unshift({ id: v.id, title: v.title, state: r.stopped ? 'stop' : r.state, message: probeNote(v, r) })
      // 只保留最近 200 条明细，几千个视频时列表不会越来越卡
      if (probe.items.length > 200) probe.items.length = 200
    }
  })
}

const ITEM_ICON = { ok: 'check-circle', fail: 'x-circle', skip: 'info', stop: 'ban' }
const ITEM_CLASS = { ok: 'ok-text', fail: 'danger-text', skip: 'muted', stop: 'dim' }

/* ---------------- 关闭 ---------------- */

async function requestClose(v) {
  if (v) return emit('update:open', true)
  if (working.value) {
    const ok = await confirmDialog({
      title: phase.value === 'probe' ? '停止提取？' : '停止导入？',
      message: phase.value === 'probe'
        ? '已导入的视频会保留；正在提取的这个会放弃，没提取的可以以后在视频列表里用「提取时长和封面」补上。'
        : '已经发出的这一批会在服务端完成并保留；剩下的批次不再导入，也不会再提取时长和封面。确定关闭？',
      confirmText: '关闭',
      danger: true
    })
    if (!ok) return
  }
  // 不管在哪一步，关掉就让进行中的这一轮停下
  runId++
  vp.cancel()
  emit('update:open', false)
}

function stopProbe() {
  probe.stopping = true
  vp.cancel()
}
const probePercent = computed(() => (probe.total ? Math.round((vp.progress.done / probe.total) * 100) : 0))
const importPercent = computed(() => (importState.total ? Math.round((importState.processed / importState.total) * 100) : 0))
const where = computed(() => 'media' + (props.dir ? '/' + props.dir : ''))

function retryScan() {
  scan().catch(e => toastError(e))
}
</script>

<template>
  <AModal :open="open" title="扫描导入视频" :width="960" persistent @update:open="requestClose">
    <div class="si">
      <!-- 扫描中 -->
      <div v-if="phase === 'scan'" class="state"><span class="spinner lg" /><p>正在扫描「{{ where }}」…</p></div>

      <!-- 选择 -->
      <template v-else-if="phase === 'list'">
        <div v-if="scanError" class="state">
          <AIcon name="warning" :size="22" />
          <p>{{ scanError }}</p>
          <ABtn size="sm" icon="refresh" @click="retryScan">重试</ABtn>
        </div>
        <template v-else>
          <div class="bar">
            <span class="muted">
              在「{{ where }}」{{ recursive ? '及子文件夹' : '' }}找到 <b class="t1 num">{{ fmtNum(files.length) }}</b> 个视频文件，
              其中 {{ fmtNum(files.length - newCount) }} 个已导入；已选 <b class="t1 num">{{ fmtNum(selected.size) }}</b> 个
            </span>
            <span class="grow" />
            <SwitchInput v-model="recursive" size="sm" label="包含子文件夹" />
            <SwitchInput v-model="onlyNew" size="sm" label="只看未导入" />
          </div>
          <p v-if="truncated" class="warn-text small">文件太多，只列出了前 5000 个；可以进入子文件夹分别扫描。</p>

          <div v-if="!files.length" class="state">
            <AIcon name="video" :size="22" />
            <p>这里没有视频文件（mp4 / webm / mov / mkv / m3u8 …）</p>
          </div>
          <template v-else>
            <div class="row sel-acts">
              <ABtn size="sm" variant="ghost" icon="check" @click="selectNew">全选未导入（{{ fmtNum(newCount) }}）</ABtn>
              <ABtn size="sm" variant="ghost" icon="x" :disabled="!selected.size" @click="selectNone">全不选</ABtn>
            </div>
            <div class="tbl-wrap">
              <table class="tbl">
                <thead>
                  <tr>
                    <th class="c-cb"><input type="checkbox" :checked="pageAllOn" :disabled="!pageList.length" aria-label="选择本页全部" @change="togglePage"></th>
                    <th>文件</th>
                    <th class="c-title">标题</th>
                    <th class="c-size">大小</th>
                    <th class="c-cover">封面</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="f in pageList" :key="f.path" :class="{ on: isOn(f), imported: f.imported }">
                    <td class="c-cb"><input type="checkbox" :checked="isOn(f)" :aria-label="`选择「${f.name}」`" @change="toggle(f)"></td>
                    <td class="c-file">
                      <div class="file">
                        <Thumb :src="f.coverUrl || ''" icon="video" :width="64" />
                        <div class="file-txt">
                          <div class="ellipsis" :title="f.path">{{ f.name }}</div>
                          <div class="dim small ellipsis" :title="f.path">{{ f.path }}</div>
                          <RouterLink v-if="f.imported" class="chip outline imp" :to="{ path: '/videos', query: { edit: f.videoId } }" title="打开已有的视频记录">已导入 · ID {{ f.videoId }}</RouterLink>
                        </div>
                      </div>
                    </td>
                    <td class="c-title">
                      <input
                        v-model="titles[f.path]"
                        class="a-input sm"
                        :aria-label="`「${f.name}」的标题`"
                        maxlength="200"
                        :aria-invalid="isOn(f) && !String(titles[f.path] || '').trim() ? 'true' : undefined"
                      >
                    </td>
                    <td class="c-size dim num">{{ fmtSize(f.size) }}</td>
                    <td class="c-cover">
                      <span v-if="f.coverUrl" class="chip ok" :title="f.coverUrl">有同名图片</span>
                      <span v-else class="dim small">无</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <APager v-if="visible.length > 100" v-model:page="page" v-model:page-size="pageSize" :total="visible.length" :page-sizes="[100, 200]" />

            <h4 class="form-section">统一设置（应用到所有选中的视频）</h4>
            <div class="form-grid">
              <FormField label="专题">
                <SelectInput v-model="common.topicId" :options="topicOptions" searchable clearable placeholder="不设置" />
              </FormField>
              <FormField label="分类">
                <SelectInput v-model="common.category" :options="categoryOptions" clearable placeholder="不设置" />
              </FormField>
              <FormField label="地区" hint="不设置地区的视频在前台「最新」里归入「其他」">
                <SelectInput v-model="common.region" :options="regionOptions" searchable clearable placeholder="不设置" />
              </FormField>
              <FormField label="清晰度">
                <SelectInput v-model="common.quality" :options="qualityOptions" clearable placeholder="默认（高清）" />
              </FormField>
              <FormField class="full" label="标签" hint="回车、逗号或空格分隔，自动加 #">
                <TagsInput v-model="common.tags" hash />
              </FormField>
              <FormField label="状态" hint="草稿不会出现在前台">
                <SelectInput v-model="common.status" :options="statusOptions" />
              </FormField>
              <FormField label="导入后" inline hint="在浏览器里逐个读取视频时长，没有同名图片的截一帧当封面">
                <SwitchInput v-model="common.probe" label="提取时长和封面" />
              </FormField>
            </div>
          </template>
        </template>
      </template>

      <!-- 导入中 -->
      <div v-else-if="phase === 'import'" class="prog" role="status">
        <div class="row"><span class="spinner" /><span>正在导入… {{ fmtNum(importState.processed) }} / {{ fmtNum(importState.total) }}</span><span class="grow" /><span class="num muted">{{ importPercent }}%</span></div>
        <div class="progress"><i :style="{ width: importPercent + '%' }" /></div>
      </div>

      <!-- 提取 / 完成 -->
      <template v-else>
        <div class="tiles">
          <div class="tile"><span>新建视频</span><b class="num ok-text">{{ fmtNum(importState.created) }}</b></div>
          <div class="tile"><span>已存在跳过</span><b class="num">{{ fmtNum(importState.skipped) }}</b></div>
          <div class="tile"><span>导入失败</span><b class="num" :class="{ 'danger-text': importState.failed }">{{ fmtNum(importState.failed) }}</b></div>
          <div v-if="probe.total" class="tile"><span>提取时长 / 封面</span><b class="num">{{ fmtNum(vp.progress.ok) }}<small class="dim"> / {{ fmtNum(probe.total) }}</small></b></div>
        </div>

        <div v-if="phase === 'probe'" class="prog" role="status">
          <div class="row">
            <span class="spinner" />
            <span class="ellipsis">{{ probe.stopping ? '正在停止…' : `正在提取：${vp.progress.current}` }}</span>
            <span class="grow" />
            <span class="num muted">{{ vp.progress.done }} / {{ probe.total }}</span>
          </div>
          <div class="progress"><i :style="{ width: probePercent + '%' }" /></div>
        </div>
        <p v-else-if="probe.total && probe.handled < probe.total" class="muted small">已停止：还有 {{ probe.total - probe.handled }} 个视频没有提取，可以在视频列表里勾选后用「提取时长和封面」补上。</p>

        <div v-if="importState.errors.length" class="errs">
          <h4 class="form-section">导入失败的文件</h4>
          <ul>
            <li v-for="(e, i) in importState.errors.slice(0, 100)" :key="i" class="two"><span class="ellipsis">{{ e.name }}</span><span class="danger-text">{{ e.message }}</span></li>
          </ul>
        </div>

        <div v-if="probe.items.length" class="errs">
          <h4 class="form-section">提取明细</h4>
          <ul>
            <li v-for="it in probe.items" :key="it.id">
              <AIcon :name="ITEM_ICON[it.state]" :size="14" :class="ITEM_CLASS[it.state]" />
              <span class="ellipsis" :title="it.title">{{ it.title }}</span>
              <span :class="it.state === 'fail' ? 'danger-text' : 'muted'">{{ it.message }}</span>
            </li>
          </ul>
        </div>
      </template>
    </div>

    <template #footer>
      <template v-if="phase === 'list'">
        <span v-if="formError" class="danger-text small foot-err" role="alert">{{ formError }}</span>
        <ABtn @click="requestClose(false)">取消</ABtn>
        <ABtn variant="primary" icon="import" :disabled="!selected.size || !!scanError" @click="startImport">导入 {{ fmtNum(selected.size) }} 个视频</ABtn>
      </template>
      <template v-else-if="phase === 'probe'">
        <ABtn variant="danger" icon="x" :disabled="probe.stopping" @click="stopProbe">停止提取</ABtn>
      </template>
      <template v-else-if="phase === 'done'">
        <ABtn @click="requestClose(false)">关闭</ABtn>
        <ABtn variant="primary" icon="video" :to="{ path: '/videos', query: { sort: 'id', order: 'desc' } }">查看视频</ABtn>
      </template>
      <ABtn v-else :disabled="busy" @click="requestClose(false)">关闭</ABtn>
    </template>
  </AModal>
</template>

<style scoped>
.si { display: flex; flex-direction: column; gap: 12px; min-height: 200px; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.t1 { color: var(--t1); }
.sel-acts { gap: 4px; margin: -4px 0 -4px -8px; }
.tbl-wrap { max-height: 46vh; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
.tbl { width: 100%; font-size: 12.5px; }
.tbl th, .tbl td { padding: 7px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
.tbl th { position: sticky; top: 0; z-index: 1; background: #151515; color: var(--t2); font-weight: 500; white-space: nowrap; }
.tbl tbody tr:last-child td { border-bottom: 0; }
.tbl tr.on td { background: #191919; }
.tbl tr.imported:not(.on) td { opacity: .7; }
.c-cb { width: 36px; }
.c-title { width: 34%; min-width: 200px; }
.c-size { width: 84px; white-space: nowrap; }
.c-cover { width: 104px; }
.file { display: flex; align-items: center; gap: 10px; min-width: 0; }
.file-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; max-width: 300px; }
.imp { align-self: flex-start; margin-top: 2px; }
.prog { display: flex; flex-direction: column; gap: 10px; padding: 8px 0; }
.prog .progress { height: 6px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.tile { display: flex; flex-direction: column; gap: 2px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); color: var(--t2); font-size: 12px; }
.tile b { color: var(--t1); font-size: 20px; font-weight: 650; }
.tile b.ok-text { color: var(--ok); }
.tile b.danger-text { color: var(--danger); }
.errs ul { max-height: 240px; overflow-y: auto; }
.errs li { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(0, 1.4fr); align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--line); font-size: 12.5px; }
.errs li.two { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); }
.foot-err { margin-right: auto; }
@media (max-width: 760px) {
  .c-cover { display: none; }
}
</style>
