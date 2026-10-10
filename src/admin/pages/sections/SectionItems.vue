<script setup>
import { ref, computed, watch, onBeforeUnmount, useId } from 'vue'
import { getSectionItems, saveSectionItems } from '../../api'
import { confirmDialog } from '../../components/confirm'
import { toast, toastError } from '../../components/toast'
import ABtn from '../../components/ABtn.vue'
import AIcon from '../../components/AIcon.vue'
import EmptyState from '../../components/EmptyState.vue'
import Thumb from '../../components/Thumb.vue'
import StatusBadge from '../../components/StatusBadge.vue'
import VideoPicker from '../../components/VideoPicker.vue'
import RebuildModal from './RebuildModal.vue'
import { useDragSort } from '../../composables/useReorder'
import { rovingKeydown, rovingTabindex } from '../../utils/roving'
import { fmtDuration } from '../../utils/format'

/*
 * 首页推荐 · 分区内容编辑：
 *   批次标签页（第 1 批、第 2 批…，可新增 / 删除；← → / Home / End 切换）→ 每批一个视频网格（拖动或 ← → 调顺序，× 移除，拖到别的批次标签上 = 移过去）
 *   「添加视频」用 VideoPicker 多选；「自动生成…」见 RebuildModal（服务端直接保存）。
 * 改动只在本地，点「保存」整体提交（PUT items）；父组件靠 update:dirty 做离开 / 切换分区前的确认。
 * 前台规则：每批只取排在最前面的「首屏数量」个已发布视频，其余是候补；这里用序号样式标出来。
 *   一个已发布视频都没有的批次，前台「换一批」会直接跳过。
 */
const props = defineProps({
  /** 已保存的分区（AdminSection） */
  section: { type: Object, required: true },
  /** 首屏数量（设置表单里的当前值，没保存也实时反映） */
  cardSize: { type: Number, default: 4 },
  /** 大卡分区：前台第一个视频显示为大图 */
  featured: { type: Boolean, default: false },
  /** 设置里改了关联专题但还没保存 */
  pendingTopic: { type: Boolean, default: false }
})
const emit = defineEmits(['update:dirty', 'saved'])

const MAX_BATCHES = 20
const MAX_PER_BATCH = 60

const batches = ref([]) // VideoBrief[][]
let snapshot = '[]' // 上次加载 / 保存的内容（撤销用）
const original = ref('[]') // 同上，只有 id（脏检查用）
const active = ref(0)
const loading = ref(false)
const error = ref('')
const saving = ref(false)
const pickerOpen = ref(false)
const rebuildOpen = ref(false)

const idsOf = list => list.map(b => b.map(v => v.id))
const dirty = computed(() => JSON.stringify(idsOf(batches.value)) !== original.value)
watch(dirty, v => emit('update:dirty', v), { immediate: true })
onBeforeUnmount(() => emit('update:dirty', false))

function setBatches(list) {
  batches.value = (list || []).map(b => [...b])
  snapshot = JSON.stringify(batches.value)
  original.value = JSON.stringify(idsOf(batches.value))
  if (active.value >= batches.value.length) active.value = Math.max(0, batches.value.length - 1)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await getSectionItems(props.section.id)
    setBatches(res?.batches || [])
  } catch (e) {
    error.value = e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}
load()

const current = computed(() => batches.value[active.value] || [])
const totalItems = computed(() => batches.value.reduce((n, b) => n + b.length, 0))
const size = computed(() => Math.max(1, props.cardSize || props.section.cardSize || 4))

/** 当前批里前台会显示的视频：按顺序取前 size 个已发布的 */
const shown = computed(() => {
  const set = new Set()
  for (const v of current.value) {
    if (set.size >= size.value) break
    if (v.status === 1) set.add(v.id)
  }
  return set
})
const firstShown = computed(() => current.value.find(v => shown.value.has(v.id))?.id ?? null)
const shownCount = b => {
  let n = 0
  for (const v of b) if (v.status === 1 && ++n >= size.value) break
  return n
}

