<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getHotWords } from '@/api'
import { useRecentSearches } from '@/components/search/recent'
import Icon from '@/components/Icon.vue'

/*
 * 桌面顶栏的搜索框（窗口中间，最宽约 560px）。
 *   - 按「/」聚焦（正在输入框里打字、或者开着弹层 / 看大图时不抢）；
 *   - 聚焦时下面展开建议：近期搜索（和搜索页同一份：登录后存服务端、未登录存本机，× 删一个）+ 热门搜索
 *     （和搜索页同一个接口，只列搜得到东西的词）；打了字就只留包含这些字的；
 *   - ↑ ↓ 在建议里移动，回车搜选中的那个（没选就搜框里的字），Esc 先收起建议、再按一次离开输入框；
 *   - 回车去 #/search?q=…；已经在搜索页上：建议页上搜多一条历史，结果页里换词替换地址（和搜索页自己的规则一致），
 *     保留「视频 / 帖子」标签；
 *   - 在搜索页上，框里显示的就是地址栏里的关键词。
 */
const PLACEHOLDER = '搜您想搜,看您所想'
const RECENT_MAX = 6
const HOT_MAX = 8

const route = useRoute()
const router = useRouter()
const recent = useRecentSearches()

const inputEl = ref(null)
const text = ref('')
const focused = ref(false)
const popOpen = ref(false)
const active = ref(-1)

/* ---------- 建议 ---------- */

const hot = shallowRef([])
let hotState = 0 // 0 没取过 / 1 取着 / 2 取到了
async function loadHot() {
  if (hotState) return
  hotState = 1
  try {
    const words = await getHotWords(0)
    hot.value = Array.isArray(words) ? words.filter(w => w && w.word) : []
    hotState = 2
  } catch {
    hotState = 0 // 下次聚焦再试
  }
}
let recentAt = 0
function refresh() {
  loadHot()
  // 近期搜索可能刚在搜索页里变过：聚焦时重新读一次（几秒内反复聚焦不重复读）
  if (performance.now() - recentAt > 4000) {
    recentAt = performance.now()
    recent.load()
  }
}

const options = computed(() => {
  const q = text.value.trim().toLowerCase()
  const match = w => !q || w.toLowerCase().includes(q)
  const rec = recent.list.value.filter(match).slice(0, RECENT_MAX)
  const seen = new Set(rec)
  const hw = hot.value.filter(w => match(w.word) && !seen.has(w.word)).slice(0, HOT_MAX)
  return [
    ...rec.map(w => ({ kind: 'recent', word: w })),
    ...hw.map(w => ({ kind: 'hot', word: w.word, hot: !!w.hot }))
  ]
})
const recentOpts = computed(() => options.value.filter(o => o.kind === 'recent'))
const hotOpts = computed(() => options.value.filter(o => o.kind === 'hot'))
const showPop = computed(() => popOpen.value && options.value.length > 0)
watch(options, () => { if (active.value >= options.value.length) active.value = -1 })
const optId = i => `dsr-opt-${i}`
const activeDesc = computed(() => (showPop.value && active.value >= 0 ? optId(active.value) : undefined))

/* ---------- 搜索 ---------- */

const queryParam = raw => (typeof raw === 'string' ? raw.trim() : '')

function submit(word) {
  const q = String(word ?? text.value).trim()
  popOpen.value = false
  active.value = -1
  inputEl.value?.blur()
  if (route.name === 'search') {
    text.value = q
    const cur = queryParam(route.query.q)
    if (q === cur) return
    const type = route.query.type === 'post' ? { type: 'post' } : {}
    const to = { path: '/search', query: { ...(q ? { q } : {}), ...type } }
    /* 和搜索页自己的规则一致：从建议页（没有关键词）搜索多一条历史，返回回到建议页；结果页里换词替换 */
    if (!cur && q) router.push(to)
    else router.replace(to)
    return
  }
  // 空着回车：去搜索页（近期搜索 / 热门搜索 / 热门创作者）
  router.push(q ? { path: '/search', query: { q } } : '/search')
}

function clear() {
  text.value = ''
  active.value = -1
  popOpen.value = true
  inputEl.value?.focus()
}

/* ---------- 键盘 ---------- */

