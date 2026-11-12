<script setup>
import { ref, computed, watch } from 'vue'
import AModal from '../../components/AModal.vue'
import ABtn from '../../components/ABtn.vue'
import FormField from '../../components/FormField.vue'
import TextInput from '../../components/TextInput.vue'
import SelectInput from '../../components/SelectInput.vue'
import Thumb from '../../components/Thumb.vue'
import { createAlbum } from '../../api'
import { useMeta } from '../../composables/useMeta'
import { toast } from '../../components/toast'
import { fmtNum } from '../../utils/format'

/*
 * 把当前文件夹建成一个图集：文件夹里的图片按文件名排序（2.jpg 排在 10.jpg 前面），第一张是封面。
 * 宽高不用在这里读：站内 /media/ 的图片由服务端读文件头补上。建好后可以「打开图集」继续调整顺序、写简介。
 */
const MAX = 100
const props = defineProps({
  open: { type: Boolean, default: false },
  /** 当前文件夹（相对 media/） */
  dir: { type: String, default: '' },
  /** 当前文件夹的条目（MediaPage 已经取回的，不再请求） */
  entries: { type: Array, default: () => [] }
})
const emit = defineEmits(['update:open', 'created'])

const { creatorOptions, albumStatusOptions } = useMeta()

const images = computed(() => props.entries
  .filter(e => e.type === 'image')
  .sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true })))
const taken = computed(() => images.value.slice(0, MAX))
/* 一排 8 格：超过 8 张时显示 7 张 + 「+N」 */
const shown = computed(() => taken.value.slice(0, taken.value.length > 8 ? 7 : 8))
const inAlbums = computed(() => taken.value.filter(e => e.usedByAlbums).length)
const folderName = computed(() => (props.dir ? props.dir.split('/').pop() : ''))

const title = ref('')
const creatorId = ref(null)
const status = ref(1)
const errors = ref({})
const saving = ref(false)
const created = ref(null)

watch(() => props.open, v => {
  if (!v) return
  title.value = folderName.value
  status.value = 1
  errors.value = {}
  created.value = null
  // 创作者沿用上一次的选择（连续给几个文件夹建图集时不用每次都选）
})
watch([title, creatorId], () => { errors.value = {} })

const close = () => { if (!saving.value) emit('update:open', false) }

async function submit() {
  if (saving.value) return
  const e = {}
  if (!creatorId.value) e.creatorId = '请选择创作者'
  if ([...title.value.trim()].length > 200) e.title = '标题最多 200 个字'
  if (!taken.value.length) e.images = '这个文件夹里没有图片'
  if (Object.keys(e).length) { errors.value = e; return }
  saving.value = true
  try {
    const album = await createAlbum({
      creatorId: creatorId.value,
      title: title.value.trim(),
      status: status.value,
      images: taken.value.map(f => ({ url: f.url, width: 0, height: 0 }))
    })
    created.value = album
    toast(`已创建图集（${album.imageCount} 张图片）`, { type: 'ok' })
    emit('created', album)
  } catch (err) {
    const field = ['creatorId', 'title', 'images', 'status'].includes(err?.field) ? err.field : 'images'
    errors.value = { [field]: err?.message || '创建失败' }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AModal :open="open" title="把这个文件夹建成图集" :width="520" persistent :closable="!saving" @update:open="v => (v ? null : close())">
    <template v-if="created">
      <div class="done">
        <p><b>已创建图集 ID {{ created.id }}</b>（{{ fmtNum(created.imageCount) }} 张图片，{{ created.status === 1 ? '已上架' : '已下架' }}）</p>
        <p class="dim small">可以打开图集继续调整顺序、写简介和标签。</p>
      </div>
    </template>
    <template v-else>
      <p class="lead">
        「media{{ dir ? '/' + dir : '' }}」里的 <b class="num">{{ fmtNum(images.length) }}</b> 张图片按文件名排序，第一张是封面。
        <span v-if="images.length > MAX" class="warn-text">图集最多 {{ MAX }} 张，只取前 {{ MAX }} 张。</span>
      </p>
      <ol class="strip" aria-label="前几张图片">
        <li v-for="(f, i) in shown" :key="f.path" :title="f.name">
          <Thumb :src="f.url" :ratio="1" width="100%" />
          <span v-if="!i" class="cv">封面</span>
        </li>
        <li v-if="taken.length > shown.length" class="more num">+{{ fmtNum(taken.length - shown.length) }}</li>
      </ol>
      <p v-if="inAlbums" class="dim small note">其中 {{ inAlbums }} 张已经在别的图集里（同一张图可以出现在多个图集里）。</p>
      <p v-if="errors.images" class="danger-text small note" role="alert">{{ errors.images }}</p>

      <div class="form-grid">
        <FormField class="full" label="标题" field="title" :error="errors.title" hint="默认用文件夹名，可以留空">
          <TextInput v-model="title" :maxlength="200" show-count />
        </FormField>
        <FormField label="创作者" field="creatorId" required :error="errors.creatorId">
          <SelectInput v-model="creatorId" :options="creatorOptions" searchable placeholder="选择创作者" />
        </FormField>
        <FormField label="状态" field="status" :error="errors.status">
          <SelectInput v-model="status" :options="albumStatusOptions" />
        </FormField>
      </div>
    </template>

    <template #footer>
      <template v-if="created">
        <ABtn icon="image" :to="{ path: '/albums', query: { edit: created.id } }">打开图集</ABtn>
        <ABtn variant="primary" @click="emit('update:open', false)">完成</ABtn>
      </template>
      <template v-else>
        <ABtn :disabled="saving" @click="close">取消</ABtn>
        <ABtn variant="primary" :loading="saving" :disabled="!taken.length" @click="submit">创建图集</ABtn>
      </template>
    </template>
  </AModal>
</template>

<style scoped>
.lead { margin-bottom: 12px; color: var(--t2); line-height: 1.6; }
.lead b { color: var(--t1); }
.strip { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 6px; margin-bottom: 10px; }
.strip li { position: relative; }
.cv { position: absolute; top: 3px; left: 3px; height: 16px; padding: 0 5px; border-radius: 8px; background: var(--accent); color: var(--on-accent); font-size: 10.5px; font-weight: 600; line-height: 16px; }
.more { display: grid; place-items: center; aspect-ratio: 1; border-radius: 6px; background: #1a1a1a; color: var(--t2); font-size: 12px; }
.note { margin-bottom: 12px; }
.done { display: flex; flex-direction: column; gap: 6px; padding: 4px 0; }
.done b { color: var(--t1); }
</style>