/* ---------------- 批次 ---------------- */

function addBatch() {
  if (batches.value.length >= MAX_BATCHES) return
  batches.value.push([])
  active.value = batches.value.length - 1
}
async function removeBatch(i) {
  const n = batches.value[i]?.length || 0
  const ok = await confirmDialog({
    title: `删除第 ${i + 1} 批`,
    message: n
      ? `第 ${i + 1} 批的 ${n} 个视频会从这个分区移除（视频本身不删），后面的批次依次前移。\n点「保存」后生效。`
      : `删除空的第 ${i + 1} 批？`,
    confirmText: '删除',
    danger: true
  })
  if (!ok) return
  batches.value.splice(i, 1)
  if (active.value > i) active.value--
  if (active.value >= batches.value.length) active.value = Math.max(0, batches.value.length - 1)
}

/* ---------------- 视频 ---------------- */

function moveItem(from, to) {
  const b = current.value
  if (from === to || from < 0 || to < 0 || from >= b.length || to >= b.length) return
  const [v] = b.splice(from, 1)
  b.splice(to, 0, v)
}
function removeItem(i) { current.value.splice(i, 1) }

function addVideos(list) {
  if (!batches.value.length) { batches.value.push([]); active.value = 0 }
  const b = batches.value[active.value]
  const have = new Set(b.map(v => v.id))
  const fresh = list.filter(v => !have.has(v.id))
  const room = Math.max(0, MAX_PER_BATCH - b.length)
  b.push(...fresh.slice(0, room))
  if (fresh.length > room) toast(`每批最多 ${MAX_PER_BATCH} 个视频，有 ${fresh.length - room} 个没有加进来`)
  else if (fresh.length) toast(`已添加 ${fresh.length} 个视频到第 ${active.value + 1} 批，记得保存`)
}

/** 拖到别的批次标签上：移到那一批的末尾 */
function moveToBatch(from, target) {
  if (target === active.value) return
  const src = batches.value[active.value]
  const dst = batches.value[target]
  const v = src?.[from]
  if (!v || !dst) return
  if (dst.some(x => x.id === v.id)) return toast(`第 ${target + 1} 批里已经有这个视频了`)
  if (dst.length >= MAX_PER_BATCH) return toast(`第 ${target + 1} 批已满（最多 ${MAX_PER_BATCH} 个）`)
  src.splice(from, 1)
  dst.push(v)
  toast(`已移到第 ${target + 1} 批`)
}

/* 拖动：卡片之间按鼠标在左半 / 右半决定插到前面还是后面；拖到别的批次标签上 = 移到那一批末尾 */
const drag = useDragSort({ axis: 'x', onMove: moveItem })
const tabOver = ref(-1)
function onTabDragOver(t, e) {
  if (drag.dragIndex < 0 || t === active.value) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  tabOver.value = t
}
function onTabDrop(t, e) {
  if (drag.dragIndex < 0 || t === active.value) return
  e.preventDefault()
  moveToBatch(drag.dragIndex, t)
  endDrag()
}
function endDrag() { drag.end(); tabOver.value = -1 }

/* 批次标签页：只有当前批可 Tab 进入，← → / Home / End 切换（utils/roving.js） */
const uid = 'sb-' + useId()
const tabId = i => `${uid}-tab-${i}`
const panelId = `${uid}-panel`
const onTabsKey = e => rovingKeydown(e, { orientation: 'horizontal' })

/* ---------------- 保存 / 撤销 / 自动生成 ---------------- */

async function save() {
  if (saving.value || !dirty.value) return false
  saving.value = true
  try {
    const empty = batches.value.filter(b => !b.length).length
    const res = await saveSectionItems(props.section.id, idsOf(batches.value))
    setBatches(res?.batches || [])
    toast(empty ? `分区内容已保存（去掉了 ${empty} 个空批次）` : '分区内容已保存', { type: 'ok' })
    emit('saved')
    return true
  } catch (e) {
    toastError(e, '保存失败')
    return false
  } finally {
    saving.value = false
  }
}
async function revert() {
  const ok = await confirmDialog({ title: '撤销修改？', message: '放弃对分区视频的所有修改，恢复到上次保存的内容？', confirmText: '撤销修改', danger: true })
  if (ok) setBatches(JSON.parse(snapshot))
}
function onRebuilt(res) {
  active.value = 0
  setBatches(res?.batches || [])
  emit('saved')
}

