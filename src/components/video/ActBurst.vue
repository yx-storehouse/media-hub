<script setup>
/*
 * 点亮「赞 / 收藏」时图标周围的一圈小动效：一道细环扩散 + 七颗小点向外散开，单色（跟随 currentColor）。
 * 父组件用 v-if + key 挂上它就播一次，播完发 done，父组件把它撤掉：
 *
 *   <span class="ico"><Icon … /><ActBurst v-if="fx" :key="fx" @done="fx = 0" /></span>
 *
 * 外层 .ico 要 position: relative；这里只动 transform / opacity，不接收点击。
 */
defineEmits(['done'])

/** 七颗小点：均匀分布、整体错开半格，不和图标的竖直轴对齐，看起来更自然 */
const DOTS = Array.from({ length: 7 }, (_, i) => Math.round(i * (360 / 7) + 26))
</script>

<template>
  <span class="ab" aria-hidden="true">
    <i class="ab-ring" @animationend.self="$emit('done')" />
    <i v-for="a in DOTS" :key="a" class="ab-dot" :style="{ '--a': `${a}deg` }" />
  </span>
</template>

<style scoped>
.ab {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  pointer-events: none;
}
.ab-ring {
  position: absolute;
  left: -20px;
  top: -20px;
  width: 40px;
  height: 40px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  opacity: 0;
  animation: ab-ring var(--dur-4) var(--ease-out);
}
.ab-dot {
  position: absolute;
  left: -2px;
  top: -2px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0;
  animation: ab-dot var(--dur-4) var(--ease-out);
}
@keyframes ab-ring {
  0% { opacity: .9; transform: scale(.35); }
  100% { opacity: 0; transform: scale(1.15); }
}
/* 从图标边缘外一点开始散（图标回弹时会放大到约 1.2 倍，太靠里会被它盖住） */
@keyframes ab-dot {
  0% { opacity: 1; transform: rotate(var(--a)) translateY(-14px) scale(1); }
  100% { opacity: 0; transform: rotate(var(--a)) translateY(-28px) scale(.2); }
}
</style>
