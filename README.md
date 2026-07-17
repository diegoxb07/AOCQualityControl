# AOC QC Tool

A browser quality-assessment tool for **Aircraft Operations Center** flight-level data. It loads any flight, grades every sensor against its counterpart and reference sensors, flags data gaps, physically implausible values, and will export the same reports the FD's need.

Runs entirely in the browser, with the API-backend always optionally used.

- **Tool Link:** https://diegoxb07.github.io/AOCQualityControl/ (GitHub Pages)
- **Repository:** https://github.com/diegoxb07/AOCQualityControl

It reuses selected pieces of the AOC Mission Visualizer (the design system, NetCDF parser, archive loader, and the 2D/3D map for spatial context), but QC is the whole tool, not a button bolted onto the visualizer.

---

## What it's for

| Use case | What the tool gives you |
| --- | --- |
| **Post-flight QC** | Load a flight, read every sensor family on stacked graphs with its members and reference overlaid, spot gaps and disagreement at a glance, confirm takeoff/landing, and export the sensor, gap, and plane stats the archive expects. |
| **Error summary** | Fill and download the mission's Error Summary PDF, prefilled from the flight (id, times, ground locations, ref-derived sensor designations) and editable before export. |
| **Sharing** | Hand a colleague a self-contained interactive HTML of the whole report, or a link that reopens an archive mission at your exact playhead and view. |

---

## 1. Loading a mission

Both paths feed the **same** QC parser, so the graphs, report, and exports behave identically either way.

**Archive browser (needs the API online).** Pick **Year → Storm → Flight**, then **⤓ Load Flight + Storm Track**. The search box takes a full mission id to load it directly, or a storm name alone to find that storm across every season. Every flight you load is saved on this device and reopens instantly from the **already loaded** list, newest first.

**Manual upload (always works, no internet).** Drop a **`.txt`** or **`.nc`** file on the **"or upload:"** zone.

> Archive controls greyed out with an **"API Offline"** banner mean the archive service is unreachable; use manual upload. It re-checks periodically and re-enables itself.

**⤓ Batch Load Flight Data** downloads whole seasons for instant, offline reopening.

---

## 2. Takeoff, landing & trimming

Takeoff and landing are auto-detected from the blended INS-GPS altitude (median across units; pure GPS, then airspeed, as fallbacks). Takeoff is the first climb through field elevation + 100 m that holds and keeps climbing over the next minutes and — when an airspeed channel exists — coincides with flying airspeed, so pre-takeoff sensor fluctuation on the ramp is not mistaken for departure. Everything recorded more than five minutes before takeoff is trimmed away and never reaches the graphs, gaps, or stats; those five minutes are the **takeoff phase** of the phase statistics.

To override, type `HHMMSS` times in the **T/O** and **LND** boxes in the header and press **Apply**; the whole report (trim, phases, stats, references, graphs) recomputes. **Auto** returns to detection.

---

## 3. Reading a graph

One family per row, in the script's panel order, SFMR families last.

- **Gap markers.** A small triangle in the top strip marks a gap; the faint yellow pillar under it spans the missing seconds. Click the triangle to jump the playhead there and zoom into the gap; hover the pillar for its window and length. One-second gaps draw as thin lines until you zoom in.
- **Check regions.** Red shading marks physically implausible values (humidity above 200 percent, a 100 m/s wind change in under 15 s, vertical wind beyond 40 m/s, a 5 degree position move within 30 minutes). Judge each in flight context: a 20 m/s vertical wind is suspect at cruise, plausible in an eyewall.
- **Markers.** Dotted verticals are takeoff and landing; the solid line is the playhead. `NO DATA` appears in place when a family has nothing to plot.
- **Hover.** The tooltip picks the point nearest the cursor in both axes, so aiming at a spike grabs it; every other visible sensor's value at that second lists below.

**Tools:** scrub (drag moves the playhead), pan (drag the window, vertically too), and select zoom (drag a box); the wheel always zooms time. **Reset Zoom** floats on a zoomed graph, as does save-PNG and fullscreen. The **graph search** bar jumps to any variable, sensor, or title.

---

## 4. Legend & references

One checkbox per variable. **Group chips** toggle a whole sensor set (direct vs GPS, and so on); several groups can be lit at once. Each block lists the **standard deviation** and **coefficient of variation** between the selected sensors, with the worst-disagreement moment named.

A pipe connector chains the **reference** to every sensor it rode across the flight, in order. If it switched mid-flight, a badge in the title names each switch with its time (click a time to jump there), and the source in force at the playhead reads blue as you scrub.

---

## 5. Issues, pills & statistics

**Summary pills** (Check, OK, gaps, no data) list their sensors on click and jump to the first issue and its graph. The per-graph **chip strip** does the same per family, with the flag breakdown in parentheses beside the **+N more** toggle.

**Max/Mean/Median** pops out under its button: takeoff, mid-flight, and landing max, mean, and median for any variable. The **Difference Between Sensors** graph plots every in-group pair with its max difference listed; cross-group pairs sit on their own row.

