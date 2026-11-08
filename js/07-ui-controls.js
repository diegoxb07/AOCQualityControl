/* Mission Visualizer, DOM refs, 3D scene, control wiring
   part of index.html, split into modules so a failure in one file does not break the others.
   loaded as a classic (non-module) script; all parts share one global scope, in order. */

    // fullscreen-friendly drag & drop logic
    ['dataDropZone'].forEach(zoneId => {
        const zone = document.getElementById(zoneId);
        if (!zone) return;
        const input = zone.querySelector('input[type="file"]');

        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('is-over');
        });

        zone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            zone.classList.remove('is-over');
        });

        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('is-over');
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                input.files = e.dataTransfer.files;
                const event = new Event('change', { bubbles: true });
                input.dispatchEvent(event);
            }
        });
    });

    const canvas = document.getElementById('mapCanvas'), ctx = canvas.getContext('2d'), mapPlaceholder = document.getElementById('mapPlaceholder'), fullscreenBtn = document.getElementById('fullscreenBtn'), mapPanel = document.getElementById('mapPanel'), trackerModeSelect = document.getElementById('trackerModeSelect'), threeDContainer = document.getElementById('threeDContainer');

    function showToast(message, duration = 8000) {
        const toast = document.getElementById('toastNotification'); document.getElementById('toastMessage').innerText = message; toast.classList.add('show'); setTimeout(() => { toast.classList.remove('show'); }, duration);
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
            // storm name, from the "(NAME)" the mission id carries when the file names one.
            let storm = (rawId.match(/\(([^)]+)\)/) || [])[1] || '';
            if (/unknown|training|research/i.test(storm)) storm = '';
            if (storm) storm = storm.charAt(0).toUpperCase() + storm.slice(1).toLowerCase();
            // aircraft designator from the tail number, NOAA name, or the mission-id letter (H/I/N).
            const acId = ((flightMetaData.aircraft || '') + ' ' + rawId).toUpperCase();
            let plane = '';
            if (/N?42 ?RF|NOAA ?42|\d{8}H\d/.test(acId)) plane = 'NOAA42';
            else if (/N?43 ?RF|NOAA ?43|\d{8}I\d/.test(acId)) plane = 'NOAA43';
            else if (/N?49 ?RF|NOAA ?49|GULFSTREAM|\bG-?IV\b|\d{8}N\d/.test(acId)) plane = 'NOAA49';
            const parts = [idPart, storm, plane].filter(Boolean);
            sub.textContent = parts.join(' · ');
            sub.classList.toggle('hidden', parts.length === 0);
            document.title = (idPart ? idPart + ' · ' : '') + 'AOC QC Tool';
        }
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
    // (nose at +X, drawn white with a dark outline). swept wings, two aft-fuselage
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

    // true when the loaded flight is the Gulfstream: aircraft letter N in the AOC
    // mission id (e.g. 20240826N1), or an archive aircraft/tail string naming it.
    function isGulfstreamFlight() {
        const id = flightMetaData.id || '', ac = flightMetaData.aircraft || '';
        return /\d{8}N\d/i.test(id) || /gulfstream|\bg-?iv\b|\bn49/i.test(ac + ' ' + id);
    }

    // home camera offset from the aircraft (the orbit target): close enough that the airframe
    // fills the view on open. the per-frame follow keeps whatever offset the user orbits to;
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

    // the 3D scene's void behind the map, tracking the theme like the rest of the basemap.
    function scene3DBgColor() {
        return (document.documentElement.dataset.theme === 'light') ? 0xdfe6ec : 0x171122;
    }

    function init3D() {
        if (threeDInitialized) return;
        const w = threeDContainer.clientWidth || canvas.width, h = threeDContainer.clientHeight || canvas.height, aspect = w / (h || 1);
        scene3D = new THREE.Scene(); scene3D.background = new THREE.Color(scene3DBgColor());
        // haze toward the horizon in the background colour, for depth; animate3D sets its range from
        // the camera distance each frame
        scene3D.fog = new THREE.Fog(scene3DBgColor(), 60, 260);
        // near clip is tiny so the camera can dolly right up to the aircraft (scaled 0.06, so it is
        // small in world units and a larger near plane clips it away before you get close); the huge
        // near/far span rides a logarithmic depth buffer to stay z-fight-free.
        camera3D = new THREE.PerspectiveCamera(45, aspect, 0.001, 50000);
        camera3D.position.set(CAM3D_HOME.x, CAM3D_HOME.y, CAM3D_HOME.z);   // starts zoomed into the aircraft, no scroll-in needed
        renderer3D = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: true });
        // render at the display's true pixel density (capped at 2x), so the 3D view is crisp on retina screens.
        renderer3D.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer3D.setSize(w, h); threeDContainer.insertBefore(renderer3D.domElement, threeDContainer.firstChild);
        controls3D = new THREE.OrbitControls(camera3D, renderer3D.domElement); controls3D.enableDamping = true;
        controls3D.minDistance = 0.02;   // let the user get right in on the aircraft without dollying through the target
        scene3D.add(new THREE.AmbientLight(0xffffff, 0.6)); const dirLight = new THREE.DirectionalLight(0xffffff, 0.8); dirLight.position.set(10, 20, 10); scene3D.add(dirLight);
        planeGroup3D = new THREE.Group(); planeGroup3D.scale.set(0.06, 0.06, 0.06); scene3D.add(planeGroup3D);
        // the airframe itself (WP-3D or G-IV per the loaded flight) is built by js/07b-plane-models.js
        if (typeof setPlaneModel3D === 'function') setPlaneModel3D();
        // direction arrow: shaft + a cone HEAD whose apex points forward (-Z, this model's nose
        // direction). the cone's local apex is at +Y, so it needs a NEGATIVE X rotation to face -Z.
        const buildDirectionArrow = (color, scale, standoff, opacity) => {
            const mat = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
            const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1.2, 8), mat); shaft.rotation.x = Math.PI / 2; shaft.position.z = -standoff - 0.6;
            const head = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.4, 8), mat); head.rotation.x = -Math.PI / 2; head.position.z = -standoff - 1.4;
            const group = new THREE.Group(); group.add(shaft, head); group.scale.set(scale, scale, scale);
            return group;
        };
        // ground track: blue, standing out ahead of the airframe so it never overlaps it.
        trackArrow3D = buildDirectionArrow(0x3da5ff, 0.17, 2.3, 1); scene3D.add(trackArrow3D);
        // true heading: yellow and slightly smaller, nested inside the track arrow's world-space
        // span, so it hides within the blue when the two agree and appears only when they
        // diverge; scene-level (not planeGroup3D) so it stays a clean world-space compass pointer.
        headingArrow3D = buildDirectionArrow(0xffd400, 0.145, 2.76, 0.8); scene3D.add(headingArrow3D);
        scene3D.add(threeMapGroup);
        function animate3D() {
            requestAnimationFrame(animate3D); if (controls3D) controls3D.update();
            // props spin only while playback runs; pausing freezes them with everything else
            if (typeof planeSpinners3D !== 'undefined' && isPlaying) for (let i = 0; i < planeSpinners3D.length; i++) planeSpinners3D[i].rotation.z += 0.3;
            // the state the plane is over: one label at that state's own centre. runs before the
            // country labels, which read _stateLabelIdx to stand down under it.
            if (_stateLabels.length) {
                const in3dS = !trackerModeSelect || trackerModeSelect.value === '3d';
                const row = (in3dS && filteredData.length) ? filteredData[currentIdx] : null;
                const sIdx = row ? stateIndexAt(row.lat, row.lon) : -1;
                if (sIdx !== _stateLabelIdx) {
                    if (_stateLabelIdx >= 0) _stateLabels[_stateLabelIdx].mesh.visible = false;
                    if (sIdx >= 0) _stateLabels[sIdx].mesh.visible = true;
                    _stateLabelIdx = sIdx;
                }
                // size and facing follow the camera, the anchor never does. yaw puts the text across
                // the view; pitching by the camera's elevation lays the name flat from straight above
                // and stands it up as the camera drops to the horizon.
                if (sIdx >= 0 && camera3D) {
                    const sl = _stateLabels[sIdx], a = sl.at;
                    const dx = camera3D.position.x - a.x, dy = camera3D.position.y - a.y, dz = camera3D.position.z - a.z;
                    const k = (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1) * 0.045;
                    const elev = Math.atan2(dy, Math.hypot(dx, dz));
                    sl.mesh.scale.set(k, k, 1);
                    sl.mesh.rotation.set(0, 0, 0);
                    sl.mesh.rotateY(Math.atan2(dx, dz));
                    sl.mesh.rotateX(-elev);
                    // it turns about its middle, so ride up by its half-height against the vertical,
                    // or standing it up puts its lower half through the terrain
                    sl.mesh.position.set(a.x, a.y + (k / 2) * Math.cos(elev), a.z);
                }
            }
            // country labels: sit at the nearest coastline point to the plane, only while that coast is in
            // range, and scale with camera distance so they stay a constant readable size at any altitude.
            if (_countryLabels.length) {
                const in3d = !trackerModeSelect || trackerModeSelect.value === '3d';
                const show = in3d && camera3D && planeGroup3D && filteredData.length;
                const px = show ? planeGroup3D.position.x : 0, pz = show ? planeGroup3D.position.z : 0, R0 = 26, R1 = 74;
                for (let i = 0; i < _countryLabels.length; i++) {
                    const cl = _countryLabels[i];
                    if (!show) { cl.sprite.visible = false; continue; }
                    // a named state already says the country, so the US label stands down over one
                    if (cl.isUSA && _stateLabelIdx >= 0) { cl.sprite.visible = false; continue; }
                    let best = Infinity, bx = 0, by = 0, bz = 0;
                    for (let k = 0; k < cl.pts.length; k++) { const p = cl.pts[k]; const dx = px - p.x, dz = pz - p.z, dd = dx * dx + dz * dz; if (dd < best) { best = dd; bx = p.x; by = p.y; bz = p.z; } }
                    const dist = Math.sqrt(best);
                    if (dist < R1) {
                        cl.sprite.visible = true;
                        const camDist = camera3D.position.distanceTo(cl.sprite.position.set(bx, by, bz)) || 1;
                        const sc = camDist * 0.032;
                        cl.sprite.position.y = by + sc * 0.7;
                        cl.sprite.scale.set(sc * cl.aspect, sc, 1);
                        cl.mat.opacity = dist <= R0 ? 1 : (R1 - dist) / (R1 - R0);
                    } else cl.sprite.visible = false;
                }
            }
            // city names lie flat on the ground near the plane (the major cities out to a wider reach),
            // faded at the edge of that reach and turned about the vertical so they read upright
            if (_cityLabels.length && camera3D && planeGroup3D) {
                const in3dC = !trackerModeSelect || trackerModeSelect.value === '3d';
                const px = planeGroup3D.position.x, pz = planeGroup3D.position.z;
                for (let i = 0; i < _cityLabels.length; i++) {
                    const cl = _cityLabels[i];
                    const R1 = cl.big ? 90 : 45, R0 = R1 * 0.7;   // world units, 20 per degree
                    const dist = Math.hypot(cl.at.x - px, cl.at.z - pz);
                    if (!in3dC || !filteredData.length || dist >= R1) { cl.mesh.visible = false; continue; }
                    cl.mesh.visible = true;
                    cl.mesh.rotation.y = Math.atan2(camera3D.position.x - cl.at.x, camera3D.position.z - cl.at.z);
                    cl.mat.opacity = dist <= R0 ? 1 : (R1 - dist) / (R1 - R0);
                }
            }
            // the haze stays clear out to a few camera distances from the view's center, so the
            // ground near the aircraft is crisp at any zoom and only the far ground fades
            if (scene3D.fog && camera3D && controls3D) {
                const cd = camera3D.position.distanceTo(controls3D.target) || 1;
                scene3D.fog.near = Math.max(60, cd * 2.5);
                scene3D.fog.far = Math.max(260, cd * 9);
            }
            // hill shading strength (terrainShadeK, js/07c-terrain.js) from the camera's angle above the
            // horizon: none at 35 degrees and steeper, easing in to full at 10 degrees and lower
            if (typeof terrainShadeK !== 'undefined' && camera3D && controls3D) {
                const dx = camera3D.position.x - controls3D.target.x, dz = camera3D.position.z - controls3D.target.z;
                const elev = Math.atan2(camera3D.position.y - controls3D.target.y, Math.hypot(dx, dz)) * 180 / Math.PI;
                const t = Math.max(0, Math.min(1, (35 - elev) / 25));
                terrainShadeK.value = t * t * (3 - 2 * t);
            }
            renderer3D.render(scene3D, camera3D);
        }
        animate3D(); threeDInitialized = true;
    }

    // real-scale toggle (a Filters checkbox): draw the 3D airframe at its true size against the world
    // instead of the default enlarged glyph. real fuselage lengths per type, defaulting to the WP-3D
    // when the aircraft is unknown; at 20 units/deg the model is tiny, so it only reads once dollied in.
    let realScale3D = false;
    let _borderLines = [];      // { line, mat, box, base } coastline/border lines, faded by distance to the plane
    let _countryLabels = [];    // { sprite, mat, aspect, pts, isUSA } country name labels shown near visible coastlines
    let _cityLabels = [];       // { mesh, mat, at, big } city names lying flat on the ground, shown near the plane
    let _stateLabels = [];      // { mesh, mat, rings, bbox } flat US state names, lying on the basemap
    let _stateLabelIdx = -1;    // index into _stateLabels of the state under the plane, -1 = none
    // how far offshore a state still names the ground beneath (these flights sit over water most of a
    // mission, so an inside-only test would leave the state nameless exactly when it is asked).
    const STATE_NEAR_DEG = 2.5;
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
    // frame the plane after a real-scale toggle: real-scale dollies in to ~2.5 plane-lengths so the
    // now-tiny airframe is visible immediately; turning it off restores the default framing distance.
    // camera distance that frames the real-size plane to ~64% of the vertical view.
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
    })();

    function get3DCoord(lon, lat, altMeters) {
        if (isNaN(lon) || isNaN(lat)) return new THREE.Vector3(0,0,0);
        const centerLon = (plotMinLon + plotMaxLon) / 2 || 0, centerLat = (plotMinLat + plotMaxLat) / 2 || 0, scaleMult = 20;
        // wrapLon (js/15-map-render.js) keeps dateline-crossing flights continuous here too;
        // safe because build3DScene only renders flight-adjacent features (never the far seam).
        // altitude is exaggerated ~8x against the horizontal scale (20 units/deg = 0.181 units/km,
        // /690 = 1.45 units/km) so climbs read at a believable angle without the track gluing flat.
        const x = (wrapLon(lon) - centerLon) * scaleMult, z = -(lat - centerLat) * scaleMult, y = (altMeters || 0) / 690; return new THREE.Vector3(x, y, z);
    }

    // altitude for the 3D map's vertical dimension: GPS, falling back to pressure altitude.
    function track3DAltMeters(d) {
        if (!d) return 0;
        return d.gpsAlt != null ? d.gpsAlt : (d.pAlt != null ? d.pAlt : 0);
    }

    function isBoxInFlightBounds(bbox) {
        if (!bbox) return true;
        const expandDeg = 15, viewMinLon = plotMinLon - expandDeg, viewMaxLon = plotMaxLon + expandDeg, viewMinLat = plotMinLat - expandDeg, viewMaxLat = plotMaxLat + expandDeg;
        if (bbox[1] > viewMaxLat || bbox[3] < viewMinLat) return false;
        // also test the bbox shifted ±360: a dateline-centered flight's plot window sits outside
        // [-180,180], where every raw feature bbox would otherwise miss it.
        return [0, -360, 360].some(s => !(bbox[0] + s > viewMaxLon || bbox[2] + s < viewMinLon));
    }

    // A small text sprite for a country name, white with a dark outline so it reads on any terrain.
    // the label keeps a constant on-screen size in animate3D by scaling with its camera distance.
    function countryLabelSprite(name) {
        const cv = document.createElement('canvas');
        let c = cv.getContext('2d');
        c.font = 'bold 40px sans-serif';
        const w = Math.min(560, Math.ceil(c.measureText(name).width) + 30);
        cv.width = w; cv.height = 58;
        c = cv.getContext('2d');
        c.font = 'bold 40px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.lineWidth = 7; c.strokeStyle = 'rgba(5,12,20,0.92)'; c.strokeText(name, w / 2, 30);
        c.fillStyle = '#eef4fb'; c.fillText(name, w / 2, 30);
        const tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter;
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
        const spr = new THREE.Sprite(mat); spr.renderOrder = 5; spr.visible = false;
        return { sprite: spr, mat, aspect: w / 58, pts: [] };
    }

    // ray-cast point-in-polygon on a lon/lat ring given as {lat, lon} points (js/04-geo-measure.js in
    // AOCVisualizer; inlined here since the QC build prunes that module).
    function pointInPolygon(pts, lat, lon) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i].lon, yi = pts[i].lat, xj = pts[j].lon, yj = pts[j].lat;
            const intersect = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    // A state name on the basemap. A mesh, not a sprite, so animate3D can lay it onto the map from
    // straight above and stand it up as the camera drops. built one world unit tall whatever the
    // name's length, and scaled there by camera distance.
    function stateLabelMesh(name) {
        const cv = document.createElement('canvas');
        let c = cv.getContext('2d');
        c.font = 'bold 44px sans-serif';
        const w = Math.ceil(c.measureText(name).width) + 40;
        cv.width = w; cv.height = 72;
        c = cv.getContext('2d');
        c.font = 'bold 44px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.lineWidth = 8; c.strokeStyle = 'rgba(5,12,20,0.92)'; c.strokeText(name, w / 2, 38);
        c.fillStyle = '#eef4fb'; c.fillText(name, w / 2, 38);
        const tex = new THREE.CanvasTexture(cv);
        tex.anisotropy = (renderer3D && renderer3D.capabilities) ? renderer3D.capabilities.getMaxAnisotropy() : 1;
        tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
        const geo = new THREE.PlaneGeometry(w / 72, 1);   // unit height, so scale is length-independent
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 6; mesh.visible = false;   // after the country labels (renderOrder 5)
        return { mesh, mat };
    }

    // a city name lying flat on the 3D ground: a small dot on the city with the name beside it in muted
    // slate, at a fixed size on the ground (CITY_LABEL_H world units tall, about 2.8 km), so it reads as
    // part of the map, flat under the track. built flat with the dot at the mesh's origin;
    // animate3D only turns it about the vertical so the text reads upright from the camera.
    const CITY_LABEL_H = 0.5;
    function cityLabelMesh(name) {
        const h = 48, fs = 30, dotX = 10, textX = 24;
        const font = '600 ' + fs + "px 'Nunito Sans', sans-serif";
        const cv = document.createElement('canvas');
        let c = cv.getContext('2d');
        c.font = font;
        const w = Math.ceil(c.measureText(name).width) + textX + 8;
        cv.width = w; cv.height = h;
        c = cv.getContext('2d');
        c.font = font; c.textBaseline = 'middle'; c.lineJoin = 'round';
        c.beginPath(); c.arc(dotX, h / 2, 5, 0, 2 * Math.PI); c.fillStyle = 'rgba(71,85,105,0.85)'; c.fill();
        c.lineWidth = 5; c.strokeStyle = 'rgba(255,255,255,0.6)'; c.strokeText(name, textX, h / 2);
        c.fillStyle = 'rgba(51,65,85,0.85)'; c.fillText(name, textX, h / 2);
        const tex = new THREE.CanvasTexture(cv);
        tex.anisotropy = (renderer3D && renderer3D.capabilities) ? renderer3D.capabilities.getMaxAnisotropy() : 1;
        tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
        const W = CITY_LABEL_H * w / h;
        const geo = new THREE.PlaneGeometry(W, CITY_LABEL_H);
        geo.translate(W / 2 - dotX / w * W, 0, 0);   // the dot, not the label's middle, at the origin
        geo.rotateX(-Math.PI / 2);                    // flat on the ground, text running east, top to the north
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = 1; mesh.visible = false;
        return { mesh, mat };
    }

    // degrees from (lat, lon) to a [minLon, minLat, maxLon, maxLat] box, 0 anywhere inside it.
    function bboxDistDeg(b, lat, lon) {
        const dx = Math.max(b[0] - lon, 0, lon - b[2]);
        const dy = Math.max(b[1] - lat, 0, lat - b[3]);
        return Math.hypot(dx, dy);
    }

    // _stateLabels index for the US state at (lat, lon): the one holding it, else the nearest within
    // STATE_NEAR_DEG, else -1. the last match is tested first (a flight sits with one state for
    // minutes), the rest reject on bbox. crossings count across every ring, even-odd.
    function stateIndexAt(lat, lon) {
        const hit = i => {
            const s = _stateLabels[i], b = s.bbox;
            if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) return false;
            let inside = false;
            for (let k = 0; k < s.rings.length; k++) if (pointInPolygon(s.rings[k], lat, lon)) inside = !inside;
            return inside;
        };
        if (_stateLabelIdx >= 0 && _stateLabelIdx < _stateLabels.length && hit(_stateLabelIdx)) return _stateLabelIdx;
        for (let i = 0; i < _stateLabels.length; i++) if (i !== _stateLabelIdx && hit(i)) return i;
        let near = -1, best = STATE_NEAR_DEG;
        for (let i = 0; i < _stateLabels.length; i++) {
            const d = bboxDistDeg(_stateLabels[i].bbox, lat, lon);
            if (d < best) { best = d; near = i; }
        }
        return near;
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
        _stateLabels.forEach(sl => { if (sl.mesh.parent) sl.mesh.parent.remove(sl.mesh); sl.mesh.geometry.dispose(); if (sl.mat.map) sl.mat.map.dispose(); sl.mat.dispose(); });
        _stateLabels = []; _stateLabelIdx = -1;
        _cityLabels.forEach(cl => { if (cl.mesh.parent) cl.mesh.parent.remove(cl.mesh); cl.mesh.geometry.dispose(); if (cl.mat.map) cl.mat.map.dispose(); cl.mat.dispose(); });
        _cityLabels = [];
        const light3d = document.documentElement.dataset.theme === 'light';
        if (scene3D) scene3D.background = new THREE.Color(scene3DBgColor());
        const landMat = new THREE.MeshBasicMaterial({ color: light3d ? 0xe4ebdd : 0x0d4a22, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        // coastlines and dimmer internal (state) borders, so countries read clearly against the
        // terrain. dark ink lines on the light theme, bright on dark. depthWrite off keeps them from
        // occluding the streaks and each other.
        const coastMat = new THREE.LineBasicMaterial({ color: light3d ? 0x5e6f7c : 0xf0f6fc, transparent: true, opacity: 0.9, depthWrite: false });
        const stateMat = new THREE.LineBasicMaterial({ color: light3d ? 0x94a3b0 : 0xaac2d6, transparent: true, opacity: 0.55, depthWrite: false });
        // when the bundled terrain grid (js/07c-terrain.js) is loaded, coastlines and borders drape onto
        // the terrain surface at their sampled elevation and the flat land fill is skipped. c is GeoJSON
        // [lon, lat], so terrainSurfaceMeters takes (c[1], c[0]). it reads the drawn surface, not the
        // raw ground, or a coastline sampling to a water cell would sit under the sea.
        const hasTerrain = typeof isTerrainLoaded === 'function' && isTerrainLoaded();
        // both prime terrainSurfaceMeters, and the drape below is its first reader
        if (typeof refreshTerrainPins === 'function') refreshTerrainPins();
        if (typeof refreshTerrainMask === 'function') refreshTerrainMask();
        const borderAlt = c => hasTerrain ? terrainSurfaceMeters(c[1], c[0]) + 90 : 5;
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
            // one small name label per country (not states); positioned at the nearest coastline point to
            // the plane each frame (animate3D) and only shown while that coastline is in range.
            if (!isState && scene3D && feature.properties && feature.properties.NAME) {
                const polys = geom.type === 'Polygon' ? [geom.coordinates] : (geom.type === 'MultiPolygon' ? geom.coordinates : []);
                const all = []; polys.forEach(poly => poly.forEach(ring => ring.forEach(cc => all.push(cc))));
                if (all.length) {
                    const step = Math.max(1, Math.floor(all.length / 40));
                    const lbl = countryLabelSprite(feature.properties.NAME);
                    lbl.isUSA = feature.properties.NAME === 'United States of America';
                    for (let k = 0; k < all.length; k += step) { const cc = all[k]; lbl.pts.push(get3DCoord(cc[0], cc[1], borderAlt(cc))); }
                    scene3D.add(lbl.sprite); _countryLabels.push(lbl);
                }
            }
            // one flat name label per US state, laid on the basemap at the state's own centre and shown
            // only for the state under the plane (animate3D), which is what names it on a look straight
            // down. us-states.json carries the name lowercase, unlike the countries file's NAME.
            if (isState && scene3D && feature.properties && feature.properties.name) {
                const polys = geom.type === 'Polygon' ? [geom.coordinates] : (geom.type === 'MultiPolygon' ? geom.coordinates : []);
                // convert the rings once to {lat, lon} here, the form pointInPolygon reads.
                const rings = [];
                polys.forEach(poly => poly.forEach(ring => rings.push(ring.map(cc => ({ lon: cc[0], lat: cc[1] })))));
                const bbox = feature.properties.bbox;
                if (rings.length && bbox) {
                    // anchor on the largest ring's average vertex, which sits inside the landmass for
                    // shapes whose bbox centre does not (a bay, a lake, a second peninsula).
                    let big = rings[0];
                    rings.forEach(r => { if (r.length > big.length) big = r; });
                    let sx = 0, sy = 0;
                    big.forEach(p => { sx += p.lon; sy += p.lat; });
                    const cLon = sx / big.length, cLat = sy / big.length;
                    const lbl = stateLabelMesh(feature.properties.name);
                    // lifted well clear of the centroid's ground, since the name spans further than the
                    // point it samples; the standing-up lift in animate3D then builds on it.
                    const at = get3DCoord(cLon, cLat, borderAlt([cLon, cLat]) + 220);
                    lbl.mesh.position.copy(at);
                    lbl.at = at; lbl.rings = rings; lbl.bbox = bbox;
                    scene3D.add(lbl.mesh); _stateLabels.push(lbl);
                }
            }
        });
        // city names (data/cities.json) inside the terrain's box, each on the drawn ground; animate3D
        // shows the ones near the plane
        const cityBox = typeof terrainExtent === 'function' ? terrainExtent() : null;
        if (scene3D && typeof cities !== 'undefined') cities.forEach(cty => {
            if (cityBox && (cty.lon < cityBox.lon0 || cty.lon > cityBox.lon1 || cty.lat < cityBox.lat0 || cty.lat > cityBox.lat1)) return;
            const lbl = cityLabelMesh(cty.name);
            lbl.at = get3DCoord(cty.lon, cty.lat, borderAlt([cty.lon, cty.lat]) + 60);
            lbl.big = cty.big;
            lbl.mesh.position.copy(lbl.at);
            scene3D.add(lbl.mesh); _cityLabels.push(lbl);
        });
        // relief-shaded terrain surface from the bundled ETOPO grid (js/07c-terrain.js), so land and
        // sea floor are drawn at real height. null until the grid loads, while the flat coastline map
        // above renders.
        if (typeof buildTerrainMesh3D === 'function') { const terrainMesh = buildTerrainMesh3D(); if (terrainMesh) threeMapGroup.add(terrainMesh); }
        if(filteredData.length > 0) {
            // one vertex per 1 Hz sample, joined straight. no smoothing and no interpolation: the
            // track shows exactly the positions in the file, so a QC read of the flight path is
            // never looking at points the tool invented.
            const pathPts = [];
            const n = filteredData.length;
            for (let i = 0; i < n; i++) {
                const d = filteredData[i];
                pathPts.push(get3DCoord(d.lon, d.lat, track3DAltMeters(d)));
            }
            const pathGeom = new THREE.BufferGeometry().setFromPoints(pathPts);
            const trackMat = new THREE.LineBasicMaterial({ color: QC_TRACK_COLOR, linewidth: 3 });
            threeMapGroup.add(new THREE.Line(pathGeom, trackMat));
        }
    }

    function update3DFrame(idx, visualRow) {
        if (!threeDInitialized || !filteredData[idx]) return;
        const d = visualRow || filteredData[idx];
        const pos = get3DCoord(d.lon, d.lat, track3DAltMeters(d));
        planeGroup3D.position.copy(pos);
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
        // size both scene-level arrows to the plane's current scale so they stay proportional in
        // real-scale mode (done here every frame so it holds regardless of arrow/plane build order).
        const arrowF = planeGroup3D.scale.x / 0.06;
        trackArrow3D.scale.setScalar(0.17 * arrowF);
        if (headingArrow3D) headingArrow3D.scale.setScalar(0.145 * arrowF);
        trackArrow3D.position.copy(pos); trackArrow3D.rotation.set(0, THREE.MathUtils.degToRad(-t_track), 0);
        // true-heading arrow: same scene-level convention as the ground-track arrow (world position,
        // Y-only rotation, not banked/pitched with the airframe), so it reads as a clean compass pointer.
        // it fades in only as heading diverges from ground track (hidden below 3 deg of drift, full by 8)
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
    }

    // real fullscreen is page-level ONLY. the panel ⛶ buttons "fake" fullscreen instead: pin the
    // panel over the whole viewport (.fake-fs, styled like :fullscreen via :is()) and take the page
    // fullscreen too if it isn't already, so panel/page switches are a single click.
    const refreshAfterViewChange = () => setTimeout(() => { resizeCanvasLayout(); if (filteredData.length > 0) { if (trackerModeSelect.value === '2d') renderMapEngineFrame(currentIdx, filteredData[currentIdx]); } }, 100);
    const setFakePanel = (panel) => {
        mapPanel.classList.toggle('fake-fs', panel === mapPanel);
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

    document.addEventListener('fullscreenchange', () => {
        fullscreenBtn.innerText = !document.fullscreenElement ? "⛶ Fullscreen" : "⛶ Exit Fullscreen";
        // leaving real fullscreen (Esc or the main button) unpins any fake-fullscreened panel too.
        if (!document.fullscreenElement) setFakePanel(null);
        else refreshAfterViewChange();
    });

    trackerModeSelect.addEventListener('change', (e) => {
        // keep the early-boot FOUC guard (index.html <head>) in sync with the live mode: its CSS
        // rule hides the 2D-only controls, and clearing an inline display cannot override it.
        document.documentElement.classList.toggle('pref-tracker-3d', e.target.value === '3d');

        if (e.target.value === '3d') {
            canvas.style.display = 'none'; threeDContainer.style.display = 'block';

            setTimeout(() => {
                resizeCanvasLayout();
                if (filteredData.length > 0) { if (!threeDInitialized) build3DScene(); updateVisualComponents(currentIdx); }
                // real-scale was likely toggled while in 2D, where the camera couldn't dolly; frame the
                // now-tiny plane on entering 3D so it isn't a distant speck.
                if (realScale3D) dollyCameraForScale();
            }, 50);
        } else {
            canvas.style.display = 'block'; threeDContainer.style.display = 'none';

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
    });


