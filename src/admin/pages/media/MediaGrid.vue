<script setup>
import AIcon from '../../components/AIcon.vue'
import Thumb from '../../components/Thumb.vue'
import { fmtSize, fmtDate } from '../../utils/format'

/*
 * 素材网格：文件夹点进去；图片显示缩略图；视频有同名图片时用它当封面，否则显示图标。
 * 每个文件的「复制地址 / 预览 / 删除」按钮常驻（键盘、触屏也能用）。
 */
defineProps({
  entries: { type: Array, default: () => [] },
  /** (entry) => 视频的封面地址（同名图片）或 '' */
  posterOf: { type: Function, required: true }
})
const emit = defineEmits(['open', 'copy', 'preview', 'delete'])

const iconOf = e => (e.type === 'dir' ? 'folder' : e.type === 'video' ? 'film' : e.type === 'image' ? 'image' : 'file')
const typeText = { dir: '文件夹', video: '视频', image: '图片', other: '文件' }
</script>

<template>
  <ul class="grid">
    <li v-for="e in entries" :key="e.path" class="cell" :class="e.type">
      <!-- 按钮里只有缩略图和类型角标：无障碍名称写明是哪个文件，不然读屏只念「视频」「图片」 -->
      <button
        type="button"
        class="cover"
        :title="e.type === 'dir' ? `打开文件夹「${e.name}」` : `预览「${e.name}」`"
        :aria-label="e.type === 'dir' ? `打开文件夹「${e.name}」` : `预览「${e.name}」`"
        @click="emit('open', e)"
      >
        <Thumb v-if="e.type === 'image'" :src="e.url" :ratio="4 / 3" width="100%" />
        <template v-else-if="e.type === 'video' && posterOf(e)">
          <Thumb :src="posterOf(e)" :ratio="4 / 3" width="100%" icon="film" />
          <span class="play" aria-hidden="true"><AIcon name="play" :size="14" /></span>
        </template>
        <span v-else class="ph"><AIcon :name="iconOf(e)" :size="30" :stroke="1.3" /></span>
        <span v-if="e.type !== 'dir'" class="badge" aria-hidden="true">{{ typeText[e.type] }}</span>
      </button>
      <div class="info">
        <div class="name ellipsis" :title="e.name">{{ e.name }}</div>
        <div class="meta">
          <template v-if="e.type === 'dir'">文件夹 · {{ fmtDate(e.mtime) }}</template>
          <template v-else>{{ fmtSize(e.size) }} · {{ fmtDate(e.mtime) }}</template>
        </div>
        <div v-if="e.type !== 'dir'" class="used" :class="{ on: e.usedBy }">{{ e.usedBy ? `被 ${e.usedBy} 个视频使用` : '未被使用' }}</div>
      </div>
      <div class="acts">
        <template v-if="e.type !== 'dir'">
          <button type="button" class="act" title="复制地址" :aria-label="`复制「${e.name}」的地址`" @click="emit('copy', e)"><AIcon name="copy" :size="14" /></button>
          <button type="button" class="act" title="预览" :aria-label="`预览「${e.name}」`" @click="emit('preview', e)"><AIcon name="eye" :size="14" /></button>
        </template>
        <button type="button" class="act danger" title="删除" :aria-label="`删除「${e.name}」`" @click="emit('delete', e)"><AIcon name="trash" :size="14" /></button>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 12px; }
.cell { position: relative; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); transition: border-color .12s; }
.cell:hover, .cell:focus-within { border-color: #3a3a3a; }
.cover { position: relative; display: block; width: 100%; aspect-ratio: 4 / 3; overflow: hidden; background: #161616; }
.cover :deep(.thumb) { border-radius: 0; }
.ph { display: grid; width: 100%; height: 100%; place-items: center; color: var(--t3); }
.cell.dir .ph { color: var(--t2); background: #141414; }
.cell.video .ph { color: var(--t2); }
.play { position: absolute; top: 50%; left: 50%; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: rgba(0, 0, 0, .6); color: #fff; transform: translate(-50%, -50%); }
.badge { position: absolute; bottom: 6px; left: 6px; height: 18px; padding: 0 6px; border-radius: 4px; background: rgba(0, 0, 0, .65); color: #ddd; font-size: 11px; line-height: 18px; }
.info { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px 34px; min-width: 0; }
.name { color: var(--t1); font-weight: 500; }
.meta { color: var(--t3); font-size: 11.5px; }
.used { color: var(--t3); font-size: 11.5px; }
.used.on { color: var(--t2); }
.acts { position: absolute; right: 6px; bottom: 6px; display: flex; gap: 2px; }
.act { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 6px; color: var(--t2); }
.act:hover { background: var(--hover); color: var(--t1); }
.act.danger:hover { background: rgba(255, 107, 107, .12); color: var(--danger); }
</style>
