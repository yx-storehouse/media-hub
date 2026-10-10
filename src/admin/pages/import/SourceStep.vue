<script setup>
import { ref, computed, nextTick } from 'vue'
import ABtn from '../../components/ABtn.vue'
import AIcon from '../../components/AIcon.vue'
import SelectInput from '../../components/SelectInput.vue'
import { toast } from '../../components/toast'
import { useSchema } from '../../composables/useSchema'
import { fmtNum, fmtSize } from '../../utils/format'
import { rovingKeydown, rovingTabindex } from '../../utils/roving'
import { useImportStore } from './store'
import { TYPES } from './types'
import { readFile, loadSheet, loadPaste, headerChoices, yieldFrame, ACCEPT } from './parse'
import { downloadTemplate } from './report'

/*
 * 第 1 步：选数据类型 + 读入数据（上传文件 / 粘贴表格），显示前几行预览。
 * 表头不一定在第一行（上面可能有合并的标题行）：自动找列名能对上字段的那一行，认错了可以手动改。
 */
const emit = defineEmits(['type', 'next'])
const store = useImportStore()
const { state, table } = store
const { schema, fieldsOf, schemaError, loadSchema, ready: schemaReady } = useSchema()

const tab = ref(state.source?.format === 'paste' ? 'paste' : 'file')
const reading = ref(false)
const readError = ref('')
const dragOver = ref(false)
const pasteText = ref('')
const showHelp = ref(false)
const fileEl = ref(null)

const fields = computed(() => fieldsOf(state.type))
const FORMAT_LABEL = { csv: 'CSV', tsv: 'TSV（制表符分隔）', xlsx: 'Excel 工作簿', json: 'JSON', paste: '粘贴的表格' }
const typeIndex = computed(() => TYPES.findIndex(t => t.type === state.type))

/** 认表头用所有类型的字段（换类型不用重新认）；字段定义加载失败时只按「有几个格子有值」认 */
async function headerFields() {
  const s = schema.value || await loadSchema().catch(() => null)
  return Object.values(s || {}).flatMap(t => (Array.isArray(t?.fields) ? t.fields : []))
}

/* ---------------- 读文件 ---------------- */

async function load(file) {
  readError.value = ''
  reading.value = true
  await yieldFrame()
  try {
    const res = await readFile(file, { fields: await headerFields() })
    // 只有 Excel 允许「这个表是空的」：可以换别的工作表
    if (!res.table.rows.length && res.format !== 'xlsx') {
      throw new Error(res.table.headers.length ? '文件里只有表头，没有数据行' : '文件里没有数据')
    }
    store.setTable(res.table, {
      name: file.name,
      size: file.size,
      format: res.format,
      sheets: res.book?.sheets || null,
      sheetIndex: res.sheetIndex ?? 0
    }, res.book || null, res.raw, res.headerIndex)
    if (res.sheetError) readError.value = res.sheetError
  } catch (e) {
    readError.value = e.message || '读取失败'
  } finally {
    reading.value = false
  }
}

function onPick(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (file) load(file)
}

/* 拖放：只认文件；离开子元素时 dragleave 会误触发，用 relatedTarget 判断是否真的离开了 */
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files')
function onDragOver(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  dragOver.value = true
}
function onDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) dragOver.value = false
}
function onDrop(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragOver.value = false
  loadFiles([...(e.dataTransfer.files || [])])
}
/** 拖进来的文件（放在页面其他位置时由 ImportPage 转过来） */
function loadFiles(files) {
  if (!files.length || reading.value) return
  if (files.length > 1) toast(`一次只能导入一个文件，已使用「${files[0].name}」`)
  tab.value = 'file'
  load(files[0])
}
defineExpose({ loadFiles })

const sheetOptions = computed(() => (state.source?.sheets || []).map((s, i) => ({ value: i, label: s.hidden ? `${s.name}（隐藏）` : s.name })))
async function pickSheet(i) {
  const book = store.getBook()
  if (!book || i === state.source.sheetIndex) return
  readError.value = ''
  reading.value = true
  await yieldFrame()
  try {
    const r = await loadSheet(book, Number(i), { fields: await headerFields() })
    store.setTable(r.table, { ...state.source, sheetIndex: Number(i) }, book, r.raw, r.headerIndex)
  } catch (e) {
    readError.value = e.message || '读取工作表失败'
  } finally {
    reading.value = false
  }
}

