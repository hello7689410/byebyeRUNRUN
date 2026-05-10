<template>
  <div v-if="props.inline || props.visible" :class="ui.wrapper" @click.self="handleWrapperClick">
    <div :class="ui.panel">
      <div v-if="loading" :class="ui.feedback">
        <i class="fa-brands fa-connectdevelop text-white text-3xl animate-bounce"></i>
        <p class="text-[10px] text-stone-600 font-black tracking-[0.3em] uppercase">连接服务中</p>
      </div>

      <div v-else-if="initError" :class="ui.feedback">
        <div class="relative">
          <i class="fa-solid fa-bomb text-red-500 text-4xl animate-pulse"></i>
          <div class="absolute -inset-2 bg-red-500/20 blur-xl rounded-full"></div>
        </div>
        <div class="text-center px-6">
          <p class="text-stone-200 text-xs font-bold">连接失败</p>
          <p class="text-stone-500 text-[10px] mt-1 line-clamp-2">{{ initError }}</p>
        </div>
        <button
          type="button"
          @click="init"
          class="px-4 py-2 bg-stone-900 hover:bg-stone-800 text-stone-300 text-[10px] font-bold rounded-xl transition-colors"
        >
          重新尝试
        </button>
      </div>

      <div v-else :class="ui.content">
        <div :class="ui.header">
          <div class="space-y-0.5">
            <h2 class="text-sm font-black text-stone-200 uppercase tracking-widest">定时任务</h2>
            <p class="text-[9px] text-stone-700 font-mono">daily-run scheduler</p>
          </div>
          <div class="flex items-center gap-2">
            <span :class="['text-[10px] font-black px-2 py-1 rounded-lg border tracking-wide', enabledLabelClass]">
              {{ enabledLabelText }}
            </span>
            <span :class="['text-[10px] font-black px-2 py-1 rounded-lg border tracking-wide', statusLabelClass]">
              {{ statusLabelText }}
            </span>
          </div>
        </div>

        <div :class="ui.fields">
          <div :class="ui.fieldItem">
            <label class="text-[10px] font-black text-stone-600 uppercase tracking-widest ml-1">学校地图</label>
            <div class="relative">
              <div @click="showMapList = !showMapList" :class="ui.mapTrigger">
                <span class="text-[12px] text-stone-200 font-medium">{{ currentMapName }}</span>
                <i
                  :class="[
                    'fa-solid fa-chevron-down text-[10px] text-stone-600 transition-transform',
                    showMapList ? 'rotate-180' : '',
                  ]"
                ></i>
              </div>
              <div
                v-if="showMapList"
                class="absolute z-50 w-full mt-1 bg-stone-900 border border-white/10 rounded-xl shadow-2xl py-1 max-h-[120px] overflow-y-auto"
              >
                <div
                  v-for="map in maps"
                  :key="map.id"
                  @click="selectMap(map)"
                  class="px-4 py-2 text-[12px] text-stone-400 hover:bg-white/5 hover:text-white cursor-pointer transition-colors"
                >
                  {{ map.name }}
                </div>
              </div>
            </div>
          </div>

          <div :class="ui.fieldItem">
            <label class="text-[10px] font-black text-stone-600 uppercase tracking-widest ml-1">跑步里程（米）</label>
            <div class="flex items-center bg-stone-900 border border-white/5 rounded-xl px-3 py-2">
              <input
                v-model.number="form.distance"
                type="number"
                min="100"
                step="1"
                class="w-full bg-transparent text-sm text-white outline-none"
              />
            </div>
          </div>

          <div :class="ui.fieldItem">
            <label class="text-[10px] font-black text-stone-600 uppercase tracking-widest ml-1">运行时间</label>
            <div class="flex items-center gap-2">
              <div class="flex-1 flex items-center bg-stone-900 border border-white/5 rounded-xl p-1">
                <select
                  v-model.number="timeObj.h"
                  class="w-full bg-transparent text-center text-sm font-mono text-white outline-none appearance-none py-1"
                >
                  <option v-for="h in 24" :key="h - 1" :value="h - 1" class="bg-stone-900 text-white">
                    {{ String(h - 1).padStart(2, '0') }}
                  </option>
                </select>
                <span class="text-[9px] text-stone-600 pr-2 italic">H</span>
              </div>
              <span class="text-stone-800 font-bold">:</span>
              <div class="flex-1 flex items-center bg-stone-900 border border-white/5 rounded-xl p-1">
                <select
                  v-model.number="timeObj.m"
                  class="w-full bg-transparent text-center text-sm font-mono text-white outline-none appearance-none py-1"
                >
                  <option v-for="m in 60" :key="m - 1" :value="m - 1" class="bg-stone-900 text-white">
                    {{ String(m - 1).padStart(2, '0') }}
                  </option>
                </select>
                <span class="text-[9px] text-stone-600 pr-2 italic">M</span>
              </div>
            </div>
          </div>

          <div @click="form.enabled = !form.enabled" class="flex items-center justify-between p-1 cursor-pointer group">
            <span class="text-[11px] font-bold text-stone-500 group-hover:text-stone-300 transition-colors">开启定时</span>
            <div
              :class="['w-9 h-5 rounded-full transition-all relative', form.enabled ? 'bg-stone-200' : 'bg-stone-800']"
            >
              <div
                :class="[
                  'absolute top-1 w-3 h-3 rounded-full transition-all',
                  form.enabled ? 'left-5 bg-black' : 'left-1 bg-stone-500',
                ]"
              ></div>
            </div>
          </div>
        </div>

        <button type="button" @click="handleSave" :disabled="submitting" :class="ui.saveButton">
          <i v-if="submitting" class="fa-solid fa-circle-notch fa-spin"></i>
          <span>{{ submitting ? 'SYNCING' : '保存配置' }}</span>
        </button>
      </div>

      <button
        v-if="!props.inline"
        type="button"
        @click="close"
        class="absolute top-6 right-6 w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/5 text-stone-600 hover:text-white transition-all"
      >
        <i class="fa-solid fa-xmark text-sm"></i>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, inject } from 'vue';
