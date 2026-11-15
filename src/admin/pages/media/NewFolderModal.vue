<script setup>
import { ref, watch, nextTick } from 'vue'
import AModal from '../../components/AModal.vue'
import ABtn from '../../components/ABtn.vue'
import FormField from '../../components/FormField.vue'
import TextInput from '../../components/TextInput.vue'
import { createFolder } from '../../api'
import { toast } from '../../components/toast'
import { nameProblem } from './files'

/*
 * 新建文件夹：在当前文件夹下创建（可以写 a/b 一次建多层）。服务端校验不通过时错误显示在输入框下面。
 * 已经有这个文件夹时服务端回 400「文件夹「…」已经存在」：提示里给一个「打开这个文件夹」。
 * 本地先按服务端的规则检查（说法一样）：空的层级（//）、. 和 ..、非法字符。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  /** 当前文件夹（相对 media/） */
  dir: { type: String, default: '' }
})
const emit = defineEmits(['update:open', 'created', 'go'])

const name = ref('')
const error = ref('')
/** 已经存在的文件夹（相对 media/）：可以直接打开 */
const existing = ref('')
const saving = ref(false)
const input = ref(null)

watch(() => props.open, v => {
  if (!v) return
  name.value = ''
  error.value = ''
  existing.value = ''
  nextTick(() => input.value?.focus())
})
watch(name, () => { error.value = ''; existing.value = '' })

function validate(s) {
  if (!s) return '请输入文件夹名称'
  const parts = s.split('/')
  if (parts.some(p => !p)) return '路径里不能有空的层级（连续的 //）'
  for (const p of parts) {
    const bad = nameProblem(p)
    if (bad) return bad
  }
  return ''
}

async function submit() {
  if (saving.value) return
  const s = name.value.trim().replace(/^\/+|\/+$/g, '')
  const local = validate(s)
  if (local) { error.value = local; input.value?.focus(); return }
  const path = props.dir ? `${props.dir}/${s}` : s
  saving.value = true
  try {
    const res = await createFolder(path)
    toast('已创建文件夹：' + res.path, { type: 'ok' })
    emit('created', res)
    emit('update:open', false)
  } catch (e) {
    // 服务端的字段错误（path）显示在输入框下；其他错误同样放这里，用户能直接改名重试
    error.value = e.message || '创建失败'
    if (e?.field === 'path' && /已经存在/.test(e.message || '')) existing.value = path
    nextTick(() => input.value?.focus())
  } finally {
    saving.value = false
  }
}

function openExisting() {
  emit('go', existing.value)
  emit('update:open', false)
}
</script>

<template>
  <AModal :open="open" title="新建文件夹" :width="440" persistent @update:open="v => emit('update:open', v)">
    <FormField label="文件夹名称" field="path" required :error="error" :hint="`建在「media${dir ? '/' + dir : ''}」里；写 a/b 可以一次建多层`">
      <TextInput ref="input" v-model="name" :maxlength="100" placeholder="例如：2026-10 旅拍" @enter="submit" />
    </FormField>
    <template #footer>
      <ABtn v-if="existing" class="go" variant="ghost" icon="folder" @click="openExisting">打开这个文件夹</ABtn>
      <ABtn @click="emit('update:open', false)">取消</ABtn>
      <ABtn variant="primary" :loading="saving" @click="submit">创建</ABtn>
    </template>
  </AModal>
</template>

<style scoped>
.go { margin-right: auto; }
</style>
