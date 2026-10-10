<script setup>
import { computed } from 'vue'
import ABtn from '../../components/ABtn.vue'
import AIcon from '../../components/AIcon.vue'
import SelectInput from '../../components/SelectInput.vue'
import SwitchInput from '../../components/SwitchInput.vue'
import { toast } from '../../components/toast'
import { useSchema } from '../../composables/useSchema'
import { fmtNum } from '../../utils/format'
import { rovingKeydown, rovingTabindex } from '../../utils/roving'
import { useImportStore } from './store'
import { mapColumns, unitConflict, unitHint } from './parse'

/*
 * 第 2 步：源列 → 字段。自动对应（列名 / 别名，或上次一模一样的表头时的手动选择），可以逐列修改。
 * 一个字段只能对应一列：选了已被占用的字段时，原来那一列自动改成「不导入」。
 * 列名括号里写的单位和字段对不上（「时长(分钟)」）时不自动对应，并在这一列下面说明原因。
 */
const emit = defineEmits(['back', 'next'])
const store = useImportStore()
const { state, table } = store
const { schema, fieldsOf } = useSchema()

const fields = computed(() => fieldsOf(state.type))
const fieldBy = computed(() => new Map(fields.value.map(f => [f.key, f])))
const options = computed(() => fields.value.map(f => ({ value: f.key, label: f.required ? `${f.label} *` : f.label })))
const keyFields = computed(() => schema.value?.[state.type]?.keyFields || [])

/** 每列的示例值：前 50 行里第一个非空的 */
const samples = computed(() => {
  const t = table.value
  if (!t) return []
  const rows = t.rows.slice(0, 50)
  return t.headers.map((_, c) => {
    const hit = rows.find(r => String(r[c] ?? '').trim() !== '')
    const v = hit ? String(hit[c]).trim().replace(/\s+/g, ' ') : ''
    return [...v].length > 60 ? [...v].slice(0, 60).join('') + '…' : v
  })
})
/** 每列有值的行数（判断是不是空列） */
const filled = computed(() => {
  const t = table.value
  if (!t) return []
  return t.headers.map((_, c) => {
    let n = 0
    for (const r of t.rows) if (String(r[c] ?? '').trim() !== '') n++
    return n
  })
})

const mappedCount = computed(() => state.mapping.filter(Boolean).length)

/* ---------------- 单位提醒 ---------------- */

/** 列名对上了字段、但单位冲突而没有自动对应的列 */
const autoWarnings = computed(() => (table.value ? mapColumns(table.value.headers, fields.value).warnings : []))
/** 每列的单位提醒：已经对应到某个字段时看那个字段；没对应时看自动对应为什么跳过了它 */
const unitNotes = computed(() => (table.value?.headers || []).map((h, i) => {
  const key = state.mapping[i]
  if (key) {
    const f = fieldBy.value.get(key)
    const unit = unitConflict(h, f)
    return unit ? `单位不符：${unitHint(f, unit)}` : ''
  }
  const w = autoWarnings.value[i]
  const f = w && fieldBy.value.get(w.key)
  return f ? `没有自动对应到「${f.label}」：${unitHint(f, w.unit)}` : ''
}))

/*
 * 时长超过 10 小时的行：多半是单位弄错了（分钟当成了秒、或者 Excel 里 h:mm 的格子）。只提醒，不拦。
 * 和服务端一样认：纯数字 = 秒；a:b = 分:秒；a:b:c = 时:分:秒。
 */
const LONG_SEC = 10 * 3600
function durationSec(v) {
  const s = String(v ?? '').trim()
  if (!s) return 0
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const p = s.split(/[:：]/)
  if (p.length < 2 || p.length > 3 || p.some(x => !/^\d+$/.test(x))) return 0
  const n = p.map(Number)
  return n.length === 2 ? n[0] * 60 + n[1] : n[0] * 3600 + n[1] * 60 + n[2]
}
const longDurations = computed(() => {
  const c = state.mapping.indexOf('duration')
  const t = table.value
  if (c < 0 || !t) return 0
  let n = 0
  for (const r of t.rows) if (durationSec(r[c]) > LONG_SEC) n++
  return n
})

function setCol(i, v) {
  const key = v || ''
  const next = [...state.mapping]
  if (key) {
    const j = next.indexOf(key)
    if (j >= 0 && j !== i) {
      next[j] = ''
      toast(`「${fieldBy.value.get(key)?.label}」改为对应「${table.value.headers[i]}」列，原来的「${table.value.headers[j]}」列不再导入`)
    }
  }
  next[i] = key
  state.mapping = next
}

const clearAll = () => { state.mapping = state.mapping.map(() => '') }
const redoAuto = () => store.ensureMapping({ force: true })

/* ---------------- 必填 / 查重 ---------------- */

