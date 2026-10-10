<script setup>
import { ref, computed, watch } from 'vue'
import ABtn from '../../components/ABtn.vue'
import FormField from '../../components/FormField.vue'
import TextInput from '../../components/TextInput.vue'
import TextArea from '../../components/TextArea.vue'
import SelectInput from '../../components/SelectInput.vue'
import SwitchInput from '../../components/SwitchInput.vue'
import DateTimeInput from '../../components/DateTimeInput.vue'
import TagsInput from '../../components/TagsInput.vue'
import MediaUrlInput from '../../components/MediaUrlInput.vue'
import { useMeta } from '../../composables/useMeta'
import { useVideoProbe } from '../../composables/useVideoProbe'
import { toast, toastError } from '../../components/toast'
import { fmtDate, fmtDuration, fmtNum, fileStamp, parseDuration } from '../../utils/format'
import { durationError } from './duration'

/*
 * 视频编辑表单（放在 VideosPage 的抽屉里）。editor 是 useEditor 返回的 reactive 对象，
 * 这里直接改 editor.form.*；字段名和接口一致，服务端报的字段错误会显示在对应的 FormField 下。
 * 时长在表单里是文本（durationText：90 / 1:30 / 01:02:03），保存时由页面的 toBody 换成秒。
 */
const props = defineProps({
  editor: { type: Object, required: true }
})

const { topicOptions, creatorOptions, categoryOptions, regionOptions, qualityOptions, statusOptions } = useMeta()
const form = computed(() => props.editor.form)
const errors = computed(() => props.editor.errors)

/* ---------- 从视频读取时长（和封面） ---------- */
/* 读视频 + 截图 + 上传都交给 useVideoProbe：抽屉关掉（本组件卸载）时自动作废，不会再上传截图 */
const vp = useVideoProbe()
const probing = ref(false)
/* 默认：没有封面时顺便截一帧当封面；已有封面就只读时长 */
const grabCover = ref(true)
watch(() => [props.editor.open, props.editor.row], () => { grabCover.value = !props.editor.form.coverUrl }, { immediate: true })

const durHint = computed(() => {
  if (durError.value) return ''
  const s = parseDuration(form.value.durationText)
  return s ? `= ${fmtNum(s)} 秒（${fmtDuration(s)}）` : '秒数，或 分:秒 / 时:分:秒；留空 = 未知'
})
/* 边输入边提示格式错误（保存时页面的 validate 也会挡一次） */
const durError = computed(() => durationError(form.value.durationText))

async function readFromVideo({ quiet = false } = {}) {
  const url = form.value.playbackUrl
  if (!url) return toast('请先填写播放地址', { type: 'error' })
  if (probing.value) return
  /*
   * 结果只写回发起读取时的那份表单：期间关了抽屉、换了一条、或者放弃后又点了「新建视频」
   * （每次打开表单对象都是新的），结果作废，截图也不会再上传。
   */
  const target = props.editor.form
  const isCurrent = () => props.editor.open && props.editor.form === target
  const grab = grabCover.value
  // 编辑时用 v<ID>.jpg（重名自动改名，不覆盖现有文件：没点保存也不会改掉线上的封面）
  const coverPath = props.editor.isNew ? `covers/frame-${fileStamp()}.jpg` : `covers/v${props.editor.id}.jpg`
  probing.value = true
  try {
    const { durationSec, coverUrl, coverNote } = await vp.read(url, { cover: grab, coverPath, overwrite: false, isCurrent })
    if (!isCurrent()) return
    target.durationText = durationSec ? fmtDuration(durationSec) : ''
    let msg = '时长 ' + fmtDuration(durationSec)
    if (grab) {
      if (coverUrl) {
        target.coverUrl = coverUrl
        grabCover.value = false
        msg += '，已截取封面'
      } else msg += '；' + coverNote
    }
    toast((quiet ? '已自动读取：' : '已读取：') + msg, { type: 'ok' })
  } catch (e) {
    if (e?.name !== 'AbortError' && isCurrent()) toastError(e, '读取失败')
  } finally {
    probing.value = false
  }
}

/* 刚上传了视频文件、时长还空着：自动读一次 */
function onVideoUploaded() {
  if (!parseDuration(form.value.durationText)) readFromVideo({ quiet: true })
}

const appUrl = computed(() => `./index.html#/video/${props.editor.id}`)
</script>

