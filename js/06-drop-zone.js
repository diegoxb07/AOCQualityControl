/* Mission Visualizer, drop-zone helpers
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    // Waiting vs loaded is one class on the zone (.is-loaded, styled in css/app.css): dashed edge
    // and muted text while empty, solid edge and full-strength text once a file is in.
    const DROP_ZONE_IDLE = 'Choose a file, or drag one here';

    // Inverse of markDropZoneLoaded: returns a drop zone to its dashed waiting state.
    function resetDropZone(zoneId, labelId, text) {
        const zone = document.getElementById(zoneId);
        const label = document.getElementById(labelId);
        if (!zone || !label) return;
        zone.classList.remove('is-loaded');
        label.textContent = text || DROP_ZONE_IDLE;
        label.removeAttribute('title');
    }

    // --- Mark a drop zone as "file loaded": solid edge + the filename, truncated if long ---
    function markDropZoneLoaded(zoneId, labelId, filename) {
        const zone = document.getElementById(zoneId);
        const label = document.getElementById(labelId);
        if (!zone || !label) return;
        zone.classList.add('is-loaded');
        label.textContent = filename;
        label.title = filename;
    }
