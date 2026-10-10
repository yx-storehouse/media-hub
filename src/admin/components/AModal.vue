<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount, useId } from 'vue'
import AIcon from './AIcon.vue'
import { pushLayer, popLayer, isTopLayer, layerZ, trapTab, focusInto, restoreFocus } from './layers'

/*
 * 居中对话框：<AModal v-model:open="show" title="标题"> 内容 <template #footer>按钮</template> </AModal>
 * Esc / 点遮罩 / 右上角 × 关闭（persistent 时点遮罩不关）；打开时焦点移入，关闭后还给打开它的按钮。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  width: { type: [Number, String], default: 480 },
  /** 点遮罩不关闭（表单填到一半时防误触） */
  persistent: { type: Boolean, default: false },
  /** 显示右上角关闭按钮 */
  closable: { type: Boolean, default: true },
  /** 内容区不留内边距（列表、网格自己控制） */
  flush: { type: Boolean, default: false }
})
const emit = defineEmits(['update:open', 'close'])

const panel = ref(null)
const titleId = useId()
let layer = 0
let opener = null
let downOnMask = false

const z = computed(() => (layer ? layerZ(layer) : 1000))
const panelWidth = computed(() => (typeof props.width === 'number' ? props.width + 'px' : props.width))

function onKey(e) {
  if (!layer || !isTopLayer(layer)) return
  if (e.key === 'Escape' && props.closable) { e.preventDefault(); close() }
  else if (e.key === 'Tab') trapTab(e, panel.value)
}

function close() {
  emit('update:open', false)
  emit('close')
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
onBeforeUnmount(() => setup(false))

/* 只有按下和松开都在遮罩上才算点遮罩（从输入框里拖选文字拖到外面不应关闭） */
const maskDown = e => { downOnMask = e.target === e.currentTarget }
const maskClick = e => {
  if (downOnMask && e.target === e.currentTarget && !props.persistent && props.closable) close()
  downOnMask = false
}

defineExpose({ close })
</script>

<template>
  <Teleport to="body">
    <Transition name="a-modal">
      <div v-if="open" class="a-mask" :style="{ zIndex: z }" @mousedown="maskDown" @click="maskClick">
        <div
          ref="panel"
          class="a-modal"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="title ? titleId : undefined"
          tabindex="-1"
          :style="{ width: panelWidth }"
        >
          <header v-if="title || closable || $slots.header" class="a-hd">
            <slot name="header">
              <h3 :id="titleId" class="a-title">{{ title }}</h3>
            </slot>
            <button v-if="closable" type="button" class="a-x" aria-label="关闭" @click="close">
              <AIcon name="x" :size="16" />
            </button>
          </header>
          <div class="a-body" :class="{ flush }">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="a-ft">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.a-mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  background: rgba(0, 0, 0, .62);
}
.a-modal {
  display: flex;
  flex-direction: column;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  border: 1px solid var(--line-2);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: var(--shadow);
}
.a-hd { display: flex; flex: none; align-items: center; gap: 10px; min-height: 50px; padding: 0 12px 0 20px; border-bottom: 1px solid var(--line); }
.a-title { flex: 1; min-width: 0; overflow: hidden; font-size: 15px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.a-x { display: grid; place-items: center; width: 28px; height: 28px; margin-left: auto; border-radius: 6px; color: var(--t2); }
.a-x:hover { background: var(--hover); color: var(--t1); }
.a-body { flex: 1; min-height: 0; padding: 18px 20px; overflow: auto; }
.a-body.flush { padding: 0; }
.a-ft { display: flex; flex: none; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--line); }

.a-modal-enter-active, .a-modal-leave-active { transition: opacity .16s; }
.a-modal-enter-active .a-modal, .a-modal-leave-active .a-modal { transition: transform .16s; }
.a-modal-enter-from, .a-modal-leave-to { opacity: 0; }
.a-modal-enter-from .a-modal, .a-modal-leave-to .a-modal { transform: translateY(8px) scale(.98); }
</style>