defineExpose({ save })
</script>

<template>
  <section class="card items" aria-label="分区内容">
    <header class="items-hd">
      <div class="row hd-top">
        <span class="hd-t">分区内容</span>
        <span v-if="dirty" class="dirty">未保存</span>
        <span class="dim small num">{{ batches.length }} 批 · {{ totalItems }} 个视频</span>
        <span class="grow" />
        <ABtn size="sm" icon="plus" :disabled="loading || !!error || (!!batches.length && current.length >= MAX_PER_BATCH)" @click="pickerOpen = true">添加视频</ABtn>
        <ABtn size="sm" icon="sparkle" :disabled="loading || !!error" @click="rebuildOpen = true">自动生成…</ABtn>
        <ABtn v-if="dirty" size="sm" variant="ghost" :disabled="saving" @click="revert">撤销修改</ABtn>
        <ABtn size="sm" variant="primary" :loading="saving" :disabled="!dirty" @click="save">保存</ABtn>
      </div>

      <div v-if="batches.length" class="tabs" role="tablist" aria-label="批次" @keydown="onTabsKey">
        <div
          v-for="(b, i) in batches"
          :key="i"
          class="tab"
          :class="{ on: i === active, over: tabOver === i }"
          role="presentation"
          @dragover="onTabDragOver(i, $event)"
          @dragleave="tabOver = -1"
          @drop="onTabDrop(i, $event)"
        >
          <button
            :id="tabId(i)"
            type="button"
            role="tab"
            class="tab-btn"
            :aria-selected="i === active ? 'true' : 'false'"
            :aria-controls="panelId"
            :tabindex="rovingTabindex(i, active)"
            @click="active = i"
          >
            第 {{ i + 1 }} 批 <span class="cnt num" :class="{ warn: b.length && !shownCount(b) }" :title="b.length && !shownCount(b) ? '没有已发布的视频，前台会跳过这一批' : null">{{ b.length }}</span>
          </button>
          <button type="button" class="tab-x" :tabindex="i === active ? 0 : -1" :aria-label="`删除第 ${i + 1} 批`" title="删除这一批" @click="removeBatch(i)">
            <AIcon name="x" :size="12" />
          </button>
        </div>
        <button type="button" class="tab-add" :disabled="batches.length >= MAX_BATCHES" :title="batches.length >= MAX_BATCHES ? `最多 ${MAX_BATCHES} 批` : ''" @click="addBatch">
          <AIcon name="plus" :size="13" />新增一批
        </button>
      </div>
    </header>

    <div :id="panelId" class="items-bd" :role="batches.length ? 'tabpanel' : undefined" :aria-labelledby="batches.length ? tabId(active) : undefined">
      <p class="hint">
        <AIcon name="info" :size="14" />
        <span>
          前台「推荐」页每个分区一次显示<b>首屏数量</b>（当前 {{ size }} 个）的视频，点「换一批」按批次轮换。
          每批只显示排在最前面的 {{ size }} 个<b>已发布</b>视频（白色序号），其余是候补；草稿和已下架的视频在前台不会显示。
        </span>
      </p>

      <div v-if="loading" class="state"><span class="spinner lg" /></div>
      <EmptyState v-else-if="error" class="pane-state" variant="error" compact :text="error" @retry="load" />
      <EmptyState v-else-if="!batches.length" class="pane-state" compact icon="layers" title="这个分区还没有视频" text="可以手动添加，也可以按专题 / 最热 / 最新自动生成">
        <ABtn variant="primary" icon="plus" @click="pickerOpen = true">添加视频</ABtn>
        <ABtn icon="sparkle" @click="rebuildOpen = true">自动生成…</ABtn>
      </EmptyState>
      <EmptyState v-else-if="!current.length" class="pane-state" compact icon="layers" :title="`第 ${active + 1} 批还没有视频`" text="空批次保存时会去掉">
        <ABtn icon="plus" @click="pickerOpen = true">添加视频</ABtn>
      </EmptyState>
      <template v-else>
        <p class="sub dim small">
          第 {{ active + 1 }} 批 · {{ current.length }} 个，前台显示 {{ shownCount(current) }} 个
          <span v-if="current.length > 1"> · 拖动卡片调整顺序，拖到上方的批次标签可以移过去</span>
        </p>
        <p v-if="!shownCount(current)" class="skip warn-text small" role="status">
          <AIcon name="warning" :size="13" />这一批没有已发布的视频，前台「换一批」会跳过这一批
        </p>
        <ol class="grid" @dragleave="drag.leave">
          <li
            v-for="(v, i) in current"
            :key="v.id"
            class="vc"
            :class="[{ off: !shown.has(v.id) }, drag.itemClass(i)]"
            draggable="true"
            @dragstart="drag.start(i, $event)"
            @dragover="drag.over($event, i)"
            @drop="drag.drop"
            @dragend="endDrag"
          >
            <div class="vc-media">
              <Thumb :src="v.coverUrl || ''" width="100%" :ratio="16 / 10" icon="video" />
              <span class="vc-no num" :class="{ on: shown.has(v.id) }" :title="shown.has(v.id) ? '前台显示' : '候补，前台不显示'">{{ i + 1 }}</span>
              <span v-if="featured && v.id === firstShown" class="vc-big chip solid">大图</span>
              <span v-if="v.durationSec" class="vc-dur num">{{ fmtDuration(v.durationSec) }}</span>
              <button type="button" class="vc-x" :aria-label="`移除「${v.title}」`" title="移除" @click="removeItem(i)">
                <AIcon name="x" :size="14" />
              </button>
            </div>
            <p class="vc-t clamp-2" :title="v.title">{{ v.title }}</p>
            <div class="vc-ft">
              <StatusBadge v-if="v.status !== 1" :status="v.status" />
              <span v-else-if="!shown.has(v.id)" class="dim small">候补</span>
              <span v-else class="dim small mono ellipsis">{{ v.publicId }}</span>
              <span class="grow" />
              <ABtn size="sm" variant="ghost" icon="chevron-left" title="前移" :aria-label="`「${v.title}」前移`" :disabled="i === 0" @click="moveItem(i, i - 1)" />
              <ABtn size="sm" variant="ghost" icon="chevron-right" title="后移" :aria-label="`「${v.title}」后移`" :disabled="i === current.length - 1" @click="moveItem(i, i + 1)" />
            </div>
          </li>
        </ol>
      </template>
    </div>

    <VideoPicker
      v-model:open="pickerOpen"
      multiple
      :exclude-ids="current.map(v => v.id)"
      :title="`添加视频到第 ${batches.length ? active + 1 : 1} 批`"
      @select="addVideos"
    />
    <RebuildModal
      v-model:open="rebuildOpen"
      :section="section"
      :card-size="size"
      :item-count="totalItems"
      :items-dirty="dirty"
      :pending-topic="pendingTopic"
      @done="onRebuilt"
    />
  </section>
