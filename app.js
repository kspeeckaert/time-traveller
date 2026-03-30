// app.js — Entry point: state, storage, render loop, event wiring
// Version: 1.2.20260330

import { formatOffsetLabel, invalidateFormatterCache, resolveIana } from './time-utils.js';
import { initScroller, syncBeltToOffset, pauseScroller, resumeScroller } from './scroller.js';
import { initZones, renderZoneList, renderAllZoneRows, refreshSelection } from './zones.js';

const VERSION    = '1.7.20260330';
const STORAGE_KEY = 'timetraveler_v1';

// ── State ─────────────────────────────────────────────────────────────────────

let state = {
  zones: [{ id: 'local', label: 'Local', pinned: true }],
  selectedZoneId: 'local',
  stepSize: '30M',
};

let offsetMs       = 0; // runtime only, never persisted
let clockIntervalId = null;
let lastLocalIana  = '';

const STEP_MS = { '1D': 86400000, '1H': 3600000, '30M': 1800000 };

// All available IANA zones — computed once at startup
const ALL_ZONES = (() => {
  const zones = new Set(['UTC']);
  try { Intl.supportedValuesOf('timeZone').forEach(z => zones.add(z)); } catch (_) {}
  return [...zones].sort();
})();

// ── Persistence ───────────────────────────────────────────────────────────────

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);

    const supported = new Set(ALL_ZONES);
    const zones = [{ id: 'local', label: 'Local', pinned: true }];
    if (Array.isArray(parsed.zones)) {
      parsed.zones
        .filter(z => z.id !== 'local')
        .filter(z => z.id === 'UTC' || supported.has(z.id))
        .forEach(z => zones.push({ id: z.id, ...(z.pseudonym ? { pseudonym: z.pseudonym } : {}) }));
    }
    state.zones = zones;

    if (typeof parsed.selectedZoneId === 'string') {
      state.selectedZoneId = state.zones.find(z => z.id === parsed.selectedZoneId)
        ? parsed.selectedZoneId : 'local';
    }
    if (['1D', '1H', '30M'].includes(parsed.stepSize)) {
      state.stepSize = parsed.stepSize;
    }
  } catch (_) { /* malformed — keep defaults */ }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    zones: state.zones,
    selectedZoneId: state.selectedZoneId,
    stepSize: state.stepSize,
  }));
}

// ── Offset management ─────────────────────────────────────────────────────────

function setOffsetMs(val) { offsetMs = val; }

function onOffsetChanged() {
  renderAllZoneRows();
  updateOffsetLabel();
}

function resetToNow() {
  offsetMs = 0;
  syncBeltToOffset(0);
  onOffsetChanged();
}

// ── Zone operations ───────────────────────────────────────────────────────────

function addZone(id) {
  if (state.zones.find(z => z.id === id)) return;
  state.zones.push({ id });
  saveState();
  renderZoneList();
}

function removeZone(id) {
  state.zones = state.zones.filter(z => z.id !== id);
  if (state.selectedZoneId === id) state.selectedZoneId = 'local';
  saveState();
  renderZoneList();
  refreshSelection(state.selectedZoneId);
}

function selectZone(id) {
  state.selectedZoneId = id;
  refreshSelection(id);
  saveState();
}

function reorderZones(newIdOrder) {
  const zoneMap = new Map(state.zones.map(z => [z.id, z]));
  const local   = state.zones[0];
  state.zones   = [local, ...newIdOrder.filter(id => id !== 'local').map(id => zoneMap.get(id)).filter(Boolean)];
  saveState();
}

function setPseudonym(id, value) {
  const zone = state.zones.find(z => z.id === id);
  if (!zone) return;
  if (value) { zone.pseudonym = value; } else { delete zone.pseudonym; }
  saveState();
  renderZoneList();
}

// ── Selected zone IANA helper ─────────────────────────────────────────────────

function getSelectedIana() {
  const zone = state.zones.find(z => z.id === state.selectedZoneId) || state.zones[0];
  return resolveIana(zone);
}

// ── Step size ─────────────────────────────────────────────────────────────────

