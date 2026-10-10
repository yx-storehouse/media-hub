<script setup>
import { ref, computed, watch, useId } from 'vue'
import { rebuildSection } from '../../api'
import { confirmDialog } from '../../components/confirm'
import { toast, toastError } from '../../components/toast'
import AModal from '../../components/AModal.vue'
import ABtn from '../../components/ABtn.vue'
import FormField from '../../components/FormField.vue'
import NumberInput from '../../components/NumberInput.vue'

/*
 * 「自动生成…」：按来源取已发布的视频，按「换一批」的规则分成若干批，整体替换分区内容（服务端直接保存）。
 *   第 n 批取候选池里第 n*每批数量 起的视频，候选不够时从头循环。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  /** 已保存的分区（关联专题以保存的为准） */
  section: { type: Object, required: true },
  /** 默认每批数量（设置里的首屏数量） */
  cardSize: { type: Number, default: 4 },
  /** 当前编辑器里的视频总数（确认文案用） */
  itemCount: { type: Number, default: 0 },
  itemsDirty: { type: Boolean, default: false },
  /** 设置里改了关联专题但还没保存 */
  pendingTopic: { type: Boolean, default: false }
})
const emit = defineEmits(['update:open', 'done'])

const name = 'rb-' + useId()
const source = ref('hot')
const batches = ref(4)
const size = ref(4)
const errors = ref({})
const busy = ref(false)

/* 每次打开都回到默认：有关联专题时默认按专题生成 */
watch(() => props.open, v => {
  if (!v) return
  source.value = props.section.topicId ? 'topic' : 'hot'
  batches.value = 4
  size.value = props.cardSize || props.section.cardSize || 4
  errors.value = {}
}, { immediate: true })

const sources = computed(() => [
  {
    value: 'topic',
    label: '关联专题的视频',
    desc: props.section.topicId ? `「${props.section.topicName || props.section.topicId}」里已发布的视频，按播放量从高到低` : '这个分区还没有关联专题（在上方「分区设置」里选择并保存）',
    disabled: !props.section.topicId
  },
  { value: 'hot', label: '全站最热', desc: '全部已发布的视频，按播放量从高到低' },
  { value: 'latest', label: '全站最新', desc: '全部已发布的视频，按发布时间从新到旧' }
])
const planned = computed(() => (batches.value || 0) * (size.value || 0))

const close = () => emit('update:open', false)

async function submit() {
  if (busy.value) return
  errors.value = {}
  if (!(batches.value >= 1 && batches.value <= 20)) { errors.value = { batches: '批数需在 1-20 之间' }; return }
  if (!(size.value >= 1 && size.value <= 60)) { errors.value = { size: '每批数量需在 1-60 之间' }; return }
  const lost = props.itemCount ? `这个分区现有的 ${props.itemCount} 个视频${props.itemsDirty ? '（包括还没保存的修改）' : ''}会被全部替换，` : ''
  const ok = await confirmDialog({
    title: '替换分区内容？',
    message: `${lost}生成 ${batches.value} 批、每批 ${size.value} 个视频，并立即保存。\n确定继续？`,
    confirmText: '生成并替换',
    danger: !!props.itemCount
  })
  if (!ok) return
  busy.value = true
  try {
    const res = await rebuildSection(props.section.id, { source: source.value, batches: batches.value, size: size.value })
    const list = res?.batches || []
    toast(`已生成 ${list.length} 批，共 ${list.reduce((n, b) => n + b.length, 0)} 个视频`, { type: 'ok' })
    emit('done', res)
    close()
  } catch (e) {
    if (e?.field && ['source', 'batches', 'size'].includes(e.field)) errors.value = { [e.field]: e.message }
    toastError(e, '生成失败')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AModal :open="open" title="自动生成分区内容" :width="520" :persistent="busy" :closable="!busy" @update:open="v => !v && close()">
    <div class="rb">
      <FormField label="视频来源" field="source" :error="errors.source">
        <div class="srcs" role="radiogroup" aria-label="视频来源">
          <label v-for="s in sources" :key="s.value" class="src" :class="{ on: source === s.value, off: s.disabled }">
            <input v-model="source" type="radio" :name="name" :value="s.value" :disabled="s.disabled || busy">
            <span class="src-txt">
              <span class="src-t">{{ s.label }}</span>
              <span class="src-d">{{ s.desc }}</span>
            </span>
          </label>
        </div>
      </FormField>
      <p v-if="pendingTopic && section.topicId" class="note warn-text small">「分区设置」里改了关联专题还没保存，会按已保存的专题生成。</p>

      <div class="form-grid">
        <FormField label="批数" field="batches" :error="errors.batches" hint="前台「换一批」依次切换（1-20）">
          <NumberInput v-model="batches" :min="1" :max="20" suffix="批" :disabled="busy" />
        </FormField>
        <FormField label="每批数量" field="size" :error="errors.size" hint="默认等于首屏数量（1-60）">
          <NumberInput v-model="size" :min="1" :max="60" suffix="个" :disabled="busy" />
        </FormField>
      </div>
      <p class="muted small">共 {{ planned }} 个位置；同一批里不会重复，候选视频不够时从头循环。生成后会<b>立即保存</b>并替换现有内容。</p>
    </div>
    <template #footer>
      <ABtn :disabled="busy" @click="close">取消</ABtn>
      <ABtn variant="primary" icon="sparkle" :loading="busy" @click="submit">生成</ABtn>
    </template>
  </AModal>
</template>

<style scoped>
.rb { display: flex; flex-direction: column; gap: 16px; }
.srcs { display: flex; flex-direction: column; gap: 6px; }
.src { display: flex; align-items: flex-start; gap: 10px; padding: 9px 12px; border: 1px solid var(--line-2); border-radius: 8px; cursor: pointer; transition: border-color .12s, background .12s; }
.src:hover:not(.off) { border-color: #4a4a4a; }
.src.on { border-color: var(--accent); background: #1b1b1b; }
.src.off { opacity: .5; cursor: not-allowed; }
.src input { flex: none; margin-top: 2px; accent-color: var(--accent); }
.src-txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.src-t { color: var(--t1); font-weight: 500; }
.src-d { color: var(--t3); font-size: 12px; }
.note { margin-top: -8px; }
.rb b { color: var(--t1); font-weight: 600; }
</style>
