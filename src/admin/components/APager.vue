<script setup>
import { computed, ref } from 'vue'
import AIcon from './AIcon.vue'

/*
 * 分页：<APager v-model:page="query.page" v-model:page-size="query.pageSize" :total="total" />
 * 「共 N 条」+ 上一页 / 页码（中间省略）/ 下一页 + 每页条数 + 跳页。
 * total 为 0 时整个不显示：首次加载中、加载失败（useListPage 会把 total 清零）、没有数据，这时表格里已经有对应的提示。
 */
const props = defineProps({
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 20 },
  total: { type: Number, default: 0 },
  pageSizes: { type: Array, default: () => [20, 50, 100, 200] },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:page', 'update:pageSize'])

const pages = computed(() => Math.max(1, Math.ceil(props.total / (props.pageSize || 20))))
const cur = computed(() => Math.min(Math.max(1, props.page), pages.value))

/* 页码：1 … 4 5 [6] 7 8 … 20 */
const items = computed(() => {
  const n = pages.value
  const c = cur.value
  if (n <= 9) return Array.from({ length: n }, (_, i) => i + 1)
  const out = [1]
  let a = Math.max(2, c - 2)
  let b = Math.min(n - 1, c + 2)
  if (c <= 4) { a = 2; b = 6 }
  if (c >= n - 3) { a = n - 5; b = n - 1 }
  if (a > 2) out.push('…l')
  for (let i = a; i <= b; i++) out.push(i)
  if (b < n - 1) out.push('…r')
  out.push(n)
  return out
})

function go(p) {
  const n = Math.min(Math.max(1, p), pages.value)
  if (n !== props.page) emit('update:page', n)
}
const jump = ref('')
function doJump() {
  const n = parseInt(jump.value, 10)
  if (Number.isFinite(n)) go(n)
  jump.value = ''
}
function setSize(e) {
  emit('update:pageSize', Number(e.target.value))
  emit('update:page', 1)
}
</script>

<template>
  <nav v-if="total > 0" class="pager" aria-label="分页">
    <span class="total">共 <b class="num">{{ total.toLocaleString() }}</b> 条</span>
    <div class="nums">
      <button type="button" class="pg" :disabled="disabled || cur <= 1" aria-label="上一页" @click="go(cur - 1)">
        <AIcon name="chevron-left" :size="14" />
      </button>
      <template v-for="it in items" :key="it">
        <span v-if="typeof it === 'string'" class="gap" aria-hidden="true">…</span>
        <button
          v-else
          type="button"
          class="pg num"
          :class="{ on: it === cur }"
          :disabled="disabled"
          :aria-current="it === cur ? 'page' : undefined"
          :aria-label="`第 ${it} 页`"
          @click="go(it)"
        >{{ it }}</button>
      </template>
      <button type="button" class="pg" :disabled="disabled || cur >= pages" aria-label="下一页" @click="go(cur + 1)">
        <AIcon name="chevron-right" :size="14" />
      </button>
    </div>
    <label class="size">
      <span class="sr-only">每页条数</span>
      <select class="a-input sm" :value="pageSize" :disabled="disabled" @change="setSize">
        <option v-for="s in pageSizes" :key="s" :value="s">{{ s }} 条/页</option>
      </select>
    </label>
    <label v-if="pages > 9" class="jump">
      跳至
      <input v-model="jump" class="a-input sm num" type="text" inputmode="numeric" aria-label="跳转到第几页" @keydown.enter="doJump" @blur="jump && doJump()">
      页
    </label>
  </nav>
</template>

<style scoped>
.pager { display: flex; flex: none; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 12px 0 14px; color: var(--t2); font-size: 12.5px; }
.total b { color: var(--t1); font-weight: 600; }
.nums { display: flex; align-items: center; gap: 2px; margin-left: auto; }
.pg { display: grid; place-items: center; min-width: 28px; height: 28px; padding: 0 6px; border-radius: 6px; color: var(--t2); font-size: 12.5px; }
.pg:hover:not(:disabled):not(.on) { background: var(--hover); color: var(--t1); }
.pg.on { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.pg:disabled:not(.on) { opacity: .35; }
.gap { width: 20px; color: var(--t3); text-align: center; }
.size select { width: auto; padding-right: 6px; cursor: pointer; }
.jump { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.jump input { width: 52px; text-align: center; }
</style>
