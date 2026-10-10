/*
 * 列表页的「抽屉编辑器」状态：打开 / 关闭跟地址栏 ?edit=<id> / ?edit=new 同步（可以直接分享链接打开某一条），
 * 表单脏检查、保存转圈、服务端字段错误显示到对应输入框并聚焦。
 *
 *   const editor = useEditor({
 *     blank: () => ({ word: '', isHot: false, weight: 0 }),       // 新建时的表单
 *     fromRow: row => ({ word: row.word, isHot: row.isHot, … }),  // 行数据 → 表单
 *     findRow: id => list.rows.value.find(r => r.id === id),      // 先在当前页找
 *     fetchRow: getKeyword,                                       // 找不到再请求（可选）
 *     create: body => createKeyword(body),
 *     update: (id, patch) => updateKeyword(id, patch),            // 只发改动过的字段
 *     toBody: form => ({ ...form }),                              // 表单 → 请求体（可选）
 *     validate: form => (form.word.trim() ? null : { word: '请输入热词' }),  // 本地校验（可选）
 *     onSaved: () => list.reload(),
 *     whenReady: list.whenLoaded                                  // 深链时先等列表加载完
 *   })
 *   模板：<ADrawer v-model:open="editor.open" :dirty="editor.dirty" :busy="editor.saving" :loading="editor.loadingRow" @save="editor.submit()">
 *           <FormField label="热词" field="word" :error="editor.errors.word"><TextInput v-model="editor.form.word" /></FormField>
 *   返回的是 reactive 对象：模板和脚本里都不用写 .value。
 *
 * 新建时请求体会去掉空值（null / ''），让服务端用默认值；编辑时只 PATCH 变化的字段（null = 清空）。
 * 字段错误（本地校验或服务端返回的 field）：显示在 <FormField field="…"> 下，该字段一改动就清掉。
 *   服务端字段名和表单键不一样时用 fieldAlias: { durationSec: 'durationText' } 说明；
 *   既不在表单里、也没写别名的字段，表单任何改动都会清掉它。
 * 校验不通过时所有错误一起显示，只聚焦（并 toast）表单里排在最前面的那一个。
 * 保存请求进行中：ADrawer 传 :busy="editor.saving" 就关不掉；万一期间换了一条记录（浏览器后退 / 深链），
 *   旧请求的结果只提示 + 刷新列表，不会关掉、也不会改动新打开的那一条。
 */
import { ref, reactive, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast, toastError } from '../components/toast'
import { useLeaveGuard } from './useLeaveGuard'

