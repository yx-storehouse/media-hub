<script setup>
import { computed, watch, onBeforeUnmount } from 'vue'
import AModal from '../../components/AModal.vue'
import ABtn from '../../components/ABtn.vue'
import AIcon from '../../components/AIcon.vue'
import { confirmState } from '../../components/confirm'
import { resolveUrl } from '../../api'
import { fmtSize, fmtDate } from '../../utils/format'

/*
 * 预览：图片大图 / 视频播放器，带文件信息；← → 键（或两侧按钮）切换同一文件夹里的上一个 / 下一个。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  entry: { type: Object, default: null },
  /** 可预览的同级文件（用于上一个 / 下一个） */
  list: { type: Array, default: () => [] }
})
const emit = defineEmits(['update:open', 'update:entry', 'copy', 'delete'])

const idx = computed(() => (props.entry ? props.list.findIndex(e => e.path === props.entry.path) : -1))
const prev = computed(() => (idx.value > 0 ? props.list[idx.value - 1] : null))
const next = computed(() => (idx.value >= 0 && idx.value < props.list.length - 1 ? props.list[idx.value + 1] : null))
const src = computed(() => resolveUrl(props.entry?.url || ''))

function onKey(e) {
  // 上面又弹了确认框（删除）时不切换
  if (!props.open || e.defaultPrevented || confirmState.open) return
  // 焦点在视频控件上时，← → 留给视频快进快退
  if (e.target?.tagName === 'VIDEO' || e.target?.closest?.('input, textarea')) return
  if (e.key === 'ArrowLeft' && prev.value) { e.preventDefault(); emit('update:entry', prev.value) }
  else if (e.key === 'ArrowRight' && next.value) { e.preventDefault(); emit('update:entry', next.value) }
}
watch(() => props.open, v => (v ? document.addEventListener('keydown', onKey) : document.removeEventListener('keydown', onKey)), { immediate: true })
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))

/*
 * 关掉预览 / 切到下一个时立刻放掉视频连接：只把 <video> 从页面上拿掉的话，浏览器可能还开着这个文件好一阵，
 * 这期间服务端覆盖上传同名文件会失败（Windows 上文件被占用）。
 */
const vReleaseMedia = {
  beforeUnmount(el) {
    try { el.pause(); el.removeAttribute('src'); el.load() } catch { /* 已经释放了 */ }
  }
}
</script>

<template>
  <AModal :open="open" :title="entry?.name || '预览'" :width="960" flush @update:open="v => emit('update:open', v)">
    <div v-if="entry" class="pv">
      <div class="stage">
        <button v-if="prev" type="button" class="nav l" aria-label="上一个" title="上一个（←）" @click="emit('update:entry', prev)">
          <AIcon name="chevron-left" :size="22" />
        </button>
        <img v-if="entry.type === 'image'" :key="entry.path" :src="src" :alt="entry.name" class="media">
        <video v-else-if="entry.type === 'video'" :key="entry.path" v-release-media :src="src" class="media" controls autoplay playsinline preload="metadata" />
        <div v-else class="other">
          <AIcon name="file" :size="32" :stroke="1.3" />
          <p>这个文件不能直接预览</p>
          <ABtn size="sm" icon="external" :href="src" target="_blank" rel="noopener">在新标签页打开</ABtn>
        </div>
        <button v-if="next" type="button" class="nav r" aria-label="下一个" title="下一个（→）" @click="emit('update:entry', next)">
          <AIcon name="chevron-right" :size="22" />
        </button>
      </div>
      <div class="info">
        <dl class="kv">
          <div><dt>大小</dt><dd>{{ fmtSize(entry.size) }}</dd></div>
          <div><dt>修改时间</dt><dd>{{ fmtDate(entry.mtime) }}</dd></div>
          <div><dt>使用情况</dt><dd>{{ entry.usedBy ? `被 ${entry.usedBy} 个视频使用` : '未被视频使用' }}</dd></div>
          <div v-if="list.length > 1 && idx >= 0"><dt>位置</dt><dd class="num">{{ idx + 1 }} / {{ list.length }}</dd></div>
        </dl>
        <div class="url-line">
          <code class="url ellipsis" :title="entry.url">{{ entry.url }}</code>
          <ABtn size="sm" icon="copy" @click="emit('copy', entry)">复制地址</ABtn>
          <ABtn size="sm" icon="external" :href="src" target="_blank" rel="noopener">在新标签页打开</ABtn>
          <ABtn size="sm" variant="danger" icon="trash" @click="emit('delete', entry)">删除</ABtn>
        </div>
      </div>
    </div>
  </AModal>
</template>

<style scoped>
.pv { display: flex; flex-direction: column; }
.stage { position: relative; display: grid; place-items: center; min-height: 240px; max-height: calc(100vh - 290px); background: #000; overflow: hidden; }
.media { display: block; max-width: 100%; max-height: calc(100vh - 290px); object-fit: contain; }
.other { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 48px 16px; color: var(--t2); }
.nav { position: absolute; top: 50%; z-index: 1; display: grid; place-items: center; width: 40px; height: 56px; border-radius: 8px; background: rgba(0, 0, 0, .5); color: #fff; transform: translateY(-50%); opacity: .75; }
.nav:hover { background: rgba(0, 0, 0, .75); opacity: 1; }
.nav.l { left: 10px; }
.nav.r { right: 10px; }
.info { display: flex; flex-direction: column; gap: 12px; padding: 14px 20px 16px; border-top: 1px solid var(--line); }
.url-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.url { flex: 1; min-width: 200px; padding: 5px 8px; border-radius: 6px; background: var(--panel-2); color: var(--t2); font: 12px/1.5 var(--mono); }
</style>
