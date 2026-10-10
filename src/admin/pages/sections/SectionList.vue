<script setup>
import ABtn from '../../components/ABtn.vue'
import AIcon from '../../components/AIcon.vue'
import StatusBadge from '../../components/StatusBadge.vue'
import EmptyState from '../../components/EmptyState.vue'
import { useDragSort } from '../../composables/useReorder'

/*
 * 首页推荐 · 左栏：分区列表。
 * 只负责显示和发出事件；顺序（拖动 / ↑ ↓）的状态在父组件里（useReorder），点「保存排序」才提交。
 * 「新建分区」只放在页头（一个入口），这里不再重复。
 */
const props = defineProps({
  /** 按当前（可能调整过的）顺序排好的分区 */
  sections: { type: Array, default: () => [] },
  selectedId: { type: [Number, String], default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  orderDirty: { type: Boolean, default: false },
  savingOrder: { type: Boolean, default: false },
  /** 正在新建（列表末尾显示一个「未保存」的临时项） */
  creating: { type: Boolean, default: false },
  newTitle: { type: String, default: '' }
})
const emit = defineEmits(['select', 'move', 'save-order', 'reset-order'])

/* 拖动：落点按鼠标在行的上半 / 下半决定插到前面还是后面 */
const drag = useDragSort({ onMove: (from, to) => emit('move', from, to) })
</script>

<template>
  <div class="sl card">
    <div class="sl-hd">
      <span>分区</span>
      <!-- 首次加载中 / 加载失败时不显示数量（不是真的 0 个） -->
      <span v-if="sections.length || (!loading && !error)" class="dim num">{{ sections.length }}</span>
    </div>

    <div v-if="orderDirty" class="sl-order" role="status">
      <span class="grow">顺序已调整</span>
      <ABtn size="sm" variant="ghost" :disabled="savingOrder" @click="emit('reset-order')">撤销</ABtn>
      <ABtn size="sm" variant="primary" icon="save" :loading="savingOrder" @click="emit('save-order')">保存排序</ABtn>
    </div>

    <div class="sl-body">
      <div v-if="loading && !sections.length" class="state"><span class="spinner lg" /></div>
      <!-- 失败：右栏有「重试」，这里只说明 -->
      <EmptyState v-else-if="error && !sections.length" variant="error" compact :retry="false" title="分区列表加载失败" :text="error" />
      <EmptyState v-else-if="!sections.length && !creating" compact icon="home" title="还没有分区" text="点右上角「新建分区」" />
      <ul v-else class="sl-list" @dragleave="drag.leave">
        <li
          v-for="(s, i) in sections"
          :key="s.id"
          class="sl-it"
          :class="[{ on: s.id === selectedId }, drag.itemClass(i)]"
          @dragover="drag.over($event, i)"
          @drop="drag.drop"
        >
          <span
            class="grip"
            draggable="true"
            title="拖动调整顺序"
            aria-hidden="true"
            @dragstart="drag.start(i, $event)"
            @dragend="drag.end"
          ><AIcon name="grip" :size="15" /></span>
          <button type="button" class="sl-main" :aria-current="s.id === selectedId ? 'true' : undefined" @click="emit('select', s.id)">
            <span class="sl-t">
              <span class="ellipsis">{{ s.title }}</span>
              <span v-if="s.isFeatured" class="chip outline" title="大卡分区">大卡</span>
            </span>
            <span class="sl-s ellipsis">
              {{ s.topicName || '未关联专题' }} · <span class="num">{{ s.batchCount }}</span> 批 × <span class="num">{{ s.itemCount }}</span> 个
            </span>
          </button>
          <span class="sl-side">
            <StatusBadge kind="creator" :status="s.status" :label="s.status === 1 ? '启用' : '停用'" />
            <span class="sl-mv">
              <ABtn size="sm" variant="ghost" icon="arrow-up" title="上移" :aria-label="`「${s.title}」上移`" :disabled="savingOrder || i === 0" @click="emit('move', i, i - 1)" />
              <ABtn size="sm" variant="ghost" icon="arrow-down" title="下移" :aria-label="`「${s.title}」下移`" :disabled="savingOrder || i === sections.length - 1" @click="emit('move', i, i + 1)" />
            </span>
          </span>
        </li>
        <li v-if="creating" class="sl-it on new">
          <span class="grip off"><AIcon name="plus" :size="15" /></span>
          <span class="sl-main">
            <span class="sl-t"><span class="ellipsis">{{ newTitle.trim() || '新建分区' }}</span></span>
            <span class="sl-s">未保存</span>
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.sl { display: flex; flex-direction: column; min-height: 0; }
.sl-hd { display: flex; flex: none; align-items: center; gap: 8px; height: 46px; padding: 0 10px 0 14px; border-bottom: 1px solid var(--line); font-weight: 600; }
.sl-order { display: flex; flex: none; align-items: center; gap: 6px; padding: 7px 8px 7px 14px; border-bottom: 1px solid rgba(227, 179, 65, .3); background: rgba(227, 179, 65, .07); color: var(--warn); font-size: 12.5px; }
.sl-body { flex: 1; min-height: 0; overflow-y: auto; }
.sl-list { padding: 6px; }
.sl-it { position: relative; display: flex; align-items: center; gap: 4px; margin-bottom: 2px; padding: 4px 6px 4px 2px; border-radius: 7px; }
.sl-it:hover { background: var(--hover); }
.sl-it.on { background: #202020; box-shadow: inset 2px 0 0 var(--accent); }
.sl-it.dragging { opacity: .45; }
.sl-it.drop-before::before, .sl-it.drop-after::after { content: ''; position: absolute; right: 6px; left: 6px; height: 2px; border-radius: 1px; background: var(--accent); }
.sl-it.drop-before::before { top: -2px; }
.sl-it.drop-after::after { bottom: -2px; }
.sl-it.new { border: 1px dashed var(--line-2); }

.grip { display: grid; flex: none; place-items: center; width: 20px; height: 30px; border-radius: 5px; color: var(--t3); cursor: grab; }
.grip:hover { background: var(--hover); color: var(--t1); }
.grip:active { cursor: grabbing; }
.grip.off { cursor: default; }
.grip.off:hover { background: none; color: var(--t3); }

.sl-main { display: flex; flex: 1; flex-direction: column; gap: 1px; min-width: 0; padding: 4px 2px; text-align: left; }
.sl-t { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--t1); font-weight: 500; }
.sl-s { color: var(--t3); font-size: 12px; }
.sl-side { display: flex; flex: none; flex-direction: column; align-items: flex-end; gap: 2px; }
.sl-mv { display: flex; opacity: .55; transition: opacity .12s; }
.sl-it:hover .sl-mv, .sl-it:focus-within .sl-mv, .sl-it.on .sl-mv { opacity: 1; }
</style>
