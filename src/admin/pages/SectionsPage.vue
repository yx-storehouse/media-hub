<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router'
import { listSections, createSection, updateSection, deleteSection, reorderSections } from '../api'
import { useMeta } from '../composables/useMeta'
import { useReorder } from '../composables/useReorder'
import { useLeaveGuard } from '../composables/useLeaveGuard'
import { confirmDialog } from '../components/confirm'
import { toast, toastError } from '../components/toast'
import { layerDepth } from '../components/layers'
import PageHeader from '../components/PageHeader.vue'
import ABtn from '../components/ABtn.vue'
import EmptyState from '../components/EmptyState.vue'
import StatusBadge from '../components/StatusBadge.vue'
import FormField from '../components/FormField.vue'
import TextInput from '../components/TextInput.vue'
import NumberInput from '../components/NumberInput.vue'
import SelectInput from '../components/SelectInput.vue'
import SwitchInput from '../components/SwitchInput.vue'
import SectionList from './sections/SectionList.vue'
import SectionItems from './sections/SectionItems.vue'
import { fmtDate } from '../utils/format'

defineOptions({ name: 'SectionsPage' })

/*
 * 首页推荐分区：左栏分区列表（可调整顺序），右栏选中分区的设置 + 内容（批次 / 视频）。
 * 选中的分区记在地址栏 ?id=3（?id=new = 新建），刷新后还在。
 * 设置、内容、顺序三处各自保存；有没保存的修改时，切换分区 / 离开页面 / 关标签页都会先确认（useLeaveGuard）。
 */

const route = useRoute()
const router = useRouter()
const { topicOptions } = useMeta()

/* ---------------- 分区列表 ---------------- */

