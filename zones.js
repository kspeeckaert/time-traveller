// zones.js — Zone list management, SortableJS, pseudonym editing, row rendering
// Version: 1.3.20260330

import { resolveIana, timeInZone, dateLabel, utcOffsetString } from './time-utils.js';

let zonesContainer;
let getZones          = () => [];
let getOffsetMs       = () => 0;
let getSelectedId     = () => 'local';
let onSelectZone      = () => {};
let onRemoveZone      = () => {};
let onReorder         = () => {};
let onPseudonymChange = () => {};

// Per-row last-rendered cache (for DOM diffing)
const rowCache = new Map();

// ── Delete confirmation modal ─────────────────────────────────────────────────

let deleteDialog;
let pendingDeleteId = null;

function ensureDeleteDialog() {
  if (deleteDialog) return;
  deleteDialog = document.createElement('dialog');
  deleteDialog.id = 'delete-dialog';
  deleteDialog.innerHTML = `
    <div class="dialog-content">
      <p class="dialog-message"></p>
      <div class="dialog-actions">
        <button class="dialog-cancel">Cancel</button>
        <button class="dialog-confirm">Remove</button>
      </div>
    </div>
  `;
  deleteDialog.querySelector('.dialog-cancel').addEventListener('click', () => {
    deleteDialog.close(); pendingDeleteId = null;
  });
  deleteDialog.querySelector('.dialog-confirm').addEventListener('click', () => {
    deleteDialog.close();
    if (pendingDeleteId) { onRemoveZone(pendingDeleteId); pendingDeleteId = null; }
  });
  deleteDialog.addEventListener('click', (e) => {
    if (e.target === deleteDialog) { deleteDialog.close(); pendingDeleteId = null; }
  });
  document.body.appendChild(deleteDialog);
}