/* ---------------- 表头在第几行 ---------------- */

/* 换表头 / 换工作表都会换 tableId，选项跟着重算 */
const headerOptions = computed(() => { void state.tableId; return headerChoices(store.getRaw()) })
function pickHeader(i) {
  readError.value = ''
  try {
    store.setHeaderRow(Number(i))
  } catch (e) {
    readError.value = e.message || '换表头失败'
  }
}

/* ---------------- 粘贴 ---------------- */

async function parsePaste() {
  readError.value = ''
  const text = pasteText.value
  if (!text.trim()) { readError.value = '请先粘贴表格内容'; return }
  try {
    const r = loadPaste(text, { fields: await headerFields() })
    const t = r.table
    if (!t.rows.length) throw new Error(t.headers.length ? '只识别到一行（表头），没有数据行。第一行应是表头，从第二行开始是数据' : '没有识别到表格')
    store.setTable(t, { name: '粘贴的表格', size: new Blob([text]).size, format: 'paste' }, null, r.raw, r.headerIndex)
  } catch (e) {
    readError.value = e.message || '识别失败'
  }
}
/* 粘贴后自动识别（等 textarea 的值更新） */
const onPaste = () => nextTick(parsePaste)

function reselect() {
  store.clearTable()
  readError.value = ''
  if (tab.value === 'file') nextTick(() => fileEl.value?.click())
}

/* 数据来源标签页：← → 切换（roving.js），面板用 aria-controls 关联 */
const TABS = [
  { key: 'file', label: '上传文件', icon: 'upload' },
  { key: 'paste', label: '粘贴表格', icon: 'copy' }
]
const tabIndex = computed(() => TABS.findIndex(t => t.key === tab.value))

/* ---------------- 预览 ---------------- */

const PREVIEW_ROWS = 5
const preview = computed(() => (table.value ? table.value.rows.slice(0, PREVIEW_ROWS) : []))
const canNext = computed(() => !!table.value && table.value.rows.length > 0 && !reading.value)

async function template() {
  try {
    await loadSchema()
    downloadTemplate(state.type, store.info.value.label, fields.value)
    toast('已下载模板：第 2 行是示例行，填好数据后请删掉它（留着的话导入时也会自动跳过）', { type: 'ok' })
  } catch (e) {
    toast(e.message || '字段定义加载失败', { type: 'error' })
  }
}

const optionText = f => {
  const opts = Array.isArray(f.options) ? f.options : []
  if (!opts.length) return ''
  const shown = opts.slice(0, 12).map(o => o.label === String(o.value) ? o.label : `${o.label}（${o.value}）`).join(' / ')
  return opts.length > 12 ? shown + ` 等 ${opts.length} 项` : shown
}
</script>