function setStepSize(size) {
  state.stepSize = size;
  saveState();
  syncBeltToOffset(offsetMs);
  updateStepButtons();
  onOffsetChanged();
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function updateOffsetLabel() {
  const el = document.getElementById('offset-label');
  if (el) el.textContent = formatOffsetLabel(offsetMs);
}

function updateStepButtons() {
  document.querySelectorAll('.step-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.step === state.stepSize);
  });
}

// ── Search / add zone ─────────────────────────────────────────────────────────

function initSearch() {
  const input    = document.getElementById('zone-search');
  const dropdown = document.getElementById('zone-dropdown');
  if (!input || !dropdown) return;

  function renderDropdown(query) {
    const q = query.toLowerCase();
    const existingIds = new Set(state.zones.map(z => z.id));
    const matches = q
      ? ALL_ZONES.filter(z => !existingIds.has(z) && z.toLowerCase().includes(q)).slice(0, 20)
      : [];

    dropdown.innerHTML = '';
    if (!matches.length) { dropdown.hidden = true; return; }

    matches.forEach(id => {
      const item = document.createElement('div');
      item.className = 'dropdown-item';
      item.textContent = id.replace(/_/g, ' ');
      item.setAttribute('role', 'option');
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        addZone(id);
        input.value = '';
        dropdown.hidden = true;
        input.focus();
      });
      dropdown.appendChild(item);
    });
    dropdown.hidden = false;
  }

  input.addEventListener('input', () => renderDropdown(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { dropdown.hidden = true; input.value = ''; }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => { dropdown.hidden = true; }, 150);
  });
}

// ── Controls bar wiring ───────────────────────────────────────────────────────

function initControls() {
  document.querySelectorAll('.step-btn').forEach(btn => {
    btn.addEventListener('click', () => setStepSize(btn.dataset.step));
  });

  document.getElementById('btn-back')?.addEventListener('click', () => {
    offsetMs -= STEP_MS[state.stepSize];
    syncBeltToOffset(offsetMs);
    onOffsetChanged();
  });
  document.getElementById('btn-fwd')?.addEventListener('click', () => {
    offsetMs += STEP_MS[state.stepSize];
    syncBeltToOffset(offsetMs);
    onOffsetChanged();
  });

  document.getElementById('btn-now')?.addEventListener('click', resetToNow);

  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') {
      offsetMs -= STEP_MS[state.stepSize]; syncBeltToOffset(offsetMs); onOffsetChanged();
    } else if (e.key === 'ArrowRight') {
      offsetMs += STEP_MS[state.stepSize]; syncBeltToOffset(offsetMs); onOffsetChanged();
    }
  });
}

// ── Clock & system TZ watch ───────────────────────────────────────────────────

function startClock() {
  lastLocalIana = Intl.DateTimeFormat().resolvedOptions().timeZone;
  clockIntervalId = setInterval(() => {
    const currentIana = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (currentIana !== lastLocalIana) {
      lastLocalIana = currentIana;
      invalidateFormatterCache();
      renderZoneList();
      return;
    }
    if (offsetMs === 0) renderAllZoneRows();
  }, 1000);
}

function stopClock() {
  if (clockIntervalId) { clearInterval(clockIntervalId); clockIntervalId = null; }
}

// ── Visibility ────────────────────────────────────────────────────────────────

function initVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pauseScroller();
      stopClock();
    } else {
      resumeScroller();
      startClock();
      if (offsetMs === 0) renderAllZoneRows();
    }
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function init() {
  loadState();

  initZones(document.getElementById('zone-list'), {
    getZones:          () => state.zones,
    getOffsetMs:       () => offsetMs,
    getSelectedId:     () => state.selectedZoneId,
    onSelectZone:      selectZone,
    onRemoveZone:      removeZone,
    onReorder:         reorderZones,
    onPseudonymChange: setPseudonym,
  });

  initScroller(document.getElementById('scroller-canvas'), {
    getOffsetMs:    () => offsetMs,
    getStepSize:    () => state.stepSize,
    getSelectedIana: () => getSelectedIana(),
    onOffsetChanged,
    setOffsetMs,
  });

  renderZoneList();
  updateStepButtons();
  updateOffsetLabel();
  initSearch();
  initControls();
  startClock();
  initVisibility();

  const badge = document.getElementById('version-badge');
  if (badge) badge.textContent = `v${VERSION}`;
}

document.addEventListener('DOMContentLoaded', init);
