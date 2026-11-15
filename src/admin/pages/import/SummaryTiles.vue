<script setup>
import { computed } from 'vue'
import { fmtNum } from '../../utils/format'
import { useImportStore } from './store'

/*
 * 预检 / 导入的计数。「无变化」（更新已有时和库里一样、不写库的行）只在选了「更新已有」或者确实有这类行时显示，
 * 这样「将更新」里只剩真的会改的行，导出 → 改了 3 行 → 再导入时看到的就是 3。
 */
const props = defineProps({
  run: { type: Object, required: true },
  /** 预检用「将新增」，导入后用「已新增」 */
  dry: { type: Boolean, default: false }
})
const store = useImportStore()

const tiles = computed(() => [
  { key: 'created', label: props.dry ? '将新增' : '已新增', value: props.run.created, cls: 'ok' },
  { key: 'updated', label: props.dry ? '将更新' : '已更新', value: props.run.updated, cls: '' },
  ...(props.run.unchanged || store?.state.options.onDuplicate === 'update'
    ? [{ key: 'unchanged', label: '无变化', value: props.run.unchanged || 0, cls: 'dim' }]
    : []),
  { key: 'skipped', label: props.dry ? '将跳过' : '已跳过', value: props.run.skipped, cls: 'dim' },
  { key: 'failed', label: props.dry ? '有错误' : '失败', value: props.run.failed, cls: 'danger' }
])
</script>

<template>
  <div class="tiles" :style="{ '--n': tiles.length }">
    <div v-for="t in tiles" :key="t.key" class="tile" :class="[t.cls, { zero: !t.value }]">
      <span class="lbl">{{ t.label }}</span>
      <b class="val num">{{ fmtNum(t.value) }}</b>
    </div>
  </div>
</template>

<style scoped>
.tiles { display: grid; grid-template-columns: repeat(var(--n, 4), minmax(0, 1fr)); gap: 10px; }
.tile { display: flex; flex-direction: column; gap: 2px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
.lbl { color: var(--t2); font-size: 12px; }
.val { font-size: 22px; font-weight: 650; line-height: 1.3; }
.tile.ok .val { color: var(--ok); }
.tile.danger .val { color: var(--danger); }
.tile.dim .val { color: var(--t2); }
.tile.zero .val { color: var(--t3); }
@media (max-width: 640px) {
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
