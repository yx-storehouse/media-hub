<script setup>
import { ref, shallowRef } from 'vue'
import { getNearbyFilters, getNearby } from '@/api'
import { toast } from '@/composables/useToast'
import { useKeepScroll } from '@/composables/useKeepScroll'
import Cover from '@/components/Cover.vue'
import Icon from '@/components/Icon.vue'

defineOptions({ name: 'NearbyView' })

/* 筛选项由接口给出：[{ label, category, sort_key }] */
const filters = shallowRef([])
const active = ref(0)
const items = shallowRef([])
const scroller = ref(null)
const chipRow = ref(null)
useKeepScroll(scroller, chipRow)

async function loadItems() {
  const filter = active.value
  const list = await getNearby({ filter })
  if (filter === active.value) items.value = list // ignore answers for a filter the user already left
}

function selectFilter(i) {
  if (i === active.value) return
  active.value = i
  loadItems()
}

getNearbyFilters().then(list => { filters.value = list })
loadItems()
</script>

<template>
  <div class="page nearby">
    <header class="bar-hd nb-hd">
      <div class="city"><Icon name="tNearby" />上海<Icon name="chevD" class="dn" /></div>
      <button class="ct-search" @click="toast('搜索功能即将上线')"><Icon name="search" /><span>搜索同城好去处</span></button>
    </header>

    <div ref="chipRow" class="chips hs">
      <button
        v-for="(f, i) in filters"
        :key="f.label"
        class="chip"
        :class="{ on: i === active }"
        :aria-pressed="i === active"
        @click="selectFilter(i)"
      >
        {{ f.label }}
      </button>
    </div>

    <div ref="scroller" class="scroll">
      <div v-for="item in items" :key="item.id" v-press class="nb-item" @click="toast('详情页即将上线')">
        <Cover class="cv" v-bind="item.cover" />
        <div class="bd">
          <h3>{{ item.title }}</h3>
          <div class="tags">
            <span v-for="tag in item.tags" :key="tag">{{ tag }}</span>
          </div>
          <div class="ft">
            <span><Icon name="tNearby" class="pin" />{{ item.distance }}</span>
            <b>{{ item.price }}</b>
          </div>
        </div>
      </div>
      <div class="pad-b" />
    </div>
  </div>
</template>

<style scoped>
.nb-hd { gap: 10px; }
.nb-hd .ct-search { flex: 1; }
.city { display: flex; flex: none; align-items: center; gap: 3px; font-size: 16px; font-weight: 600; }
.city svg { width: 15px; height: 15px; color: var(--accent); }
.city .dn { width: 12px; height: 12px; color: var(--t2); stroke-width: 2.8; }

.chips { padding-bottom: 8px; }

.nb-item { display: flex; gap: 11px; padding: 13px 14px; border-bottom: 1px solid var(--line); cursor: pointer; }
.nb-item .cv { flex: none; width: 112px; aspect-ratio: 1; border-radius: 8px; }
.nb-item .bd { display: flex; flex: 1; flex-direction: column; min-width: 0; padding: 1px 0; }
.nb-item h3 {
  display: -webkit-box;
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.tags span { height: 18px; padding: 0 7px; border-radius: 4px; background: #1e1e1e; color: var(--t2); font-size: 11px; line-height: 18px; }
.ft { display: flex; align-items: center; justify-content: space-between; margin-top: auto; color: var(--t2); font-size: 12px; }
.ft b { color: var(--accent); font-size: 14px; font-weight: 600; }
.ft .pin { display: inline; width: 12px; height: 12px; margin-right: 3px; vertical-align: -2px; }
</style>
