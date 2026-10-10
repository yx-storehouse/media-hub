<script setup>
import { ref, computed, watch } from 'vue'
import AModal from './AModal.vue'
import ABtn from './ABtn.vue'
import FormField from './FormField.vue'
import SelectInput from './SelectInput.vue'
import TagsInput from './TagsInput.vue'

/*
 * 批量改一个字段的小对话框（视频、帖子等列表页共用）：
 *   <BatchValueModal v-model:open="topicOpen" title="批量改专题" label="专题" :options="topicOptions" searchable
 *                    null-label="不属于任何专题" :count="selected.length" unit="个视频" :busy="batch.busy"
 *                    @submit="v => batch.run('setTopic', v, { done: '已修改' }).then(() => topicOpen = false)" />
 *   mode="select"：下拉选一个值；nullLabel 有值时多一个「清空」选项，提交 null
 *   mode="tags"：  填若干标签（hash = 视频标签，带 #），提交字符串数组
 * 点「确定」只 emit('submit', value)，由页面去调批量接口；成功后页面把 open 关掉，失败时对话框留着可以重试。
 * busy 时不能关闭（Esc / × / 遮罩都不行），免得结果出来时用户以为没执行。
 * 每次打开都从空白开始，不会沿用上一批的选择。
 */
const NONE = '__none__'

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  label: { type: String, default: '' },
  mode: { type: String, default: 'select', validator: v => ['select', 'tags'].includes(v) },
  options: { type: Array, default: () => [] },
  searchable: { type: Boolean, default: false },
  nullLabel: { type: String, default: '' },
  hash: { type: Boolean, default: false },
  hint: { type: String, default: '' },
  /** 选中的条数（显示「将修改选中的 N 项」） */
  count: { type: Number, default: 0 },
  /** 单位：个视频 / 条帖子 */
  unit: { type: String, default: '项' },
  busy: { type: Boolean, default: false },
  /** 下拉 / 标签输入框的占位文字 */
  placeholder: { type: String, default: '' },
  /** 确定按钮的文字 */
  confirmText: { type: String, default: '确定' },
  /** 对话框宽度 */
  width: { type: Number, default: 440 }
})
const emit = defineEmits(['update:open', 'submit'])

const value = ref(null)
const tags = ref([])
watch(() => props.open, v => { if (v) { value.value = null; tags.value = [] } })

const opts = computed(() => (props.nullLabel ? [{ value: NONE, label: props.nullLabel }, ...props.options] : props.options))
const ready = computed(() => (props.mode === 'tags' ? tags.value.length > 0 : value.value !== null && value.value !== ''))
const ph = computed(() => props.placeholder || (props.mode === 'tags' ? '输入后回车，可一次输入多个' : '请选择'))

function submit() {
  if (!ready.value || props.busy) return
  emit('submit', props.mode === 'tags' ? [...tags.value] : value.value === NONE ? null : value.value)
}
</script>

<template>
  <AModal :open="open" :title="title" :width="width" :persistent="busy" :closable="!busy" @update:open="v => emit('update:open', v)">
    <FormField :label="label" :hint="hint">
      <TagsInput v-if="mode === 'tags'" v-model="tags" :hash="hash" :placeholder="ph" />
      <SelectInput v-else v-model="value" :options="opts" :searchable="searchable" :placeholder="ph" :pop-width="300" />
    </FormField>
    <p class="muted small cnt">将修改选中的 <b class="num">{{ count }}</b> {{ unit }}</p>
    <template #footer>
      <ABtn :disabled="busy" @click="emit('update:open', false)">取消</ABtn>
      <ABtn variant="primary" :loading="busy" :disabled="!ready" @click="submit">{{ confirmText }}</ABtn>
    </template>
  </AModal>
</template>

<style scoped>
.cnt { margin-top: 14px; }
.cnt b { color: var(--t1); }
</style>
