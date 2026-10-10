<script setup>
import { ref, computed, watch, nextTick, provide, onBeforeUnmount, useId } from 'vue'
import AIcon from './AIcon.vue'
import { confirmDialog } from './confirm'
import { pushLayer, popLayer, isTopLayer, layerZ, trapTab, focusInto, restoreFocus } from './layers'
import { UPLOAD_GUARD } from '../composables/useUploader'

/*
 * 右侧抽屉（编辑器）：
 *   <ADrawer v-model:open="editor.open" title="编辑热词" :dirty="editor.dirty" @save="editor.submit()">
 *     表单… <template #footer>取消 / 保存</template>
 *   </ADrawer>
 * Esc、点遮罩、× 都会关闭；dirty 时先确认「有未保存的修改，确定关闭？」。
 * busy（保存请求进行中，传 editor.saving）时关不掉：免得用户以为「放弃修改」撤销了已经发出去的保存。
 * 抽屉里的组件用 useUploader 上传时，还没传完就关会先确认（关闭 = 取消上传）。
 * 抽屉在最上层时按 Ctrl/⌘+S 触发 save 事件。打开时焦点移入，关闭后还给打开它的按钮。
 * 页面里的「取消」按钮请调用 ref 上的 requestClose()，同样会走未保存确认。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  width: { type: [Number, String], default: 560 },
  dirty: { type: Boolean, default: false },
  /** 内容加载中（显示转圈，不渲染表单） */
  loading: { type: Boolean, default: false },
  /** 请求进行中（保存 / 删除）：暂时不能关闭 */
  busy: { type: Boolean, default: false }
})
const emit = defineEmits(['update:open', 'close', 'save'])

const panel = ref(null)
const titleId = useId()
let layer = 0
let opener = null
let asking = false
let downOnMask = false

const z = computed(() => (layer ? layerZ(layer) : 1000))
const panelWidth = computed(() => (typeof props.width === 'number' ? props.width + 'px' : props.width))

/* 抽屉里正在进行的上传数（useUploader 通过 inject 登记） */
const uploads = ref(0)
provide(UPLOAD_GUARD, { add: () => { uploads.value++ }, remove: () => { uploads.value = Math.max(0, uploads.value - 1) } })

async function requestClose() {
  if (asking || props.busy) return false
  if (props.dirty || uploads.value > 0) {
    asking = true
    const ok = await confirmDialog(uploads.value > 0
      ? { title: '取消上传？', message: '还有文件正在上传，关闭后会取消上传' + (props.dirty ? '，未保存的修改也会丢失' : '') + '。确定关闭？', confirmText: '关闭', danger: true }
      : { title: '放弃修改？', message: '有未保存的修改，确定关闭？', confirmText: '放弃修改', danger: true })
    asking = false
    // 确认期间保存开始了（Ctrl+S）：不关
    if (!ok || props.busy) return false
  }
  emit('update:open', false)
  emit('close')
  return true
}

function onKey(e) {
  if (!layer || !isTopLayer(layer)) return
  if (e.key === 'Escape') { e.preventDefault(); requestClose() }
  else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); emit('save') }
  else if (e.key === 'Tab') trapTab(e, panel.value)
}

function setup(on) {
  if (on && !layer) {
    opener = document.activeElement
    layer = pushLayer()
    document.addEventListener('keydown', onKey)
    nextTick(() => focusInto(panel.value))
  } else if (!on && layer) {
    popLayer(layer)
    layer = 0
    document.removeEventListener('keydown', onKey)
    const el = opener
    opener = null
    nextTick(() => restoreFocus(el))
  }
}
watch(() => props.open, setup, { immediate: true })
/* 内容异步加载完成后再把焦点放进第一个输入框 */
watch(() => props.loading, (v, old) => { if (old && !v && props.open) nextTick(() => focusInto(panel.value)) })
onBeforeUnmount(() => setup(false))

const maskDown = e => { downOnMask = e.target === e.currentTarget }
const maskClick = e => {
  if (downOnMask && e.target === e.currentTarget) requestClose()
  downOnMask = false
}

defineExpose({ requestClose })
</script>

<template>
  <Teleport to="body">
    <Transition name="a-drawer">
      <div v-if="open" class="a-mask" :style="{ zIndex: z }" @mousedown="maskDown" @click="maskClick">
        <aside
          ref="panel"
          class="a-drawer"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
          :style="{ width: panelWidth }"
        >
          <header class="a-hd">
            <h3 :id="titleId" class="a-title">{{ title }}</h3>
            <span v-if="dirty" class="dirty" title="有未保存的修改">未保存</span>
            <slot name="header" />
            <button type="button" class="a-x" aria-label="关闭" :disabled="busy" @click="requestClose">
              <AIcon name="x" :size="16" />
            </button>
          </header>
          <div class="a-body">
            <div v-if="loading" class="state"><span class="spinner lg" /></div>
            <slot v-else />
          </div>
          <footer v-if="$slots.footer" class="a-ft">
            <span class="kb-hint"><span class="kbd">Ctrl</span> + <span class="kbd">S</span> 保存</span>
            <slot name="footer" />
          </footer>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.a-mask { position: fixed; inset: 0; display: flex; justify-content: flex-end; background: rgba(0, 0, 0, .5); }
.a-drawer {
  display: flex;
  flex-direction: column;
  max-width: 100vw;
  height: 100%;
  border-left: 1px solid var(--line-2);
  background: var(--panel);
  box-shadow: var(--shadow);
}
.a-hd { display: flex; flex: none; align-items: center; gap: 10px; height: 54px; padding: 0 12px 0 22px; border-bottom: 1px solid var(--line); }
.a-title { min-width: 0; overflow: hidden; font-size: 15px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.dirty { flex: none; height: 18px; padding: 0 6px; border-radius: 9px; background: rgba(227, 179, 65, .12); color: var(--warn); font-size: 11px; line-height: 18px; }
.a-x { display: grid; flex: none; place-items: center; width: 30px; height: 30px; margin-left: auto; border-radius: 6px; color: var(--t2); }
.a-x:hover:not(:disabled) { background: var(--hover); color: var(--t1); }
.a-x:disabled { opacity: .4; }
.a-body { flex: 1; min-height: 0; padding: 20px 22px 28px; overflow-y: auto; overscroll-behavior: contain; }
.a-ft { display: flex; flex: none; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 22px; border-top: 1px solid var(--line); background: #141414; }
.kb-hint { margin-right: auto; color: var(--t3); font-size: 12px; }

.a-drawer-enter-active, .a-drawer-leave-active { transition: opacity .2s; }
.a-drawer-enter-active .a-drawer, .a-drawer-leave-active .a-drawer { transition: transform .22s cubic-bezier(.2, .8, .2, 1); }
.a-drawer-enter-from, .a-drawer-leave-to { opacity: 0; }
.a-drawer-enter-from .a-drawer, .a-drawer-leave-to .a-drawer { transform: translateX(32px); }
@media (max-width: 640px) {
  .kb-hint { display: none; }
}
</style>
