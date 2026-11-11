<script setup>
import BottomSheet from '@/components/BottomSheet.vue'

/*
 * 确认弹层：退出登录、清空观看历史、取消关注这类点错了麻烦的操作，先问一句。
 *
 *   <ConfirmSheet v-model:open="asking" title="退出登录？" text="…" ok="退出登录" danger @confirm="signOut" />
 *
 * 底部升起，和其他弹层一样：返回键 / 返回手势、点遮罩、点「取消」都只是关掉；换页面时自动关。
 * 点确认按钮先关弹层，再发出 confirm。
 */
const open = defineModel('open', { type: Boolean, default: false })
defineProps({
  title: { type: String, required: true },
  /** 标题下面的说明（可选） */
  text: { type: String, default: '' },
  ok: { type: String, default: '确定' },
  /** 删除、退出这类操作：确认按钮用醒目的红字 */
  danger: Boolean
})
const emit = defineEmits(['confirm'])

function confirm() {
  open.value = false
  emit('confirm')
}
</script>

<template>
  <BottomSheet v-model:open="open" :title="title">
    <p v-if="text" class="cf-text">{{ text }}</p>
    <div class="cf-btns">
      <button type="button" class="cf-ok" :class="{ danger }" @click="confirm">{{ ok }}</button>
      <button type="button" class="cf-no" @click="open = false">取消</button>
    </div>
  </BottomSheet>
</template>

<style scoped>
.cf-text { margin: -4px 0 16px; color: var(--t2); font-size: 13px; line-height: 20px; }
.cf-btns { display: flex; flex-direction: column; gap: 10px; }
.cf-btns button { height: 46px; border-radius: 10px; font-size: 15px; }
.cf-ok { background: var(--accent); color: var(--on-accent); font-weight: 700; }
.cf-ok.danger { background: var(--chip); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06); color: #ff7a7a; font-weight: 600; }
.cf-no { background: var(--chip); color: var(--t1); }
.cf-btns button:active { filter: brightness(.9); }

/*
 * 桌面布局（≥ 1024px）：BottomSheet 是窗口正中的对话框，按钮按桌面对话框的习惯排成一行、靠右，
 * 确认在最右边（DOM 顺序不变：Tab 先到确认、再到取消）
 */
@media (min-width: 1024px) {
  .cf-text { margin: -8px 0 24px; font-size: 14px; line-height: 22px; }
  .cf-btns { flex-direction: row-reverse; justify-content: flex-start; gap: 12px; }
  .cf-btns button { min-width: 96px; height: 40px; padding: 0 20px; border-radius: 20px; font-size: 14px; }
  /* 对话框底色（#151515）上 --chip 几乎看不出来：次要按钮用亮一档的灰底 */
  .cf-no, .cf-ok.danger { background: #222; box-shadow: none; }
}
@media (min-width: 1024px) and (hover: hover) {
  .cf-btns button { transition: background-color var(--dur-2) var(--ease-out), opacity var(--dur-2) var(--ease-out); }
  .cf-ok:hover { opacity: .88; }
  .cf-ok.danger:hover { opacity: 1; background: #2a2a2a; }
  .cf-no:hover { background: #2a2a2a; }
}
</style>
