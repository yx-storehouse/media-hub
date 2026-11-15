<script setup>
import { computed, ref } from 'vue'
import { ApiError, errorText, isNetworkError, MSG } from '@/api/http'
import { useReconnect, isOffline } from '@/composables/useReconnect'

/*
 * 页面 / 列表的出错状态和空状态，全 App 一个样子、一套说法（样式是 styles/common.css 的 .empty / .retry / .sub）：
 *
 *   <LoadState v-if="error" :error="error" :retry="load" />                 // 出错：统一的说法 + 「重试」，会自动重试
 *   <LoadState v-else-if="!list.length" empty text="还没有收藏" sub="看到喜欢的点一下收藏" />
 *   <LoadState :error="error" :retry="load" inline />                       // 列表底部「加载更多」失败：留白小一点
 *   <LoadState :error="error"><button class="retry" @click="back">返回</button></LoadState>   // 自己的按钮放默认插槽
 *
 * props
 *   error   出错（Error / ApiError / 字符串 / true）。文字用 api/http.js 的 errorText：断网「网络连接失败，请检查网络」、
 *           超时「请求超时，请检查网络」、5xx 和网关错误页「服务器开小差了，请稍后重试」，4xx 用接口的说明；
 *           浏览器报告断网时是「网络已断开，连上网后会自动重新加载」。传字符串就原样显示。
 *   retry   重试函数：有它才显示「重试」按钮；出错是「连不上 / 服务器出错」这一类时还会自动重试
 *           （联网时马上、页面看得见时每 12 秒起越来越慢，见 composables/useReconnect.js）。4xx（内容不存在）不自动重试。
 *   empty   空状态（没有 error 时）：text 是说明，sub 是第二行小字
 *   text / sub   自定义文字（出错时 text 会代替自动的说法）
 *   retryText   按钮文字，默认「重试」
 *   inline  列表底部用：上下留白小一点
 * 读屏：出错是 role="alert"，空状态是 role="status"。
 */
const props = defineProps({
  error: { type: [Object, String, Boolean, Error], default: null },
  retry: { type: Function, default: null },
  empty: { type: Boolean, default: false },
  text: { type: String, default: '' },
  sub: { type: String, default: '' },
  retryText: { type: String, default: '重试' },
  inline: { type: Boolean, default: false }
})

const failed = computed(() => !!props.error)
/* 能自动恢复的错误：连不上、超时、5xx、网关页面（字符串 / true 当作这一类）；4xx 是接口正常的答复，重试也一样 */
const recoverable = computed(() => {
  const e = props.error
  if (!e) return false
  if (typeof e === 'string' || e === true) return true
  return isNetworkError(e) || !(e instanceof ApiError)
})

/* 重试进行中：按钮不能再点、满 0.25 秒还没结果才变灰（出错状态在重试期间不撤，慢的时候不至于点了没反应） */
const busy = ref(false)
async function doRetry() {
  if (busy.value || !props.retry) return
  busy.value = true
  try {
    await props.retry()
  } catch { /* 页面自己会显示新的出错 */ }
  busy.value = false
}

useReconnect(doRetry, () => failed.value && recoverable.value && !!props.retry)

const message = computed(() => {
  if (!props.error) return props.text || '暂无内容'
  if (props.text) return props.text
  if (recoverable.value && isOffline.value) return MSG.offline
  if (typeof props.error === 'string') return props.error
  return errorText(props.error === true ? null : props.error)
})
</script>

<template>
  <div class="empty ls" :class="{ inline }" :role="error ? 'alert' : 'status'">
    <p>{{ message }}</p>
    <p v-if="sub" class="sub">{{ sub }}</p>
    <slot>
      <button v-if="error && retry" type="button" class="retry" :disabled="busy" :aria-busy="busy" @click="doRetry">{{ retryText }}</button>
    </slot>
  </div>
</template>

<style scoped>
.ls.inline { padding: 20px 0; }
.ls .retry { transition: background-color var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out), opacity var(--dur-1) var(--ease-out); }
/* 和「我的」的 .me-retry 一样：满 0.25 秒还没结果才变灰（自动重试很快失败时按钮不闪） */
.ls .retry:disabled { opacity: .5; transition-delay: .25s; }
</style>
