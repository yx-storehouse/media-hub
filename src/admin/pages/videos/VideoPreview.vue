<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import AModal from '../../components/AModal.vue'
import ABtn from '../../components/ABtn.vue'
import AIcon from '../../components/AIcon.vue'
import StatusBadge from '../../components/StatusBadge.vue'
import { resolveUrl } from '../../api'
import { fmtDuration, fmtDate } from '../../utils/format'

/*
 * 视频预览：有播放地址就直接播放（同源 /media 和外链都行），没有就提示去编辑里补上。
 * 底部「在前台查看」跳到移动端的播放页，看看用户那边的实际效果。
 * 关闭时把 <video> 的地址清掉：只卸载元素的话浏览器还会把视频下完，大文件会一直占着连接和带宽。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  video: { type: Object, default: null }
})
const emit = defineEmits(['update:open', 'edit'])

const failed = ref(false)
watch(() => [props.open, props.video?.playbackUrl], () => { failed.value = false })

const player = ref(null)
function release() {
  const v = player.value
  if (!v) return
  v.pause()
  v.removeAttribute('src')
  v.load()
}
watch(() => props.open, v => { if (!v) release() })
onBeforeUnmount(release)

const appUrl = v => `./index.html#/video/${v.id}`
</script>

<template>
  <AModal :open="open" :title="video ? video.title : '预览'" :width="760" @update:open="v => emit('update:open', v)">
    <template v-if="video">
      <div class="stage">
        <video
          v-if="video.playbackUrl && !failed"
          :key="video.playbackUrl"
          ref="player"
          class="player"
          :src="resolveUrl(video.playbackUrl)"
          controls
          playsinline
          preload="metadata"
          @error="failed = true"
        />
        <div v-else class="none">
          <AIcon :name="failed ? 'warning' : 'video'" :size="26" :stroke="1.4" />
          <p v-if="failed">视频无法播放：地址打不开，或浏览器不支持这种格式</p>
          <p v-else>这个视频还没有播放地址，前台只会显示封面</p>
        </div>
      </div>

      <dl class="meta">
        <div><dt>编号</dt><dd class="mono">{{ video.publicId }}</dd></div>
        <div><dt>专题</dt><dd>{{ video.topicName || '—' }}</dd></div>
        <div><dt>时长</dt><dd class="num">{{ fmtDuration(video.durationSec) }}</dd></div>
        <div><dt>状态</dt><dd><StatusBadge :status="video.status" /><span v-if="video.isShort" class="chip outline short">短</span></dd></div>
        <div><dt>发布时间</dt><dd class="num">{{ fmtDate(video.publishedAt) }}</dd></div>
      </dl>
      <p v-if="video.playbackUrl" class="url mono dim ellipsis" :title="video.playbackUrl">{{ video.playbackUrl }}</p>
    </template>

    <template #footer>
      <ABtn v-if="video" icon="external" :href="appUrl(video)" target="_blank" rel="noopener" class="left">在前台查看</ABtn>
      <ABtn v-if="video" icon="edit" @click="emit('edit', video)">编辑</ABtn>
      <ABtn variant="primary" @click="emit('update:open', false)">关闭</ABtn>
    </template>
  </AModal>
</template>

<style scoped>
.stage { overflow: hidden; border-radius: 8px; background: #000; }
.player { width: 100%; max-height: 56vh; background: #000; }
.none { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; aspect-ratio: 16 / 9; max-height: 56vh; color: var(--t2); text-align: center; padding: 16px; }
.meta { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px 16px; margin-top: 14px; }
.meta dt { color: var(--t3); font-size: 12px; }
.meta dd { display: flex; align-items: center; gap: 6px; min-height: 22px; margin-top: 2px; }
.short { height: 18px; }
.url { margin-top: 10px; }
.left { margin-right: auto; }
</style>