<template>
  <div class="step1">
    <section class="card">
      <h2 class="card-hd">1. 要导入什么数据</h2>
      <div class="card-bd">
        <div class="types" role="radiogroup" aria-label="数据类型" @keydown="rovingKeydown">
          <button
            v-for="(t, i) in TYPES"
            :key="t.type"
            type="button"
            role="radio"
            class="type"
            :class="{ on: state.type === t.type }"
            :aria-checked="state.type === t.type ? 'true' : 'false'"
            :tabindex="rovingTabindex(i, typeIndex)"
            @click="emit('type', t.type)"
          >
            <span class="t-ico"><AIcon :name="t.icon" :size="18" /></span>
            <span class="t-txt">
              <b>{{ t.label }}</b>
              <span class="t-desc">{{ t.desc }}</span>
            </span>
            <AIcon v-if="state.type === t.type" class="t-check" name="check" :size="16" :stroke="2" />
          </button>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-hd src-hd">
        <h2 class="src-title">2. 数据来源</h2>
        <div v-if="!table" class="tabs" role="tablist" aria-label="数据来源" @keydown="e => rovingKeydown(e, { orientation: 'horizontal' })">
          <button
            v-for="(t, i) in TABS"
            :id="`src-tab-${t.key}`"
            :key="t.key"
            type="button"
            role="tab"
            class="tab"
            :class="{ on: tab === t.key }"
            :aria-selected="tab === t.key ? 'true' : 'false'"
            :aria-controls="`src-panel-${t.key}`"
            :tabindex="rovingTabindex(i, tabIndex)"
            @click="tab = t.key"
          >
            <AIcon :name="t.icon" :size="14" /> {{ t.label }}
          </button>
        </div>
        <span class="grow" />
        <ABtn size="sm" variant="ghost" :icon="showHelp ? 'chevron-up' : 'info'" :aria-expanded="showHelp ? 'true' : 'false'" @click="showHelp = !showHelp">字段说明</ABtn>
        <ABtn size="sm" icon="download" :disabled="!schemaReady && !schemaError" @click="template">下载{{ store.info.value.label }}模板</ABtn>
      </div>

      <div class="card-bd">
        <!-- 字段说明 -->
        <div v-if="showHelp" class="help">
          <p v-if="schemaError" class="danger-text">字段定义加载失败：{{ schemaError }} <button type="button" class="link" @click="loadSchema().catch(() => {})">重试</button></p>
          <template v-else>
            <p class="muted small help-tip">第一行写列名（用下面的「列名」最省事，也认常见的其他写法），从第二行开始每行一条数据。没有的列可以不写；带 <b class="req">*</b> 的必须有。</p>
            <div class="help-scroll">
              <table class="tbl">
                <thead><tr><th>列名</th><th>必填</th><th>说明</th><th>示例</th></tr></thead>
                <tbody>
                  <tr v-for="f in fields" :key="f.key">
                    <td class="nowrap"><b>{{ f.label }}</b><span v-if="f.required" class="req">*</span></td>
                    <td>{{ f.required ? '是' : '' }}</td>
                    <td>
                      {{ f.help }}
                      <span v-if="optionText(f)" class="opts">可选：{{ optionText(f) }}</span>
                    </td>
                    <td class="mono ex">{{ f.example || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </div>

        <!-- 已读入 -->
        <div v-if="table" class="loaded">
          <div class="loaded-hd">
            <AIcon :name="state.source?.format === 'paste' ? 'copy' : 'file'" :size="18" />
            <div class="grow">
              <div class="fname ellipsis" :title="state.source?.name">{{ state.source?.name }}</div>
              <div class="muted small">
                {{ FORMAT_LABEL[state.source?.format] || '' }}
                <template v-if="state.source?.size"> · {{ fmtSize(state.source.size) }}</template>
                · <b class="t1 num">{{ fmtNum(table.rows.length) }}</b> 行数据 · {{ table.headers.length }} 列
              </div>
            </div>
            <div v-if="sheetOptions.length > 1" class="sheet">
              <span class="muted small" aria-hidden="true">工作表</span>
              <SelectInput size="sm" aria-label="工作表" :model-value="state.source.sheetIndex" :options="sheetOptions" :disabled="reading" :pop-width="200" @update:model-value="pickSheet" />
            </div>
            <div v-if="headerOptions.length > 1" class="sheet head-sel">
              <span class="muted small" aria-hidden="true">表头</span>
              <SelectInput size="sm" aria-label="表头在第几行" :model-value="state.headerIndex" :options="headerOptions" :disabled="reading" :pop-width="320" @update:model-value="pickHeader" />
            </div>
            <ABtn size="sm" icon="refresh" :disabled="reading" @click="reselect">{{ state.source?.format === 'paste' ? '重新粘贴' : '换一个文件' }}</ABtn>
          </div>
          <div v-if="table.skippedAbove || table.merged || table.extraRows" class="notes">
            <p v-if="table.skippedAbove" class="note">
              <AIcon name="info" :size="14" />
              <span>表头在第 {{ table.headerRow }} 行，上面 {{ table.skippedAbove }} 行（标题、说明）不导入。认错了可以在右侧的「表头」里改。</span>
            </p>
            <p v-if="table.merged" class="note">
              <AIcon name="info" :size="14" />
              <span>有 {{ fmtNum(table.merged) }} 处合并单元格：已把合并的值填进它覆盖的每一行（和在 Excel 里看到的一样）。</span>
            </p>
            <p v-if="table.extraRows" class="note warn-text">
              <AIcon name="warning" :size="14" />
              <span>有 {{ fmtNum(table.extraRows) }} 行在表头以外的列里有数据（显示为「第 N 列」，默认不导入）。如果是分隔符认错了（比如值里带英文逗号），请检查文件或改用制表符分隔。</span>
            </p>
          </div>
          <p v-if="!table.rows.length" class="warn-text small empty-sheet">这个工作表里没有数据行（表头下面没有内容），请换一个工作表、改「表头」行或换个文件。</p>
          <div v-else class="pv-scroll">
            <table class="tbl pv">
              <thead>
                <tr><th class="rn">行</th><th v-for="(h, i) in table.headers" :key="i" :title="h">{{ h }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="(r, ri) in preview" :key="ri">
                  <td class="rn dim num">{{ table.rowNos[ri] }}</td>
                  <td v-for="(c, ci) in r" :key="ci" :title="c"><span class="cell">{{ c }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="table.rows.length > PREVIEW_ROWS" class="dim small more">只显示前 {{ PREVIEW_ROWS }} 行，共 {{ fmtNum(table.rows.length) }} 行</p>
        </div>

        <!-- 上传 -->
        <div v-else-if="tab === 'file'" id="src-panel-file" class="drop-wrap" role="tabpanel" aria-labelledby="src-tab-file" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
          <button type="button" class="drop" :class="{ over: dragOver, busy: reading }" :disabled="reading" @click="fileEl?.click()">
            <span v-if="reading" class="spinner lg" />
            <AIcon v-else name="upload" :size="28" :stroke="1.4" />
            <span class="d1">{{ reading ? '正在读取…' : dragOver ? '松开鼠标导入这个文件' : '把文件拖到这里，或点击选择文件' }}</span>
            <span class="d2">支持 CSV / TSV / TXT、Excel（.xlsx）、JSON；第一行是表头。中文 Excel 存的 CSV（GBK 编码）也能直接读</span>
          </button>
          <input ref="fileEl" type="file" class="sr-only" :accept="ACCEPT" tabindex="-1" aria-label="选择要导入的文件" @change="onPick">
        </div>

        <!-- 粘贴 -->
        <div v-else id="src-panel-paste" class="paste" role="tabpanel" aria-labelledby="src-tab-paste">
          <label class="sr-only" for="import-paste">粘贴表格</label>
          <textarea
            id="import-paste"
            v-model="pasteText"
            class="a-input mono"
            rows="10"
            spellcheck="false"
            placeholder="在 Excel / WPS 里选中包含表头的单元格，复制（Ctrl+C）后粘贴到这里（Ctrl+V）。&#10;第一行是表头，例如：&#10;标题	播放地址	专题&#10;海边日落	/media/videos/a.mp4	治愈日常"
            @paste="onPaste"
          />
          <div class="row">
            <ABtn variant="primary" size="sm" icon="check" @click="parsePaste">识别表格</ABtn>
            <ABtn v-if="pasteText" size="sm" variant="ghost" @click="pasteText = ''; readError = ''">清空</ABtn>
            <span class="dim small">粘贴后会自动识别；也支持逗号分隔的文本（第一行没有逗号时按一列处理）</span>
          </div>
        </div>

        <p v-if="readError" class="err" role="alert"><AIcon name="warning" :size="15" /> {{ readError }}</p>
      </div>
    </section>

    <div class="foot">
      <span class="dim small">{{ canNext ? '下一步：确认每一列对应的字段' : '先选择文件或粘贴表格' }}</span>
      <ABtn variant="primary" icon-right="chevron-right" :disabled="!canNext" @click="emit('next')">下一步：对应字段</ABtn>
    </div>
  </div>
</template>

<style scoped>
.step1 { display: flex; flex-direction: column; gap: 16px; }
.card-hd { font-size: 13.5px; }
.types { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.type { position: relative; display: flex; align-items: flex-start; gap: 10px; min-height: 66px; padding: 12px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--panel-2); text-align: left; transition: border-color .12s, background .12s; }
.type:hover { border-color: #4a4a4a; background: var(--hover); }
.type.on { border-color: var(--accent); background: #1d1d1d; box-shadow: inset 0 0 0 1px var(--accent); }
.t-ico { display: grid; flex: none; place-items: center; width: 32px; height: 32px; border-radius: 8px; background: #232323; color: var(--t1); }
.type.on .t-ico { background: var(--accent); color: var(--on-accent); }
.t-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding-right: 14px; }
.t-txt b { font-size: 13.5px; }
.t-desc { color: var(--t2); font-size: 12px; line-height: 1.45; }
.t-check { position: absolute; top: 10px; right: 10px; }

.src-hd { flex-wrap: wrap; gap: 8px 12px; padding: 8px 16px; }
.src-title { font-size: 13.5px; font-weight: 600; }
.tabs { display: inline-flex; padding: 2px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--panel-2); }
.tab { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 5px; color: var(--t2); font-size: 12.5px; font-weight: 500; }
.tab:hover { color: var(--t1); }
.tab.on { background: var(--hover); color: var(--t1); box-shadow: inset 0 0 0 1px var(--line-2); }

.drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 190px; padding: 24px 16px; border: 1.5px dashed #3c3c3c; border-radius: 10px; background: #101010; color: var(--t2); text-align: center; transition: border-color .12s, background .12s; }
.drop:hover:not(:disabled), .drop.over { border-color: #8a8a8a; background: #151515; color: var(--t1); }
.drop.over { border-style: solid; }
.drop.busy { cursor: progress; }
.d1 { color: var(--t1); font-size: 14px; font-weight: 600; }
.d2 { max-width: 520px; font-size: 12px; line-height: 1.6; }

.paste { display: flex; flex-direction: column; gap: 10px; }
.paste textarea { min-height: 200px; font-size: 12px; white-space: pre; overflow-wrap: normal; overflow-x: auto; }

.err { display: flex; align-items: flex-start; gap: 6px; margin-top: 12px; padding: 9px 12px; border-radius: 7px; background: rgba(255, 107, 107, .08); color: var(--danger); line-height: 1.5; }
.err :deep(svg) { margin-top: 2px; }

.loaded { display: flex; flex-direction: column; gap: 10px; }
.loaded-hd { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; color: var(--t2); }
.fname { color: var(--t1); font-weight: 600; }
.t1 { color: var(--t1); }
.sheet { display: flex; flex: none; align-items: center; gap: 6px; }
.sheet > span { white-space: nowrap; }
.head-sel :deep(.trigger) { max-width: 240px; }
.notes { display: flex; flex-direction: column; gap: 4px; }
.note { display: flex; align-items: flex-start; gap: 6px; color: var(--t2); font-size: 12.5px; line-height: 1.6; }
.note :deep(svg) { flex: none; margin-top: 3px; }
.empty-sheet { padding: 8px 0; }
.more { text-align: right; }

/* 预览 / 字段说明的小表格：横向在自己的容器里滚动 */
.pv-scroll, .help-scroll { max-width: 100%; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
.help-scroll { max-height: 380px; }
.tbl { width: 100%; font-size: 12.5px; }
.tbl th, .tbl td { padding: 7px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
.tbl th { position: sticky; top: 0; z-index: 1; background: #151515; color: var(--t2); font-weight: 500; white-space: nowrap; }
.tbl tbody tr:last-child td { border-bottom: 0; }
.pv th { max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
.pv td { white-space: nowrap; }
.pv .cell { display: inline-block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
.rn { width: 44px; text-align: right; }
.help { margin-bottom: 16px; }
.help-tip { margin-bottom: 8px; }
.req { margin-left: 2px; color: var(--danger); }
.opts { display: block; margin-top: 2px; color: var(--t3); font-size: 12px; }
.ex { color: var(--t2); white-space: nowrap; }

.foot { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
</style>