const required = computed(() => fields.value.filter(f => f.required).map(f => ({ ...f, ok: state.mapping.includes(f.key) })))
const missing = computed(() => required.value.filter(f => !f.ok))
const mappedKeys = computed(() => keyFields.value.filter(k => state.mapping.includes(k)))
/* 只更新已有数据（按 ID / 编号等匹配）时，没对应必填列也可以继续：新数据行会在预检里报错 */
const relaxed = computed(() => missing.value.length > 0 && state.options.onDuplicate === 'update' && mappedKeys.value.length > 0)
const blocked = computed(() => {
  if (!mappedCount.value) return '至少要对应一列'
  if (missing.value.length && !relaxed.value) return `请为必填字段「${missing.value.map(f => f.label).join('、')}」指定一列`
  return ''
})

const labelOf = k => fieldBy.value.get(k)?.label || k
const keyOrder = computed(() => keyFields.value.map(labelOf).join(' → '))

const DUP = [
  { value: 'skip', label: '跳过', text: '已存在的数据不动' },
  { value: 'update', label: '更新已有', text: '用表里的值覆盖；空单元格不改' },
  { value: 'error', label: '报错', text: '已存在的行标为错误' }
]
const STATUS = [{ value: 1, label: '已发布' }, { value: 0, label: '草稿' }]

function next() {
  if (blocked.value) { toast(blocked.value, { type: 'error' }); return }
  emit('next')
}
</script>

<template>
  <div class="step2">
    <section class="card">
      <div class="card-hd">
        <h2 class="hd-t">字段对应</h2>
        <span class="muted small hd-sub">
          {{ fmtNum(table?.rows.length || 0) }} 行 · {{ table?.headers.length }} 列，已对应 {{ mappedCount }} 列
          <template v-if="state.remembered">（套用了上次同样表头时的选择）</template>
        </span>
        <span class="grow" />
        <ABtn size="sm" variant="ghost" icon="refresh" @click="redoAuto">重新自动对应</ABtn>
        <ABtn size="sm" variant="ghost" icon="x" :disabled="!mappedCount" @click="clearAll">全部不导入</ABtn>
      </div>
      <div class="card-bd">
        <div class="req-line">
          <span class="muted small">必填字段：</span>
          <span v-for="f in required" :key="f.key" class="chip" :class="f.ok ? 'ok' : 'danger'">
            <AIcon :name="f.ok ? 'check' : 'warning'" :size="12" :stroke="2" />{{ f.label }}
          </span>
          <span v-if="!required.length" class="dim small">无</span>
        </div>

        <div class="map-scroll">
          <table class="tbl map">
            <thead>
              <tr><th class="c-src">源文件的列</th><th class="c-sample">示例值</th><th class="c-to">导入为</th></tr>
            </thead>
            <tbody>
              <tr v-for="(h, i) in table?.headers || []" :key="i" :class="{ off: !state.mapping[i] }">
                <td class="c-src">
                  <div class="src-name ellipsis" :title="h">{{ h }}</div>
                  <div class="dim small">第 {{ i + 1 }} 列 · {{ filled[i] ? `${fmtNum(filled[i])} 行有值` : '整列为空' }}</div>
                </td>
                <td class="c-sample"><span class="sample ellipsis" :title="samples[i]">{{ samples[i] || '（空）' }}</span></td>
                <td class="c-to">
                  <label class="sr-only" :for="`map-col-${i}`">「{{ h }}」列导入为</label>
                  <SelectInput
                    :id="`map-col-${i}`"
                    :model-value="state.mapping[i] || null"
                    :options="options"
                    placeholder="不导入"
                    clearable
                    searchable
                    :pop-width="220"
                    @update:model-value="v => setCol(i, v)"
                  />
                  <div v-if="unitNotes[i]" class="unit-warn small" role="note">
                    <AIcon name="warning" :size="13" />
                    <span>{{ unitNotes[i] }}</span>
                  </div>
                  <div v-else-if="state.mapping[i] === 'duration' && longDurations" class="unit-warn small" role="note">
                    <AIcon name="warning" :size="13" />
                    <span>有 {{ fmtNum(longDurations) }} 行时长超过 10 小时，请确认单位（{{ fieldBy.get('duration')?.help }}）</span>
                  </div>
                  <div v-else-if="state.mapping[i] && fieldBy.get(state.mapping[i])?.help" class="dim small help ellipsis" :title="fieldBy.get(state.mapping[i]).help">
                    {{ fieldBy.get(state.mapping[i]).help }}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="card">
      <h2 class="card-hd">导入选项</h2>
      <div class="card-bd opts">
        <div class="opt">
          <div class="opt-l">重复数据</div>
          <div class="opt-r">
            <div class="choices" role="radiogroup" aria-label="重复数据" @keydown="rovingKeydown">
              <button
                v-for="(d, di) in DUP"
                :key="d.value"
                type="button"
                role="radio"
                class="choice"
                :class="{ on: state.options.onDuplicate === d.value }"
                :aria-checked="state.options.onDuplicate === d.value ? 'true' : 'false'"
                :tabindex="rovingTabindex(di, DUP.findIndex(x => x.value === state.options.onDuplicate))"
                @click="state.options.onDuplicate = d.value"
              >
                <b>{{ d.label }}</b><span>{{ d.text }}</span>
              </button>
            </div>
            <p class="dim small note">
              按 {{ keyOrder }} 的顺序判断数据是否已存在（只看已对应的列，空单元格不参与）。
              <template v-if="mappedKeys.length">当前已对应：{{ mappedKeys.map(labelOf).join('、') }}。</template>
              <span v-else class="warn-text">当前没有对应这些列，无法判断重复，所有行都会作为新数据。</span>
              文件里前后重复的行也会被识别。
            </p>
          </div>
        </div>

        <div v-if="store.info.value.hasStatus" class="opt">
          <div class="opt-l">默认状态</div>
          <div class="opt-r">
            <div class="choices sm" role="radiogroup" aria-label="默认状态" @keydown="rovingKeydown">
              <button
                v-for="(s, si) in STATUS"
                :key="s.value"
                type="button"
                role="radio"
                class="choice"
                :class="{ on: Number(state.options.defaultStatus) === s.value }"
                :aria-checked="Number(state.options.defaultStatus) === s.value ? 'true' : 'false'"
                :tabindex="rovingTabindex(si, STATUS.findIndex(x => x.value === Number(state.options.defaultStatus)))"
                @click="state.options.defaultStatus = s.value"
              >
                <b>{{ s.label }}</b>
              </button>
            </div>
            <p class="dim small note">新增的行「状态」为空时用这个；草稿不会出现在前台</p>
          </div>
        </div>

        <div v-if="store.info.value.autoCreate" class="opt">
          <div class="opt-l">自动创建</div>
          <div class="opt-r">
            <SwitchInput v-model="state.options.autoCreate" :label="store.info.value.autoCreate" />
            <p class="dim small note">只在按「名称」引用且找不到时创建；填的是 ID 却不存在会报错。关掉后找不到的行会报错。</p>
          </div>
        </div>
      </div>
    </section>

    <div class="foot">
      <ABtn icon="chevron-left" @click="emit('back')">上一步</ABtn>
      <span class="grow" />
      <span v-if="blocked" class="danger-text small" role="alert">{{ blocked }}</span>
      <span v-else-if="relaxed" class="warn-text small">未对应必填字段「{{ missing.map(f => f.label).join('、') }}」：只能更新已有数据，新数据行会报错</span>
      <ABtn variant="primary" icon-right="chevron-right" :disabled="!!blocked" @click="next">下一步：预检</ABtn>
    </div>
  </div>
