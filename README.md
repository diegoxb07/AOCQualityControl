# AOC QC Tool

An HTML frontend quality-control tool for NOAA Aircraft Operations Center (AOC) flight-level data. It is based on the `qc_plots_with_map_v2.py` script that was previously used, that required a more extensive and much less autonomous workflow.

This new tool can automatically load a hurricane-hunter flight (`.nc`), but has the option to also upload manually in case the API is offline. The QC tool does not filter any data unlike the AOCVisualizer tool on a continuous 1-second axis, separates recorder-level data gaps from per-sensor gaps, reproduces the script's statistics, draws every sensor family with its redundant members and their differences, and can put the flight on a 2D/3D map for context.

It is a purpose-built QC tool that reuses selected pieces of the AOC Mission Visualizer (the design system, NetCDF parser, archive loader, and the 2D/3D map). 

## Specifications

- **Raw data.** The QC parser (`parseFlightRawQC` in `js/11b-parser-core.js`) does no cleanup: no minimum-altitude cut, no low-airspeed cut, no glitch or duplicate-time filters either. Every catalog variable is indexed onto a continuous 1-second axis; a missing second is an explicit gap, never a silently dropped row.
- **Three kinds of gap, told apart.**
  - Recording gaps: seconds where no instrument recorded at all. Reported once at flight level, phrased exactly like the archive's `GapReport.dat` ("Data gap from 13:31:59 - 13:33:05"), and exportable in that same format with the Gap Report button.
  - Late-start gaps: (a sensor quiet before takeoff) Flagged but not counted against the sensor's status, since warm-up on the ramp is normal ops.
  - In-flight sensor gaps: the real QC signal. These drive the GAP status, the summary counts, and the chart shading.
- **Check flags**: physically implausible values (humidity above 200 percent, wind changes of 100 m/s in under 15 seconds, vertical wind beyond 40 m/s, latitude or longitude moving more than 5 degrees within 30 minutes) are flagged red as regions, prioritized over gaps, shaded on the graphs, and rolled into every report surface. Users judge each region in its flight context (eyewall penetration vs cruise).
- **Stacked family graphs**, one family per row in the script's panel order with SFMR families last; the difference graph opens from its button and plots every combination within a sensor group (cross-group pairs selectable for curiosity), with each combination's max difference listed under the graph. Each graph has a toolbar (scrub, pan, select zoom), wheel zoom, a floating Reset Zoom while zoomed, save-png and fullscreen buttons at its corner, and a 2D-nearest hover that grabs spikes and reads every sensor's exact value at that second. The issue strip lists Check regions, gaps, absent sensors, and late start / early stop notes with color-coded per-kind totals; clicking a chip or any point jumps the timeline and map to that second. Gaps are shaded with width-matched carets on top; empty families say NO DATA in place.
- **Legend system**: one checkbox per variable, glowing group chips that swap sensor kinds (direct vs GPS) exclusively, an always-listed standard deviation between the selected sensors (whole-flight mean sigma and the worst disagreement moment, bottom right of each block), and a ref pipe connector chaining the ref to every sensor it rode across the flight in order (mid-flight switches get a red badge).
- **Statistics**: takeoff / mid-flight / landing max, mean, median for any variable on request (the Max/Mean/Median dock), whole-flight mean UWZ, and each pair's max difference beside every diff plot (the cross-flight store still records the mean differences, matching the script's stats files).
- **Navigation and feedback**: a graph search bar jumps to any variable, sensor, or graph title; the sidebar player has play, speed, and the flight clock; a report button opens a form that mails feedback to diegoxiaobarbero@gmail.com with the mission id attached. A Share QC Link reopens an archive mission for anyone at the sharer's playhead, tracker view, and sidebar state. Takeoff and landing are auto-detected from the flight data.
- **Derived surface pressure**: the Dr. Willoughby SLP block and standard SLP, ported verbatim from the script.
- **Exports**: the Indiv. Sensor Report CSV, the archive-format Gap Report, and `N42/N43/N49_Stats.txt` in the script's exact format (headerless comma-separated lines, one per flight, same column order and quirks, so downloads append straight onto historical stats files). Every loaded flight is saved to the on-device cross-flight store automatically (no button needed).
- **Context on demand**: the flight-track map (2D or 3D) and the per-sensor report live in a sidebar that is hidden by default; the Flight 2D/3D button opens it. Playback controls (play and the flight clock) live inside that sidebar.

## Moving the recon API host

Everything currently points at `https://joshmurdock.net/api`. When the API moves to its new host, change exactly two things:

1. `RECON_API_BASE` in `js/02-satellite.js` (single constant; every API call in the app derives from it).
2. The Content-Security-Policy `<meta>` tag in `index.html`: replace `https://joshmurdock.net` in both `connect-src` and `img-src` with the new host.

Doc comments in `js/01-state.js` and `js/12b-recon-archive.js` also mention the old URL and can be updated for tidiness, but they do not affect behavior. `docs/CONNECTIVITY.md` describes what the API is used for.

## Architecture

Classic scripts in `index.html`, one global scope, load order matters, `?v=YYYYMMDD<letter>` cache-buster on every asset (bump it after editing any css/js).

QC-specific files:

| File | Role |
|---|---|
| `js/00b-qc-catalog.js` | sensor catalog: families, per-airframe members (P-3 `H`/`I`, G-IV `N`), references, difference pairs. The catalog is the allow-list |
| `js/11b-parser-core.js` | adds `parseFlightRawQC` (keep-all-rows, 1 s axis) alongside the visualizer's cleaning parser |
| `js/parse-worker.js` | returns the QC raw dataset alongside the cleaned playback rows |
| `js/21-qc-engine.js` | presence, coverage, recording/ground/in-flight gap classification, phase stats, diffs, derived SLP |
| `js/22-qc-charts.js` | stacked family + diff graphs, gap shading, playhead, toolbar, issue strips, theme recolor |
| `js/23-qc-report.js` | the app shell, per-sensor report, exports, cross-flight store, timeline, sidebar, map relocation |

The remaining `js/` files are the reused visualizer subsystems (parser, map, archive loader, playback engine, layout, theming). The visualizer's own page stays in the DOM underneath the QC app so its wiring keeps working, but only the map panel, mission loader, and top-right controls are shown (relocated into the QC layout).

## Note

Assistant working files (`CLAUDE.md`, `.claude/`) are gitignored.