function onKey(e) {
  const n = options.value.length
  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      e.preventDefault()
      if (!popOpen.value) { popOpen.value = true; return }
      if (!n) return
      if (e.key === 'ArrowDown') active.value = active.value >= n - 1 ? 0 : active.value + 1
      else active.value = active.value <= 0 ? n - 1 : active.value - 1
      document.getElementById(optId(active.value))?.scrollIntoView({ block: 'nearest' })
      return
    case 'Enter':
      // 输入法确认候选词的那次回车不算（Safari 报 keyCode 229）
      if (e.isComposing || e.keyCode === 229) return
      e.preventDefault()
      submit(showPop.value && active.value >= 0 ? options.value[active.value].word : undefined)
      return
    case 'Escape':
      e.preventDefault()
      if (showPop.value) { popOpen.value = false; active.value = -1 } else inputEl.value?.blur()
      return
    case 'Tab':
      popOpen.value = false
      return
  }
}

function onInput() {
  popOpen.value = true
  active.value = -1
}
function onFocus() {
  focused.value = true
  popOpen.value = true
  refresh()
}
function onBlur() {
  focused.value = false
  popOpen.value = false
  active.value = -1
}

/* 「/」聚焦搜索框 */
function onDocKey(e) {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return
  const t = e.target
  if (t instanceof Element && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
  if (document.querySelector('[aria-modal="true"]')) return
  e.preventDefault()
  inputEl.value?.focus()
  inputEl.value?.select()
}
onMounted(() => document.addEventListener('keydown', onDocKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onDocKey))

/* 在搜索页上：框里就是地址栏的关键词；离开搜索页清空（正在输入时不动） */
watch(() => (route.name === 'search' ? queryParam(route.query.q) : null), q => {
  if (focused.value) return
  text.value = q || ''
}, { immediate: true })
/* 换页面时收起建议 */
watch(() => route.fullPath, () => { popOpen.value = false })
</script>

<template>
  <div class="dsr" :class="{ focus: focused, open: showPop }" role="search">
    <div class="dsr-box">
      <div class="dsr-field">
        <Icon name="search" class="dsr-ic" />
        <input
          ref="inputEl"
          v-model="text"
          type="search"
          role="combobox"
          aria-label="搜索"
          aria-autocomplete="list"
          aria-controls="dsr-pop"
          :aria-expanded="showPop"
          :aria-activedescendant="activeDesc"
          :placeholder="PLACEHOLDER"
          autocomplete="off"
          spellcheck="false"
          enterkeyhint="search"
          maxlength="100"
          @keydown="onKey"
          @input="onInput"
          @focus="onFocus"
          @blur="onBlur"
        >
        <button v-show="text" type="button" class="dsr-clr" tabindex="-1" aria-label="清除" @mousedown.prevent @click="clear"><Icon name="close" /></button>
        <kbd v-show="!focused && !text" class="dsr-kbd" aria-hidden="true">/</kbd>
      </div>
      <button type="button" class="dsr-go" aria-label="搜索" title="搜索" @mousedown.prevent @click="submit()"><Icon name="search" /></button>
    </div>

    <!-- 建议：点按不让输入框失焦（mousedown.prevent），点完再搜 -->
    <div v-show="showPop" id="dsr-pop" class="dsr-pop" role="listbox" aria-label="搜索建议" @mousedown.prevent>
      <div v-if="recentOpts.length" class="dsr-h">近期搜索</div>
      <div
        v-for="(o, i) in recentOpts"
        :id="optId(i)"
        :key="'r' + o.word"
        class="dsr-o"
        :class="{ on: active === i }"
        role="option"
        :aria-selected="active === i"
        @mousemove="active = i"
        @click="submit(o.word)"
      >
        <Icon name="history" class="oi" />
        <span class="ow">{{ o.word }}</span>
        <button type="button" class="ox" tabindex="-1" :aria-label="`删除 ${o.word}`" @click.stop="recent.remove(o.word)"><Icon name="close" /></button>
      </div>
      <div v-if="hotOpts.length" class="dsr-h">热门搜索</div>
      <div
        v-for="(o, j) in hotOpts"
        :id="optId(recentOpts.length + j)"
        :key="'h' + o.word"
        class="dsr-o"
        :class="{ on: active === recentOpts.length + j }"
        role="option"
        :aria-selected="active === recentOpts.length + j"
        @mousemove="active = recentOpts.length + j"
        @click="submit(o.word)"
      >
        <Icon name="search" class="oi" />
        <span class="ow">{{ o.word }}</span>
        <Icon v-if="o.hot" name="flame" class="fl" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.dsr { position: relative; width: 100%; max-width: 560px; }
.dsr-box { display: flex; align-items: stretch; height: 40px; }
.dsr-field {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
  padding: 0 8px 0 16px;
  border-radius: 20px 0 0 20px;
  background: var(--field);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .07);
  transition: box-shadow var(--dur-2) var(--ease-out), background-color var(--dur-2) var(--ease-out);
}
.dsr.focus .dsr-field { background: #141414; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .28); }
.dsr-ic { width: 16px; height: 16px; margin-right: 10px; color: var(--t2); stroke-width: 2.4; }
.dsr-field input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  background: none;
  color: var(--t1);
  font-size: 14px;
  -webkit-appearance: none;
  appearance: none;
}
.dsr-field input::placeholder { color: #6e6e6e; }
/*
 * 用自己的清除按钮：去掉浏览器自带的 ×。WebKit 有的版本自带的 × 本来就是 appearance: none + 遮罩画的，
 * 只有 display: none 藏得掉（和搜索页 SearchView 一样）
 */
.dsr-field input::-webkit-search-cancel-button { display: none; }
.dsr-field input::-webkit-search-decoration { -webkit-appearance: none; appearance: none; }
.dsr-clr {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: var(--t2);
}
.dsr-clr svg { width: 16px; height: 16px; stroke-width: 2.2; }
.dsr-kbd {
  display: grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 5px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .14);
  color: var(--t2);
  font: 600 11px/1 var(--font);
}
.dsr-go {
  display: grid;
  place-items: center;
  width: 60px;
  border-radius: 0 20px 20px 0;
  background: #1f1f1f;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .07);
  color: var(--t3);
  transition: background-color var(--dur-2) var(--ease-out);
}
.dsr-go svg { width: 18px; height: 18px; stroke-width: 2.2; }
.dsr-go:focus-visible, .dsr-clr:focus-visible { outline-offset: -2px; }