</template>

<style scoped>
.step2 { display: flex; flex-direction: column; gap: 16px; }
.card-hd { flex-wrap: wrap; gap: 6px 10px; padding-top: 6px; padding-bottom: 6px; font-size: 13.5px; }
.hd-t { font-size: 13.5px; font-weight: 600; }
.hd-sub { font-weight: 400; }
.req-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; }

.map-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
.tbl { width: 100%; font-size: 12.5px; }
.tbl th, .tbl td { padding: 8px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
.tbl th { background: #151515; color: var(--t2); font-weight: 500; white-space: nowrap; }
.tbl tbody tr:last-child td { border-bottom: 0; }
.map tr.off .src-name { color: var(--t2); }
.c-src { width: 32%; min-width: 180px; }
.c-sample { width: 34%; min-width: 160px; }
.c-to { width: 34%; min-width: 220px; }
.src-name { max-width: 320px; color: var(--t1); font-weight: 500; }
.sample { display: block; max-width: 340px; color: var(--t2); }
.help { max-width: 320px; margin-top: 4px; }
.unit-warn { display: flex; align-items: flex-start; gap: 5px; max-width: 360px; margin-top: 5px; color: var(--warn); line-height: 1.5; }
.unit-warn :deep(svg) { flex: none; margin-top: 2px; }

.opts { display: flex; flex-direction: column; gap: 18px; }
.opt { display: flex; gap: 16px; }
.opt-l { flex: none; width: 72px; padding-top: 7px; color: var(--t2); font-size: 12.5px; font-weight: 500; }
.opt-r { flex: 1; min-width: 0; }
.choices { display: flex; flex-wrap: wrap; gap: 8px; }
.choice { display: flex; flex-direction: column; gap: 2px; min-width: 150px; padding: 8px 12px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--panel-2); text-align: left; }
.choices.sm .choice { min-width: 90px; }
.choice:hover { border-color: #4a4a4a; }
.choice.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: #1d1d1d; }
.choice b { font-size: 13px; }
.choice span { color: var(--t2); font-size: 12px; }
.note { margin-top: 8px; line-height: 1.6; }

.foot { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
@media (max-width: 640px) {
  .opt { flex-direction: column; gap: 6px; }
  .opt-l { width: auto; padding-top: 0; }
}
</style>
