<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import AIcon from './AIcon.vue'
import { setBottomInset } from './toast'

/*
 * 批量操作条：勾选了行才出现，贴在内容区底部。
 * <BatchBar :count="selected.length" @clear="clearSelection"> <ABtn size="sm">上架</ABtn> … </BatchBar>
 */
defineProps({
  count: { type: Number, default: 0 },
  /** 正在执行批量操作（按钮由页面自己禁用，这里只显示转圈） */
  busy: { type: Boolean, default: false }
})
const emit = defineEmits(['clear'])

/*
 * 显示时把自己占用的高度（含底部外边距）登记给提示条，右下角的提示条叠到它上面。
 * 按钮多时会换成两排：用 ResizeObserver 跟着实际高度走，不写死。
 */
const el = ref(null)
const key = Symbol('batch-bar')
let ro = null
function measure() {
  const b = el.value
  if (!b) return setBottomInset(key, 0)
  setBottomInset(key, b.offsetHeight + (parseFloat(getComputedStyle(b).marginBottom) || 0))
}
watch(el, b => {
  ro?.disconnect()
  ro = null
  if (b && typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(b) }
  measure()
}, { flush: 'post' })
onBeforeUnmount(() => { ro?.disconnect(); setBottomInset(key, 0) })
</script>

<template>
  <Transition name="bb">
    <div v-if="count > 0" ref="el" class="bb" role="region" aria-label="批量操作">
      <span class="cnt">已选 <b class="num">{{ count }}</b> 项</span>
      <span v-if="busy" class="spinner" aria-label="处理中" />
      <div class="acts"><slot /></div>
      <button type="button" class="clr" @click="emit('clear')">
        <AIcon name="x" :size="14" />取消选择
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.bb {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 0 24px 16px;
  padding: 10px 12px 10px 16px;
  border: 1px solid var(--line-2);
  border-radius: 10px;
  background: #1a1a1a;
  box-shadow: 0 -8px 30px rgba(0, 0, 0, .5);
}
.cnt { color: var(--t2); white-space: nowrap; }
.cnt b { color: var(--t1); }
.acts { display: flex; flex: 1; flex-wrap: wrap; align-items: center; gap: 6px; }
.clr { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px; border-radius: 6px; color: var(--t2); white-space: nowrap; }
.clr:hover { background: var(--hover); color: var(--t1); }

.bb-enter-active, .bb-leave-active { transition: opacity .16s, transform .16s; }
.bb-enter-from, .bb-leave-to { opacity: 0; transform: translateY(10px); }
</style>