</template>

<style scoped>
.items { min-width: 0; }
/* 标题栏 + 批次标签吸在右栏顶部，网格很长时也随手可点 */
.items-hd { position: sticky; top: 0; z-index: 3; border-bottom: 1px solid var(--line); border-radius: var(--radius) var(--radius) 0 0; background: var(--panel); }
.hd-top { flex-wrap: wrap; min-height: 46px; padding: 7px 12px 7px 16px; }
.hd-t { font-weight: 600; }
.dirty { height: 18px; padding: 0 6px; border-radius: 9px; background: rgba(227, 179, 65, .12); color: var(--warn); font-size: 11px; line-height: 18px; }

.tabs { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 4px; padding: 0 12px; }
.tab { display: flex; align-items: center; margin-bottom: -1px; border: 1px solid transparent; border-bottom: 0; border-radius: 7px 7px 0 0; color: var(--t2); }
.tab:hover { background: var(--hover); color: var(--t1); }
.tab.on { border-color: var(--line); background: var(--bg); color: var(--t1); box-shadow: inset 0 2px 0 var(--accent); }
.tab.over { background: #262626; color: var(--t1); box-shadow: inset 0 0 0 1px var(--accent); }
.tab-btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 4px 0 12px; color: inherit; font-weight: 500; white-space: nowrap; }
.cnt { min-width: 20px; height: 17px; padding: 0 5px; border-radius: 9px; background: #262626; color: var(--t2); font-size: 11px; line-height: 17px; text-align: center; }
.cnt.warn { background: rgba(227, 179, 65, .14); color: var(--warn); }
.tab-x { display: grid; place-items: center; width: 22px; height: 22px; margin-right: 4px; border-radius: 5px; color: var(--t3); }
.tab-x:hover { background: rgba(255, 107, 107, .14); color: var(--danger); }
.tab-add { display: inline-flex; align-items: center; gap: 4px; height: 30px; margin-bottom: 2px; padding: 0 10px; border: 1px dashed var(--line-2); border-radius: 6px; color: var(--t2); white-space: nowrap; }
.tab-add:hover:not(:disabled) { border-color: #555; color: var(--t1); }
.tab-add:disabled { opacity: .45; }

.items-bd { padding: 14px 16px 18px; background: var(--bg); border-radius: 0 0 var(--radius) var(--radius); }
.hint { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 12px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--t2); font-size: 12.5px; line-height: 1.6; }
.hint > svg { margin-top: 3px; color: var(--t3); }
.hint b { color: var(--t1); font-weight: 600; }
.sub { margin-bottom: 10px; }
.skip { display: flex; align-items: center; gap: 6px; margin: -4px 0 10px; }
.pane-state { border: 1px dashed var(--line); border-radius: 8px; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.vc { position: relative; display: flex; flex-direction: column; min-width: 0; padding: 6px 6px 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); cursor: grab; transition: opacity .12s, border-color .12s; }
.vc:hover { border-color: var(--line-2); }
.vc:active { cursor: grabbing; }
.vc.off { opacity: .55; }
.vc.off:hover { opacity: .85; }
.vc.dragging { opacity: .3; }
.vc.drop-before::before, .vc.drop-after::after { content: ''; position: absolute; top: 4px; bottom: 4px; width: 3px; border-radius: 2px; background: var(--accent); }
.vc.drop-before::before { left: -8px; }
.vc.drop-after::after { right: -8px; }

.vc-media { position: relative; }
.vc-no { position: absolute; top: 5px; left: 5px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: rgba(0, 0, 0, .6); color: var(--t2); font-size: 11.5px; line-height: 20px; text-align: center; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .25); }
.vc-no.on { background: var(--accent); color: var(--on-accent); font-weight: 700; box-shadow: none; }
.vc-big { position: absolute; top: 5px; left: 32px; height: 20px; }
.vc-dur { position: absolute; right: 5px; bottom: 5px; padding: 0 4px; border-radius: 3px; background: rgba(0, 0, 0, .65); color: #ddd; font-size: 11px; line-height: 16px; }
.vc-x { position: absolute; top: 4px; right: 4px; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; background: rgba(0, 0, 0, .6); color: #ddd; opacity: 0; transition: opacity .12s; }
.vc:hover .vc-x, .vc-x:focus-visible { opacity: 1; }
.vc-x:hover { background: var(--danger); color: #fff; }
.vc-t { min-height: 36px; margin: 6px 2px 2px; color: var(--t1); font-size: 12.5px; line-height: 18px; }
.vc-ft { display: flex; align-items: center; gap: 2px; min-width: 0; height: 28px; padding-left: 2px; }
@media (hover: none) {
  .vc-x { opacity: 1; }
}
</style>
