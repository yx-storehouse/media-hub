/*
 * 播放页的两个转圈（加载占位的 .ph-spin、播放器的缓冲转圈 .spinner，一圈 0.8 秒）旋转的相位按页面时间对齐：
 * 先后挂上的两个转圈是同一个角度，接口慢时占位换成播放器、转圈原地接上，不会跳一下。
 *
 *   <div class="spinner" :style="{ animationDelay: spinPhase() }" />   // 挂上的那一刻算一次
 */
const TURN_MS = 800

/** 给 animation-delay 用（rot 在第一个，后面的淡入不延迟） */
export const spinPhase = () => `${-Math.round(performance.now() % TURN_MS)}ms, 0ms`
