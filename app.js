// app.js — Entry point: state, storage, render loop, event wiring
// Version: 1.2.20260330

import { formatOffsetLabel, invalidateFormatterCache, resolveIana } from './time-utils.js';
import { initScroller, syncBeltToOffset, pauseScroller, resumeScroller } from './scroller.js';
import { initZones, renderZoneList, renderAllZoneRows, refreshSelection } from './zones.js';

const VERSION    = '1.8.20260330';
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

// ── Zone & country search index ───────────────────────────────────────────────
// Built once at startup from countries-and-timezones (global `ct`).
// Falls back gracefully to Intl.supportedValuesOf if the library didn't load.

// ALL_ZONES: sorted array of every known IANA zone id
const ALL_ZONES = (() => {
  const zones = new Set(['UTC']);
  try {
    if (typeof ct !== 'undefined') {
      Object.keys(ct.getAllTimezones()).forEach(z => zones.add(z));
    } else {
      Intl.supportedValuesOf('timeZone').forEach(z => zones.add(z));
    }
  } catch (_) {
    try { Intl.supportedValuesOf('timeZone').forEach(z => zones.add(z)); } catch (_) {}
  }
  return [...zones].sort();
})();

// SEARCH_INDEX: Map<lowerCaseTerm, Array<{ id, subtitle }>>
// Indexed terms: formatted zone name, country name, country code (ISO2).
// A subtitle is shown in the dropdown when the match came via country.
const SEARCH_INDEX = (() => {
  const index = new Map(); // term → [{ id, subtitle }]

  const add = (term, id, subtitle) => {
    const key = term.toLowerCase();
    if (!index.has(key)) index.set(key, []);
    // Avoid duplicates for the same id under the same term
    if (!index.get(key).some(e => e.id === id)) {
      index.get(key).push({ id, subtitle });
    }
  };

  if (typeof ct !== 'undefined') {
    const allTZ  = ct.getAllTimezones();
    const allC   = ct.getAllCountries();

    // Index every zone by its formatted name (spaces instead of underscores)
    Object.keys(allTZ).forEach(id => {
      add(id.replace(/_/g, ' '), id, null);
      // Also index each path segment separately (e.g. "Ho Chi Minh" from "Asia/Ho_Chi_Minh")
      const city = id.split('/').pop().replace(/_/g, ' ');
      if (city) add(city, id, null);
    });

    // Index every country name and code → its zones
    Object.values(allC).forEach(country => {
      (country.timezones || []).forEach(id => {
        add(country.name, id, country.name);
        add(country.id,   id, country.name); // ISO2 code e.g. "VN"
      });
    });
  } else {
    // Fallback: index zone IDs only
    ALL_ZONES.forEach(id => add(id.replace(/_/g, ' '), id, null));
  }

  return index;
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
        .filter(z => {
          if (supported.has(z.id)) return true;
          // Accept zones that Intl can format even if not enumerated
          try { new Intl.DateTimeFormat('en', { timeZone: z.id }); return true; } catch (_) { return false; }
        })
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
    const q = query.trim().toLowerCase();
    if (!q) { dropdown.hidden = true; return; }

    const existingIds = new Set(state.zones.map(z => z.id));

    // Collect results: { id, subtitle } — deduplicated, existing zones excluded
    const seen = new Set();
    const results = [];

    // Layer 1 & 2: scan search index for any term that includes the query
    for (const [term, entries] of SEARCH_INDEX) {
      if (!term.includes(q)) continue;
      for (const entry of entries) {
        if (existingIds.has(entry.id) || seen.has(entry.id)) continue;
        seen.add(entry.id);
        results.push(entry);
        if (results.length >= 20) break;
      }
      if (results.length >= 20) break;
    }

    // Layer 3: if the raw query looks like an IANA id and wasn't found, validate with Intl
    if (results.length === 0 && query.includes('/')) {
      const candidate = query.trim();
      if (!existingIds.has(candidate)) {
        try {
          new Intl.DateTimeFormat('en', { timeZone: candidate });
          results.push({ id: candidate, subtitle: null });
        } catch (_) {}
      }
    }

    dropdown.innerHTML = '';
    if (!results.length) { dropdown.hidden = true; return; }

    results.forEach(({ id, subtitle }) => {
      const item = document.createElement('div');
      item.className = 'dropdown-item';

      const nameEl = document.createElement('span');
      nameEl.className = 'dropdown-item-name';
      nameEl.textContent = id.replace(/_/g, ' ');
      item.appendChild(nameEl);

      if (subtitle) {
        const subEl = document.createElement('span');
        subEl.className = 'dropdown-item-sub';
        subEl.textContent = subtitle;
        item.appendChild(subEl);
      }

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
