/* Mission Visualizer, per-frame visual refresh
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    let _lastStaticIdx = -1;   // last idx the clock/badges were rendered for
    function updateVisualComponents(idx, skipCharts = false) {
        const currentRow = filteredData[idx]; if (!currentRow) return;

        // the clock depends only on idx, so a same-idx refresh (skipCharts=true, from sliding)
        // skips rebuilding it; any idx change or full update still redraws everything.
        const skipStatic = skipCharts && idx === _lastStaticIdx;

        if (trackerModeSelect.value === '2d') renderMapEngineFrame(idx, currentRow); else update3DFrame(idx, currentRow);

        if (skipStatic) return;
        _lastStaticIdx = idx;
    }
