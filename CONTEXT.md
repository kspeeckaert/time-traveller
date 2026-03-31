# Time Traveler — Session Context & Implementation Notes

> AI context document. Optimised for continuation across sessions.
> Current version: **1.7.20260330** · Last updated: 2026-03-30

---

## What This App Is

A vanilla-JS PWA world clock with "time travel". Displays a user-configurable list of IANA time zones, each showing the current (or offset) time. A momentum-driven infinite canvas scroller shifts all clocks forward or backward simultaneously.

**Target platform:** Safari on macOS (Apple Silicon) primary; responsive to mobile/iOS. No build step — files served directly.

---

## File Structure

```
time-traveler/
├── index.html          HTML shell; loads SortableJS (CDN classic script), then app.js as module
├── style.css           All styles — dark palette, CSS custom properties
├── app.js              Entry point: state, localStorage, render loop, event wiring
├── zones.js            Zone list: SortableJS, row creation/rendering, pseudonym editing, delete modal
├── scroller.js         Canvas tick belt: pointer events, inertia RAF loop, ResizeObserver
├── time-utils.js       Pure helpers: Intl formatter cache, displayedEpoch, timeInZone, dateLabel, utcOffsetString
├── manifest.json       PWA manifest: standalone display, dark theme, icon refs
├── sw.js               Service worker: cache-first, pre-caches APP_SHELL, versioned CACHE_NAME
└── icons/
    ├── apple-touch-icon.png   180×180 — placeholder, user replaces
    ├── icon-192.png            192×192 — placeholder, user replaces
    ├── icon-512.png            512×512 — placeholder, user replaces
    └── icon-512-maskable.png  512×512 maskable — placeholder, user replaces
```

**Load order matters:** SortableJS must be a classic `<script>` before the `<script type="module">` entry point, because SortableJS 1.15.0 has no ESM build on jsDelivr.

---

## Architecture

### State (app.js)

```js
// Persisted to localStorage key "timetraveler_v1"
state = {
  zones: [
    { id: 'local', label: 'Local', pinned: true },   // always index 0, never removed
    { id: 'Europe/London', pseudonym: 'London HQ' }, // pseudonym optional
    { id: 'UTC' }
  ],
  selectedZoneId: 'local',   // which zone the scroller references
  stepSize: '30M'            // '1D' | '1H' | '30M'
}

// Runtime only — never persisted, always resets to 0 on load
offsetMs = 0   // ms offset from Date.now()
```

`displayedEpoch()` = `Date.now() + offsetMs` — used everywhere for time calculations.

### Module dependencies

```
index.html
  └── app.js
        ├── time-utils.js   (no imports)
        ├── scroller.js     (imports time-utils)
        └── zones.js        (imports time-utils)
```

All inter-module communication is via injected callback/getter functions passed at `init*()` time — no shared globals between modules.

### Render loop split

Two independent loops to avoid wasted work:

| Loop | Frequency | Condition | Does |
|------|-----------|-----------|------|
| RAF (scroller) | 60 fps | `scrollerDirty === true` | Redraws canvas |
| Clock interval | 1 fps | `offsetMs === 0` | Updates zone row times |

`onOffsetChanged()` is called synchronously by any interaction that mutates `offsetMs` — it calls `renderAllZoneRows()` and sets `scrollerDirty = true`.

Zone rows use a per-row Map cache (`rowCache`) for DOM diffing — only writes to the DOM when `time`, `dateLabel`, or `offset` value actually changes.

---

## Key Design Decisions & Rationale

### SortableJS loaded as classic script
SortableJS 1.15.0 on jsDelivr does not expose an ESM build. It must be loaded as a `<script>` tag *before* the module entry point so `Sortable` is a global when `zones.js` calls `Sortable.create()`.

### ResizeObserver for canvas sizing (not window resize)
`window.resize` + `canvas.offsetWidth` produces stale values because layout hasn't settled yet. `ResizeObserver` on the canvas element fires post-layout with accurate `contentRect.width/height`. The context is reset with `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` (not `ctx.scale`) to avoid accumulating transforms across resize events.

### Canvas centre line always at `W/2`
`beltOffsetPx` tracks how far the belt has scrolled in logical pixels. `centreTickF = -beltOffsetPx / TICK_SPACING_PX` gives the fractional tick index at centre. The centre indicator line is drawn last (after all ticks) so it always renders on top.

### Pseudonym edit — row removal strategy
**The bug that recurred:** any approach that patches the existing DOM row in-place while an `<input>` is active fails because `renderZoneList` re-uses existing rows (only creates new ones for missing IDs). If `commit()` clears tracking refs before `renderZoneList` runs, the row still contains the live input.