const sections = ref([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')

async function loadList() {
  loading.value = true
  error.value = ''
  try {
    const res = await listSections()
    sections.value = res?.list || []
    loaded.value = true
  } catch (e) {
    error.value = e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

/* 首次加载就失败了（还没有任何数据）：不能新建，右栏显示错误和「重试」 */
const listFailed = computed(() => !!error.value && !loaded.value)

/* 左栏顺序：本地调整，点「保存排序」才提交；分区增删后未保存的顺序自动作废 */
const order = useReorder(() => sections.value, { onReset: had => { if (had) toast('分区有变化，未保存的排序已还原') } })
const savingOrder = ref(false)
const byId = computed(() => new Map(sections.value.map(s => [s.id, s])))
async function saveOrder() {
  if (!order.dirty || savingOrder.value) return
  savingOrder.value = true
  try {
    await reorderSections(order.keys())
    await loadList()
    order.reset()
    toast('排序已保存', { type: 'ok' })
  } catch (e) {
    toastError(e, '保存排序失败')
  } finally {
    savingOrder.value = false
  }
}

/* ---------------- 选中的分区 ---------------- */

/** 数字 id | 'new' | null */
const selectedId = ref(null)
const isNew = computed(() => selectedId.value === 'new')
const current = computed(() => (typeof selectedId.value === 'number' ? byId.value.get(selectedId.value) || null : null))
const parseId = v => {
  const s = Array.isArray(v) ? v[0] : v
  if (s === 'new') return 'new'
  return /^\d+$/.test(String(s ?? '')) ? Number(s) : null
}

/* 设置表单 */
const blankForm = () => ({ title: '', subtitle: '', topicId: null, isFeatured: false, cardSize: 4, status: 1 })
const toForm = s => ({ title: s.title || '', subtitle: s.subtitle || '', topicId: s.topicId ?? null, isFeatured: !!s.isFeatured, cardSize: s.cardSize ?? 4, status: s.status ?? 1 })
const form = ref(blankForm())
const formOriginal = ref(JSON.stringify(form.value))
const errors = ref({})
const savingSettings = ref(false)
const deleting = ref(false)
const settingsEl = ref(null)
const settingsDirty = computed(() => (isNew.value || !!current.value) && JSON.stringify(form.value) !== formOriginal.value)

/* 内容编辑器（子组件）报告的脏状态 */
const itemsRef = ref(null)
const itemsDirty = ref(false)
const onItemsDirty = v => { itemsDirty.value = v }

function resetForm(s) {
  form.value = s ? toForm(s) : blankForm()
  formOriginal.value = JSON.stringify(form.value)
  errors.value = {}
}

/** 切到某个分区（不做确认；调用方负责） */
function applySelection(id) {
  selectedId.value = id
  resetForm(typeof id === 'number' ? byId.value.get(id) || null : null)
  itemsDirty.value = false
  const q = { ...route.query }
  if (id == null) delete q.id
  else q.id = String(id)
  if (String(route.query.id ?? '') !== String(q.id ?? '')) router.replace({ query: q }).catch(() => {})
}

async function confirmDiscard(message) {
  if (!settingsDirty.value && !itemsDirty.value) return true
  return confirmDialog({ title: '放弃修改？', message, confirmText: '放弃修改', danger: true })
}

async function select(id) {
  if (id === selectedId.value) return
  if (!(await confirmDiscard('当前分区有未保存的修改（设置或视频），切换后会丢失。确定切换？'))) return
  applySelection(id)
}
function cancelNew() {
  select(sections.value[0]?.id ?? null)
}

/** 首次进入 / 重试：按地址栏选中，没有就选第一个 */
async function init() {
  await loadList()
  if (!loaded.value) return
  const want = parseId(route.query.id)
  if (want === 'new') return applySelection('new')
  if (want != null && byId.value.has(want)) return applySelection(want)
  if (want != null) toast('找不到这个分区（可能已被删除）')
  applySelection(sections.value[0]?.id ?? null)
}
onMounted(init)
function retry() { loaded.value ? loadList() : init() }

/* 地址栏被改（手动改 ?id=、前进后退）：跟着切换；有未保存的修改先确认 */
const willSwitch = id => id !== selectedId.value && (id === 'new' || (id != null && byId.value.has(id)))
onBeforeRouteUpdate(async to => {
  if (!loaded.value || !willSwitch(parseId(to.query.id))) return true
  return confirmDiscard('当前分区有未保存的修改（设置或视频），切换后会丢失。确定切换？')
})
watch(() => route.query.id, v => {
  if (!loaded.value || route.name !== 'sections') return
  const id = parseId(v)
  if (id === selectedId.value) return
  if (willSwitch(id)) return applySelection(id)
  // 地址栏里没有 id（比如点了侧边栏的「首页推荐」）或 id 已失效：保持当前选中，把参数补回去
  if (selectedId.value != null) router.replace({ query: { ...route.query, id: String(selectedId.value) } }).catch(() => {})
})

/* ---------------- 保存设置 / 新建 / 删除 ---------------- */

function showFieldError(field, message) {
  errors.value = { ...errors.value, [field]: message }
  nextTick(() => {
    const box = settingsEl.value?.querySelector(`[data-field="${CSS.escape(field)}"]`)
    box?.querySelector('input:not([type="hidden"]), textarea, button, [tabindex]')?.focus()
    box?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}

function validate(f) {
  const title = f.title.trim()
  if (!title) return { title: '请输入标题' }
  if ([...title].length > 30) return { title: '标题最多 30 个字' }
  if ([...f.subtitle.trim()].length > 60) return { subtitle: '副标题最多 60 个字' }
  if (!(f.cardSize >= 1 && f.cardSize <= 20)) return { cardSize: '首屏数量需在 1-20 之间' }
  return null
}

async function saveSettings() {
  if (savingSettings.value || (!isNew.value && !current.value)) return
  errors.value = {}
  const f = form.value
  const bad = validate(f)
  if (bad) {
    const [k] = Object.keys(bad)
    showFieldError(k, bad[k])
    toast(bad[k], { type: 'error' })
    return
  }
  const body = { title: f.title.trim(), subtitle: f.subtitle.trim(), topicId: f.topicId ?? null, isFeatured: !!f.isFeatured, cardSize: f.cardSize, status: f.status }
  savingSettings.value = true
  try {
    if (isNew.value) {
      if (body.topicId == null) delete body.topicId
      const s = await createSection(body)
      formOriginal.value = JSON.stringify(form.value) // 已保存，切过去不用再确认
      await loadList()
      applySelection(s.id)
      toast('分区已创建，现在可以添加视频了', { type: 'ok' })
    } else {
      const id = current.value.id
      const before = JSON.parse(formOriginal.value)
      const was = { ...before, title: before.title.trim(), subtitle: before.subtitle.trim() }
      const patch = {}
      for (const k of Object.keys(body)) if (JSON.stringify(body[k]) !== JSON.stringify(was[k] ?? null)) patch[k] = body[k]
      if (Object.keys(patch).length) await updateSection(id, patch)
      await loadList()
      if (selectedId.value === id) resetForm(byId.value.get(id) || null)
      toast(patch.isFeatured ? '设置已保存（其他分区的大卡已关闭）' : '设置已保存', { type: 'ok' })
    }
  } catch (e) {
    if (e?.field) { showFieldError(e.field, e.message); toast(e.message, { type: 'error' }) }
    else toastError(e, '保存失败')
  } finally {
    savingSettings.value = false
  }
}

async function removeSection() {
  const s = current.value
  if (!s || deleting.value) return
  const ok = await confirmDialog({
    title: '删除分区',
    message: `确定删除分区「${s.title}」？\n分区里的 ${s.itemCount} 个视频条目会一起移除（视频本身不删）。\n删除后不可恢复。`,
    confirmText: '删除',
    danger: true
  })
  if (!ok) return
  deleting.value = true
  try {
    const idx = order.list.findIndex(x => x.id === s.id)
    await deleteSection(s.id)
    itemsDirty.value = false
    resetForm(null)
    await loadList()
    const next = sections.value[Math.min(Math.max(idx, 0), sections.value.length - 1)]
    applySelection(next?.id ?? null)
    toast('分区已删除', { type: 'ok' })
  } catch (e) {
    toastError(e, '删除失败')
  } finally {
    deleting.value = false
  }
}

/* ---------------- 离开 / 快捷键 ---------------- */

const anyDirty = computed(() => settingsDirty.value || itemsDirty.value || order.dirty)
useLeaveGuard(anyDirty, { message: '首页推荐有未保存的修改，确定离开这个页面？' })

/* Ctrl/⌘+S：保存右栏里改过的部分（有弹层时不抢） */
function onKey(e) {
  if (!(e.ctrlKey || e.metaKey) || (e.key !== 's' && e.key !== 'S') || layerDepth()) return
  e.preventDefault()
  if (isNew.value || settingsDirty.value) saveSettings()
  if (itemsDirty.value) itemsRef.value?.save()
}
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))

const appLink = './index.html#/home/recommend'
</script>

<template>
  <div class="sec-page">
    <PageHeader title="首页推荐" :subtitle="loaded ? `共 ${sections.length} 个分区` : ''">
      <template #actions>
        <ABtn icon="external" :href="appLink" target="_blank" rel="noopener">在前台查看</ABtn>
        <ABtn variant="primary" icon="plus" :disabled="isNew || listFailed" @click="select('new')">新建分区</ABtn>
      </template>
    </PageHeader>

    <div class="sec-body">
      <SectionList
        class="pane-l"
        :sections="order.list"
        :selected-id="selectedId"
        :loading="loading"
        :error="error"
        :order-dirty="order.dirty"
        :saving-order="savingOrder"
        :creating="isNew"
        :new-title="isNew ? form.title : ''"
        @select="select"
        @move="order.move"
        @save-order="saveOrder"
        @reset-order="order.reset()"
      />

      <div class="pane-r">
        <template v-if="isNew || current">
          <section ref="settingsEl" class="card settings" :aria-label="isNew ? '新建分区' : '分区设置'">
            <header class="card-hd">
              <span>{{ isNew ? '新建分区' : '分区设置' }}</span>
              <span v-if="settingsDirty && !isNew" class="dirty">未保存</span>
              <StatusBadge v-if="current" kind="creator" :status="current.status" :label="current.status === 1 ? '启用' : '停用'" />
              <span class="grow" />
              <span v-if="current" class="dim small">ID {{ current.id }} · 更新于 {{ fmtDate(current.updatedAt) }}</span>
            </header>
            <div class="card-bd">
              <div class="form-grid">
                <FormField label="标题" field="title" required :error="errors.title">
                  <TextInput v-model="form.title" :maxlength="30" show-count placeholder="例如：治愈日常" />
                </FormField>
                <FormField label="副标题" field="subtitle" :error="errors.subtitle">
                  <TextInput v-model="form.subtitle" :maxlength="60" show-count placeholder="可选" />
                </FormField>
                <FormField label="关联专题" field="topicId" :error="errors.topicId" hint="「自动生成」可以从这个专题取视频；前台这个分区的「全部 / 看更多」打开这个专题（专题未发布时不显示）">
                  <SelectInput v-model="form.topicId" :options="topicOptions" searchable clearable placeholder="不关联" />
                </FormField>
                <FormField label="首屏数量" field="cardSize" required :error="errors.cardSize" hint="前台这个分区一次显示几个视频（1-20）">
                  <NumberInput v-model="form.cardSize" :min="1" :max="20" suffix="个" />
                </FormField>
                <FormField inline label="大卡" field="isFeatured" :error="errors.isFeatured" hint="第一个视频显示为大图；首页只能有一个大卡分区">
                  <SwitchInput v-model="form.isFeatured" />
                </FormField>
                <FormField inline label="启用" field="status" :error="errors.status" hint="停用后前台不显示这个分区">
                  <SwitchInput :model-value="form.status === 1" @update:model-value="v => (form.status = v ? 1 : 0)" />
                </FormField>
              </div>
              <div class="settings-ft">
                <ABtn v-if="current" variant="danger" icon="trash" :loading="deleting" :disabled="savingSettings" @click="removeSection">删除分区</ABtn>
                <span class="grow" />
                <ABtn v-if="isNew" :disabled="savingSettings" @click="cancelNew">取消</ABtn>
                <ABtn v-else-if="settingsDirty" :disabled="savingSettings" @click="resetForm(current)">撤销</ABtn>
                <ABtn variant="primary" :loading="savingSettings" :disabled="!isNew && !settingsDirty" @click="saveSettings">
                  {{ isNew ? '创建' : '保存' }}
                </ABtn>
              </div>
            </div>
          </section>

          <SectionItems
            v-if="current"
            :key="current.id"
            ref="itemsRef"
            :section="current"
            :card-size="form.cardSize || current.cardSize"
            :featured="form.isFeatured"
            :pending-topic="(form.topicId ?? null) !== (current.topicId ?? null)"
            @update:dirty="onItemsDirty"
            @saved="loadList"
          />
          <div v-else class="card new-hint">
            <p class="muted">创建分区后，就可以手动添加视频，或者按专题 / 最热 / 最新自动生成。</p>
          </div>
        </template>

        <div v-else-if="listFailed" class="card">
          <EmptyState variant="error" title="分区列表加载失败" :text="error" :retrying="loading" @retry="retry" />
        </div>
        <div v-else-if="loaded" class="card">
          <EmptyState icon="home" title="还没有首页分区" text="分区就是前台「推荐」页上的一个个板块，每个板块可以有多批视频供「换一批」">
            <ABtn variant="primary" icon="plus" @click="select('new')">新建分区</ABtn>
          </EmptyState>
        </div>
        <div v-else-if="loading" class="state"><span class="spinner lg" /></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sec-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.sec-body { display: grid; flex: 1; grid-template-columns: 300px minmax(0, 1fr); gap: 16px; min-height: 0; padding: 0 24px 24px; }
.pane-l { min-height: 0; }
.pane-r { display: flex; flex-direction: column; gap: 16px; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }

.settings { flex: none; }
.settings .card-hd { gap: 10px; }
.dirty { height: 18px; padding: 0 6px; border-radius: 9px; background: rgba(227, 179, 65, .12); color: var(--warn); font-size: 11px; font-weight: 400; line-height: 18px; }
.settings-ft { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); }
.new-hint { padding: 28px 20px; text-align: center; }

/* 窄屏：上下排列，整页滚动 */
@media (max-width: 1000px) {
  .sec-page { height: auto; }
  .sec-body { grid-template-columns: minmax(0, 1fr); }
  .pane-l { max-height: 340px; }
  .pane-r { overflow: visible; }
}
</style>