<template>
  <div class="vf">
    <h4 class="form-section">基本</h4>
    <div class="form-grid">
      <FormField class="full" label="标题" field="title" required :error="errors.title">
        <TextInput v-model="form.title" :maxlength="200" show-count placeholder="视频标题" />
      </FormField>
      <FormField label="编号" field="publicId" :error="errors.publicId" :hint="editor.isNew ? '例如 VID-1001，不能和已有编号重复' : '不能和已有编号重复'">
        <TextInput v-model="form.publicId" mono :maxlength="64" :placeholder="editor.isNew ? '留空自动生成' : ''" />
      </FormField>
      <FormField label="清晰度" field="quality" :error="errors.quality">
        <SelectInput v-model="form.quality" :options="qualityOptions" />
      </FormField>
      <FormField class="full" label="简介" field="description" :error="errors.description">
        <TextArea v-model="form.description" :rows="2" :maxlength="5000" show-count placeholder="可选" />
      </FormField>
    </div>

    <h4 class="form-section">归类</h4>
    <div class="form-grid">
      <FormField label="专题" field="topicId" :error="errors.topicId">
        <SelectInput v-model="form.topicId" :options="topicOptions" searchable clearable placeholder="不属于任何专题" />
      </FormField>
      <FormField label="创作者" field="creatorId" :error="errors.creatorId">
        <SelectInput v-model="form.creatorId" :options="creatorOptions" searchable clearable placeholder="不指定" />
      </FormField>
      <FormField label="分类" field="categoryKey" :error="errors.categoryKey" hint="决定出现在首页哪个频道">
        <SelectInput v-model="form.categoryKey" :options="categoryOptions" clearable placeholder="不分类" />
      </FormField>
      <FormField label="地区" field="region" :error="errors.region" hint="不设置地区的视频在前台「最新」里归入「其他」">
        <SelectInput v-model="form.region" :options="regionOptions" clearable placeholder="不设置" />
      </FormField>
      <FormField class="full" label="标签" field="tags" :error="errors.tags" hint="回车或逗号分隔，自动加 #；最多 20 个">
        <TagsInput v-model="form.tags" hash />
      </FormField>
    </div>

    <h4 class="form-section">媒体</h4>
    <div class="form-grid">
      <FormField class="full" label="播放地址" field="playbackUrl" :error="errors.playbackUrl" hint="mp4 / webm / m3u8 等；可以填外链，也可以上传到素材文件夹">
        <MediaUrlInput v-model="form.playbackUrl" kind="video" @uploaded="onVideoUploaded" />
      </FormField>
      <FormField class="full" label="封面" field="coverUrl" :error="errors.coverUrl" hint="留空时前台显示自动生成的占位图">
        <MediaUrlInput v-model="form.coverUrl" kind="image" />
      </FormField>
      <FormField class="full" label="时长" field="durationSec" :error="errors.durationSec || durError" :hint="durHint">
        <div class="dur">
          <TextInput v-model="form.durationText" class="dur-in" mono placeholder="例如 1:30" />
          <ABtn icon="film" :loading="probing" :disabled="!form.playbackUrl" title="在浏览器里打开播放地址，读取时长" @click="readFromVideo()">从视频读取</ABtn>
          <label class="ck small">
            <input v-model="grabCover" type="checkbox" :disabled="probing">
            <span>同时截一帧作封面</span>
          </label>
        </div>
      </FormField>
    </div>

    <h4 class="form-section">发布</h4>
    <div class="form-grid">
      <FormField label="状态" field="status" :error="errors.status" hint="只有「已发布」的视频会出现在前台">
        <SelectInput v-model="form.status" :options="statusOptions" />
      </FormField>
      <FormField label="发布时间" field="publishedAt" :error="errors.publishedAt" :hint="editor.isNew ? '留空 = 保存的时间' : '影响「最新」排序'">
        <DateTimeInput v-model="form.publishedAt" :clearable="editor.isNew" />
      </FormField>
      <FormField class="full" inline label="加入短视频" field="isShort" :error="errors.isShort" hint="加入后出现在前台「短视频」流的末尾">
        <SwitchInput v-model="form.isShort" />
      </FormField>
    </div>

    <template v-if="!editor.isNew && editor.row">
      <h4 class="form-section">数据</h4>
      <dl class="kv">
        <div><dt>ID</dt><dd>{{ editor.row.id }}</dd></div>
        <div><dt>播放</dt><dd>{{ fmtNum(editor.row.playCount) }}</dd></div>
        <div><dt>点赞</dt><dd>{{ fmtNum(editor.row.likeCount) }}</dd></div>
        <div><dt>收藏</dt><dd>{{ fmtNum(editor.row.favCount) }}</dd></div>
        <div><dt>创建时间</dt><dd>{{ fmtDate(editor.row.createdAt) }}</dd></div>
      </dl>
      <p class="front">
        <ABtn size="sm" variant="ghost" icon="external" :href="appUrl" target="_blank" rel="noopener">在前台查看</ABtn>
        <span class="dim small">（未发布的视频前台打不开）</span>
      </p>
    </template>
  </div>
</template>

<style scoped>
.dur { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dur-in { width: 150px; }
.ck { display: inline-flex; align-items: center; gap: 6px; color: var(--t2); cursor: pointer; }
.front { display: flex; align-items: center; gap: 4px; margin-top: 14px; margin-left: -8px; }
</style>
