<script setup>
import { ref, computed, watch } from 'vue'
import ABtn from '../../components/ABtn.vue'
import FormField from '../../components/FormField.vue'
import TextArea from '../../components/TextArea.vue'
import NumberInput from '../../components/NumberInput.vue'
import SelectInput from '../../components/SelectInput.vue'
import SwitchInput from '../../components/SwitchInput.vue'
import DateTimeInput from '../../components/DateTimeInput.vue'
import TagsInput from '../../components/TagsInput.vue'
import MediaUrlInput from '../../components/MediaUrlInput.vue'
import UrlListInput from '../../components/UrlListInput.vue'
import Thumb from '../../components/Thumb.vue'
import StatusBadge from '../../components/StatusBadge.vue'
import VideoPicker from '../../components/VideoPicker.vue'
import PostPreview from './PostPreview.vue'
import { useMeta } from '../../composables/useMeta'
import { getCreator, getVideo } from '../../api'
import { fmtDate, fmtDuration, fmtNum } from '../../utils/format'
import { rovingKeydown, rovingTabindex } from '../../utils/roving'

/*
 * 帖子编辑表单（放在 PostsPage 的抽屉里）：左边表单，右边按前台社区卡片的样子实时预览。
 * 「标题」就是 posts.text（卡片和详情页顶部那一句），「详情正文」是 posts.content（只在详情页显示）。
 * editor 是 useEditor 返回的 reactive 对象，这里直接改 editor.form.*。
 */
const props = defineProps({
  editor: { type: Object, required: true }
})

const { creatorOptions, statusOptions, postKindOptions } = useMeta()
const form = computed(() => props.editor.form)
const errors = computed(() => props.editor.errors)

/* ---------- 类型：分段按钮（视频 / 图文 / 文档），方向键可切换（utils/roving.js） ---------- */
function pickKind(v) { form.value.mediaKind = v }
const kindIndex = computed(() => postKindOptions.value.findIndex(o => o.value === form.value.mediaKind))

/* ---------- 关联视频：显示缩略图和标题；行里没有封面，按 id 补查一次 ---------- */
const pickerOpen = ref(false)
const video = ref(null) // { id, title, publicId, coverUrl, status, durationSec }
const videoErr = ref('')
let videoSeq = 0
watch(() => form.value.videoId, async id => {
  videoErr.value = ''
  if (!id) { video.value = null; return }
  if (video.value?.id === id) return
  const row = props.editor.row
  // 先用列表行里已有的标题顶上，封面和时长查到再补
  video.value = row && row.videoId === id ? { id, title: row.videoTitle, publicId: row.videoPublicId, coverUrl: null, status: null, durationSec: 0 } : { id, title: `视频 #${id}`, publicId: '' }
  const my = ++videoSeq
  try {
    const v = await getVideo(id)
    if (my === videoSeq) video.value = { id: v.id, title: v.title, publicId: v.publicId, coverUrl: v.coverUrl, status: v.status, durationSec: v.durationSec }
  } catch (e) {
    if (my === videoSeq) videoErr.value = e.message || '视频信息读取失败'
  }
}, { immediate: true })

function onPicked([v]) {
  if (!v) return
  videoSeq++
  video.value = v
  videoErr.value = ''
  form.value.videoId = v.id
}
function removeVideo() {
  videoSeq++
  video.value = null
  form.value.videoId = null
}
const canUseCover = computed(() => !!(video.value?.coverUrl && !form.value.mainImage))
const useVideoCover = () => { form.value.mainImage = video.value.coverUrl }

/* ---------- 预览用的发布者信息（头像、认证），按 id 缓存 ---------- */
const creatorCache = new Map()
const creator = ref(null)
let creatorSeq = 0
watch(() => form.value.creatorId, async id => {
  if (!id) { creator.value = null; return }
  const my = ++creatorSeq
  const opt = creatorOptions.value.find(o => String(o.value) === String(id))
  creator.value = creatorCache.get(id) || (opt ? { name: opt.label.replace(/ @.*$/, ''), handle: '', avatarUrl: null, isVerified: false } : null)
  if (creatorCache.has(id)) return
  try {
    const c = await getCreator(id)
    creatorCache.set(id, c)
    if (my === creatorSeq) creator.value = c
  } catch { /* 预览而已，拿不到就用下拉框里的名字 */ }
}, { immediate: true })

</script>