/* ---- 建议 ---- */
.dsr-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 60px;
  max-height: min(520px, calc(100vh - 120px));
  padding: 8px 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  border-radius: 14px;
  background: #151515;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .07), 0 16px 48px rgba(0, 0, 0, .6);
  scrollbar-width: thin;
  scrollbar-color: #2e2e2e transparent;
  animation: dsr-in var(--dur-2) var(--ease-out);
}
@keyframes dsr-in { from { opacity: 0; transform: translate3d(0, -4px, 0); } }
.dsr-h { padding: 8px 16px 4px; color: var(--t2); font-size: 12px; line-height: 16px; }
.dsr-h:not(:first-child) { margin-top: 6px; }
.dsr-o {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 36px;
  padding: 0 8px 0 16px;
  color: var(--t3);
  font-size: 14px;
  cursor: pointer;
}
.dsr-o.on { background: #232323; color: var(--t1); }
.dsr-o .oi { width: 16px; height: 16px; color: var(--t2); stroke-width: 2.2; }
.dsr-o .ow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsr-o .fl { width: 12px; height: 14px; margin-right: 8px; color: var(--t2); }
.dsr-o .ox {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: var(--t2);
}
.dsr-o .ox svg { width: 14px; height: 14px; stroke-width: 2.2; }

/* 触屏（平板横屏也是桌面布局）：没有键盘快捷键的提示「/」；删除近期搜索的 × 一直看得见（没有悬停可以把它叫出来） */
@media (hover: none) {
  .dsr-kbd { display: none; }
}
@media (hover: hover) {
  /* 有鼠标：删除用的 × 平时藏着，鼠标移到那一行（或 ↑ ↓ 选中它）才出来 */
  .dsr-o .ox { opacity: 0; }
  .dsr-o.on .ox { opacity: 1; }
  .dsr-field:hover { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .14); }
  .dsr.focus .dsr-field:hover { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .28); }
  .dsr-go:hover { background: #262626; color: var(--t1); }
  .dsr-clr:hover { background: var(--chip); color: var(--t1); }
  .dsr-o .ox:hover { background: #303030; color: var(--t1); }
}
</style>