**Working fix:** on both `commit` and `cancel`, immediately call `row.remove()` and `rowCache.delete(zone.id)` *before* triggering `onPseudonymChange`. `renderZoneList` then finds no existing row for that ID and calls `createRowElement` unconditionally, producing a clean row.

```js
const restoreRow = () => {
  rowCache.delete(zone.id);
  row.remove();
};
const commit = () => {
  if (committed) return;
  committed = true;
  const val = input.value.trim();
  restoreRow();
  onPseudonymChange(zone.id, val); // triggers renderZoneList → recreates row
};
```

`cancel` calls `onPseudonymChange(zone.id, zone.pseudonym || '')` to re-render with unchanged state.

### Local row alignment
The Local row has no drag handle. Non-local rows have a `.drag-handle` button of width `--handle-w: 28px`. Without a spacer, the time column right-aligns differently between row types. Fix: Local rows render `<div class="drag-handle-spacer">` — same width as the handle, invisible, no pointer events.

### Offset label centering
`position: absolute; left: 0; right: 0` inside a `position: relative` container centres the label over the full bar width regardless of asymmetric siblings. `pointer-events: none` so clicks pass through to buttons. This approach replaced `flex: 1` which can't truly centre when siblings have unequal widths.

**Later change:** the controls bar was restructured so the offset label has its own dedicated row (`#offset-row`) above the scroller, and step/Now buttons moved below the scroller. This eliminates all interference at narrow PWA window widths.

### Footer layout (final)

```
[ offset label — centred, #offset-row ]
[ ‹  canvas  › — #scroller-row ]
[ 1D  1H  30M  ·  Now — #controls-bar, centred ]
```

### Canvas overflow at narrow widths
`#app { overflow: hidden }` + `#scroller-row { min-width: 0 }` + `#scroller-canvas { min-width: 0; width: 100% }` prevents the canvas from escaping the flex container at narrow PWA window widths. Without `overflow: hidden` on `#app`, flex children clip the right arrow off-screen rather than constraining the canvas.

---

## CSS Palette

Fixed dark values — not CSS system colour tokens (the initial implementation used `Canvas`/`CanvasText` but these were replaced to match the macOS Clock aesthetic).

```css
--bg:              #000
--surface:         #1c1c1e    /* header, footer, zone list background */
--surface-raised:  #2c2c2e    /* inputs, dropdowns, dialog */
--surface-high:    #3a3a3c
--text-primary:    #ffffff
--text-secondary:  rgba(255,255,255,0.72)
--text-tertiary:   rgba(255,255,255,0.50)
--accent:          #ff9f0a    /* orange — matches macOS Clock */
--accent-dim:      rgba(255,159,10,0.25)
--divider:         rgba(255,255,255,0.10)
--scroller-bg:         #1c1c1e
--scroller-tick:       rgba(255,255,255,0.20)
--scroller-tick-major: rgba(255,255,255,0.50)
```

---

## Intl Formatter Cache (time-utils.js)

`Intl.DateTimeFormat` construction is expensive. All formatters are created once and stored in `_fmtCache: Map<string, Intl.DateTimeFormat>` keyed by `"${ianaId}|${JSON.stringify(options)}"`.

Cache is invalidated and rebuilt (`invalidateFormatterCache()`) when `Intl.DateTimeFormat().resolvedOptions().timeZone` changes between clock ticks (system timezone change detection).

Typical formatters created per zone: `{ hour, minute }`, `{ year, month, day }`, `{ timeZoneName: 'shortOffset' }`.

---

## IANA ID Display

Raw IANA IDs (e.g. `America/Sao_Paulo`) are displayed with underscores replaced by spaces everywhere in the UI via `formatIana(id)` in `zones.js`:

```js
function formatIana(id) { return id.replace(/_/g, ' '); }
```

The raw ID is **never modified** in state, localStorage, or any `Intl` call. Display sites: primary name, secondary name, Local system TZ line, delete modal, inline edit placeholder, search dropdown.

---

## UTC Offset String Format

`UTC+05:30`, `UTC−05:00` (U+2212 MINUS SIGN, not hyphen-minus). Special case: `UTC±00:00`.

Derived via `Intl.DateTimeFormat` with `{ timeZoneName: 'shortOffset' }`, normalised from the `GMT±H:MM` format it returns.

---

## Date Label Logic

