# AOC QC Tool

This is a browser-based quality-assessment tool built specifically for **Aircraft Operations Center** WP-3D and G-IV flight-level data. It loads any flight, grades the sensors against their counterparts and reference sensors, flags any data gaps and physically impossible values, and has the ability to export reports that FD's / Engineers needs.

This tool runs entirely in the browser, with the online capabilities always being optional (ex. loading a flight from the archive instead of a local files upload)

- **Tool Link:** https://diegoxb07.github.io/AOCQualityControl/ (GitHub Pages)
- **Github Repository:** https://github.com/diegoxb07/AOCQualityControl

This tool reuses selected pieces of the AOC Mission Visualizer (the design, NetCDF parser, archive loader, and the 2D/3D map for spatial context).

---

## What it's for

| Use case | What the tool gives you |
| --- | --- |
| **Post-flight QC** | Load a flight, read every sensor family on stacked graphs with its members and reference overlaid, spot gaps and disagreement at a glance, confirm takeoff/landing, and export the sensor, gap, and plane stats the archive expects. |
| **Error summary/Flight track** | Fill and download the mission's Error Summary PDF, prefilled from the flight (id, times, ground locations, ref-derived sensor designations) and editable before export. Also able to download the flight track similar to previously exported by FD's in the last tool. |
| **Sharing** | Can send a colleagues interactive HTMLs of the whole flight, or a link that reopens an archive mission at your exact playhead and view for easy sharing and collaborating. |

---

## 1. Loading a mission

**Archive browser (needs API to be online).** Pick **Year → Storm → Flight**, then **⤓ Load Flight + Storm Track**. The search box takes a full mission id to load it directly, or a storm name alone to find that storm across every season. Every flight you load is saved on this device and reopens instantly from the **already loaded** list, newest first.

**Manual upload (always works, no internet needed).** Drop a **`.txt`** or **`.nc`** file on the **"or upload:"** zone. Every flight you load is saved on this device and reopens instantly from the **already loaded** list, newest first.

> If the archive shows greyed out with an **"API Offline"** banner mean the archive service is unreachable; and the user should use manual upload. It will re-check periodically and re-enables itself (refresh recommended).

**⤓ Batch Load Flight Data** is a tool you can use to download multiple flights in batch, (ex. whole seasons), so that when you need the flight, it will be instant, and offline reopening (browser musn't be closed)

---

## 2. Takeoff, landing & trimming

Takeoff and landing are auto-detected from the blended INS-GPS altitude (median across units; pure GPS, then airspeed, as fallbacks). Takeoff is detected as the first climb through field elevation + 100 m that holds and keeps climbing over the next minutes and if an airspeed channel exists, it should coincide with flying airspeed, so pre-takeoff sensor fluctuation on the ramp is not mistaken for departure. Everything recorded more than five minutes before takeoff is trimmed away and never reaches the graphs, gaps, or stats; those five minutes are the **takeoff phase** of the phase statistics.

To override this automated detection, you can type `HHMMSS` times in the **T/O** and **LND** boxes in the header and press **Apply**; the whole report (trim, phases, stats, references, graphs) recomputes. **Auto** returns to detection.

---

## 3. Reading a graph

- **Gap markers.** A small triangle in the top strip marks a gap; the faint yellow pillar under it spans the missing seconds. Click the triangle to jump the playhead there and zoom into the gap; hover the pillar for its window and length. One-second gaps draw as thin lines until you zoom in.
- **Check regions.** Red shading marks physically implausible values (humidity above 200 percent, a 100 m/s wind change in under 15 s, vertical winds beyond 40 m/s, a 5 degree lat/lon position move within 30 minutes). User should judge each in the flights' context: a 20 m/s vertical wind is suspect at cruise, plausible in an eyewall.
- **Markers.** Dotted verticals are takeoff and landing; the solid line is the playhead. `NO DATA` appears in place when a family of sensors (ex. SFMR) has nothing to plot.

**Tools:** scrub (dragging moves the player), pan (drags the window), and select zoom (drag a box). **Reset Zoom** will appear on a zoomed graph. The **graph search** bar jumps to any variable, sensor, or title.

---

## 4. Legend & references

 **Group chips** toggle a whole sensor set; several groups can be selected at once. Each block lists the **standard deviation** and **coefficient of variation** between the selected sensors, with the worst-disagreement moment named.

A connector shows the **reference** to every sensor it rode across the flight, in order. If it switched mid-flight, a badge in the title names each switch with its time (click a time to jump there), and the source in force at the playhead reads blue as you scrub.

---

## 5. Issues, pills & statistics

**Summary pills** (Check, OK, gaps, no data) list their sensors on click and jump to the first issue and its graph. The per-graph **chip strip** does the same per family, with the flag breakdown in parentheses beside the **+N more** toggle.

**Max/Mean/Median** will show: takeoff, mid-flight, and landing max, mean, and median for any variable (ex. PSM). The **Difference Between Sensors** graph plots every in-group pair with its max difference listed; cross-group pairs sit on their own row.

The **Flight Track** panel shows latitude and longitude into one map (longitude x, latitude y) with geography behind the tracks, takeoff/landing/playhead dots, and GPS / Blended Inertial group chips; clicking a track jumps the playhead there.

---

## 6. Flight context

**Flight Context** button will give context to users: the 2D/3D map tracker, and the per-sensor report. The 2D map follows the aircraft; pan away and **Recenter on Aircraft** appears. Scrub from any graph, the arrow keys, or Play, and everything should follow the same time.

Keyboard Shortcuts: **Space** play/pause, **← / →** step one second (**Shift** for ten), **Ctrl/Cmd + Z** step a zoom back, **Esc** close panels.

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

The **Error Summary** modal prefills the flight id, takeoff/landing times, flight directory, ground locations (nearest airport within a few miles of the aircraft at takeoff/landing), and sensor designations (from what the reference variables rode). Any fields the tool can't derive are left blank rather than automated; required fields flag red while empty. You can click a designation row to graph its sensors beside the modal.

---

## Architecture

Classic scripts in `index.html`, one global scope, load order matters, a `?v=YYYYMMDD<letter>` cache-buster on every asset (bump it after editing any css/js). No build step, no dependencies; all libraries, fonts, basemap, and the airport table ship in the repo, so manual uploads work with no internet.

**Offline (`sw.js`).** A service worker precaches every same-origin asset (~5.5 MB: page, css/js, libs, fonts, basemap data) on the first visit and serves it cache-first from then on, so after one online load the page opens and replays flights with no network — `docs/CONNECTIVITY.md` has the full online/offline matrix. Cross-origin requests (recon-api, NASA GIBS, the GeoJSON fallback) pass straight through uncached, so the API health check still sees real failures and the "API Offline" banner keeps working. The deploy workflow stamps `CACHE_VERSION` in `sw.js` with the commit SHA, the same `sed` that stamps the `?v=` tokens, so every deploy installs a fresh cache and drops the previous one on activate; cached files are matched ignoring the query string, and a new version applies on the next page load. Two rules to keep it honest: **every added or renamed css/js/font/data file must also be added to `PRECACHE` in `sw.js`** (`cache.addAll` rejects wholesale on a single 404, and the app silently stays online-only), and cache names keep the `aoc-qc-` prefix because the `github.io` origin is shared with sibling project pages. The worker only registers on `github.io`; localhost and Codespaces previews stay service-worker-free and always serve the working tree.

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
