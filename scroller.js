// scroller.js — Canvas tick belt, pointer events, inertia, beltOffsetPx ↔ offsetMs
// Version: 1.2.20260330

const TICK_SPACING_PX = 40;
const INERTIA_DECAY   = 0.92;
const INERTIA_STOP    = 0.5;

const STEP_MS = {
  '1D':  86400000,
  '1H':  3600000,
  '30M': 1800000,
};

const MAJOR_INTERVAL = {
  '1D': 7,
  '1H': 24,
  '30M': 24, // every 12 h = 24 × 30 min
};

let canvas, ctx;
let logicalW = 0; // logical (CSS) pixel width — set by ResizeObserver
let logicalH = 0;

let beltOffsetPx    = 0;
let velocity        = 0;
let isDragging      = false;
let lastPointerX    = 0;
let isInertiaActive = false;
let scrollerDirty   = true;
let rafId           = null;
let isPaused        = false;

// Injected from app.js
let getOffsetMs     = () => 0;
let getStepSize     = () => '30M';
let onOffsetChanged = () => {};
let setOffsetMs     = () => {};

export function initScroller(canvasEl, deps) {
  canvas = canvasEl;
  ctx    = canvas.getContext('2d');

  getOffsetMs     = deps.getOffsetMs;
  getStepSize     = deps.getStepSize;
  onOffsetChanged = deps.onOffsetChanged;
  setOffsetMs     = deps.setOffsetMs;

  // ResizeObserver gives us post-layout pixel sizes — no stale offsetWidth
  const ro = new ResizeObserver(entries => {
    for (const entry of entries) {
      const r = entry.contentRect;
      resizeCanvas(r.width, r.height);
    }
  });
  ro.observe(canvas);

  // Pointer events (unified mouse + touch)
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup',   onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  startRAF();
}

function resizeCanvas(w, h) {
  const dpr = window.devicePixelRatio || 1;
  logicalW = w;
  logicalH = h;
  // Assigning .width/.height resets the canvas context transform entirely
  canvas.width  = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  // Re-apply DPR scale on a clean transform
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scrollerDirty = true;
}

// Called externally when offsetMs changes (arrow buttons, Now)
export function syncBeltToOffset(offsetMs) {
  const stepMs = STEP_MS[getStepSize()];
  beltOffsetPx = -(offsetMs / stepMs) * TICK_SPACING_PX;
  velocity = 0;
  isInertiaActive = false;
  scrollerDirty = true;
}

export function pauseScroller() {
  isPaused = true;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

export function resumeScroller() {
  if (!isPaused) return;
  isPaused = false;
  startRAF();
}

function startRAF() {
  if (rafId) return;
  rafId = requestAnimationFrame(scrollerTick);
}

function scrollerTick() {
  if (isPaused) return;

  if (isInertiaActive) {
    velocity *= INERTIA_DECAY;
    if (Math.abs(velocity) < INERTIA_STOP) {
      velocity = 0;
      isInertiaActive = false;
    } else {
      beltOffsetPx += velocity;
      const stepMs = STEP_MS[getStepSize()];
      const newOffset = Math.round(-(beltOffsetPx / TICK_SPACING_PX) * stepMs);
      setOffsetMs(newOffset);
      scrollerDirty = true;
      onOffsetChanged();
    }
  }

  if (scrollerDirty) {
    renderScrollerCanvas();
    scrollerDirty = false;
  }

  rafId = requestAnimationFrame(scrollerTick);
}

function onPointerDown(e) {
  isDragging      = true;
  lastPointerX    = e.clientX;
  velocity        = 0;
  isInertiaActive = false;
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onPointerMove(e) {
  if (!isDragging) return;
  const dx = e.clientX - lastPointerX;
  lastPointerX = e.clientX;
  velocity = dx;

  beltOffsetPx += dx;
  const stepMs = STEP_MS[getStepSize()];
  const newOffset = Math.round(-(beltOffsetPx / TICK_SPACING_PX) * stepMs);
  setOffsetMs(newOffset);
  scrollerDirty = true;
  onOffsetChanged();
  e.preventDefault();
}

function onPointerUp() {
  if (!isDragging) return;
  isDragging = false;
  if (Math.abs(velocity) > INERTIA_STOP) {
    isInertiaActive = true;
  }
}

function renderScrollerCanvas() {
  if (!ctx || logicalW === 0) return;
  const W = logicalW;
  const H = logicalH;
  const stepSize   = getStepSize();
  const majorEvery = MAJOR_INTERVAL[stepSize];

  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = getVar('--scroller-bg');
  ctx.fillRect(0, 0, W, H);

  // Centre is always exactly W/2 in logical pixels
  const centreX = W / 2;

  // Which tick index maps to the centre?
  const centreTickF = -beltOffsetPx / TICK_SPACING_PX;
  const centreTickI = Math.round(centreTickF);
  const subPixel    = (centreTickF - centreTickI) * TICK_SPACING_PX;

  const halfTicks = Math.ceil(W / TICK_SPACING_PX / 2) + 2;

  // Draw ticks first
  for (let i = centreTickI - halfTicks; i <= centreTickI + halfTicks; i++) {
    const x = centreX + (i - centreTickI) * TICK_SPACING_PX + subPixel;
    const isMajor = (((i % majorEvery) + majorEvery) % majorEvery) === 0;
    const tickH = isMajor ? H * 0.55 : H * 0.30;
    const tickY = (H - tickH) / 2;

    ctx.beginPath();
    ctx.lineWidth = isMajor ? 1.5 : 1;
    ctx.strokeStyle = isMajor
      ? getVar('--scroller-tick-major')
      : getVar('--scroller-tick');
    ctx.moveTo(x, tickY);
    ctx.lineTo(x, tickY + tickH);
    ctx.stroke();
  }

  // Centre indicator line — drawn last, always on top
  ctx.beginPath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = getVar('--accent');
  ctx.moveTo(centreX, 4);
  ctx.lineTo(centreX, H - 4);
  ctx.stroke();
}

function getVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}