const clone = v => JSON.parse(JSON.stringify(v ?? null))
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function useEditor(opts) {
  const {
    blank, fromRow, findRow = () => null, fetchRow = null, create, update,
    toBody = f => ({ ...f }), validate = null, onSaved = null, whenReady = null,
    param = 'edit', closeOnSave = true, savedText = '已保存', fieldAlias = {}
  } = opts
  const route = useRoute()
  const router = useRouter()
  const path = route.path

  const open = ref(false)
  const mode = ref('new') // 'new' | 'edit'
  const id = ref(null)
  const row = ref(null) // 正在编辑的原始行（只读信息从这里取）
  const form = ref(blank())
  const original = ref(JSON.stringify(form.value))
  const errors = ref({})
  const saving = ref(false)
  const loadingRow = ref(false)

  const dirty = computed(() => open.value && !loadingRow.value && JSON.stringify(form.value) !== original.value)
  const isNew = computed(() => mode.value === 'new')

  /* 有未保存的修改时：点侧边栏去别的页面先确认；刷新 / 关标签页由浏览器提示 */
  useLeaveGuard(dirty)

  /*
   * 编辑会话编号：每次打开 / 关闭都 +1。保存请求回来时编号变了，说明期间关掉了抽屉或换了一条，
   * 结果不能再套到当前表单上。
   */
  let session = 0
  // 页面卸载（离开了页面）也算会话结束；之后回来的保存结果只提示，不再刷新已经不在的列表
  let alive = true
  onBeforeUnmount(() => { alive = false; session++ })

  /* ---------- 字段错误：记下出错时该字段的值，字段一改就清掉这条错误 ---------- */
  let errSnap = {}
  const snapOf = field => {
    const k = fieldAlias[field] || field
    const f = form.value
    return JSON.stringify(f && typeof f === 'object' && k in f ? f[k] ?? null : f)
  }
  function setErrors(next) {
    errors.value = next
    errSnap = {}
    for (const f of Object.keys(next)) errSnap[f] = snapOf(f)
  }
  watch(form, () => {
    const cur = errors.value
    const keys = Object.keys(cur)
    if (!keys.length) return
    const left = keys.filter(f => errSnap[f] === snapOf(f))
    if (left.length === keys.length) return
    const next = {}
    for (const f of left) next[f] = cur[f]
    errors.value = next
  }, { deep: true })

  function fill(r) {
    row.value = r
    form.value = r ? fromRow(r) : blank()
    original.value = JSON.stringify(form.value)
    setErrors({})
  }

  const setParam = v => {
    const q = { ...route.query }
    if (v == null) delete q[param]
    else q[param] = String(v)
    return router.replace({ query: q }).catch(() => {})
  }

  /** 新建（preset 用来预填，比如「在此专题下新建」） */
  function openNew(preset = null) {
    session++
    mode.value = 'new'
    id.value = null
    fill(null)
    if (preset) { form.value = { ...form.value, ...preset }; original.value = JSON.stringify(form.value) }
    open.value = true
    if (route.query[param] !== 'new') setParam('new')
  }

  /** 编辑：传行对象（不再请求）或 id */
  async function openEdit(target) {
    const r = target && typeof target === 'object' ? target : null
    const key = r ? r.id : Number(target)
    session++
    mode.value = 'edit'
    id.value = key
    open.value = true
    if (String(route.query[param] ?? '') !== String(key)) setParam(key)
    if (r) { loadingRow.value = false; return fill(r) }
    loadingRow.value = true
    try {
      let found = findRow(key)
      if (!found && whenReady) { await whenReady(); found = findRow(key) }
      if (!found && fetchRow) found = await fetchRow(key)
      if (id.value !== key) return // 期间已切到别的行
      if (!found) throw new Error('找不到这条记录（可能已被删除）')
      fill(found)
    } catch (e) {
      if (id.value !== key) return
      toastError(e, '加载失败')
      close()
    } finally {
      if (id.value === key) loadingRow.value = false
    }
  }

  function close() {
    session++
    open.value = false
    setErrors({})
    if (route.query[param] !== undefined) setParam(null)
  }

  /* 地址栏 → 编辑器（深链、浏览器前进后退） */
  watch(() => (route.path === path ? route.query[param] : undefined), v => {
    const s = Array.isArray(v) ? v[0] : v
    if (s === undefined || s === null || s === '') { if (open.value) { session++; open.value = false; setErrors({}) } return }
    if (s === 'new') { if (!open.value || mode.value !== 'new') openNew(); return }
    if (/^\d+$/.test(s) && (!open.value || String(id.value) !== s)) openEdit(Number(s))
  }, { immediate: true })

  /* 抽屉被关掉（Esc / 遮罩 / ×，脏检查已在 ADrawer 里做过）→ 会话作废、去掉地址栏参数 */
  watch(open, v => {
    if (v) return
    session++
    if (route.query[param] !== undefined && route.path === path) setParam(null)
  })

  /* 抽屉里某个字段所在的 FormField（data-field） */
  const fieldBox = field => document.querySelector(`[role="dialog"] [data-field="${CSS.escape(field)}"]`)
  function focusField(field) {
    nextTick(() => {
      const box = fieldBox(field)
      const el = box?.querySelector('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])')
      el?.focus({ preventScroll: true })
      box?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }
  /** 多个出错字段里，在表单上排最前面的那个（找不到对应 FormField 的排最后） */
  function firstField(fields) {
    const order = [...document.querySelectorAll('[role="dialog"] [data-field]')].map(el => el.dataset.field)
    const pos = f => { const i = order.indexOf(f); return i < 0 ? Infinity : i }
    return [...fields].sort((a, b) => pos(a) - pos(b))[0]
  }

  /** 字段错误：显示在对应 FormField 下面；focus=false 时只显示、不抢焦点 */
  function showFieldError(field, message, { focus = true } = {}) {
    setErrors({ ...errors.value, [field]: message })
    if (focus) focusField(field)
  }

  /** 编辑时只发改动过的字段 */
  function diff(body, before) {
    const out = {}
    for (const k of Object.keys(body)) if (!same(body[k], before[k])) out[k] = body[k]
    return out
  }

  async function submit() {
    if (saving.value || loadingRow.value || !open.value) return
    setErrors({})
    if (validate) {
      const bad = validate(form.value)
      if (bad && Object.keys(bad).length) {
        // 错误一次全部显示；焦点和提示只给表单里最靠前的那个（各自聚焦的话最后一个会抢走焦点）
        setErrors({ ...bad })
        const f = firstField(Object.keys(bad))
        focusField(f)
        toast(bad[f], { type: 'error' })
        return
      }
    }
    const my = session
    saving.value = true
    try {
      let saved
      if (isNew.value) {
        const body = toBody(clone(form.value))
        for (const k of Object.keys(body)) if (body[k] === null || body[k] === '') delete body[k]
        saved = await create(body)
      } else {
        const patch = diff(toBody(clone(form.value)), toBody(JSON.parse(original.value)))
        saved = Object.keys(patch).length ? await update(id.value, patch) : row.value
      }
      const wasNew = isNew.value
      toast(savedText, { type: 'ok' })
      // 期间抽屉被关掉或换了一条：数据已经存上了，只刷新列表，不碰现在打开的表单
      if (my !== session) { if (alive) await onSaved?.(saved, wasNew); return saved }
      original.value = JSON.stringify(form.value)
      if (closeOnSave) close()
      else if (saved && typeof saved === 'object') { mode.value = 'edit'; id.value = saved.id; fill(saved); setParam(saved.id) }
      await onSaved?.(saved, wasNew)
      return saved
    } catch (e) {
      if (my === session && e?.field) { showFieldError(e.field, e.message); toast(e.message, { type: 'error' }) }
      else toastError(e, '保存失败')
    } finally {
      saving.value = false
    }
  }

  // 返回 reactive：模板里直接写 editor.open / editor.form.word / editor.errors.word，不用 .value
  return reactive({ open, mode, isNew, id, row, form, errors, saving, loadingRow, dirty, openNew, openEdit, close, submit, showFieldError })
}