The **Flight Track** panel fuses latitude and longitude into one map (longitude x, latitude y) with faint geography behind the tracks, takeoff/landing/playhead dots, and a GPS / Blended Inertial group chip; clicking a track jumps the playhead there.

---

## 6. Flight context

**Flight Context** opens the sidebar: the 2D/3D map tracker, the per-sensor report, **Play**, the speed control, and the flight clock. The 2D map follows the aircraft; pan away and **Recenter on Aircraft** appears. Scrub from any graph, the arrow keys, or Play, and every surface follows the same playhead.

Keyboard: **Space** play/pause, **← / →** step one second (**Shift** for ten), **Ctrl/Cmd + Z** step a zoom back, **Esc** close panels.

---

## 7. Exporting

| Export | What it is |
| --- | --- |
| **Indiv. Sensor Stats CSV** | One row per sensor (presence, gaps, missing seconds, early stop) plus each pair's max difference. |
| **Indiv. Plane Stats CSV** | Pick which stored flights go into each plane's `N42/N43/N49_Stats.txt`, byte-for-byte in the legacy format so downloads append onto historical files. Every loaded flight saves automatically. |
| **Gap Report (.dat)** | Recorder gaps in the archive's `GapReport.dat` wording. |
| **Interactive Report (.html)** | One self-contained file: every graph interactive (zoom, hover), the gap markers, the flight track, and the summary. Opens anywhere, no flight load needed, sendable to anyone. |
| **Error Summary (.pdf)** | The `qc_Error_Summary` form, prefilled by the tool and editable; the PDF layout matches the script exactly. |
| **Share QC Link** | Reopens an archive mission at your playhead, tracker view, and sidebar state. |

The **Error Summary** modal prefills the flight id, takeoff/landing times, flight directory, ground locations (nearest airport within a few miles of the aircraft at takeoff/landing), and sensor designations (from what the reference variables rode). Fields the tool can't derive are left blank rather than guessed; required fields flag red while empty. Click a designation row to graph its candidate sensors beside the form.

---

## Architecture

Classic scripts in `index.html`, one global scope, load order matters, a `?v=YYYYMMDD<letter>` cache-buster on every asset (bump it after editing any css/js). No build step, no dependencies; all libraries, fonts, basemap, and the airport table ship in the repo, so manual uploads work with no internet.

**Offline (`sw.js`).** A service worker precaches every same-origin asset (~5.5 MB: page, css/js, libs, fonts, basemap data) on the first visit and serves it cache-first from then on, so after one online load the page opens and replays flights with no network — `docs/CONNECTIVITY.md` has the full online/offline matrix. Cross-origin requests (recon-api, NASA GIBS, the GeoJSON fallback) pass straight through uncached, so the API health check still sees real failures and the "API Offline" banner keeps working. The deploy workflow stamps `CACHE_VERSION` in `sw.js` with the commit SHA — the same `sed` that stamps the `?v=` tokens — so every deploy installs a fresh cache and drops the previous one on activate; cached files are matched ignoring the query string, and a new version applies on the next page load. Two rules to keep it honest: **every added or renamed css/js/font/data file must also be added to `PRECACHE` in `sw.js`** (`cache.addAll` rejects wholesale on a single 404, and the app silently stays online-only), and cache names keep the `aoc-qc-` prefix because the `github.io` origin is shared with sibling project pages. The worker only registers on `github.io`; localhost and Codespaces previews stay service-worker-free and always serve the working tree.

QC-specific files:

| File | Role |
| --- | --- |
| `js/00b-qc-catalog.js` | sensor catalog: families, per-airframe members (P-3 `H`/`I`, G-IV `N`), references, difference pairs. The allow-list. |
| `js/11b-parser-core.js` | `parseFlightRawQC`: keeps every row on a continuous 1-second axis, no cleanup. |
| `js/21-qc-engine.js` | presence, coverage, gap classification, phase stats, differences, derived SLP. |
| `js/22-qc-charts.js` | stacked family and difference graphs, the flight-track map, gap shading, playhead, toolbar, issue strips. |
| `js/23-qc-report.js` | the app shell, per-sensor report, exports, cross-flight store, sidebar, map relocation. |
| `js/24-qc-export-html.js` | the self-contained interactive HTML export. |
| `js/25-qc-error-summary.js` | the Error Summary PDF and its prefill logic. |
| `data/airports.json` | large/medium airports worldwide (OurAirports, public domain), for ground-location lookup. |

The remaining `js/` files are the reused visualizer subsystems (parser, map, archive loader, layout, theming). The visualizer's own page stays in the DOM underneath the QC app so its wiring keeps working; only the map panel, mission loader, and top-right controls are relocated into the QC layout.

---

## Running & deploying

- **No build step.** Open the tool link, or serve the directory statically (`python3 -m http.server`).
- **Deployment:** GitHub Pages.
- **No test suite.** Verify changes by opening the page and exercising the load → read → export flow.
