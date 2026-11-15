<script setup>
import { computed } from 'vue'
import AIcon from '../../components/AIcon.vue'
import Thumb from '../../components/Thumb.vue'
import { fmtSize, fmtDate, fmtNum } from '../../utils/format'
import { usedCount, usageText } from './files'

/*
 * 素材网格：文件夹点进去；图片显示缩略图（有小图 .thumb.jpg 时用小图）；视频有同名图片时用它当封面，否则显示图标。
 * 每格左上角是勾选框（鼠标移上去、键盘聚焦、已经勾了东西时显示；按住 Shift 点可以连选一段），
 * 「复制地址 / 预览 / 重命名 / 删除」按钮常驻（键盘、触屏也能用）。
 * 文件夹显示里面有几项（不是空的文件夹删不掉）；原图已经不在的小图标「小图」。
 */
const props = defineProps({
  entries: { type: Array, default: () => [] },
  /** (entry) => 视频的封面地址（同名图片）或 '' */
  posterOf: { type: Function, required: true },
  /** 勾选的路径 */
  selected: { type: Array, default: () => [] }
})
const emit = defineEmits(['open', 'copy', 'preview', 'delete', 'rename', 'toggle'])

const sel = computed(() => new Set(props.selected))
const selecting = computed(() => props.selected.length > 0)
const iconOf = e => (e.type === 'dir' ? 'folder' : e.type === 'video' ? 'film' : e.type === 'image' ? 'image' : 'file')
const typeText = { dir: '文件夹', video: '视频', image: '图片', other: '文件' }
</script>

<template>
  <ul class="grid" :class="{ selecting }">
    <li v-for="e in entries" :key="e.path" class="cell" :class="[e.type, { on: sel.has(e.path) }]">
      <!-- 按钮里只有缩略图和类型角标：无障碍名称写明是哪个文件，不然读屏只念「视频」「图片」 -->
      <button
        type="button"
        class="cover"
        :title="e.type === 'dir' ? `打开文件夹「${e.name}」` : `预览「${e.name}」`"
        :aria-label="e.type === 'dir' ? `打开文件夹「${e.name}」` : `预览「${e.name}」`"
        @click="emit('open', e)"
      >
        <Thumb v-if="e.type === 'image'" :src="e.thumb || e.url" :ratio="4 / 3" width="100%" />
        <template v-else-if="e.type === 'video' && posterOf(e)">
          <Thumb :src="posterOf(e)" :ratio="4 / 3" width="100%" icon="film" />
          <span class="play" aria-hidden="true"><AIcon name="play" :size="14" /></span>
        </template>
        <span v-else class="ph"><AIcon :name="iconOf(e)" :size="30" :stroke="1.3" /></span>
        <span v-if="e.type !== 'dir'" class="badge" aria-hidden="true">{{ e.isThumb ? '小图' : typeText[e.type] }}</span>
      </button>
      <label class="pick" :title="sel.has(e.path) ? '取消选择' : '选择'">
        <input
          type="checkbox"
          :checked="sel.has(e.path)"
          :aria-label="`选择「${e.name}」`"
          @click="emit('toggle', e, $event)"
        >
      </label>
      <div class="info">
        <div class="name ellipsis" :title="e.name">{{ e.name }}</div>
        <div class="meta">
          <template v-if="e.type === 'dir'">{{ e.items ? `${fmtNum(e.items)} 项` : '空文件夹' }} · {{ fmtDate(e.mtime) }}</template>
          <template v-else>{{ fmtSize(e.size) }} · {{ fmtDate(e.mtime) }}</template>
        </div>
        <div v-if="e.isThumb" class="used" title="以 .thumb.jpg 结尾的是图片的小图，原图删掉或挪走后留下的，可以删掉">原图已不在的小图</div>
        <div v-else-if="e.type !== 'dir'" class="used" :class="{ on: usedCount(e) }">{{ usageText(e) }}</div>
      </div>
      <div class="acts">
        <template v-if="e.type !== 'dir'">
          <button type="button" class="act" title="复制地址" :aria-label="`复制「${e.name}」的地址`" @click="emit('copy', e)"><AIcon name="copy" :size="14" /></button>
          <button type="button" class="act" title="预览" :aria-label="`预览「${e.name}」`" @click="emit('preview', e)"><AIcon name="eye" :size="14" /></button>
        </template>
        <button type="button" class="act" title="重命名" :aria-label="`重命名「${e.name}」`" @click="emit('rename', e)"><AIcon name="edit" :size="14" /></button>
        <button
          type="button"
          class="act danger"
          :title="e.type === 'dir' && e.items ? `删除（文件夹里还有 ${e.items} 项，要先清空）` : '删除'"
          :aria-label="`删除「${e.name}」`"
          @click="emit('delete', e)"
        ><AIcon name="trash" :size="14" /></button>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 12px; }
.cell { position: relative; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); transition: border-color .12s; }
.cell:hover, .cell:focus-within { border-color: #3a3a3a; }
.cell.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.cover { position: relative; display: block; width: 100%; aspect-ratio: 4 / 3; overflow: hidden; background: #161616; }
.cover :deep(.thumb) { border-radius: 0; }
.ph { display: grid; width: 100%; height: 100%; place-items: center; color: var(--t3); }
.cell.dir .ph { color: var(--t2); background: #141414; }
.cell.video .ph { color: var(--t2); }
.play { position: absolute; top: 50%; left: 50%; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: rgba(0, 0, 0, .6); color: #fff; transform: translate(-50%, -50%); }
.badge { position: absolute; bottom: 6px; left: 6px; height: 18px; padding: 0 6px; border-radius: 4px; background: rgba(0, 0, 0, .65); color: #ddd; font-size: 11px; line-height: 18px; }
/* 勾选框：盖在缩略图左上角；平时隐藏，移上去 / 聚焦 / 已勾选 / 正在多选时显示 */
.pick { position: absolute; top: 0; left: 0; z-index: 1; display: grid; place-items: center; width: 36px; height: 36px; cursor: pointer; opacity: 0; transition: opacity .12s; }
.pick input { width: 16px; height: 16px; margin: 0; cursor: pointer; }
.pick::before { content: ''; position: absolute; top: 7px; left: 7px; width: 22px; height: 22px; border-radius: 6px; background: rgba(0, 0, 0, .55); }
.pick input { position: relative; }
.cell:hover .pick, .cell:focus-within .pick, .cell.on .pick, .selecting .pick { opacity: 1; }
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
