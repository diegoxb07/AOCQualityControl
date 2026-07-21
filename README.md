# AOC QC Tool

This is a browser-based quality-assessment tool built for Aircraft Operations Center WP-3D and G-IV flight-level data. It will load any flight, compare the sensors against their counterparts and reference sensors, flag any data gaps and/or physically impossible values, and has the ability to export the reports that FD's / Engineers needs (ex. Error Summary, Flight Track, & more)

This tool runs entirely in the browser, with the online capabilities always being optional (ex. loading a flight from the archive instead of a local files upload)

- **Tool Link:** https://diegoxb07.github.io/AOCQualityControl/ (GitHub Pages)
- **Github Repository:** https://github.com/diegoxb07/AOCQualityControl

This tool reuses selected pieces of the AOC Mission Visualizer (the design, NetCDF parser, archive loader, and the 2D/3D map for context).


## 1. Loading a mission

**Archive browser (needs API to be online).** Pick **Year → Storm → Flight**, then **⤓ Load Flight + Storm Track**. The search box takes a full mission id to load it directly, or a storm name alone to find that storm across every season. Every flight you load is saved on this device and reopens instantly from the **already loaded** list, newest first.

**Manual upload (works offline).** Drop a **`.nc`** file on the **"or upload:"** button. Keep in mind that every flight that you load is saved on this device and can reopen instantly from the **already loaded** list.

> If the archive loader is greyed out with an **"API Offline"** banner, this means the API archive service is unreachable; and the user should simply manually upload the nc file. It will re-check periodically and re-enables itself (refresh recommended).

**⤓ Batch Load Flight Data** is a tool you can use to download flights in batch, (ex. whole seasons), so that when you need many flights readily available, it will be instant, and offline reopening (if browser closes, then it will get rid of the loaded flights)

**Metrics Across Flights** finds which stored flight recorded the highest or lowest value of any metric, with a comparison graph (works offline).

---

## 2. Takeoff, landing & trimming

Takeoff and landing are auto-detected from the blended INS-GPS altitude (median across units; pure GPS, then airspeed, as fallbacks). Takeoff is detected as the first climb through field elevation + 100 m that holds and keeps climbing over the next minutes and if an airspeed channel exists, it should coincide with flying airspeed, so pre-takeoff sensor fluctuation on the ramp is not mistaken for departure. Everything recorded more than five minutes before takeoff is trimmed away and never reaches the graphs, gaps, or stats; those five minutes are the **takeoff phase** of the phase statistics.

To override these automated T/O and LND times , you can type `HHMMSS` times in the **T/O** and **LND** boxes in the header and press **Apply**; the whole report (trim, phases, stats, references, graphs) recomputes. **Auto** returns to detection.

---

## 3. Reading a graph

- **Gap markers.** A small triangle in the top part of the graph marks a gap; the faint yellow highlight under it shows the length the missing seconds. Users can click on the triangle to jump the playhead there and it will zoom into the gap; hover the highlighted region for info on the gap and length.
- **Check regions.** Red shading mark physically implausible values (humidity above 200 percent, a 100 m/s wind change in under 15 s, vertical winds beyond 40 m/s, a 5 degree lat/lon position move within 30 minutes). User should still judge each in the flights' context.
- **Markers.** Dotted vertical lines mark the takeoff and landing; the solid white line is the playhead. `NO DATA` appears in places where sensors (ex. SFMR) has nothing to plot.
**Tools:** timesliding (dragging moves the player), pan (drags the window), and select zoom (drag a box to zoom). **Reset Zoom** will appear on any zoomed graphs. The **graph search** bar helps the user find a variable they need, and jumps to that pertinent graph.

---

## 4. Legend & references

 **Group chips** Clicking on the 'group' chip selects/unselects a whole sensor set; several groups can be selected at once. Selected sensors will display a **standard deviation** and **coefficient of variation** between eachother.

A horizontal line shows the **reference** and its referring sensor as it goes across the flight, in order. If it switches mid-flight, a badge in the title names each switch with its time (click a time to jump there), and the source sensor reads blue as you slide to the point in the flight it is being referred to.

---

