/* Mission Visualizer, playback control + master playback loop
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    // Playback state. isPlaying (js/01-state.js) is the truth; start/stop/toggle below are the only
    // things that change it, and every consumer (the QC play button, arrow-key sliding, graph
    // scrubbing) goes through them. There is no hidden player UI behind this: the QC app's own
    // Play button is the sole control.
    let playbackReady = false;   // a flight is loaded, so playback is allowed

    function setPlaybackReady(on) { playbackReady = !!on; syncPlayButton(); }

    // mirror engine state onto the QC play/speed buttons, the only playback controls that exist.
    function syncPlayButton() {
        const qb = document.getElementById('qcPlayBtn');
        if (qb) { qb.textContent = isPlaying ? 'Pause' : 'Play'; qb.disabled = !playbackReady; }
    }

    function startPlayback() {
        if (!playbackReady || filteredData.length === 0 || isPlaying) return;
        // Every play start is seeded FROM the playhead through the one translation contract, so a
        // playhead parked before takeoff starts at takeoff (row 0), never "x hours in".
        if (typeof qcPlayheadToRow === 'function') currentIdx = qcPlayheadToRow();
        isPlaying = true;
        playbackAccumulator = 0; lastTickTime = performance.now();
        syncPlayButton();
        masterSyncEngineTick();
    }

    function stopPlayback() {
        if (!isPlaying) return;
        isPlaying = false;
        if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
        syncPlayButton();
    }

    function togglePlayback() { if (isPlaying) stopPlayback(); else startPlayback(); }

    function updateSpeedDisplay() {
        const qs = document.getElementById('qcSpeedBtn'); if (qs) qs.textContent = speeds[currentSpeedIdx] + 'x';
    }

    function masterSyncEngineTick() {
        if (!isPlaying) return;
        const now = performance.now();
        const deltaMs = now - lastTickTime;
        lastTickTime = now;

        if (deltaMs < 1000) {
            playbackAccumulator += (deltaMs / 1000) * speeds[currentSpeedIdx];

            let updatedIdx = false;
            while (true) {
                if (currentIdx >= filteredData.length - 1) break;
                let dt = filteredData[currentIdx+1].absSeconds - filteredData[currentIdx].absSeconds || 1;
                if (playbackAccumulator >= dt) {
                    playbackAccumulator -= dt;
                    currentIdx++;
                    updatedIdx = true;
                } else {
                    break;
                }
            }

            if (currentIdx >= filteredData.length - 1) {
                currentIdx = filteredData.length - 1;
                playbackAccumulator = 0;
                updateVisualComponents(currentIdx);
                stopPlayback();
                return;
            }

            if (updatedIdx) {
                updateVisualComponents(currentIdx);
            }
        }
        animationFrameId = requestAnimationFrame(masterSyncEngineTick);
    }
