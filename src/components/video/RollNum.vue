<script setup>
import { onDeactivated, ref, watch } from 'vue'

/*
 * 会「翻动」的数字 / 短文字：值变了，旧的往上滑走、新的从下面滑进来（变小时方向相反），不再一下子跳过去。
 * 只在值真的变了时动；第一次显示、页面被 KeepAlive 收起再回来都不动。
 *
 *   <RollNum :value="formatCount(likes)" :n="likes" />
 *
 * value：显示的文字；n：用来判断变大还是变小的数（不传就当变大）。
 * 不用 <Transition>：短视频每一条都挂好几个，换条时少建几层组件；旧值只在翻动的那一下多渲染一个 span。
 */
const props = defineProps({
  value: { type: [String, Number], default: '' },
  n: { type: Number, default: null }
})

/** 正在翻走的旧值 { text, key }；新值的进场动画播完（比旧值离场长）就清掉 */
const out = ref(null)
const dir = ref('up')
let seq = 0
watch(() => [props.value, props.n], ([v, n], [ov, on]) => {
  if (v === ov) return
  dir.value = n == null || on == null || n >= on ? 'up' : 'down'
  out.value = { text: ov, key: ++seq }
})
/* 收起时动画会被打断，再挂回来浏览器会从头重播：直接收尾 */
onDeactivated(() => { out.value = null })
</script>

<template>
  <span class="roll" :class="dir">
    <span :key="value" class="roll-v" :class="{ in: out }" @animationend.self="out = null">{{ value }}</span>
    <span v-if="out" :key="`o${out.key}`" class="roll-v out" aria-hidden="true">{{ out.text }}</span>
  </span>
</template>

<style scoped>
/* 两层叠在同一格里（换的时候宽度取两者较宽的），上下裁掉，看起来像里程表在转；左右留一点余量，文字阴影不被裁掉 */
.roll {
  display: inline-grid;
  margin: -2px -4px;
  padding: 2px 4px;
  overflow: hidden;
  vertical-align: top;
}
.roll-v { grid-area: 1 / 1; text-align: center; }
/*
 * 新旧两个值像同一条转轮上相邻的两格：同样的时长和曲线、始终相隔一整行一起走，字不会叠在一起。
 * （旧值要是用更短的加速曲线先走，起步慢、新值又来得快，中途两个数字会糊在同一个位置。）
 * 旧值停在看不见的位置，进场播完一起撤掉。
 */
.roll-v.in { animation: roll-in-up var(--dur-3) var(--ease-out); }
.roll-v.out { animation: roll-out-up var(--dur-3) var(--ease-out) forwards; }
.roll.down .roll-v.in { animation-name: roll-in-down; }
.roll.down .roll-v.out { animation-name: roll-out-down; }
@keyframes roll-in-up { from { opacity: 0; transform: translateY(100%); } }
@keyframes roll-out-up { to { opacity: 0; transform: translateY(-100%); } }
@keyframes roll-in-down { from { opacity: 0; transform: translateY(-100%); } }
@keyframes roll-out-down { to { opacity: 0; transform: translateY(100%); } }
</style>
