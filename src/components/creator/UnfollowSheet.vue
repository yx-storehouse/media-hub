<script setup>
import BottomSheet from '@/components/BottomSheet.vue'

/*
 * 取消关注前确认（帖子详情、创作者主页共用）：点「已关注」先弹这个底部面板，点「不再关注」才真的取消。
 *   <UnfollowSheet v-model:open="asking" :name="author.name" @confirm="unfollow" />
 * 遮罩、「取消」、返回键 / 返回手势都只关面板（BottomSheet 已接好返回键），换页面时自动关。
 * 外观和「我的」里的确认弹层（components/me/ConfirmSheet.vue）一致。
 */
const open = defineModel('open', { type: Boolean, default: false })
defineProps({ name: { type: String, default: '' } })
const emit = defineEmits(['confirm'])

function confirm() {
  open.value = false
  emit('confirm')
}
</script>

<template>
  <BottomSheet v-model:open="open" :title="name ? `不再关注「${name}」？` : '不再关注这位创作者？'">
    <p class="uf-text">之后社区「关注」里不再显示 TA 的新帖子，随时可以重新关注。</p>
    <div class="uf-btns">
      <!-- m-press：按下缩一点、松手弹回（components/motion/press.js） -->
      <button type="button" class="uf-ok m-press" @click="confirm">不再关注</button>
      <button type="button" class="uf-no m-press" @click="open = false">取消</button>
    </div>
  </BottomSheet>
</template>

<style scoped>
.uf-text { margin: -4px 0 16px; color: var(--t2); font-size: 13px; line-height: 20px; }
.uf-btns { display: flex; flex-direction: column; gap: 10px; }
.uf-btns button { height: 46px; border-radius: 10px; font-size: 15px; }
.uf-ok { background: var(--chip); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06); color: #ff7a7a; font-weight: 600; }
.uf-no { background: var(--chip); color: var(--t1); }
.uf-btns button { transition: filter var(--dur-1) var(--ease-out); }
.uf-btns button:active { filter: brightness(.9); }
</style>