import { useDataStore } from '@/composables/useDataStore';
import { loadMapFiles, getMapNames } from '@/utils/map';
import { isClubSchedulerConfigured } from '@/utils/clubSchedulerSync';
import { getDailyRunRule, saveDailyRunRule, removeDailyRunRule } from '@/utils/dailyRunSync';

const props = defineProps({
  visible: { type: Boolean, default: false },
  inline: { type: Boolean, default: false },
});
const emit = defineEmits(['update:visible', 'saved']);
const showMessage = inject('showMessage', (msg) => alert(msg));
const { token } = useDataStore();

const loading = ref(true);
const initError = ref(null);
const submitting = ref(false);
const showMapList = ref(false);
const todayRun = ref(null);

const maps = ref([]);
const form = ref({
  map_id: '',
  enabled: false,
  distance: 4631,
});
const timeObj = reactive({ h: 8, m: 0 });

const ui = computed(() =>
  props.inline
    ? {
        wrapper: 'w-full',
        panel: 'relative w-full bg-stone-950 border border-white/10 rounded-lg p-4',
        feedback: 'py-8 flex flex-col items-center justify-center space-y-4',
        content: 'p-4 space-y-4',
        header: 'flex justify-between items-center gap-3',
        fields: 'space-y-3',
        fieldItem: 'space-y-1',
        mapTrigger:
          'flex items-center justify-between bg-stone-900 border border-white/5 rounded-xl px-3 py-2 cursor-pointer hover:border-white/10 transition-all',
        saveButton:
          'w-full bg-stone-800 hover:bg-stone-700 text-stone-200 py-2 rounded-xl font-black text-[11px] uppercase tracking-widest transition-all active:scale-[0.97] disabled:opacity-20 flex items-center justify-center gap-2',
      }
    : {
        wrapper: 'fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md',
        panel:
          'relative w-full max-w-[300px] bg-stone-950 border border-white/10 rounded-[2rem] shadow-2xl transition-all overflow-hidden',
        feedback: 'py-16 flex flex-col items-center justify-center space-y-4',
        content: 'p-6 space-y-5',
        header: 'flex justify-between items-center gap-3 pr-8',
        fields: 'space-y-4',
        fieldItem: 'space-y-1.5',
        mapTrigger:
          'flex items-center justify-between bg-stone-900 border border-white/5 rounded-xl px-4 py-2.5 cursor-pointer hover:border-white/10 transition-all',
        saveButton:
          'w-full bg-stone-800 hover:bg-stone-700 text-stone-200 py-3 rounded-2xl font-black text-[11px] uppercase tracking-widest transition-all active:scale-[0.97] disabled:opacity-20 flex items-center justify-center gap-2',
      },
);

const parseCronToTime = (cronExpr) => {
  if (!cronExpr) return { h: 8, m: 0 };
  const parts = String(cronExpr).trim().split(/\s+/);
  if (parts.length < 2) return { h: 8, m: 0 };
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  return {
    h: Number.isInteger(hour) ? Math.max(0, Math.min(23, hour)) : 8,
    m: Number.isInteger(minute) ? Math.max(0, Math.min(59, minute)) : 0,
  };
};

