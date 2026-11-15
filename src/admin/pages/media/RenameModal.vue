<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import AModal from '../../components/AModal.vue'
import ABtn from '../../components/ABtn.vue'
import FormField from '../../components/FormField.vue'
import TextInput from '../../components/TextInput.vue'
import { renameMedia } from '../../api'
import { toast } from '../../components/toast'
import { nameProblem, extOf, isThumbName, refsText, VIDEO_EXTS, IMAGE_EXTS, THUMB_SUFFIX } from './files'

/*
 * 改名（文件或文件夹，留在原来的文件夹里）。服务端会把视频、图集、帖子、专题头图、头像里引用它的地址一起改掉，
 * 图片的小图（.thumb.jpg）跟着改名。文件类型不能变（.jpeg → .jpg 这种同类的可以）。
 *   <RenameModal v-model:open="show" :entry="e" @renamed="res => …" />   res = { from, to, url, type, refs }
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  /** 要改名的条目（listMedia 的 entry） */
  entry: { type: Object, default: null }
})
const emit = defineEmits(['update:open', 'renamed'])

const name = ref('')
const error = ref('')
const saving = ref(false)
const input = ref(null)
const isDir = computed(() => props.entry?.type === 'dir')

watch(() => props.open, v => {
  if (!v || !props.entry) return
  name.value = props.entry.name
  error.value = ''
  // 文件：先选中主名（不含扩展名），直接打字就是改名字、保留扩展名
  nextTick(() => {
    const el = input.value?.el
    if (!el) return
    el.focus()
    const dot = isDir.value ? -1 : props.entry.name.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : props.entry.name.length)
  })
})
watch(name, () => { error.value = '' })

const kindOf = ext => (VIDEO_EXTS.includes(ext) ? 'video' : IMAGE_EXTS.includes(ext) ? 'image' : ext)

function validate(s) {
  if (s.includes('/')) return '新名称里不能有 /（要换文件夹请用「移动」）'
  const bad = nameProblem(s)
  if (bad) return bad
  if (s === props.entry.name) return '新名称和原来一样'
  if (!isDir.value) {
    const from = extOf(props.entry.name)
    const to = extOf(s)
    if (!to) return `请保留扩展名（.${from}）`
    if (kindOf(from) !== kindOf(to)) return `不能改文件类型（原来是 ${from}），只能改名字`
    if (isThumbName(s) && !isThumbName(props.entry.name)) return `以「${THUMB_SUFFIX}」结尾的名字留给小图用，换个名字吧`
  }
  return ''
}

async function submit() {
  if (saving.value || !props.entry) return
  const s = name.value.trim()
  const local = validate(s)
  if (local) { error.value = local; input.value?.focus(); return }
  saving.value = true
  try {
    const res = await renameMedia(props.entry.path, s)
    const refs = refsText(res?.refs)
    toast(`已改名为「${s}」` + (refs ? `，${refs}里的地址已一起更新` : ''), { type: 'ok', duration: refs ? 5000 : undefined })
    emit('renamed', res)
    emit('update:open', false)
  } catch (e) {
    // 服务端的字段错误（name / path）都显示在输入框下，改了名字就能重试
    error.value = e.message || '改名失败'
    nextTick(() => input.value?.focus())
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AModal :open="open" :title="isDir ? '重命名文件夹' : '重命名文件'" :width="460" persistent :closable="!saving" @update:open="v => emit('update:open', v)">
    <FormField
      label="新名称"
      field="name"
      required
      :error="error"
      :hint="isDir ? '文件夹里所有文件的地址都会变；视频、图集、帖子里用到的地址会一起改' : '视频、图集、帖子、头像里用到它的地址会一起改；扩展名（文件类型）不能变'"
    >
      <TextInput ref="input" v-model="name" :maxlength="200" @enter="submit" />
    </FormField>
    <p v-if="entry" class="from dim small">原名：<span class="mono">{{ entry.name }}</span></p>
    <template #footer>
      <ABtn :disabled="saving" @click="emit('update:open', false)">取消</ABtn>
      <ABtn variant="primary" :loading="saving" @click="submit">改名</ABtn>
    </template>
  </AModal>
</template>

<style scoped>
.from { margin-top: 10px; word-break: break-all; }
</style>
