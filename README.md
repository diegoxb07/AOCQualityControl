# AOC QC Tool

[![License: CC0-1.0](https://img.shields.io/badge/License-CC0_1.0-lightgrey.svg)](http://creativecommons.org/publicdomain/zero/1.0/)

This is a browser-based quality-assessment tool for Aircraft Operations Center WP-3D and G-IV flight-level data. It loads any flight, compares the sensors against their counterparts and reference sensors, flags data gaps and any physically impossible values, and exports reports FDs and engineers need (Error Summary, Flight Track, NC to TXT, and more!).

Tool link: https://diegoxb07.github.io/AOCQualityControl/ (GitHub Pages)
Offline version of the tool is available within this link too (the 'Offline Version' button)

Repository: https://github.com/diegoxb07/AOCQualityControl

The tool reuses selected pieces of the AOC Mission Visualizer: the design, the NetCDF parser, and the 2D/3D map for context.

## Loading a mission

Upload a `.nc` flight-level file on the **Load a Flight** section in the header!

Every flight you load is saved on this device and reopens from the **Loaded Flights** list instantly, newest first, including after a reload. The red cross on a row removes that flight; the list keeps the 100 most recent.

**Metrics Across Flights** finds which saved flight recorded the highest or lowest value of any metric, with a comparison graph.

## Takeoff, landing, and trimming

Takeoff and landing are auto-detected from the blended INS-GPS altitude on the P-3s and the pure GPS altitude on the G-IV. It will get the median across units and fall back to airspeed if not available

Takeoff is designated as the first climb from taxi elevation + 100 m and seen to keep climbing over the next minutes; where an airspeed fallback exists should it should coincide with flying airspeed, so any pre-takeoff sensor fluctuation on the ramp is not mistaken for departure.

Everything recorded more than five minutes before takeoff is trimmed away and never reaches any of the graphs, gaps, or anything else. The kept five minutes are used for the takeoff phase of the phase stats.

To override the automatically set T/O and Landing times, type `HHMMSS` in the **T/O** and **LND** boxes in the header and press **Apply**; the whole report (trim, phases, stats, references, graphs) recomputes. **Auto** returns to detection.

## Reading a graph

A small triangle in the top part of a graph marks a gap, and the faint yellow highlight under it shows the length of the missing seconds. Click the triangle to jump the playhead there and zoom into the gap. You can hover over the highlighted region for info on the gap .

Red shading marks physically implausible values: humidity above 200 percent, a 100 m/s wind change in under 15 s, vertical winds beyond 40 m/s, and a 5 degree lat/lon position move within 30 minutes. Judge each one in the flight's context.

Dotted vertical lines mark takeoff and landing, and the solid white line is the playhead. `NO DATA` appears where a sensor (ex. SFMR) has nothing to plot.

Timesliding (dragging your mouse moves the playhead), pan (drags the graph itself), and select zoom (you drag a box to zoom into a specific area). **Reset Zoom** appears on any zoomed graph. The graph search bar finds a variable by name and jumps to its graph.

## Legend and references

Clicking a group chip selects or unselects a whole sensor set, and several groups can be selected at once. Selected sensors display a standard deviation and coefficient of variation between each other.

A horizontal line shows the reference and its referring sensor as it goes across the flight, in order. If it switches mid-flight, a badge in the title names each switch with its time (click a time to jump there), and the source sensor reads blue as you slide to the point in the flight it is being referred to.

## Issues, pills, and statistics

Summary pills list the flagged items on each sensor; click one to jump to its graph. A **No Gaps** pill means just that: the sensor recorded without gaps, which is all the tool can attest. Every graph carries something similar but more in-depth, with the flag breakdown in parentheses beside the **+N more** toggle.

Max/mean/median shows the takeoff, mid-flight, and landing max, mean, and median for any variable (ex. PSM, PS.c).

The Difference Between Sensors graph plots every in-group pair with its max difference listed. Cross-group pairs sit on their own row, and any combination of pairs (cross-group included) can be selected at once. Each pair is labeled first sensor − second sensor, and the plotted difference is computed in exactly that order.

## Flight map

**Flight Map** gives context through the 2D/3D map tracker, with a per-sensor report below it. The 2D map follows the aircraft; if you pan away, **Recenter on Aircraft** appears. Slide from any graph, use the arrow keys, or press Play, and everything follows the same playtime.

Keyboard shortcuts: Space play/pause, ← / → step one second (Shift for ten), Ctrl/Cmd + Z step a zoom back, Esc close panels.

## Exporting

| Export | What it is |
| --- | --- |
| Indiv. Sensor Stats CSV | An in-depth export listing every pertinent sensor from this flight. One row per sensor (presence, gaps, missing seconds, early stop) plus each pair's max difference. |
| Indiv. Plane Stats CSV | Pick which of the cached flights go into each plane's `N42/N43/N49_Stats.csv`, to compare sensors across flights of the same plane. |
| Gap Report (.dat) | Recorder gaps in the archive's `GapReport.dat` wording. |
| Interactive Report (.html) | One easy-to-share file with every graph interactive, gap markers, and the flight track. Opens in any browser, with no flight loaded. |
| Error Summary (.pdf) | Based on the `qc_Error_Summary` form, partially prefilled by the tool and editable. Matches the script exactly. |
| Flight Track Map (.pdf) | A landscape PDF map of the flight track, in the traditional FD style. |
| NC → TXT (.txt) | Converts the loaded flight to a delimited text file. Every variable in the file is listed, not just the graphed set, and the parameters, delimiter, and time window are all pickable. |

The Error Summary modal prefills the flight id, takeoff/landing times, flight directory, ground locations (nearest airport within a few miles of the aircraft at takeoff/landing), and sensor designations (from what the reference variables rode). Any field the tool cannot derive is left blank rather than automated, and required fields flag red while empty. Click a designation row to graph its sensors beside the modal.

## Code architecture

Classic scripts in `index.html`, one global scope, load order matters. No build step, no dependencies; all libraries, fonts, basemap, and the airport table ship in the repo.

`sw.js` precaches every asset (page, css/js, libs, fonts, basemap data) on the first visit and serves it cache-first from then on. The deploy workflow stamps `CACHE_VERSION` in `sw.js` with the commit SHA, the same `sed` that stamps the `?v=` tokens, so every deploy installs a fresh cache (each file revalidated against the server, never trusted to the HTTP cache) and drops the previous one on activate. Cached files are matched ignoring the query string.

The first load after a deploy still renders the old build while the new cache installs in the background; the reload after that shows it.

Two rules keep that honest. Every added or renamed css/js/font/data file must also be added to `PRECACHE` in `sw.js`, because `cache.addAll` rejects wholesale on a single 404 and the precache then silently fails. And cache names keep the `aoc-qc-` prefix, because the `github.io` origin is shared with sibling project pages. The worker only registers on `github.io`; localhost and Codespaces previews stay service-worker-free and always serve the working tree.

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

The remaining `js/` files are the reused visualizer subsystems: parser, 2D/3D map, playback engine, on-device mission store, layout, theming. The visualizer's shell stays in the DOM underneath the QC app so its wiring keeps working; the map panel, the flight loader, and the top-right controls are relocated into the QC layout.