const isCompletedToday = computed(() => {
  const st = String(todayRun.value?.status || '').trim();
  return st === 'ok' || st === 'external';
});
const statusLabelText = computed(() => (isCompletedToday.value ? '已完成' : '待执行'));
const statusLabelClass = computed(() =>
  isCompletedToday.value
    ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10'
    : 'text-orange-300 border-orange-500/30 bg-orange-500/10',
);
const enabledLabelText = computed(() => (form.value.enabled ? '已启用' : '未启用'));
const enabledLabelClass = computed(() =>
  form.value.enabled
    ? 'text-cyan-300 border-cyan-500/30 bg-cyan-500/10'
    : 'text-stone-400 border-stone-600/40 bg-stone-700/20',
);
const currentMapName = computed(() => {
  const selectedId = String(form.value.map_id || '');
  const map = maps.value.find((m) => String(m.id) === selectedId);
  return map ? map.name : '选择地图';
});

const selectMap = (map) => {
  form.value.map_id = map.id;
  showMapList.value = false;
};

const initMaps = async () => {
  await loadMapFiles();
  const names = getMapNames();
  maps.value = Object.keys(names).map((id) => ({ id, name: names[id] }));
  if (!form.value.map_id && maps.value.length > 0) form.value.map_id = maps.value[0].id;
};

const init = async () => {
  loading.value = true;
  initError.value = null;
  try {
    await initMaps();
    if (!isClubSchedulerConfigured()) {
      throw new Error('Scheduled task service URL is not configured');
    }
    if (!token.value) {
      throw new Error('Missing auth token');
    }
    const resp = await getDailyRunRule(token.value);
    if (resp?.rule) {
      form.value.map_id = String(resp.rule.mapId || form.value.map_id || '');
      form.value.enabled = !!resp.rule.enabled;
      form.value.distance = Number(resp.rule.distance || form.value.distance || 4631);
      const { h, m } = parseCronToTime(resp.rule.cron);
      timeObj.h = h;
      timeObj.m = m;
    }
    todayRun.value = resp?.todayRun || null;
  } catch (err) {
    console.error('daily-run init error:', err);
    initError.value = err?.message || 'Unknown error';
  } finally {
    loading.value = false;
  }
};

const handleSave = async () => {
  if (!form.value.map_id) {
    showMessage('请选择地图', 'error');
    return;
  }
  if (!Number.isInteger(Number(form.value.distance)) || Number(form.value.distance) < 100) {
    showMessage('里程需为大于等于 100 的整数', 'error');
    return;
  }
  if (!token.value) {
    showMessage('请先登录', 'error');
    return;
  }
  submitting.value = true;
  try {
    if (!form.value.enabled) {
      const r = await removeDailyRunRule(token.value);
      if (r?.ok === false) throw new Error(r.message || '关闭失败');
      todayRun.value = null;
      showMessage('已关闭定时任务', 'success');
      emit('saved');
      return;
    }

    const tz =
      typeof Intl !== 'undefined' && Intl.DateTimeFormat
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
        : 'Asia/Shanghai';
    const saveResp = await saveDailyRunRule(token.value, {
      enabled: true,
      mapId: String(form.value.map_id),
      distance: Number(form.value.distance),
      hour: Number(timeObj.h),
      minute: Number(timeObj.m),
      timezone: tz,
    });
    if (saveResp?.ok === false) throw new Error(saveResp.message || '保存失败');
    const latest = await getDailyRunRule(token.value);
    todayRun.value = latest?.todayRun || null;
    showMessage('Settings updated', 'success');
    emit('saved');
  } catch (err) {
    showMessage(err?.message || 'Save failed', 'error');
  } finally {
    submitting.value = false;
  }
};

const close = () => {
  showMapList.value = false;
  emit('update:visible', false);
};

const handleWrapperClick = () => {
  if (!props.inline) close();
};

watch(
  () => ({ visible: props.visible, inline: props.inline }),
  (current, previous) => {
    const shouldInitInline = current.inline && !previous?.inline;
    const shouldInitModal = current.visible && !previous?.visible;
    if (shouldInitInline || shouldInitModal) init();
  },
  { immediate: true },
);
</script>

<style scoped>
select {
  -webkit-appearance: none;
  -moz-appearance: none;
  background: transparent;
}

.overflow-y-auto::-webkit-scrollbar {
  width: 4px;
}

.overflow-y-auto::-webkit-scrollbar-thumb {
  background: #292524;
  border-radius: 10px;
}

option {
  background-color: #0c0a09;
  color: #e7e5e4;
}
</style>

