<script setup>
import { ref, shallowRef } from 'vue'
import { getLatestFilters, getLatestVideos } from '@/api'
import { toast } from '@/composables/useToast'
import Icon from '@/components/Icon.vue'
import VideoCard from '@/components/VideoCard.vue'
import { useKeepScroll } from '@/composables/useKeepScroll'

const filters = shallowRef({ dates: [], regions: [] })
const date = ref(0)
const region = ref(0)
const videos = shallowRef([])
/* bumps whenever a list arrives: re-keys the grid so every new list fades in */
const batch = ref(0)

const dateRow = ref(null)
const scroller = ref(null)
const { reset } = useKeepScroll(scroller, dateRow)

const failed = ref(false)

async function loadFilters() {
  try {
    filters.value = await getLatestFilters()
    await loadVideos()
    failed.value = false
  } catch {
    failed.value = true
  }
}

/** Resolves to false when the answer is stale (the filters changed while it was loading). */
async function loadVideos() {
  const query = { date: date.value, region: region.value }
  const list = await getLatestVideos(query)
  if (query.date !== date.value || query.region !== region.value) return false
  videos.value = list
  batch.value++
  return true
}

/* a new date or region starts the list over from the top */
async function reload() {
  if (await loadVideos()) reset()
}

function selectDate(i) {
  date.value = i
  reload()
}

function selectRegion(i) {
  region.value = i
  reload()
}

loadFilters()
loadVideos()
</script>

<template>
  <div>
    <!-- date bar stays fixed above the list -->
    <div class="datebar">
      <div ref="dateRow" class="row hs">
        <button
          v-for="(d, i) in filters.dates"
          :key="d.label"
          class="dchip"
          :class="{ on: i === date }"
          :aria-pressed="i === date"
          @click="selectDate(i)"
        >
          {{ d.label }}<span class="bd">{{ d.count }}</span>
        </button>
      </div>
      <button class="cal" aria-label="选择日期" @click="toast('日期选择即将上线')"><Icon name="calCheck" /></button>
    </div>

    <div v-if="failed" class="empty">
      加载失败，请稍后重试
      <button class="retry" @click="loadFilters()">重试</button>
    </div>
    <div v-else ref="scroller" class="scroll">
      <div class="pills">
        <button
          v-for="(r, i) in filters.regions"
          :key="r.label"
          class="rp"
          :class="{ on: i === region }"
          :aria-pressed="i === region"
          @click="selectRegion(i)"
        >
          {{ r.label }}<span class="n">{{ r.count }}</span>
        </button>
      </div>
      <div :key="batch" v-fade-in class="grid g16">
        <VideoCard v-for="v in videos" :key="v.id" :video="v" />
      </div>
      <div class="pad-b" />
    </div>
  </div>
</template>

<style scoped>
.datebar { position: relative; flex: none; border-bottom: 1px solid var(--line); }
.datebar .row { display: flex; gap: 13px; padding: 11px 58px 12px 14px; }

.dchip {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 50px;
  height: 30px;
  border-radius: 8px;
  background: var(--chip);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .035);
  color: var(--t2);
  font-size: 12.5px;
  font-weight: 500;
}
.dchip.on { background: var(--accent); box-shadow: none; color: var(--on-accent); font-weight: 600; }
/* new-video count badge on the chip's top-right corner */
.dchip .bd {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 23px;
  height: 13px;
  padding: 0 5px;
  border-radius: 7px;
  background: var(--accent);
  box-shadow: 0 0 0 1.5px var(--bg);
  color: var(--on-accent);
  font-size: 10px;
  font-weight: 600;
  line-height: 13px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.datebar .cal {
  position: absolute;
  top: 11px;
  right: 12px;
  display: grid;
  place-items: center;
  width: 39px;
  height: 30px;
  border-radius: 8px;
  background: var(--chip);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .035);
  color: #d4d4d4;
}
/* fades the chips out as they scroll under the calendar button */
.datebar .cal::before {
  content: '';
  position: absolute;
  top: -11px;
  right: 100%;
  bottom: -12px;
  width: 30px;
  background: linear-gradient(90deg, rgba(10, 10, 10, 0), var(--bg));
  pointer-events: none;
}
.datebar .cal svg { width: 19px; height: 19px; }

.pills { display: flex; gap: 9px; padding: 9px 14px 21px; }
.rp {
  display: flex;
  flex: none;
  align-items: center;
  gap: 7px;
  height: 29px;
  padding: 0 15px;
  border: 1.5px solid transparent;
  border-radius: 15px;
  background: var(--chip);
  color: var(--t2);
  font-size: 12px;
  font-weight: 500;
}
.rp .n { font-size: 11.5px; font-weight: 400; font-variant-numeric: tabular-nums; opacity: .92; }
.rp.on { border-color: var(--accent); background: transparent; color: var(--accent); }
</style>
