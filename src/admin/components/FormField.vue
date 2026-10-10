<script setup>
import { computed, provide, useId } from 'vue'
import { FIELD_KEY } from './formField'

/*
 * 表单项：标签 + 控件 + 提示 / 错误。
 *   <FormField label="标题" field="title" required :error="errors.title" hint="最多 200 字">
 *     <TextInput v-model="form.title" />
 *   </FormField>
 * field：接口字段名。保存时服务端报字段错误，useEditor 会按 data-field 找到这一项并聚焦。
 * inline：标签和控件左右排列（开关类用）。
 */
const props = defineProps({
  label: { type: String, default: '' },
  required: { type: Boolean, default: false },
  hint: { type: String, default: '' },
  error: { type: String, default: '' },
  field: { type: String, default: '' },
  inline: { type: Boolean, default: false }
})

const id = 'ff-' + useId()
const msgId = id + '-msg'
const hasMsg = computed(() => !!(props.error || props.hint))
provide(FIELD_KEY, {
  id,
  invalid: computed(() => !!props.error),
  describedBy: computed(() => (hasMsg.value ? msgId : ''))
})
</script>

<template>
  <div class="ff" :class="{ inline, invalid: !!error }" :data-field="field || undefined">
    <div v-if="label || $slots.extra" class="ff-hd">
      <label v-if="label" class="ff-label" :for="id">
        {{ label }}<b v-if="required" class="req" aria-hidden="true">*</b>
      </label>
      <span v-if="$slots.extra" class="ff-extra"><slot name="extra" /></span>
    </div>
    <div class="ff-ctl"><slot /></div>
    <p v-if="error" :id="msgId" class="ff-err" role="alert">{{ error }}</p>
    <p v-else-if="hint" :id="msgId" class="ff-hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.ff { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ff-hd { display: flex; align-items: center; gap: 8px; min-height: 18px; }
.ff-label { color: var(--t2); font-size: 12.5px; font-weight: 500; }
.req { margin-left: 3px; color: var(--danger); font-weight: 600; }
.ff-extra { margin-left: auto; color: var(--t3); font-size: 12px; }
.ff-ctl { min-width: 0; }
.ff-err { color: var(--danger); font-size: 12px; line-height: 1.45; }
.ff-hint { color: var(--t3); font-size: 12px; line-height: 1.45; }

.ff.inline { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 12px; row-gap: 2px; }
.ff.inline .ff-hd { grid-column: 1; }
.ff.inline .ff-ctl { grid-column: 2; grid-row: 1; }
.ff.inline .ff-err, .ff.inline .ff-hint { grid-column: 1 / -1; }
</style>