<template>
  <div class="pf">
    <div class="fields">
      <div class="form-grid">
        <FormField class="full" label="发布者" field="creatorId" required :error="errors.creatorId">
          <SelectInput v-model="form.creatorId" :options="creatorOptions" searchable placeholder="选择创作者" />
        </FormField>
        <FormField class="full" label="标题" field="text" required :error="errors.text" hint="显示在社区列表和详情页顶部">
          <TextArea v-model="form.text" :rows="2" :max-rows="6" :maxlength="5000" show-count placeholder="一句话说清楚这条帖子" />
        </FormField>
        <FormField class="full" label="详情正文" field="content" :error="errors.content" hint="显示在帖子详情页标题下面，支持换行">
          <TextArea v-model="form.content" :rows="5" :max-rows="18" :maxlength="20000" show-count placeholder="正文内容，可以分段…" />
        </FormField>

        <FormField class="full" label="类型" field="mediaKind" :error="errors.mediaKind" hint="视频：关联了视频时主图带播放按钮；文档：配图显示成文档页">
          <div class="seg" role="radiogroup" aria-label="类型" @keydown="rovingKeydown">
            <button
              v-for="(o, i) in postKindOptions"
              :key="o.value"
              type="button"
              role="radio"
              class="seg-btn"
              :class="{ on: form.mediaKind === o.value }"
              :aria-checked="form.mediaKind === o.value ? 'true' : 'false'"
              :tabindex="rovingTabindex(i, kindIndex)"
              @click="pickKind(o.value)"
            >{{ o.label }}</button>
          </div>
        </FormField>

        <FormField class="full" label="关联视频" field="videoId" :error="errors.videoId || videoErr" hint="点前台卡片的主图会播放这个视频">
          <div v-if="form.videoId && video" class="vid">
            <Thumb :src="video.coverUrl || ''" :width="96" icon="video" />
            <div class="vid-txt">
              <p class="ellipsis" :title="video.title">{{ video.title }}</p>
              <p class="small dim">
                <span class="mono">{{ video.publicId || '#' + video.id }}</span>
                <span v-if="video.durationSec"> · {{ fmtDuration(video.durationSec) }}</span>
                <StatusBadge v-if="video.status !== null && video.status !== undefined && video.status !== 1" class="vs" :status="video.status" />
              </p>
            </div>
            <div class="vid-ops">
              <ABtn size="sm" icon="refresh" @click="pickerOpen = true">更换</ABtn>
              <ABtn size="sm" variant="ghost" icon="x" @click="removeVideo">移除</ABtn>
            </div>
          </div>
          <ABtn v-else icon="video" @click="pickerOpen = true">选择视频</ABtn>
          <button v-if="canUseCover" type="button" class="link small use-cover" @click="useVideoCover">用视频封面作主图</button>
        </FormField>

        <FormField class="full" label="标签" field="tags" :error="errors.tags" hint="不带 #，前台显示时会自动加上">
          <TagsInput v-model="form.tags" />
        </FormField>
        <FormField class="full" label="主图" field="mainImage" :error="errors.mainImage" hint="卡片上 16:9 的大图；视频帖一般用视频封面">
          <MediaUrlInput v-model="form.mainImage" kind="image" upload-dir="images" />
        </FormField>
        <FormField class="full" label="配图" field="images" :error="errors.images" hint="最多 9 张；App 卡片上显示前 3 张，多出来的张数显示在第 3 张上（+N）">
          <UrlListInput v-model="form.images" :max="9" upload-dir="images" />
        </FormField>

        <FormField label="阅读数" field="readCount" :error="errors.readCount">
          <NumberInput v-model="form.readCount" :min="0" required />
        </FormField>
        <FormField label="状态" field="status" :error="errors.status">
          <SelectInput v-model="form.status" :options="statusOptions" />
        </FormField>
        <FormField label="发布时间" field="publishedAt" :error="errors.publishedAt" :hint="editor.isNew ? '留空 = 保存的时间' : ''">
          <DateTimeInput v-model="form.publishedAt" :clearable="editor.isNew" />
        </FormField>
        <FormField class="full" inline label="热门" field="isHot" :error="errors.isHot" hint="出现在社区「热门」里">
          <SwitchInput v-model="form.isHot" />
        </FormField>
      </div>

      <template v-if="!editor.isNew && editor.row">
        <h4 class="form-section">数据</h4>
        <dl class="kv">
          <div><dt>ID</dt><dd>{{ editor.row.id }}</dd></div>
          <div><dt>收藏</dt><dd>{{ fmtNum(editor.row.favCount) }}</dd></div>
          <div><dt>创建时间</dt><dd>{{ fmtDate(editor.row.createdAt) }}</dd></div>
        </dl>
      </template>
    </div>

    <aside class="side">
      <p class="side-hd">前台效果预览</p>
      <PostPreview :post="form" :creator="creator" :fav-count="editor.row?.favCount || 0" :duration-sec="video?.durationSec || 0" />
    </aside>

    <VideoPicker v-model:open="pickerOpen" title="选择关联视频" @select="onPicked" />
  </div>
</template>

<style scoped>
.pf { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 24px; align-items: start; }
.side { position: sticky; top: 0; }
.side-hd { margin-bottom: 8px; color: var(--t2); font-size: 12px; font-weight: 600; letter-spacing: .04em; }

.seg { display: inline-flex; padding: 2px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--field); }
.seg-btn { min-width: 64px; height: 28px; padding: 0 14px; border-radius: 5px; color: var(--t2); }
.seg-btn:hover { color: var(--t1); }
.seg-btn.on { background: var(--accent); color: var(--on-accent); font-weight: 600; }

.vid { display: flex; align-items: center; gap: 12px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
.vid-txt { flex: 1; min-width: 0; }
.vid-txt .small { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
.vs { margin-left: 4px; }
.vid-ops { display: flex; flex: none; gap: 4px; }
.use-cover { display: inline-block; margin-top: 8px; color: var(--t2); }

@media (max-width: 1100px) {
  .pf { grid-template-columns: minmax(0, 1fr); }
  .side { position: static; order: -1; }
}
</style>