```
localToday = calendar date of Date.now() in local system TZ
zoneDate   = calendar date of displayedEpoch() in that zone's TZ

diff = zoneDate − localToday (whole days)
0  → "Today"
1  → "Tomorrow"
-1 → "Yesterday"
else → "YYYY-MM-DD"
```

Comparison uses `Date.UTC(y, m-1, d)` midnights to avoid DST-induced hour shifts corrupting the day diff.

---

## PWA Configuration

### manifest.json
- `display: standalone` — no browser chrome when installed
- `theme_color: #1c1c1e` — matches surface colour
- `background_color: #000000`
- Icons: `icons/icon-192.png`, `icons/icon-512.png` (any), `icons/icon-512-maskable.png` (maskable)
- `apple-touch-icon` linked separately in `<head>` (Safari ignores manifest icons for home screen)

### sw.js
- Cache-first strategy
- Pre-caches `APP_SHELL` (all 8 app files) on `install`
- Deletes old caches on `activate` (keyed by `CACHE_NAME = 'time-traveler-v${VERSION}'`)
- `skipWaiting()` + `clients.claim()` for immediate takeover
- **Must bump `CACHE_NAME`** on every deployment to evict stale assets

### Deployment requirement
Service workers require HTTPS (or `localhost`). `file://` will not register the SW. Options: GitHub Pages, Netlify, Cloudflare Pages (all free, HTTPS automatic).

---

## Versioning Convention

`[major].[minor].[iso-date]` e.g. `1.7.20260330`

Three places to update on each change:
1. `const VERSION` in `app.js`
2. `const CACHE_NAME` in `sw.js` (include version so old caches are evicted)
3. Version comment header in changed files

---

## Known Removed Features (from original spec)

| Feature | Status | Reason |
|---------|--------|--------|
| `[+ Add]` header button | Removed | Redundant — search bar is the only entry point |
| Date/time picker (`📅`) | Removed | Safari `showPicker()` unreliable; `<input type="datetime-local">` UI inconsistent across platforms |
| Inline delete confirm (row expands) | Replaced | Replaced with `<dialog>` modal — less layout-disruptive |
| Scroller tick labels | Removed | Clipped at canvas bottom; labels added no value given ticks are unlabelled by design |

---

## Bugs Fixed & How

### Canvas centre line drifts on resize
**Cause:** `window.resize` + `canvas.offsetWidth` read stale pre-layout value.
**Fix:** `ResizeObserver` on the canvas element; `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` resets transform cleanly.

### Pseudonym edit input persists / multiple active simultaneously
**Cause:** `renderZoneList` re-uses existing DOM rows. `commit()` cleared tracking refs before `renderZoneList` ran, making `cancelActiveEdit()` a no-op. Row with live `<input>` was never rebuilt.
**Fix:** `row.remove()` + `rowCache.delete()` before calling `onPseudonymChange`. Forces `createRowElement` to run on next render.

### `getOffsetMs` ReferenceError on init
**Cause:** ES6 shorthand `{ getOffsetMs }` in `initScroller` call requires a declared identifier of that name. `getOffsetMs` only existed as an inline lambda.
**Fix:** Explicit arrow function `getOffsetMs: () => offsetMs`.

### Right arrow clipped / canvas overflow at narrow widths
**Cause:** Default flex `min-width: auto` prevents container from shrinking below content size.
**Fix:** `#app { overflow: hidden }`, `#scroller-row { min-width: 0 }`, `#scroller-canvas { min-width: 0; width: 100% }`.

### Offset label not truly centred
**Cause:** `flex: 1` on label between asymmetric siblings can't achieve true visual centre.
**Fix (v1):** `position: absolute; left: 0; right: 0` inside `position: relative` container.
**Fix (v2):** Moved label to its own dedicated `#offset-row` with `justify-content: center`.

### Safari `<dialog>` renders top-left
**Cause:** Safari does not auto-centre `<dialog>` like Chrome.
**Fix:** `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); margin: 0`.

---

## What Has NOT Been Implemented (from spec)

- Sunrise/sunset display (spec didn't include this in the version that was built)
- World map with city pins
- The spec's date-time picker — removed entirely

---

## Continuation Notes for Next Session

- All files are at version `1.7.20260330`
- Icon placeholders exist at `icons/` — user will supply real icons (180, 192, 512px PNG)
- The app works over `localhost:8000` with `python3 -m http.server` or similar
- `localStorage` key is `"timetraveler_v1"` — if data model changes, bump the key
- SortableJS CDN integrity hash: `sha256-ipiJrswvAR4VAx/th+6zWsdeYmVae0iJuiR+6OqHJHQ=`
