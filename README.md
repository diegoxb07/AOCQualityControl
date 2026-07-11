# AOC QC Tool

A browser-based quality-control tool for NOAA Aircraft Operations Center (AOC) flight-level data. It replaces the `qc_plots_with_map_v2.py` workflow: load a hurricane-hunter flight (`.nc` or `.txt`, or straight from the recon archive) and the QC tool keeps every raw sample on a continuous 1-second axis, separates recorder-level data gaps from per-sensor gaps, reproduces the script's statistics, draws every sensor family with its redundant members and their differences, and puts the flight on a 2D/3D map for context.

It is a purpose-built QC tool that reuses selected pieces of the AOC Mission Visualizer (the design system, NetCDF parser, archive loader, and the 2D/3D map). The unused visualizer modules (PFD/HUD, 8Hz interpolation, OCR video lock, point analysis) are not shipped.

## Run it

Static, client-side, no build step and no `node`/`npm`. Serve the folder and open it:

```
python3 -m http.server 8000
# then open http://localhost:8000
```

Load a flight from the archive search or dropdowns in the top bar (needs the recon API), or drop a `.nc` / `.txt` onto the upload zone (works fully offline). Missions list newest first.

## What the QC tool does

- **Absolutely raw data.** The QC parser (`parseFlightRawQC` in `js/11b-parser-core.js`) does no cleanup: no minimum-altitude cut, no low-airspeed cut, no glitch or duplicate-time dropping. Every catalog variable is indexed onto a continuous 1-second axis; a missing second is an explicit gap, never a silently dropped row. (The visualizer's filtered rows are used only to drive the map playback.)
- **Three kinds of gap, told apart.**
  - Recording gaps: seconds where no instrument recorded at all. Reported once at flight level, phrased exactly like the archive's `GapReport.dat` ("Data gap from 13:31:59 - 13:33:05"), and exportable in that same format with the Gap Report button.
  - Ground gaps: a sensor quiet before takeoff or after landing while others record. Listed (dimmed) but not counted against the sensor's status, since warm-up on the ramp is normal ops.
  - In-flight sensor gaps: the real QC signal. These drive the GAP status, the summary counts, and the chart shading.
- **Stacked family graphs**, one family per row with its difference sub-plot, in the script's panel order. Each panel has a Bokeh-style toolbar (pan, box zoom, reset, save png), wheel zoom, and double-click to reset, plus an always-visible issue strip listing that family's absent sensors and gaps. Clicking an issue chip or any point on a graph jumps the timeline and map to that second.
- **Statistics**: takeoff / mid-flight / landing max, mean, median for any variable on request (Phase Stats panel, bottom right), whole-flight mean UWZ, and per-pair mean differences in each diff plot title. Takeoff and landing are auto-detected and editable (T/O and Land fields, then Apply).
- **Derived surface pressure**: the Dr. Willoughby SLP block and standard SLP, ported verbatim from the script.
- **Exports**: per-sensor Report CSV, the archive-format Gap Report, and the cross-flight difference-stats CSV. Every loaded flight is saved to the on-device cross-flight store automatically (no button needed); the store replaces the script's `N42/N43/N49_Stats.txt` files.
- **Context on demand**: the flight-track map (2D or 3D) and the per-sensor report live in a sidebar that is hidden by default; the Show Context button opens it. Playback controls stay in the bottom bar either way.

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