## 5. Issues, pills & statistics

**Summary pills** These pills list the flagged items on each sensor, which you can click and jump its graph with these pills. Ever graph has something similar but more in-depth on the flagged items, with the flag breakdown in parentheses beside the **+N more** toggle.

**Max/Mean/Median** will show: takeoff, mid-flight, and landing max, mean, and median for any variable (ex. PSM, PS.c).

The **Difference Between Sensors** graph plots every in-group pair with its max difference listed; cross-group pairs sit on their own row.

---

## 6. Flight context

**Flight Context** button will give context to users via the 2D/3D map tracker, and a per-sensor report below it. The 2D map follows the aircraft. If you pan away, **Recenter on Aircraft** is prompted. Slide from any graph, the arrow keys, or Play, and everything should follow the same playtime.

Keyboard Shortcuts: **Space** play/pause, **← / →** step one second (**Shift** for ten), **Ctrl/Cmd + Z** step a zoom back, **Esc** close panels.

---

## 7. Exporting

| Export | Tools |
| --- | --- |
| **Indiv. Sensor Stats CSV** | This is an in-depth export tool that lists out all pertinent sensors from this flight. Has one row per sensor (presence, gaps, missing seconds, early stop) plus each pair's max difference. |
| **Indiv. Plane Stats CSV** | You can pick which of the cached flights go into each plane's `N42/N43/N49_Stats.csv`. This allows you to compare sensors across flights of the same plane. |
| **Gap Report (.dat)** | Recorder gaps in the archive's `GapReport.dat` wording. |
| **Interactive Report (.html)** | One easy-to-share file that includes every graph interactive, gap markers, and the flight track. Opens anywhere offline, no flight loading needed. |
| **Error Summary (.pdf)** | Based on the `qc_Error_Summary` form, but partially prefilled by the tool and editable. This matches the script exactly. |
| **Flight Track Map (.pdf)** | A landscape PDF map of the flight track, like the ones previously exported by FD's. |
| **Share QC Link** | Reopens an archive mission at your playhead, tracker view, and sidebar state. Best used to share the entire tool. |
| **NC → TXT (.txt)** | Converts the loaded flight to a delimited text file. Every variable in the file is listed (not just the graphed set), and the parameters, delimiter, and time window are all pickable. |
| **Download Original (.nc)** | The mission's full-resolution source NetCDF. |

The **Error Summary** modal prefills the flight id, takeoff/landing times, flight directory, ground locations (nearest airport within a few miles of the aircraft at takeoff/landing), and sensor designations (from what the reference variables rode). Any fields the tool can't derive are left blank rather than automated; required fields flag red while empty. You can click a designation row to graph its sensors beside the modal.

---

## Code Architecture

Classic scripts in `index.html`, one global scope, load order matters. No build step, no dependencies; all libraries, fonts, basemap, and the airport table ship in the repo, so manual uploads work with no internet.

**Offline (`sw.js`).** A service worker precaches every same-origin asset (~5.5 MB: page, css/js, libs, fonts, basemap data) on the first visit and serves it cache-first from then on, so after one online load the page opens and replays flights with no network. `docs/CONNECTIVITY.md` has the full online/offline matrix. Cross-origin requests (recon-api, NASA GIBS, the GeoJSON fallback) pass straight through uncached, so the API health check still sees real failures and the "API Offline" banner keeps working. The deploy workflow stamps `CACHE_VERSION` in `sw.js` with the commit SHA, the same `sed` that stamps the `?v=` tokens, so every deploy installs a fresh cache (each file revalidated against the server, never trusted to the HTTP cache) and drops the previous one on activate; cached files are matched ignoring the query string. The first load after a deploy still renders the old build while the new cache installs in the background; the reload after that shows it. Two rules to keep it honest: **every added or renamed css/js/font/data file must also be added to `PRECACHE` in `sw.js`** (`cache.addAll` rejects wholesale on a single 404, and the app silently stays online-only), and cache names keep the `aoc-qc-` prefix because the `github.io` origin is shared with sibling project pages. The worker only registers on `github.io`; localhost and Codespaces previews stay service-worker-free and always serve the working tree.

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