function showDeleteModal(zone) {
  ensureDeleteDialog();
  deleteDialog.querySelector('.dialog-message').textContent =
    `Remove "${zone.pseudonym || formatIana(zone.id)}"?`;
  pendingDeleteId = zone.id;
  deleteDialog.showModal();
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initZones(containerEl, deps) {
  zonesContainer    = containerEl;
  getZones          = deps.getZones;
  getOffsetMs       = deps.getOffsetMs;
  getSelectedId     = deps.getSelectedId;
  onSelectZone      = deps.onSelectZone;
  onRemoveZone      = deps.onRemoveZone;
  onReorder         = deps.onReorder;
  onPseudonymChange = deps.onPseudonymChange;
  initSortable();
}

function initSortable() {
  if (typeof Sortable === 'undefined') return;
  Sortable.create(zonesContainer, {
    animation: 150,
    handle: '.drag-handle',
    onMove(evt) {
      if (evt.dragged.dataset.id === 'local') return false;
      if (evt.related.dataset.id === 'local') return false;
    },
    onEnd() {
      const ids = [...zonesContainer.querySelectorAll('.zone-row')].map(el => el.dataset.id);
      onReorder(ids);
    },
  });
}

// ── Render ────────────────────────────────────────────────────────────────────

export function renderZoneList() {
  const zones      = getZones();
  const selectedId = getSelectedId();

  // Remove DOM rows no longer in state
  const currentIds = new Set(zones.map(z => z.id));
  [...zonesContainer.querySelectorAll('.zone-row')].forEach(el => {
    if (!currentIds.has(el.dataset.id)) {
      rowCache.delete(el.dataset.id);
      el.remove();
    }
  });

  zones.forEach((zone, index) => {
    let row = zonesContainer.querySelector(`.zone-row[data-id="${CSS.escape(zone.id)}"]`);

    // If a row exists but still contains an inline edit input, it was not cleaned
    // up properly — tear it down and recreate it from scratch.
    if (row && row.querySelector('.zone-inline-edit')) {
      rowCache.delete(zone.id);
      row.remove();
      row = null;
    }

    if (!row) {
      row = createRowElement(zone);
      zonesContainer.appendChild(row);
    }

    // Ensure DOM order matches state order
    const children = [...zonesContainer.children];
    if (children[index] !== row) {
      zonesContainer.insertBefore(row, children[index] || null);
    }

    updateRowSelection(row, zone.id === selectedId);
    updateRowName(row, zone);
  });

  renderAllZoneRows();
}

export function renderAllZoneRows() {
  const zones    = getZones();
  const offsetMs = getOffsetMs();
  const now      = Date.now() + offsetMs;

  zones.forEach(zone => {
    const row = zonesContainer.querySelector(`.zone-row[data-id="${CSS.escape(zone.id)}"]`);
    if (!row) return;

    const iana  = resolveIana(zone);
    const { hour, minute } = timeInZone(iana, now);
    const timeStr   = `${hour}:${minute}`;
    const dateLbl   = dateLabel(iana, now);
    const offsetStr = utcOffsetString(iana, now);

    const cache = rowCache.get(zone.id) || {};
    if (cache.time !== timeStr) {
      const el = row.querySelector('.zone-time');
      if (el) el.textContent = timeStr;
      cache.time = timeStr;
    }
    if (cache.dateLabel !== dateLbl) {
      const el = row.querySelector('.zone-date-label');
      if (el) el.textContent = dateLbl;
      cache.dateLabel = dateLbl;
    }
    if (cache.offset !== offsetStr) {
      const el = row.querySelector('.zone-offset');
      if (el) el.textContent = offsetStr;
      cache.offset = offsetStr;
    }
    rowCache.set(zone.id, cache);
  });
}

// ── Row creation ──────────────────────────────────────────────────────────────

function createRowElement(zone) {
  const isLocal = zone.id === 'local';
  const row = document.createElement('div');
  row.className = 'zone-row';
  row.dataset.id = zone.id;
  row.setAttribute('tabindex', '0');
  row.setAttribute('role', 'option');

  const trashSVG = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M1.5 3h9M4.5 3V2a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1M2.5 3l.5 7a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5l.5-7" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M5 5.5v3M7 5.5v3" stroke="currentColor" stroke-linecap="round"/>
  </svg>`;

  const rightSuffix = isLocal
    ? '<div class="drag-handle-spacer" aria-hidden="true"></div>'
    : '<button class="drag-handle" title="Drag to reorder" aria-label="Drag to reorder">↕</button>';

  row.innerHTML = `
    <div class="zone-row-inner">
      <span class="zone-select-dot" aria-hidden="true"></span>
      <div class="zone-names">
        <div class="zone-primary-name">
          <span class="zone-name-text"></span>
          ${!isLocal ? '<button class="zone-edit-btn" title="Edit name" aria-label="Edit zone name">✎</button>' : ''}
        </div>
        <div class="zone-secondary-name"></div>
        <div class="zone-meta">
          <span class="zone-offset"></span>
          ${!isLocal ? `<button class="zone-delete-btn" title="Remove zone" aria-label="Remove zone">${trashSVG}</button>` : ''}
        </div>
      </div>
      <div class="zone-right">
        <div class="zone-time-block">
          <span class="zone-time" aria-live="polite"></span>
          <span class="zone-date-label"></span>
        </div>
        ${rightSuffix}
      </div>
    </div>
  `;

  row.addEventListener('click', (e) => {
    if (
      e.target.closest('.zone-delete-btn') ||
      e.target.closest('.drag-handle') ||
      e.target.closest('.zone-edit-btn') ||
      e.target.closest('.zone-inline-edit')
    ) return;
    onSelectZone(zone.id);
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectZone(zone.id);
    }
  });

  row.querySelector('.zone-delete-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showDeleteModal(zone);
  });

  row.querySelector('.zone-edit-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    startPseudonymEdit(row, zone);
  });
  if (!isLocal) {
    row.querySelector('.zone-name-text')?.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startPseudonymEdit(row, zone);
    });
  }

  updateRowName(row, zone);
  return row;
}

// Replace underscores with spaces for display; keep the raw id for logic.
function formatIana(id) {
  return id.replace(/_/g, ' ');
}

function updateRowName(row, zone) {
  // Don't touch rows that are currently being edited
  if (row.querySelector('.zone-inline-edit')) return;

  const nameText    = row.querySelector('.zone-name-text');
  const secondaryEl = row.querySelector('.zone-secondary-name');

  if (zone.id === 'local') {
    if (nameText) nameText.textContent = 'Local';
    if (secondaryEl) {
      secondaryEl.textContent = formatIana(Intl.DateTimeFormat().resolvedOptions().timeZone);
      secondaryEl.hidden = false;
    }
  } else if (zone.pseudonym) {
    if (nameText) nameText.textContent = zone.pseudonym;
    if (secondaryEl) { secondaryEl.textContent = formatIana(zone.id); secondaryEl.hidden = false; }
  } else {
    if (nameText) nameText.textContent = formatIana(zone.id);
    if (secondaryEl) { secondaryEl.textContent = ''; secondaryEl.hidden = true; }
  }
}

export function updateRowSelection(row, isSelected) {
  row.classList.toggle('selected', isSelected);
  row.setAttribute('aria-selected', isSelected ? 'true' : 'false');
}

export function refreshSelection(selectedId) {
  zonesContainer.querySelectorAll('.zone-row').forEach(row => {
    updateRowSelection(row, row.dataset.id === selectedId);
  });
}

// ── Pseudonym editing ─────────────────────────────────────────────────────────

function startPseudonymEdit(row, zone) {
  // Cancel any other open edit first (different row)
  const existing = zonesContainer.querySelector('.zone-inline-edit');
  if (existing && existing !== row.querySelector('.zone-inline-edit')) {
    // Blur it — its own blur handler will fire and clean up via onPseudonymChange / cancel
    existing.blur();
  }

  const primaryName = row.querySelector('.zone-primary-name');
  // Don't open a second edit on the same row
  if (!primaryName || primaryName.querySelector('.zone-inline-edit')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'zone-inline-edit';
  input.value = zone.pseudonym || '';
  input.placeholder = formatIana(zone.id);

  primaryName.innerHTML = '';
  primaryName.appendChild(input);

  let committed = false;

  const restoreRow = () => {
    // Remove the row from DOM so renderZoneList recreates it cleanly
    rowCache.delete(zone.id);
    row.remove();
  };

  const commit = () => {
    if (committed) return;
    committed = true;
    const val = input.value.trim();
    restoreRow();
    onPseudonymChange(zone.id, val);
    // app.setPseudonym → renderZoneList will recreate the row fresh
  };

  const cancel = () => {
    if (committed) return;
    committed = true;
    restoreRow();
    // Trigger a re-render with unchanged state to put the row back
    onPseudonymChange(zone.id, zone.pseudonym || '');
  };

  input.addEventListener('blur', () => {
    setTimeout(() => { if (!committed) commit(); }, 0);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      committed = true; // block blur handler
      input.removeEventListener('blur', () => {});
      cancel();
    }
  });

  requestAnimationFrame(() => { input.focus(); input.select(); });
}
