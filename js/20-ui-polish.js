/* Mission Visualizer, cosmetic UI polish (timeline glow fill)
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; carries NO app state, everything here is
   presentation-only and the app functions identically if this file fails to load. */

    (function () {
        'use strict';

        // Paint the timeline slider's elapsed portion (--fill) every frame. The slider's
        // value is driven programmatically by the playback engine, which fires no 'input'
        // events, so a lightweight rAF poll is the only reliable hook.
        try {
            const slider = document.getElementById('timelineSlider');
            if (slider) {
                let lastPct = -1;
                const paint = () => {
                    const max = Number(slider.max) || 1;
                    const pct = Math.max(0, Math.min(100, (Number(slider.value) / max) * 100));
                    if (pct !== lastPct) {
                        lastPct = pct;
                        slider.style.setProperty('--fill', pct.toFixed(2) + '%');
                    }
                    requestAnimationFrame(paint);
                };
                requestAnimationFrame(paint);
            }
        } catch (e) { /* cosmetic only */ }
    })();
