/* Mission Visualizer, DOM refs, sync-mode, 3D scene, control wiring
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    // --- Fullscreen-Friendly Drag & Drop Logic ---
    ['dataDropZone', 'videoDropZone'].forEach(zoneId => {
        const zone = document.getElementById(zoneId);
        if (!zone) return;
        const input = zone.querySelector('input[type="file"]');
        
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('border-accent', 'bg-elevated');
        });
        
        zone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            zone.classList.remove('border-accent', 'bg-elevated');
        });
        
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('border-accent', 'bg-elevated');
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                input.files = e.dataTransfer.files;
                const event = new Event('change', { bubbles: true });
                input.dispatchEvent(event);
            }
        });
    });

    const canvas = document.getElementById('mapCanvas'), ctx = canvas.getContext('2d'), video = document.getElementById('radarVideo'), mapPlaceholder = document.getElementById('mapPlaceholder'), playPauseBtn = document.getElementById('playPauseBtn'), timelineSlider = document.getElementById('timelineSlider'), timelineTimeDisplay = document.getElementById('timelineTimeDisplay'), speedDownBtn = document.getElementById('speedDownBtn'), speedDisplayBtn = document.getElementById('speedDisplayBtn'), speedUpBtn = document.getElementById('speedUpBtn'), replayBtn = document.getElementById('replayBtn'), videoSyncMode = document.getElementById('videoSyncMode'), ocrIndicator = document.getElementById('ocrIndicator'), fullscreenBtn = document.getElementById('fullscreenBtn'), fullscreenMapBtn = document.getElementById('fullscreenMapBtn'), fullscreenVideoBtn = document.getElementById('fullscreenVideoBtn'), mapPanel = document.getElementById('mapPanel'), videoPanel = document.getElementById('videoPanel'), trackerModeSelect = document.getElementById('trackerModeSelect'), threeDContainer = document.getElementById('threeDContainer'), attitudeHud = document.getElementById('attitudeHud'), stickyBottomBar = document.getElementById('stickyBottomBar'), pathColorSelect = document.getElementById('pathColorSelect'), barbColorSelect = document.getElementById('barbColorSelect');

    function applySyncModeLock() {
        // On Auto-Sync the timeline window is driven by the video clock, so the user must NOT type start/end times.
        const isAuto = videoSyncMode.value === 'auto';
        const dataLoaded = allParsedData.length > 0;
        const startEl = document.getElementById('startTimeInput');
        const endEl = document.getElementById('endTimeInput');
        if (startEl) { startEl.disabled = isAuto || !dataLoaded; startEl.title = isAuto ? 'Disabled during Auto-Sync (timeline follows the MMR video clock)' : ''; }
        if (endEl) { endEl.disabled = isAuto || !dataLoaded; endEl.title = isAuto ? 'Disabled during Auto-Sync (timeline follows the MMR video clock)' : ''; }
        // The time inputs only exist for manual syncing; everywhere else the window and offset
        // come from the data and the video clock, so the fields stay out of the header.
        document.querySelectorAll('.manual-sync-field').forEach(el => { el.style.display = isAuto ? 'none' : ''; });
    }

    function evaluateAutoSyncDefault() {
        if (videoLoaded && allParsedData.length > 0) {
            videoSyncMode.value = 'auto'; ocrIndicator.style.display = 'block'; document.getElementById('videoStartInput').disabled = true; document.getElementById('forceSyncBtn').style.display = 'inline-block';
            applySyncModeLock();
            forceOcrSyncNextTick = true; isManualSyncRequest = true;
            refreshSyncingIndicator();
            setTimeout(() => { if (!isPlaying) syncTelemetryToVideoClock(); }, 800);
        }
    }

    function showToast(message, duration = 8000) {
        const toast = document.getElementById('toastNotification'); document.getElementById('toastMessage').innerText = message; toast.classList.add('show'); setTimeout(() => { toast.classList.remove('show'); }, duration);
    }
    function flashAutoSyncLabel() {
        const label = document.getElementById('autosyncLabel'); label.classList.add('show'); setTimeout(() => { label.classList.remove('show'); }, 4000);
    }

    function updateMissionHeader() {
        const set = (id, val) => {
            const el = document.getElementById(id); if (!el) return;
            const ok = val && val !== 'Unknown' && val !== ''; el.textContent = ok ? val : '-'; el.classList.toggle('on', !!ok);
            const chip = el.closest('.status-chip'); if (chip) chip.classList.toggle('lit', !!ok);
        };
        set('hdrFlightId', flightMetaData.id);
        let ac = flightMetaData.aircraft; const acEl = document.getElementById('hdrAircraft');
        if (acEl) acEl.title = (ac && ac !== 'Unknown') ? ac : '';
        if (ac && ac !== 'Unknown') { const m = ac.match(/^(NOAA\d+)/); ac = m ? m[1] : ac; }
        // append the aircraft's NOAA nickname so the chip reads e.g. "NOAA42 (Kermit)"
        const acNickname = { NOAA42: 'Kermit', NOAA43: 'Miss Piggy', NOAA49: 'Gonzo' }[ac];
        if (acNickname) ac = ac + ' (' + acNickname + ')';
        set('hdrAircraft', ac); set('hdrDate', flightMetaData.date);
        let range = '';
        if (allParsedData && allParsedData.length) { const a = allParsedData[0].time, b = allParsedData[allParsedData.length-1].time; range = `${a.slice(0,2)}:${a.slice(2,4)} → ${b.slice(0,2)}:${b.slice(2,4)}Z`; }
        set('hdrRange', range);
        const sub = document.getElementById('missionSubline');
        if (sub) {
            const rawId = (flightMetaData.id && flightMetaData.id !== 'Unknown') ? flightMetaData.id : '';
            const idPart = rawId.replace(/\s*\([^)]*\)\s*$/, '');
            // Storm name: archive metadata when available, else the "(NAME)" an archive
            // load bakes into flightMetaData.id (reconArchiveMeta is set after parse).
            let storm = (reconArchiveMeta && reconArchiveMeta.stormName) || (rawId.match(/\(([^)]+)\)/) || [])[1] || '';
            if (/unknown|training/i.test(storm)) storm = '';
            if (storm) storm = storm.charAt(0).toUpperCase() + storm.slice(1).toLowerCase();
            // Aircraft designator from the tail number, NOAA name, or the mission-id letter (H/I/N).
            const acId = ((flightMetaData.aircraft || '') + ' ' + rawId).toUpperCase();
            let plane = '';
            if (/N?42 ?RF|NOAA ?42|\d{8}H\d/.test(acId)) plane = 'NOAA42';
            else if (/N?43 ?RF|NOAA ?43|\d{8}I\d/.test(acId)) plane = 'NOAA43';
            else if (/N?49 ?RF|NOAA ?49|GULFSTREAM|\bG-?IV\b|\d{8}N\d/.test(acId)) plane = 'NOAA49';
            const parts = [idPart, storm, plane].filter(Boolean);
            sub.textContent = parts.join(' · ');
            sub.classList.toggle('hidden', parts.length === 0);
            document.title = (idPart ? idPart + ' · ' : '') + 'AOC Mission Visualizer';
        }
        // Share links need an archive mission id; a manually uploaded file has none.
        const shareBtn = document.getElementById('shareLinkBtn');
        if (shareBtn) shareBtn.disabled = !reconArchiveMeta;
    }
    
    function getConvertedVal(val, key, isImperial) {
        if (val === null || val === undefined) return null; if (!isImperial) return val;
        if (['vtWnd', 'accZ'].includes(key)) return val * 2.23694; 
        if (['gpsAlt', 'radAlt', 'pAlt', 'dValue'].includes(key)) return val * 3.28084;
        if (['tempr', 'dewpt'].includes(key)) return (val * 9/5) + 32; return val;
    }
    
    function getMetricLabel(key, isImperial) {
        let label = METRIC_DEFS[key].label; if (!isImperial) return label;
        if (['vtWnd', 'accZ'].includes(key)) return label.replace('(m/s)', '(mph)').replace('(m/s²)', '(mph/s)');
        if (['gpsAlt', 'radAlt', 'pAlt', 'dValue'].includes(key)) return label.replace('(m)', '(ft)');
        if (['tempr', 'dewpt'].includes(key)) return label.replace('(°C)', '(°F)'); return label;
    }

    function drawP3Orion(c) {
        c.fillStyle = '#ffffff'; c.strokeStyle = '#222222'; c.lineWidth = 2.5; c.beginPath();
        c.moveTo(22, 0); c.quadraticCurveTo(22, -3.5, 14, -3.5); c.lineTo(4, -3.5); c.lineTo(0, -25); c.lineTo(-4, -25); c.lineTo(-6, -3.5); c.lineTo(-16, -2.5); c.lineTo(-18, -10); c.lineTo(-21, -10); c.lineTo(-21, -1.5); c.lineTo(-30, -0.5); c.lineTo(-30, 0.5); c.lineTo(-21, 1.5); c.lineTo(-21, 10); c.lineTo(-18, 10); c.lineTo(-16, 2.5); c.lineTo(-6, 3.5); c.lineTo(-4, 25); c.lineTo(0, 25); c.lineTo(4, 3.5); c.lineTo(14, 3.5); c.quadraticCurveTo(22, 3.5, 22, 0); c.closePath(); c.fill(); c.stroke();
        const drawEngine = (cx, cy) => { c.beginPath(); c.ellipse(cx, cy, 6, 1.5, 0, 0, Math.PI * 2); c.fillStyle = '#ffffff'; c.fill(); c.stroke(); c.beginPath(); c.moveTo(cx + 6, cy - 1); c.lineTo(cx + 10, cy); c.lineTo(cx + 6, cy + 1); c.fillStyle = '#cccccc'; c.fill(); };
        drawEngine(1.5, -9); drawEngine(-0.5, -16); drawEngine(1.5, 9); drawEngine(-0.5, 16);
        const drawProps = (cx, cy) => { c.beginPath(); c.ellipse(cx, cy, 0.5, 5, 0, 0, Math.PI * 2); c.fillStyle = 'rgba(200, 230, 255, 0.7)'; c.fill(); c.beginPath(); c.moveTo(cx, cy - 5); c.lineTo(cx, cy + 5); c.strokeStyle = '#aaaaaa'; c.lineWidth = 1; c.stroke(); };
        drawProps(11.5, -9); drawProps(9.5, -16); drawProps(11.5, 9); drawProps(9.5, 16);
        c.beginPath(); c.moveTo(17, -1.5); c.lineTo(19, -1); c.lineTo(19, 1); c.lineTo(17, 1.5); c.lineTo(16, 0); c.closePath(); c.fillStyle = '#222222'; c.fill();
    }

    // G-IV (NOAA49) glyph for the 2D tracker, same coordinate frame as drawP3Orion
    // (nose at +X, drawn white with a dark outline). Swept wings, two aft-fuselage
    // nacelles, T-tail; picked over the P-3 by isGulfstreamFlight().
    function drawGulfstreamIV(c) {
        c.fillStyle = '#ffffff'; c.strokeStyle = '#222222'; c.lineWidth = 2.5; c.beginPath();
        c.moveTo(24, 0); c.quadraticCurveTo(23, -2.6, 17, -2.8); c.lineTo(5, -2.8);
        c.lineTo(-11, -21); c.lineTo(-14, -21); c.lineTo(-9, -2.8);
        c.lineTo(-21, -2.2); c.lineTo(-26.5, -9.5); c.lineTo(-28.5, -9.5); c.lineTo(-29.5, -1.2);
        c.lineTo(-30.5, 0);
        c.lineTo(-29.5, 1.2); c.lineTo(-28.5, 9.5); c.lineTo(-26.5, 9.5); c.lineTo(-21, 2.2);
        c.lineTo(-9, 2.8); c.lineTo(-14, 21); c.lineTo(-11, 21);
        c.lineTo(5, 2.8); c.lineTo(17, 2.8); c.quadraticCurveTo(23, 2.6, 24, 0);
        c.closePath(); c.fill(); c.stroke();
        const nacelle = (cy) => {
            c.beginPath(); c.ellipse(-13.5, cy, 4.4, 1.8, 0, 0, Math.PI * 2); c.fillStyle = '#ffffff'; c.fill(); c.stroke();
            c.beginPath(); c.moveTo(-9.4, cy - 1.2); c.lineTo(-8.2, cy); c.lineTo(-9.4, cy + 1.2); c.fillStyle = '#cccccc'; c.fill();
        };
        nacelle(-4.8); nacelle(4.8);
        c.beginPath(); c.moveTo(-11, -21); c.lineTo(-9.8, -19.4); c.moveTo(-11, 21); c.lineTo(-9.8, 19.4); c.lineWidth = 1.5; c.stroke();  // winglets
        c.beginPath(); c.moveTo(-21, 0); c.lineTo(-29.5, 0); c.strokeStyle = '#999999'; c.lineWidth = 1; c.stroke();  // fin seen from above
        c.beginPath(); c.moveTo(19, -1.4); c.lineTo(21, -0.8); c.lineTo(21, 0.8); c.lineTo(19, 1.4); c.lineTo(18, 0); c.closePath(); c.fillStyle = '#222222'; c.fill();
    }

    // True when the loaded flight is the Gulfstream: aircraft letter N in the AOC
    // mission id (e.g. 20240826N1), or an archive aircraft/tail string naming it.
    function isGulfstreamFlight() {
        const id = flightMetaData.id || '', ac = flightMetaData.aircraft || '';
        return /\d{8}N\d/i.test(id) || /gulfstream|\bg-?iv\b|\bn49/i.test(ac + ' ' + id);
    }

    // White tropical-cyclone symbol (disc + spiral arms above depression strength) carrying its
    // dark category label, cached per label; the mesh material tints the white per intensity
    // while the label stays dark and readable. Drawn flat on the sea, never billboarded or spun.
    let stormFixRing3D = null;   // current-fix marker on the 3D best track, positioned per frame
    let _stormSymTex = {};
    function stormSymbolTex(label) {
        if (_stormSymTex[label]) return _stormSymTex[label];
        const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128;
        const c = cv.getContext('2d');
        c.strokeStyle = '#ffffff'; c.fillStyle = '#ffffff'; c.lineCap = 'round';
        c.beginPath(); c.arc(64, 64, 34, 0, Math.PI * 2); c.fill();
        if (label !== 'TD') {
            c.lineWidth = 13;
            c.beginPath(); c.arc(64, 64, 44, -0.3, 1.5); c.stroke();
            c.beginPath(); c.arc(64, 64, 44, Math.PI - 0.3, Math.PI + 1.5); c.stroke();
        }
        c.fillStyle = '#0b1220'; c.font = '700 36px sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(label, 64, 66);
        _stormSymTex[label] = new THREE.CanvasTexture(cv);
        return _stormSymTex[label];
    }

    // Home camera offset from the aircraft (the orbit target): close enough that the airframe
    // fills the view on open. The per-frame follow keeps whatever offset the user orbits to;
    // reset3DView() snaps back to this one.
    const CAM3D_HOME = { x: 0, y: 0.28, z: 0.66 };
    function reset3DView() {
        if (!threeDInitialized || !controls3D) return;
        if (realScale3D && typeof realScaleCamDistance === 'function') {
            // real-scale: keep the home viewing angle but pull in to frame the tiny plane, not the far preset
            const dir = new THREE.Vector3(CAM3D_HOME.x, CAM3D_HOME.y, CAM3D_HOME.z).normalize().multiplyScalar(realScaleCamDistance());
            camera3D.position.copy(controls3D.target).add(dir);
        } else {
            camera3D.position.set(controls3D.target.x + CAM3D_HOME.x, controls3D.target.y + CAM3D_HOME.y, controls3D.target.z + CAM3D_HOME.z);
        }
        controls3D.update();
    }

    function init3D() {
        if (threeDInitialized) return;
        const w = threeDContainer.clientWidth || canvas.width, h = threeDContainer.clientHeight || canvas.height, aspect = w / (h || 1);
        scene3D = new THREE.Scene(); scene3D.background = new THREE.Color(0x171122);
        // Near clip is tiny so the camera can dolly right up to the aircraft (scaled 0.06, so it is
        // small in world units and used to near-clip before you could get close); the huge near/far
        // span rides a logarithmic depth buffer to stay z-fight-free.
        camera3D = new THREE.PerspectiveCamera(45, aspect, 0.001, 50000);
        camera3D.position.set(CAM3D_HOME.x, CAM3D_HOME.y, CAM3D_HOME.z);   // starts zoomed into the aircraft, no scroll-in needed
        renderer3D = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: true });
        // Render at the display's true pixel density (capped at 2x) so the 3D view is crisp on retina
        // screens and, since Record Clip composites this canvas, so recorded 3D footage is sharp too.
        renderer3D.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer3D.setSize(w, h); threeDContainer.insertBefore(renderer3D.domElement, threeDContainer.firstChild);
        controls3D = new THREE.OrbitControls(camera3D, renderer3D.domElement); controls3D.enableDamping = true;
        controls3D.minDistance = 0.02;   // let the user get right in on the aircraft without dollying through the target
        scene3D.add(new THREE.AmbientLight(0xffffff, 0.6)); const dirLight = new THREE.DirectionalLight(0xffffff, 0.8); dirLight.position.set(10, 20, 10); scene3D.add(dirLight);
        planeGroup3D = new THREE.Group(); planeGroup3D.scale.set(0.06, 0.06, 0.06); scene3D.add(planeGroup3D);
        // the airframe itself (WP-3D or G-IV per the loaded flight) is built by js/07b-plane-models.js
        if (typeof setPlaneModel3D === 'function') setPlaneModel3D();
        // Direction arrow: shaft + a cone HEAD whose apex points forward (-Z, this model's nose
        // direction). The cone's local apex is at +Y, so it needs a NEGATIVE X rotation to face -Z.
        const buildDirectionArrow = (color, scale, standoff, opacity) => {
            const mat = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
            const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1.2, 8), mat); shaft.rotation.x = Math.PI / 2; shaft.position.z = -standoff - 0.6;
            const head = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.4, 8), mat); head.rotation.x = -Math.PI / 2; head.position.z = -standoff - 1.4;
            const group = new THREE.Group(); group.add(shaft, head); group.scale.set(scale, scale, scale);
            return group;
        };
        // Ground track: blue, standing out ahead of the airframe so it never overlaps it.
        trackArrow3D = buildDirectionArrow(0x3da5ff, 0.17, 2.3, 1); scene3D.add(trackArrow3D);
        // True heading: yellow and slightly smaller, nested inside the track arrow's world-space
        // span, so it hides within the blue when the two agree and appears only when they
        // diverge; scene-level (not planeGroup3D) so it stays a clean world-space compass pointer.
        headingArrow3D = buildDirectionArrow(0xffd400, 0.145, 2.76, 0.8); scene3D.add(headingArrow3D);
        scene3D.add(threeMapGroup); scene3D.add(threeMarkersGroup);
        function animate3D() {
            requestAnimationFrame(animate3D); if (controls3D) controls3D.update();
            // props spin only while playback runs; pausing freezes them with everything else
            if (typeof planeSpinners3D !== 'undefined' && isPlaying) for (let i = 0; i < planeSpinners3D.length; i++) planeSpinners3D[i].rotation.z += 0.3;
            // wind streaks: while playing in 3D, stream the small vertical streaks up on an updraft/bump
            // and down on a downdraft/dip, with brightness and speed scaled by the vertical bump size.
            if (windStreaks3D) {
                const in3d = !trackerModeSelect || trackerModeSelect.value === '3d';
                const vb = (isPlaying && in3d) ? _vertBump : 0, inten = Math.abs(vb);
                const active = inten > 0.4;   // only clear updrafts/downdrafts, not minor bumps
                windStreaks3D.visible = active;
                if (active) {
                    const dir = vb > 0 ? 1 : -1;   // updraft rises, downdraft falls
                    const H = WIND_STREAK_H, tnow = performance.now() / 1000, speed = 0.8 + 1.6 * inten;
                    for (let i = 0; i < windStreaks3D.children.length; i++) {
                        const ln = windStreaks3D.children[i];
                        const yy = (((ln.userData.baseY + dir * tnow * speed) % (2 * H)) + (2 * H)) % (2 * H) - H;
                        ln.position.y = yy;
                        ln.material.opacity = Math.min(0.9, inten) * (1 - Math.abs(yy) / H);
                    }
                }
            }
            // country labels: sit at the nearest coastline point to the plane, only while that coast is in
            // range, and scale with camera distance so they stay a constant readable size at any altitude.
            if (_countryLabels.length) {
                const in3d = !trackerModeSelect || trackerModeSelect.value === '3d';
                const show = in3d && camera3D && planeGroup3D && filteredData.length;
                const px = show ? planeGroup3D.position.x : 0, pz = show ? planeGroup3D.position.z : 0, R0 = 26, R1 = 74;
                // the state the plane is OVER gets its label placed directly under the plane, so a
                // straight-down look reads it (a plane deep inside a big state is far from every
                // border, so nearest-border alone would hide the state you are actually in).
                let over = null, gx = px, gy = 5, gz = pz;
                if (show && filteredData[currentIdx]) {
                    const prow = filteredData[currentIdx], plon = prow.lon, plat = prow.lat;
                    if (isFinite(plon) && isFinite(plat)) {
                        for (let i = 0; i < _countryLabels.length; i++) {
                            const cl = _countryLabels[i];
                            if (cl.rings && cl.rings.some(r => ptInRing(plon, plat, r))) { over = cl; break; }
                        }
                        const gAlt = (typeof isTerrainLoaded === 'function' && isTerrainLoaded() && typeof terrainElevationMeters === 'function') ? terrainElevationMeters(plat, plon) + 90 : 5;
                        const gp = get3DCoord(plon, plat, gAlt); gx = gp.x; gy = gp.y; gz = gp.z;
                    }
                }
                for (let i = 0; i < _countryLabels.length; i++) {
                    const cl = _countryLabels[i];
                    if (!show) { cl.sprite.visible = false; continue; }
                    if (cl === over) {   // the state under the plane: park the label right below it, always lit
                        cl.sprite.visible = true;
                        const camDist = camera3D.position.distanceTo(cl.sprite.position.set(gx, gy, gz)) || 1;
                        const sc = camDist * 0.032, f = cl.base || 1;
                        cl.sprite.position.y = gy + sc * 0.7;
                        cl.sprite.scale.set(sc * cl.aspect * f, sc * f, 1);
                        cl.mat.opacity = 1;
                        continue;
                    }
                    let best = Infinity, bx = 0, by = 0, bz = 0;
                    for (let k = 0; k < cl.pts.length; k++) { const p = cl.pts[k]; const dx = px - p.x, dz = pz - p.z, dd = dx * dx + dz * dz; if (dd < best) { best = dd; bx = p.x; by = p.y; bz = p.z; } }
                    const dist = Math.sqrt(best);
                    if (dist < R1) {
                        cl.sprite.visible = true;
                        const camDist = camera3D.position.distanceTo(cl.sprite.position.set(bx, by, bz)) || 1;
                        const sc = camDist * 0.032, f = cl.base || 1;   // states ride a bit smaller
                        cl.sprite.position.y = by + sc * 0.7;
                        cl.sprite.scale.set(sc * cl.aspect * f, sc * f, 1);
                        cl.mat.opacity = dist <= R0 ? 1 : (R1 - dist) / (R1 - R0);
                    } else cl.sprite.visible = false;
                }
            }
            renderer3D.render(scene3D, camera3D);
        }
        animate3D(); threeDInitialized = true;
    }

    // Real-scale toggle (a Filters checkbox): draw the 3D airframe at its true size against the world
    // instead of the default enlarged glyph. Real fuselage lengths per type, defaulting to the WP-3D
    // when the aircraft is unknown; at 20 units/deg the model is tiny, so it only reads once dollied in.
    let realScale3D = false;
    let windStreaks3D = null;   // small vertical wind streaks on the plane for updrafts/downdrafts
    let _vertBump = 0;          // signed vertical bump at the current frame (updraft +, downdraft -)
    let _borderLines = [];      // { line, mat, box, base } coastline/border lines, faded by distance to the plane
    let _countryLabels = [];    // { sprite, mat, aspect, base, pts } country and US state name labels shown near visible borders
    let _reframeRealScale = false;   // set when the plane is (re)built with real-scale on; consumed once the plane is positioned (update3DFrame)
    const PLANE_REAL_LEN_M = { p3: 35.61, giv: 26.90 };
    function planeModelLocalLength() {
        if (typeof planeGroup3D === 'undefined' || !planeGroup3D || typeof planeModelGroup3D === 'undefined' || !planeModelGroup3D || typeof THREE === 'undefined') return 0;
        // measure the airframe in planeGroup-local units, independent of the group's live attitude/scale
        const q = planeGroup3D.quaternion.clone(), s = planeGroup3D.scale.clone();
        planeGroup3D.quaternion.identity(); planeGroup3D.scale.set(1, 1, 1); planeGroup3D.updateMatrixWorld(true);
        const size = new THREE.Vector3();
        new THREE.Box3().setFromObject(planeModelGroup3D).getSize(size);
        planeGroup3D.quaternion.copy(q); planeGroup3D.scale.copy(s); planeGroup3D.updateMatrixWorld(true);
        return Math.max(size.x, size.z);
    }
    function planeScaleFactor() {
        if (!realScale3D) return 0.06;
        const localLen = planeModelLocalLength();
        if (!(localLen > 0)) return 0.06;
        const isGiv = (typeof isGulfstreamFlight === 'function' && isGulfstreamFlight());
        const targetWorld = (isGiv ? PLANE_REAL_LEN_M.giv : PLANE_REAL_LEN_M.p3) * 20 / 111319;   // 20 units/deg, ~111.3 km/deg
        return targetWorld / localLen;
    }
    function applyPlaneScale() {
        if (typeof planeGroup3D === 'undefined' || !planeGroup3D) return;
        const f = planeScaleFactor();
        planeGroup3D.scale.set(f, f, f);
        // (the scene-level ground-track / heading arrows are scaled to match each frame in update3DFrame)
        // let the user dolly right up to a tiny real-size plane (a gentle floor keeps the enlarged view sane)
        if (typeof controls3D !== 'undefined' && controls3D) controls3D.minDistance = realScale3D ? 0.005 : 0.02;
        // A build/swap with real-scale on (incl. a refresh that rebuilds the scene) needs the camera
        // reframed once the plane is positioned; flag it for update3DFrame rather than dolly a plane
        // that may not be placed yet.
        if (realScale3D) _reframeRealScale = true;
    }
    // Frame the plane after a real-scale toggle: real-scale dollies in to ~2.5 plane-lengths so the
    // now-tiny airframe is visible immediately; turning it off restores the default framing distance.
    // Camera distance that frames the real-size plane to ~64% of the vertical view.
    function realScaleCamDistance() {
        const halfLen = Math.max(1e-5, planeModelLocalLength() * planeGroup3D.scale.x * 0.5);
        const fovR = (camera3D.fov || 45) * Math.PI / 180;
        return halfLen / Math.tan(fovR * 0.32);
    }
    function dollyCameraForScale() {
        if (typeof controls3D === 'undefined' || !controls3D || typeof camera3D === 'undefined' || !camera3D) return;
        const dist = realScale3D ? realScaleCamDistance() : Math.hypot(CAM3D_HOME.x, CAM3D_HOME.y, CAM3D_HOME.z);
        const dir = camera3D.position.clone().sub(controls3D.target);
        if (dir.lengthSq() < 1e-12) dir.set(CAM3D_HOME.x, CAM3D_HOME.y, CAM3D_HOME.z);
        dir.setLength(dist);
        camera3D.position.copy(controls3D.target).add(dir);
        controls3D.update();
    }
    (function wireRealScale() {
        const el = document.getElementById('toggleRealScale');
        if (el) el.addEventListener('change', () => { realScale3D = el.checked; applyPlaneScale(); dollyCameraForScale(); });
    })();

    function get3DCoord(lon, lat, altMeters) {
        if (isNaN(lon) || isNaN(lat)) return new THREE.Vector3(0,0,0);
        const centerLon = (plotMinLon + plotMaxLon) / 2 || 0, centerLat = (plotMinLat + plotMaxLat) / 2 || 0, scaleMult = 20;
        // wrapLon (js/15-map-render.js) keeps dateline-crossing flights continuous here too;
        // safe because build3DScene only renders flight-adjacent features (never the far seam).
        // Altitude is exaggerated ~8x against the horizontal scale (20 units/deg = 0.181 units/km,
        // /690 = 1.45 units/km) so climbs read at a believable angle without the track gluing flat.
        const x = (wrapLon(lon) - centerLon) * scaleMult, z = -(lat - centerLat) * scaleMult, y = (altMeters || 0) / 690; return new THREE.Vector3(x, y, z);
    }

    // Altitude source for the 3D map's vertical dimension (track, plane, markers). Its OWN control
    // (#trackAltSelect, defaults to GPS), independent of the PFD's GPS->Press filter (#toggleGpsAlt),
    // which still only governs the PFD altitude tape / point analysis.
    function track3DAltMeters(d) {
        if (!d) return 0;
        const sel = document.getElementById('trackAltSelect');
        const useGps = !sel || sel.value !== 'press';   // default GPS
        return useGps ? (d.gpsAlt != null ? d.gpsAlt : (d.pAlt != null ? d.pAlt : 0))
                      : (d.pAlt != null ? d.pAlt : (d.gpsAlt != null ? d.gpsAlt : 0));
    }

    // 3D waypoints: each point-analysis marker gets a dotted plumb line from the sea surface up to
    // the flagged sample, a ground ring anchoring it, and a glowing beacon at altitude, so a mark
    // reads as a surveyed position in space rather than a floating dot.
    function sync3DMarkers() {
        if (!threeDInitialized) return;
        while (threeMarkersGroup.children.length > 0) {
            const c = threeMarkersGroup.children[0]; threeMarkersGroup.remove(c);
            if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose();
        }
        customMarkers.forEach(marker => {
            const d = filteredData[marker.idx];
            if (!d) return;
            const top = get3DCoord(d.lon, d.lat, track3DAltMeters(d));
            const col = new THREE.Color(marker.color);
            const line = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(top.x, 0, top.z), top]),
                new THREE.LineDashedMaterial({ color: col, dashSize: 0.06, gapSize: 0.045, transparent: true, opacity: 0.9 }));
            line.computeLineDistances();
            threeMarkersGroup.add(line);
            const ring = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.075, 24),
                new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, transparent: true, opacity: 0.75 }));
            ring.rotation.x = -Math.PI / 2; ring.position.set(top.x, 0.012, top.z);
            threeMarkersGroup.add(ring);
            const bead = new THREE.Mesh(new THREE.OctahedronGeometry(0.018),
                new THREE.MeshPhongMaterial({ color: col, emissive: col, emissiveIntensity: 0.35 }));
            bead.position.copy(top); bead.userData = { dataPoint: d };
            threeMarkersGroup.add(bead);
        });
    }

    function isBoxInFlightBounds(bbox) {
        if (!bbox) return true;
        const expandDeg = 15, viewMinLon = plotMinLon - expandDeg, viewMaxLon = plotMaxLon + expandDeg, viewMinLat = plotMinLat - expandDeg, viewMaxLat = plotMaxLat + expandDeg;
        if (bbox[1] > viewMaxLat || bbox[3] < viewMinLat) return false;
        // Also test the bbox shifted ±360: a dateline-centered flight's plot window sits outside
        // [-180,180], where every raw feature bbox would otherwise miss it.
        return [0, -360, 360].some(s => !(bbox[0] + s > viewMaxLon || bbox[2] + s < viewMinLon));
    }

    // A few small world-vertical wind streaks near the plane that rise on an updraft/altitude bump and
    // fall on a downdraft/dip, so vertical air motion reads on the model. Kept off the rolling plane
    // group so they stay vertical; positioned and scaled onto the plane each frame (update3DFrame), and
    // streamed and faded by the signed vertical bump (vertBump) in animate3D.
    const WIND_STREAK_H = 1.35;   // half-range the streaks stream over, in local space
    function ensureWindStreaks() {
        if (windStreaks3D || typeof scene3D === 'undefined' || !scene3D) return;
        windStreaks3D = new THREE.Group();
        for (let i = 0; i < 8; i++) {
            const mat = new THREE.LineBasicMaterial({ color: 0xdfeaf7, transparent: true, opacity: 0, depthWrite: false });
            const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, 0.5, 0)]);
            const line = new THREE.Line(geo, mat);
            const ox = (Math.random() * 2 - 1) * 0.5, oz = (Math.random() * 2 - 1) * 0.5;   // tight cluster near the fuselage
            const wingShrink = 1 - 0.55 * Math.min(1, Math.abs(ox) / 0.5);   // shorter toward the wingtips
            line.userData = { ox, oz, baseY: (Math.random() * 2 - 1) * WIND_STREAK_H };
            line.scale.y = (0.26 + Math.random() * 0.22) * wingShrink;
            line.position.set(ox, line.userData.baseY, oz);
            windStreaks3D.add(line);
        }
        windStreaks3D.visible = false;
        scene3D.add(windStreaks3D);
    }
    // Plane vertical rate (m/s) over a short window centered on idx; positive is a climb.
    function planeVertRateMps(idx) {
        if (!filteredData.length) return 0;
        const i0 = Math.max(0, idx - 4), i1 = Math.min(filteredData.length - 1, idx + 4);
        const dt = filteredData[i1].absSeconds - filteredData[i0].absSeconds;
        return dt > 0 ? (track3DAltMeters(filteredData[i1]) - track3DAltMeters(filteredData[i0])) / dt : 0;
    }
    // Signed vertical bump at idx: positive on an updraft/upward bump, negative on a downdraft/dip.
    // Driven by vertical wind (the updraft/downdraft signal) and the jerk in vertical rate (sudden dips).
    function vertBump(idx) {
        const d = filteredData[idx]; if (!d) return 0;
        let s = (d.vtWnd != null ? d.vtWnd / 5 : 0);
        const jerk = (planeVertRateMps(idx) - planeVertRateMps(Math.max(0, idx - 3))) / 7;
        if (Math.abs(jerk) > Math.abs(s)) s = jerk;
        return Math.max(-1.3, Math.min(1.3, s));
    }

    // ray-cast point-in-polygon on a lon/lat ring, for finding which state the plane is over
    function ptInRing(lon, lat, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
            if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    }

    // A small text sprite for a country (or US state) name, white with a dark outline so it reads on
    // any terrain. state names are smaller and dimmer so the countries still lead. The label keeps a
    // constant on-screen size in animate3D by scaling with its camera distance.
    function countryLabelSprite(name, isState) {
        const fs = isState ? 32 : 40, h = Math.round(fs * 1.45);
        const cv = document.createElement('canvas');
        let c = cv.getContext('2d');
        c.font = 'bold ' + fs + 'px sans-serif';
        const w = Math.min(560, Math.ceil(c.measureText(name).width) + 30);
        cv.width = w; cv.height = h;
        c = cv.getContext('2d');
        c.font = 'bold ' + fs + 'px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.lineWidth = 7; c.strokeStyle = 'rgba(5,12,20,0.92)'; c.strokeText(name, w / 2, h / 2);
        c.fillStyle = isState ? '#c3d2e2' : '#eef4fb'; c.fillText(name, w / 2, h / 2);
        const tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter;
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
        const spr = new THREE.Sprite(mat); spr.renderOrder = 5; spr.visible = false;
        return { sprite: spr, mat, aspect: w / h, base: isState ? 0.72 : 1, pts: [] };
    }

    function build3DScene() {
        if (!threeDInitialized) init3D();
        // a newly loaded flight may be the other airframe; no-ops when the right model is up
        if (typeof setPlaneModel3D === 'function') setPlaneModel3D();
        while(threeMapGroup.children.length > 0) threeMapGroup.remove(threeMapGroup.children[0]);
        _borderLines = [];
        // country labels live on the scene (not threeMapGroup), so drop the previous set here.
        _countryLabels.forEach(cl => { if (cl.sprite.parent) cl.sprite.parent.remove(cl.sprite); if (cl.mat.map) cl.mat.map.dispose(); cl.mat.dispose(); });
        _countryLabels = [];
        const light3d = document.documentElement.dataset.theme === 'light';
        const landMat = new THREE.MeshBasicMaterial({ color: light3d ? 0x8fbf76 : 0x0d4a22, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        // coastlines and dimmer internal (state) borders, so countries read clearly against the
        // terrain. dark ink lines on the light theme, bright on dark. depthWrite off keeps them from
        // occluding the streaks and each other.
        const coastMat = new THREE.LineBasicMaterial({ color: light3d ? 0x1c3f63 : 0xf0f6fc, transparent: true, opacity: light3d ? 0.85 : 0.9, depthWrite: false });
        const stateMat = new THREE.LineBasicMaterial({ color: light3d ? 0x5a7fa0 : 0xaac2d6, transparent: true, opacity: 0.55, depthWrite: false });
        // when the bundled terrain grid (js/07c-terrain.js) is loaded, coastlines and borders drape onto
        // the terrain surface at their sampled elevation and the flat land fill is skipped. c is GeoJSON
        // [lon, lat], so terrainElevationMeters takes (c[1], c[0]).
        const hasTerrain = typeof isTerrainLoaded === 'function' && isTerrainLoaded();
        const borderAlt = c => hasTerrain ? terrainElevationMeters(c[1], c[0]) + 90 : 5;
        const processPolygon = (poly, isState) => {
            const shape = new THREE.Shape();
            poly.forEach((ring, ringIdx) => {
                const pts = []; let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
                ring.forEach(c => { const p = get3DCoord(c[0], c[1], borderAlt(c)); pts.push(p); if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x; if (p.z < minz) minz = p.z; if (p.z > maxz) maxz = p.z; });
                const mat = (isState ? stateMat : coastMat).clone();   // per-line so update3DFrame can fade each by distance
                const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat); line.renderOrder = 1; threeMapGroup.add(line);
                _borderLines.push({ line, mat, box: [minx, maxx, minz, maxz], base: isState ? 0.55 : 0.9 });
                if (!isState && !hasTerrain) {
                    if (ringIdx === 0) { ring.forEach((c, i) => { const pt = get3DCoord(c[0], c[1], 0); if (i === 0) shape.moveTo(pt.x, -pt.z); else shape.lineTo(pt.x, -pt.z); }); }
                    else { const hole = new THREE.Path(); ring.forEach((c, i) => { const pt = get3DCoord(c[0], c[1], 0); if (i === 0) hole.moveTo(pt.x, -pt.z); else hole.lineTo(pt.x, -pt.z); }); shape.holes.push(hole); }
                }
            });
            if (!isState && !hasTerrain) { const shapeGeom = new THREE.ShapeGeometry(shape); shapeGeom.rotateX(-Math.PI / 2); shapeGeom.translate(0, 5 / 200, 0); threeMapGroup.add(new THREE.Mesh(shapeGeom, landMat)); }
        };
        mapFeatures.forEach(feature => {
            if (!isBoxInFlightBounds(feature.properties.bbox)) return; 
            const geom = feature.geometry; if (!geom) return;
            const isState = feature.properties && feature.properties.isState === true;
            if (geom.type === 'Polygon') processPolygon(geom.coordinates, isState); else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(poly => processPolygon(poly, isState));
            // one small name label per country, plus US state names, positioned at the nearest border
            // point to the plane each frame (animate3D) and only shown while that border is in range.
            // the "United States of America" label is suppressed: it is huge so it showed almost
            // always, and the state labels now carry US context.
            const labelName = feature.properties && (isState ? feature.properties.name : feature.properties.NAME);
            if (labelName && labelName !== 'United States of America' && scene3D) {
                const polys = geom.type === 'Polygon' ? [geom.coordinates] : (geom.type === 'MultiPolygon' ? geom.coordinates : []);
                const all = []; polys.forEach(poly => poly.forEach(ring => ring.forEach(cc => all.push(cc))));
                if (all.length) {
                    const step = Math.max(1, Math.floor(all.length / 40));
                    const lbl = countryLabelSprite(labelName, isState);
                    for (let k = 0; k < all.length; k += step) { const cc = all[k]; lbl.pts.push(get3DCoord(cc[0], cc[1], borderAlt(cc))); }
                    if (isState) lbl.rings = polys.map(poly => poly[0]);   // exterior rings (lon/lat) for the look-down containment test
                    scene3D.add(lbl.sprite); _countryLabels.push(lbl);
                }
            }
        });
        // elevation-shaded terrain surface from the bundled ETOPO grid, so land and sea floor sit at
        // real height. null until the grid loads, while the flat coastline map above renders.
        if (typeof buildTerrainMesh3D === 'function') { const terrainMesh = buildTerrainMesh3D(); if (terrainMesh) threeMapGroup.add(terrainMesh); }
        if(filteredData.length > 0) {
            // densify each 1 Hz segment with a uniform catmull-rom, so the 3D track curves
            // through turns and climbs instead of kinking at every sample.
            // built once per flight, so the extra vertices are cheap. colors lerp across each segment.
            const pathPts = []; const colors = [];
            const n = filteredData.length, K = 6;   // sub-samples per 1 Hz segment
            const coordAt = j => { const d = filteredData[j < 0 ? 0 : (j > n - 1 ? n - 1 : j)]; return get3DCoord(d.lon, d.lat, track3DAltMeters(d)); };
            const cr = (a, b, c, d, t) => { const t2 = t * t, t3 = t2 * t; return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3); };
            for (let i = 0; i < n; i++) {
                const P0 = coordAt(i - 1), P1 = coordAt(i), P2 = coordAt(i + 1), P3 = coordAt(i + 2);
                const c1 = getPathColorRGB(filteredData[i], i);
                const c2 = getPathColorRGB(filteredData[Math.min(i + 1, n - 1)], Math.min(i + 1, n - 1));
                const steps = (i < n - 1) ? K : 1;   // last point drawn once (no trailing segment)
                for (let s = 0; s < steps; s++) {
                    const t = s / K;
                    pathPts.push(new THREE.Vector3(cr(P0.x, P1.x, P2.x, P3.x, t), cr(P0.y, P1.y, P2.y, P3.y, t), cr(P0.z, P1.z, P2.z, P3.z, t)));
                    colors.push(c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t);
                }
            }
            const pathGeom = new THREE.BufferGeometry().setFromPoints(pathPts); pathGeom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
            const trackMat = new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 3 }); const coloredTrack3D = new THREE.Line(pathGeom, trackMat); threeMapGroup.add(coloredTrack3D);
        }
        // Storm best-track overlay (js/12b-recon-archive.js), same points as the 2D layer, flattened to
        // sea level (get3DCoord's altitude term stays 0) since it spans the storm's whole life, not the
        // flight's altitude profile.
        stormFixRing3D = null;
        if (showStormTrack && stormTrackPoints.length > 1) {
            const stormPts = [];
            stormTrackPoints.forEach(p => stormPts.push(get3DCoord(p.lon, p.lat, 0)));
            // flat dashed ribbon laid on the sea surface, one strip per fix-to-fix leg
            // (shortened to leave the gap), intensity-colored like the 2D layer; the width
            // scales with the track's own extent so it stays readable at the zoom that frames it
            const bb = new THREE.Box3().setFromPoints(stormPts);
            const span = bb.getSize(new THREE.Vector3()).length();
            const ribbonW = Math.max(0.16, span * 0.0017);
            for (let i = 0; i < stormPts.length - 1; i++) {
                const a = stormPts[i], b = stormPts[i + 1];
                const dx = b.x - a.x, dz = b.z - a.z;
                const legLen = Math.hypot(dx, dz) * 0.72;
                if (legLen < 0.01) continue;
                const geo = new THREE.PlaneGeometry(ribbonW, legLen);
                geo.rotateX(-Math.PI / 2);   // lay the strip flat; its length axis runs along z
                const strip = new THREE.Mesh(geo,
                    new THREE.MeshBasicMaterial({ color: new THREE.Color(stormWindColor(stormTrackPoints[i].windKt)), transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
                strip.position.copy(a).lerp(b, 0.5); strip.position.y = 0.03;
                strip.rotation.y = Math.atan2(dx, dz);
                strip.renderOrder = 1;   // symbols draw after the ribbon, whatever the camera angle
                threeMapGroup.add(strip);
            }
            // flat, static cyclone symbol at each fix with its category printed on it
            const symSize = Math.max(0.42, ribbonW * 1.9);
            stormTrackPoints.forEach((p, i) => {
                const geo = new THREE.PlaneGeometry(symSize, symSize);
                geo.rotateX(-Math.PI / 2);
                const sym = new THREE.Mesh(geo,
                    new THREE.MeshBasicMaterial({ map: stormSymbolTex(stormCatLabel(p.windKt)), color: new THREE.Color(stormWindColor(p.windKt)), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
                sym.position.copy(stormPts[i]); sym.position.y = 0.06;
                sym.renderOrder = 2;
                threeMapGroup.add(sym);
            });
            // discreet marker for the best-track fix the status card currently refers to:
            // a thin flat ring around that fix's symbol, moved by updateStormTrackBadge()
            // as playback advances
            const ringGeo = new THREE.RingGeometry(symSize * 0.62, symSize * 0.72, 40);
            ringGeo.rotateX(-Math.PI / 2);
            stormFixRing3D = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
            stormFixRing3D.renderOrder = 3;
            stormFixRing3D.position.y = 0.09;
            stormFixRing3D.visible = false;
            threeMapGroup.add(stormFixRing3D);
        }
        sync3DMarkers();
    }

    function update3DFrame(idx, visualRow) {
        if (!threeDInitialized || !filteredData[idx]) return;
        const d = visualRow || filteredData[idx];
        const pos = get3DCoord(d.lon, d.lat, track3DAltMeters(d));
        planeGroup3D.position.copy(pos);
        // keep the world-vertical streaks on the plane and sized to it; animate3D streams/fades them.
        _vertBump = vertBump(idx);
        ensureWindStreaks();
        if (windStreaks3D) { windStreaks3D.position.copy(pos); windStreaks3D.scale.setScalar(Math.max(1e-4, planeGroup3D.scale.x) * 4); }
        // fade coastline/border lines by the plane's distance to each, so only nearby ones show.
        if (_borderLines.length) {
            const px = pos.x, pz = pos.z, R0 = 26, R1 = 74;   // full within R0 units (~1.3deg), gone by R1
            for (let i = 0; i < _borderLines.length; i++) {
                const b = _borderLines[i], bx = b.box;
                const dx = Math.max(bx[0] - px, 0, px - bx[1]), dz = Math.max(bx[2] - pz, 0, pz - bx[3]);
                const dist = Math.hypot(dx, dz);
                const f = dist <= R0 ? 1 : dist >= R1 ? 0 : (R1 - dist) / (R1 - R0);
                b.mat.opacity = b.base * f; b.line.visible = f > 0.01;
            }
        }
        let t_pitch = d.pitch ?? 0, t_th = d.th ?? 0, t_roll = d.roll ?? 0, t_track = d.gTrack ?? 0;
        planeGroup3D.rotation.set(THREE.MathUtils.degToRad(t_pitch), THREE.MathUtils.degToRad(-t_th), THREE.MathUtils.degToRad(-t_roll), 'YXZ');
        // Size both scene-level arrows to the plane's current scale so they stay proportional in
        // real-scale mode (done here every frame so it holds regardless of arrow/plane build order).
        const arrowF = planeGroup3D.scale.x / 0.06;
        trackArrow3D.scale.setScalar(0.17 * arrowF);
        if (headingArrow3D) headingArrow3D.scale.setScalar(0.145 * arrowF);
        trackArrow3D.position.copy(pos); trackArrow3D.rotation.set(0, THREE.MathUtils.degToRad(-t_track), 0);
        // True-heading arrow: same scene-level convention as the ground-track arrow (world position,
        // Y-only rotation, not banked/pitched with the airframe), so it reads as a clean compass pointer.
        // It fades in only as heading diverges from ground track (hidden below 3 deg of drift, full by 8)
        // so a no-drift leg shows a single arrow instead of two overlapping, z-fighting ones.
        if (headingArrow3D) {
            headingArrow3D.position.copy(pos); headingArrow3D.rotation.set(0, THREE.MathUtils.degToRad(-t_th), 0);
            const drift = Math.abs(((t_track - t_th + 540) % 360) - 180);
            const op = Math.max(0, Math.min(1, (drift - 3) / 5));
            headingArrow3D.visible = op > 0.02;
            const hmat = headingArrow3D.children[0].material;
            hmat.transparent = true; hmat.opacity = op;
        }
        camera3D.position.x += (pos.x - controls3D.target.x); camera3D.position.y += (pos.y - controls3D.target.y); camera3D.position.z += (pos.z - controls3D.target.z);
        controls3D.target.copy(pos); controls3D.update();
        if (_reframeRealScale) { _reframeRealScale = false; dollyCameraForScale(); }   // frame the plane after a real-scale build/refresh
        attitudeHud.innerHTML = `PITCH: ${t_pitch.toFixed(1)}°<br>ROLL: ${t_roll.toFixed(1)}°<br>HDG: ${t_th.toFixed(1)}°<br>TRK: ${t_track.toFixed(1)}°`;
    }

    // Real fullscreen is page-level ONLY. The panel ⛶ buttons "fake" fullscreen instead: pin the
    // panel over the whole viewport (.fake-fs, styled like :fullscreen via :is()) and take the page
    // fullscreen too if it isn't already, so panel/page switches are a single click.
    const refreshAfterViewChange = () => setTimeout(() => { resizeCanvasLayout(); if (filteredData.length > 0) { if (trackerModeSelect.value === '2d') renderMapEngineFrame(currentIdx, filteredData[currentIdx]); } }, 100);
    const setFakePanel = (panel) => {
        mapPanel.classList.toggle('fake-fs', panel === mapPanel);
        videoPanel.classList.toggle('fake-fs', panel === videoPanel);
        // the whole top-right sticky cluster (help, reset, theme, fullscreen) sits over the pinned
        // panel's own header buttons and would steal their clicks, so hide the cluster while a panel
        // is pinned; the panel's own header buttons and esc still work.
        const topRight = document.getElementById('topRightControls');
        if (topRight) topRight.style.display = panel ? 'none' : '';
        refreshAfterViewChange();
    };
    fullscreenBtn.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(err => { });
    });
    const togglePanelFullscreen = (panel) => {
        if (panel.classList.contains('fake-fs')) { setFakePanel(null); return; }
        if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(err => { });
        setFakePanel(panel);
    };
    fullscreenMapBtn.addEventListener('click', () => togglePanelFullscreen(mapPanel));
    fullscreenVideoBtn.addEventListener('click', () => togglePanelFullscreen(videoPanel));

    document.addEventListener('fullscreenchange', () => {
        fullscreenBtn.innerText = !document.fullscreenElement ? "⛶ Fullscreen" : "⛶ Exit Fullscreen";
        // Leaving real fullscreen (Esc or the main button) unpins any fake-fullscreened panel too.
        if (!document.fullscreenElement) setFakePanel(null);
        else refreshAfterViewChange();
    });

    trackerModeSelect.addEventListener('change', (e) => {
        const satSelect = document.getElementById('satelliteSelect');
        const satBandSelect = document.getElementById('satBandSelect');

        // Keep the early-boot FOUC guard (index.html <head>) in sync with the live mode: its CSS
        // rule hides the 2D-only controls, and clearing an inline display cannot override it.
        document.documentElement.classList.toggle('pref-tracker-3d', e.target.value === '3d');

        if (e.target.value === '3d') {
            canvas.style.display = 'none'; threeDContainer.style.display = 'block';

            if (satSelect) satSelect.style.display = 'none';
            if (satBandSelect) satBandSelect.style.display = 'none';
            if (typeof closeSatPicker === 'function') closeSatPicker();   // popover has no place in 3d mode
            syncSatSplit();
            buildSatDayStepper();
            const satBadge = document.getElementById('satTimeBadge');
            if (satBadge) satBadge.classList.add('hidden');

            setTimeout(() => {
                resizeCanvasLayout();
                if (filteredData.length > 0) { if (!threeDInitialized) build3DScene(); updateVisualComponents(currentIdx); }
                // real-scale was likely toggled while in 2D, where the camera couldn't dolly; frame the
                // now-tiny plane on entering 3D so it isn't a distant speck.
                if (realScale3D) dollyCameraForScale();
            }, 50);
        } else {
            canvas.style.display = 'block'; threeDContainer.style.display = 'none';

            if (satSelect) satSelect.style.display = '';
            if (satBandSelect && satSelect.value !== 'none') satBandSelect.style.display = '';
            syncSatSplit();
            buildSatDayStepper();

            setTimeout(() => {
                resizeCanvasLayout();
                if (filteredData.length > 0) {
                    // the 2d map may have been fitted against a zero-size canvas (flight loaded while
                    // in 3d), leaving a stale, off-target view; recompute the frame and re-center on
                    // the plane while still following, so it lands where it should instead of blank sea
                    if (typeof calculateMapScales === 'function') calculateMapScales();
                    bgNeedsUpdate = true;
                    if (followAircraft2D && typeof engageFollowAircraft === 'function') engageFollowAircraft();
                    updateVisualComponents(currentIdx);
                }
            }, 50);
        }
        if (typeof updateFollowButton === 'function') updateFollowButton();
        if (typeof updateSatColorLegend === 'function') updateSatColorLegend();   // hide in 3d, show in 2d
    });

    document.getElementById('satelliteSelect').addEventListener('change', () => {
        updateBandOptions();
        satImageLoaded = false; lastSatFetchTime = ''; bgNeedsUpdate = true; resetSatPreload();
        satLoadedInfo = null; satImageBox = null;
        satDayOffset = 0;            
        buildSatDayStepper();
        updateSatTimeBadge();
        if (filteredData.length > 0 && trackerModeSelect.value === '2d') {
            // Archive-GOES layers reset satBandSelect to a blank placeholder, so fetchSatelliteImage/
            // maybeAutoPrecacheSatellite no-op until a product is picked. Polar (MODIS/VIIRS) layers
            // have no placeholder and fetch their daily image immediately.
            fetchSatelliteImage(filteredData[currentIdx].absSeconds);
            maybeAutoPrecacheSatellite();
            renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
        }
        if (typeof refreshSatPicker === 'function') refreshSatPicker();
        if (typeof updateSatColorLegend === 'function') updateSatColorLegend();
    });

    document.getElementById('satBandSelect').addEventListener('change', () => {
        satImageLoaded = false; lastSatFetchTime = ''; bgNeedsUpdate = true; resetSatPreload();
        if (filteredData.length > 0 && trackerModeSelect.value === '2d') {
            // Archived (recon-api) satellites stream a tile per 10-min scan from the API, which can
            // pause playback, so picking a bbox-capable product auto-builds its whole timeframe up
            // front (maybeAutoPrecacheSatellite) instead of trickling in during playback. A full-disk-
            // only composite (sandwich/geocolor) skips that and just streams per-frame like a polar layer.
            fetchSatelliteImage(filteredData[currentIdx].absSeconds);
            maybeAutoPrecacheSatellite();
            renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
        }
        if (typeof refreshSatPicker === 'function') refreshSatPicker();
        if (typeof updateSatColorLegend === 'function') updateSatColorLegend();
    });

    // combined satellite and product picker popover.
    // a single button opens a popover: pick a satellite, its products appear right under it to pick
    // consecutively. it reads and writes the two hidden native selects (satelliteSelect, satBandSelect)
    // and fires their 'change' events, so the whole satellite engine (fetch, day stepper, caching,
    // coverage and scan time labels) keeps working unchanged. satPickerExpanded is the layer whose
    // product list is currently open in the panel.
    let satPickerExpanded = null;

    function updateSatPickerButton() {
        const sat = document.getElementById('satelliteSelect');
        const band = document.getElementById('satBandSelect');
        const btn = document.getElementById('satPickerBtn');
        const lbl = document.getElementById('satPickerBtnLabel');
        if (!sat || !btn || !lbl) return;
        if (sat.value === 'none') { lbl.textContent = 'Sat: Off'; btn.classList.remove('sat-on'); return; }
        const def = (typeof GIBS_LAYERS !== 'undefined') ? GIBS_LAYERS.find(d => d.value === sat.value) : null;
        const base = def ? def.baseLabel : sat.value;
        let prod = '';
        if (band && band.value) { const o = band.options[band.selectedIndex]; prod = o ? o.textContent : ''; }
        lbl.textContent = prod ? `${base} · ${prod}` : base;
        btn.classList.add('sat-on');
    }

    function renderSatPickerPanel() {
        const list = document.getElementById('satPickerList');
        const sat = document.getElementById('satelliteSelect');
        const band = document.getElementById('satBandSelect');
        if (!list || !sat) return;
        const activeSat = sat.value, activeBand = band ? band.value : '';
        let html = `<button type="button" class="sat-pick-off${activeSat === 'none' ? ' active' : ''}" data-off="1">Off (no overlay)</button>`;
        for (const opt of sat.options) {
            if (opt.value === 'none') continue;
            const def = (typeof GIBS_LAYERS !== 'undefined') ? GIBS_LAYERS.find(d => d.value === opt.value) : null;
            const expanded = satPickerExpanded === opt.value && !opt.disabled;
            const isActive = activeSat === opt.value;
            html += `<div class="sat-pick-sat${opt.disabled ? ' disabled' : ''}${isActive ? ' active' : ''}">`;
            html += `<button type="button" class="sat-pick-sat-row"${opt.disabled ? ' disabled' : ` data-sat="${opt.value}"`}>`
                 +  `<span class="sat-pick-caret">${opt.disabled ? '' : (expanded ? '▾' : '▸')}</span>`
                 +  `<span class="sat-pick-name">${escapeHtml(opt.textContent)}</span>`
                 +  (opt.disabled ? `<span class="sat-pick-tag">unavailable</span>` : ``)
                 +  `</button>`;
            if (expanded && def && def.bands) {
                const renderBand = b => {
                    const unavail = b.available === false;   // api online but this product isn't being served
                    return `<button type="button" class="sat-pick-prod${(isActive && activeBand === b.id) ? ' active' : ''}${unavail ? ' unavailable' : ''}"`
                        + (unavail ? ' disabled' : ` data-sat="${opt.value}" data-band="${escapeHtml(b.id)}"`) + `>`
                        + `<span class="sat-pick-name">${escapeHtml(b.name)}</span>`
                        + (unavail ? `<span class="sat-pick-tag">unavailable</span>` : ``) + `</button>`;
                };
                html += `<div class="sat-pick-products">`;
                if (def.isReconApi) {
                    const spectral = def.bands.filter(b => !b.isComposite), comps = def.bands.filter(b => b.isComposite);
                    if (spectral.length) html += `<div class="sat-pick-group">Spectral Bands</div>` + spectral.map(renderBand).join('');
                    if (comps.length) html += `<div class="sat-pick-group">Composites</div>` + comps.map(renderBand).join('');
                } else {
                    html += def.bands.map(renderBand).join('');
                }
                html += `</div>`;
            }
            html += `</div>`;
        }
        list.innerHTML = html;
    }

    function refreshSatPicker() {
        updateSatPickerButton();
        const panel = document.getElementById('satPickerPanel');
        if (panel && !panel.classList.contains('hidden')) renderSatPickerPanel();
    }

    // the panel is position:fixed (see app.css) so it escapes the map header's z-20 stacking context
    // and layers above the map overlays. anchor it under the button, right aligned to it.
    function positionSatPicker() {
        const panel = document.getElementById('satPickerPanel'), btn = document.getElementById('satPickerBtn');
        if (!panel || !btn || panel.classList.contains('hidden')) return;
        const r = btn.getBoundingClientRect();
        panel.style.top = (r.bottom + 4) + 'px';
        panel.style.left = 'auto';
        panel.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    }
    function openSatPicker() {
        const panel = document.getElementById('satPickerPanel');
        if (!panel) return;
        const sat = document.getElementById('satelliteSelect');
        if (sat && sat.value !== 'none') satPickerExpanded = sat.value;   // open with the active layer expanded already
        renderSatPickerPanel();
        panel.classList.remove('hidden');
        panel.scrollTop = 0;   // always reopen scrolled to the top (opacity slider + first products)
        positionSatPicker();
    }
    function closeSatPicker() { const p = document.getElementById('satPickerPanel'); if (p) p.classList.add('hidden'); }

    // apply a satellite and product together: set the satellite (which rebuilds its band options via
    // the 'change' handler), then the product, so imagery only loads once a product is actually chosen.
    function satPickerChooseProduct(satValue, bandId) {
        const sat = document.getElementById('satelliteSelect'), band = document.getElementById('satBandSelect');
        if (!sat || !band) return;
        if (sat.value !== satValue) { sat.value = satValue; sat.dispatchEvent(new Event('change')); }
        if (band.value !== bandId) { band.value = bandId; band.dispatchEvent(new Event('change')); }
        closeSatPicker();
    }
    function satPickerChooseOff() {
        const sat = document.getElementById('satelliteSelect');
        if (sat && sat.value !== 'none') { sat.value = 'none'; sat.dispatchEvent(new Event('change')); }
        closeSatPicker();
    }

    (function wireSatPicker() {
        const btn = document.getElementById('satPickerBtn'), list = document.getElementById('satPickerList');
        if (!btn || !list) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const panel = document.getElementById('satPickerPanel');
            if (panel && panel.classList.contains('hidden')) openSatPicker(); else closeSatPicker();
        });
        list.addEventListener('click', (e) => {
            if (e.target.closest('[data-off]')) { satPickerChooseOff(); return; }
            const prod = e.target.closest('[data-band]');
            if (prod) { satPickerChooseProduct(prod.getAttribute('data-sat'), prod.getAttribute('data-band')); return; }
            const row = e.target.closest('.sat-pick-sat-row[data-sat]');
            if (row) { const v = row.getAttribute('data-sat'); satPickerExpanded = (satPickerExpanded === v) ? null : v; renderSatPickerPanel(); }
        });
        // outside click or esc closes, like the measure popover.
        document.addEventListener('mousedown', (e) => {
            const panel = document.getElementById('satPickerPanel');
            if (!panel || panel.classList.contains('hidden')) return;
            if (panel.contains(e.target) || btn.contains(e.target)) return;
            closeSatPicker();
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSatPicker(); });
        // keep the fixed panel glued to the button as the page or media bar scrolls or the window resizes.
        window.addEventListener('resize', positionSatPicker);
        window.addEventListener('scroll', positionSatPicker, true);
        // satellite tile opacity: redraw the map background at the new alpha as the user drags
        const opacitySlider = document.getElementById('satOpacitySlider'), opacityVal = document.getElementById('satOpacityVal');
        if (opacitySlider) opacitySlider.addEventListener('input', () => {
            satTileOpacity = (parseInt(opacitySlider.value) || 92) / 100;
            if (opacityVal) opacityVal.textContent = opacitySlider.value + '%';
            if (filteredData.length > 0 && trackerModeSelect.value === '2d') { bgNeedsUpdate = true; renderMapEngineFrame(currentIdx, filteredData[currentIdx]); }
        });
        updateSatPickerButton();
    })();

    pathColorSelect.addEventListener('change', () => { if (filteredData.length > 0) { if (threeDInitialized) build3DScene(); renderMapEngineFrame(currentIdx, filteredData[currentIdx]); } });
    barbColorSelect.addEventListener('change', () => { if (filteredData.length > 0) { if (threeDInitialized) build3DScene(); renderMapEngineFrame(currentIdx, filteredData[currentIdx]); } });
    document.getElementById('trackAltSelect').addEventListener('change', () => { if (filteredData.length > 0 && threeDInitialized) { build3DScene(); updateVisualComponents(currentIdx); } });

    document.getElementById('markBtn').addEventListener('click', () => {
        if (!customMarkers.find(m => m.idx === currentIdx)) {
            const palette = ['#fbbf24', '#ef4444', '#38bdf8', '#7dd3fc', '#9aa1ad', '#7ad9ff', '#22d0ee']; const assignedColor = palette[customMarkers.length % palette.length];
            customMarkers.push({ idx: currentIdx, color: assignedColor }); if (threeDInitialized) sync3DMarkers(); updateVisualComponents(currentIdx);
        }
    });
    document.getElementById('clearMarksBtn').addEventListener('click', () => { customMarkers = []; if (threeDInitialized) sync3DMarkers(); updateVisualComponents(currentIdx); });
    document.getElementById('simpleTrackerIcon').addEventListener('change', () => { if (filteredData.length > 0 && trackerModeSelect.value === '2d') renderMapEngineFrame(currentIdx, filteredData[currentIdx]); });

    document.getElementById('toggleSI').addEventListener('change', () => { if (filteredData.length > 0) { buildChartLayout(); updateVisualComponents(currentIdx); } });
    document.getElementById('toggleGpsAlt').addEventListener('change', () => { if (filteredData.length > 0) { if (trackerModeSelect.value === '3d') build3DScene(); updateVisualComponents(currentIdx); } });
    
    videoSyncMode.addEventListener('change', (e) => {
        if (e.target.value === 'auto') { ocrIndicator.style.display = 'block'; document.getElementById('videoStartInput').disabled = true; document.getElementById('forceSyncBtn').style.display = 'inline-block'; } 
        else { ocrIndicator.style.display = 'none'; if (videoLoaded) document.getElementById('videoStartInput').disabled = false; document.getElementById('forceSyncBtn').style.display = 'none'; }
        applySyncModeLock();
        refreshSyncingIndicator();  // hide the badge immediately when leaving Auto-Sync
    });
