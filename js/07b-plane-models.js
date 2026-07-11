/* Mission Visualizer, 3D aircraft models (WP-3D Orion + Gulfstream IV-SP)
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   Builds the tracker's 3D airframe procedurally (lofted fuselage, airfoil wing panels, nacelles,
   props) with the NOAA livery painted onto canvas textures: white top, navy belly, sky cheatline,
   navy tail with the white swoosh and tail registration. The WP-3D carries its mission hardware
   (black nose radome, chin + belly radomes, tail Doppler boom, four turboprops); the G-IV carries
   winglets, aft fuselage nacelles, the T-tail, and its tail Doppler tube. setPlaneModel3D() picks
   the airframe from the loaded flight id (isGulfstreamFlight) and swaps it inside planeGroup3D.

   Conventions: nose at -Z, tail +Z, up +Y, span along X, all sizes in plane-local units
   (planeGroup3D applies the world scale). Fuselage textures map u around the hull (0 = belly,
   0.5 = top) and v along it (0 = nose, 1 = tail). */

    let planeModelGroup3D = null;    // airframe-only group inside planeGroup3D (the direction arrows live outside it)
    let planeModelType3D = null;     // 'p3' | 'giv'
    let planeSpinners3D = [];        // propeller groups, spun by the 3D render loop

    const NOAA_LIV = { white: '#f2f5f7', navy: '#11356f', sky: '#7ec8ec', black: '#1d2126', dark: '#2b3540', metal: '#aab4bd', prop: '#23272c' };

    // Tail registration for the fin decal: NOAA42/43 are the two WP-3Ds, NOAA49 the G-IV.
    function noaaTailReg(type) {
        if (type === 'giv') return 'N49RF';
        const s = ((typeof flightMetaData !== 'undefined' && flightMetaData) ? (flightMetaData.aircraft + ' ' + flightMetaData.id) : '');
        return (/noaa43/i.test(s) || /\d{8}I\d/i.test(s)) ? 'N43RF' : 'N42RF';
    }

    // ---------------------------------------------------------------------------------------
    // Geometry helpers

    // Skin a list of same-length 3D point loops into one closed surface with end caps.
    // uv: u = section fraction (spanwise), v = loop fraction, or the chord fraction folded onto
    // both surfaces when foldV is set (used by textured fins so a decal reads on either side).
    function loftGeometry(sections, opts) {
        opts = opts || {};
        const P = sections[0].length, S = sections.length, row = P + 1;
        const pos = [], uvs = [], idx = [];
        for (let s = 0; s < S; s++) {
            for (let p = 0; p <= P; p++) {
                const v = sections[s][p % P];
                pos.push(v.x, v.y, v.z);
                let vv = p / P;
                if (opts.foldV) vv = vv <= 0.5 ? vv * 2 : 2 - vv * 2;
                uvs.push(s / (S - 1), vv);
            }
        }
        for (let s = 0; s < S - 1; s++) for (let p = 0; p < P; p++) {
            const a = s * row + p, b = a + 1, c = a + row + 1, d = a + row;
            idx.push(a, b, d, b, c, d);
        }
        [0, S - 1].forEach((s, capI) => {
            const start = pos.length / 3;
            for (let p = 0; p < P; p++) { const v = sections[s][p]; pos.push(v.x, v.y, v.z); uvs.push(capI, p / P); }
            for (let p = 1; p < P - 1; p++) {
                if (capI === 0) idx.push(start, start + p + 1, start + p);
                else idx.push(start, start + p, start + p + 1);
            }
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        return geo;
    }

    // Closed airfoil outline: [chordwise 0..chord, thickness +up/-down], leading edge first,
    // around the trailing edge and back along the underside. Slightly cambered (flatter bottom).
    function airfoilLoop(chord, thick) {
        const ts = [0, 0.03, 0.09, 0.18, 0.32, 0.5, 0.7, 0.88, 1];
        const pts = ts.map(t => [t * chord, chord * thick * 2.4 * Math.sqrt(t) * (1 - t)]);
        for (let i = ts.length - 2; i >= 1; i--) { const t = ts[i]; pts.push([t * chord, -chord * thick * 1.6 * Math.sqrt(t) * (1 - t)]); }
        return pts;
    }

    // Chord fraction -> loft loop fraction for airfoilLoop's fixed sampling, top or bottom face.
    // Lets textures draw lines at an exact chord position despite the non-uniform point spacing.
    function loopV(t, top) {
        const ts = [0, 0.03, 0.09, 0.18, 0.32, 0.5, 0.7, 0.88, 1];
        let i = 0; while (i < ts.length - 2 && ts[i + 1] < t) i++;
        const fi = i + (t - ts[i]) / (ts[i + 1] - ts[i]);
        return top ? fi / 16 : (16 - fi) / 16;
    }

    // Painted control-surface grooves for a lifting panel: the spanwise hinge line at hinge chord
    // fraction plus a chordwise separator at each span fraction in seps, drawn on both faces and
    // wrapped around the trailing edge. Canvas x = span fraction, y = loop fraction. base/line
    // recolor the panel (a navy surface takes a darker groove line).
    function grooveTexture(hinge, seps, base, line) {
        const W = 256, H = 256;
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        const g = cv.getContext('2d');
        g.fillStyle = base || NOAA_LIV.white; g.fillRect(0, 0, W, H);
        const vt = loopV(hinge, true) * H, vb = loopV(hinge, false) * H;
        const s0 = seps[0] * W, s1 = seps[seps.length - 1] * W;
        g.strokeStyle = line || '#828d99'; g.lineWidth = 2.5;
        [vt, vb].forEach(v => { g.beginPath(); g.moveTo(s0, v); g.lineTo(s1, v); g.stroke(); });
        seps.forEach(s => { g.beginPath(); g.moveTo(s * W, vt); g.lineTo(s * W, vb); g.stroke(); });
        return makePlaneTexture(cv);
    }

    // One horizontal lifting-surface panel (half a wing or stabilizer). root = leading edge of the
    // root section; side +1/-1 mirrors it. grooves { hinge, seps } paints flap/aileron panel lines.
    function wingPanel(o) {
        const tanS = Math.tan((o.sweepDeg || 0) * Math.PI / 180), tanD = Math.tan((o.dihedralDeg || 0) * Math.PI / 180);
        const segs = o.segs || 3, sections = [];
        for (let s = 0; s <= segs; s++) {
            const f = s / segs, dist = o.halfSpan * f, chord = o.rootChord + (o.tipChord - o.rootChord) * f;
            sections.push(airfoilLoop(chord, o.thick || 0.10).map(([cw, th]) => new THREE.Vector3(
                o.root.x + o.side * dist,
                o.root.y + tanD * dist + th,
                o.root.z + tanS * dist + cw
            )));
        }
        const mat = o.grooves
            ? new THREE.MeshPhongMaterial({ map: grooveTexture(o.grooves.hinge, o.grooves.seps, o.grooves.base, o.grooves.line), shininess: 45, side: THREE.DoubleSide })
            : o.mat;
        return new THREE.Mesh(loftGeometry(sections), mat);
    }

    // Vertical surface (fin/winglet) built at the origin, leading edge of the base at (0,0,0),
    // span along +Y; the caller positions and cants the mesh.
    function finPanel(o) {
        const tanS = Math.tan((o.sweepDeg || 0) * Math.PI / 180);
        const segs = o.segs || 3, sections = [];
        for (let s = 0; s <= segs; s++) {
            const f = s / segs, h = o.height * f, chord = o.rootChord + (o.tipChord - o.rootChord) * f;
            sections.push(airfoilLoop(chord, o.thick || 0.09).map(([cw, th]) => new THREE.Vector3(th, h, tanS * h + cw)));
        }
        return new THREE.Mesh(loftGeometry(sections, { foldV: !!o.foldV }), o.mat);
    }

    // Body of revolution along Z from stations [{ z, r, y }], y = centerline offset (nose droop /
    // tail upsweep). uv.y is remapped to the z fraction so textures paint in station space.
    function bodyLathe(stations, mat, radial, phiStart, phiLength) {
        const pts = stations.map(s => new THREE.Vector2(Math.max(0.008, s.r), s.z));
        const geo = new THREE.LatheGeometry(pts, radial || 24, phiStart || 0, phiLength || Math.PI * 2);
        geo.rotateX(Math.PI / 2);
        const pos = geo.attributes.position, uv = geo.attributes.uv;
        const z0 = stations[0].z, z1 = stations[stations.length - 1].z;
        for (let i = 0; i < pos.count; i++) {
            const j = Math.round(uv.getY(i) * (stations.length - 1));
            pos.setY(i, pos.getY(i) + (stations[j].y || 0));
            uv.setY(i, (pos.getZ(i) - z0) / (z1 - z0));
        }
        geo.computeVertexNormals();
        return new THREE.Mesh(geo, mat);
    }

    // Four-blade propeller facing -Z: spinner cone, pitched paddle blades, and a faint spin disc.
    // The render loop spins everything in planeSpinners3D about Z.
    function buildProp(o, mats) {
        const grp = new THREE.Group();
        const spinner = new THREE.Mesh(new THREE.ConeGeometry(o.spinnerR, o.spinnerLen, 16), o.spinnerMat || mats.metal);
        spinner.rotation.x = -Math.PI / 2; spinner.position.z = -o.spinnerLen / 2;
        grp.add(spinner);
        // black paddle blades with the red/white/blue tip bands NOAA's props carry
        const bandMats = ['#d23b2f', '#f2f5f7', '#1b4a94'].map(c => new THREE.MeshPhongMaterial({ color: c, shininess: 30 }));
        for (let i = 0; i < 4; i++) {
            const blade = new THREE.Mesh(new THREE.BoxGeometry(o.bladeW, o.bladeLen, 0.012), mats.prop);
            blade.position.y = o.spinnerR * 0.4 + o.bladeLen / 2;
            blade.rotation.y = 0.5;
            const bandH = o.bladeLen * 0.055;
            bandMats.forEach((bm, bi) => {
                const band = new THREE.Mesh(new THREE.BoxGeometry(o.bladeW + 0.003, bandH, 0.014), bm);
                band.position.y = o.bladeLen / 2 - bandH / 2 - bi * bandH;
                blade.add(band);
            });
            const holder = new THREE.Group(); holder.add(blade); holder.rotation.z = i * Math.PI / 2 + 0.3;
            grp.add(holder);
        }
        const disc = new THREE.Mesh(
            new THREE.CircleGeometry(o.spinnerR * 0.4 + o.bladeLen + 0.01, 28),
            new THREE.MeshBasicMaterial({ color: 0x30343a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
        grp.add(disc);
        return grp;
    }

    // ---------------------------------------------------------------------------------------
    // Livery textures (canvas painted, so the whole app stays asset-free)

    function makePlaneTexture(cv) {
        const tex = new THREE.CanvasTexture(cv);
        tex.flipY = false;   // canvas row 0 = v 0, so texture v tracks the painted station fraction directly
        if (typeof renderer3D !== 'undefined' && renderer3D && renderer3D.capabilities) tex.anisotropy = renderer3D.capabilities.getMaxAnisotropy();
        return tex;
    }

    // Piecewise-smoothstep height curve through [z, u] anchors, clamped at the ends; the u
    // building block for livery sweeps that rise, dive, or wrap along the hull.
    function liveryCurve(z, pts) {
        if (z <= pts[0][0]) return pts[0][1];
        for (let i = 0; i < pts.length - 1; i++) {
            const z0 = pts[i][0], u0 = pts[i][1], z1 = pts[i + 1][0], u1 = pts[i + 1][1];
            if (z <= z1) { const t = (z - z0) / (z1 - z0); return u0 + (u1 - u0) * t * t * (3 - 2 * t); }
        }
        return pts[pts.length - 1][1];
    }

    // Fill the hull region between two height curves over z0..z1, mirrored onto both sides
    // across the belly seam (u and 1-u). A bottom curve that reaches 0 makes the two sides
    // meet at the seam, wrapping the paint under the belly. shift2 slides the mirrored (port)
    // side's curves aft by that many z-units, so a sweep crosses the crown asymmetrically and
    // reads as one band wrapping over the top instead of two mirrored halves meeting in a V.
    function paintSweep(g, W, H, vOf, z0, z1, topU, botU, color, shift2) {
        const N = 72;
        const dzf = typeof shift2 === 'function' ? shift2 : (() => shift2 || 0);
        [u => u, u => 1 - u].forEach((m, mi) => {
            g.fillStyle = color; g.beginPath();
            for (let i = 0; i <= N; i++) { const z = z0 + (z1 - z0) * i / N; const dz = mi ? dzf(z) : 0; const x = W * m(topU(z - dz, mi)), y = vOf(z) * H; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
            for (let i = N; i >= 0; i--) { const z = z0 + (z1 - z0) * i / N; const dz = mi ? dzf(z) : 0; g.lineTo(W * m(botU(z - dz, mi)), vOf(z) * H); }
            g.closePath(); g.fill();
        });
    }

    // Pinstripe following a height curve over z0..z1, on both sides; shift2 as in paintSweep.
    // Curve functions receive (z, mirrorIndex), so a livery can shape the two sides differently.
    function strokeSweep(g, W, H, vOf, z0, z1, uOf, color, lw, shift2) {
        const N = 72;
        const dzf = typeof shift2 === 'function' ? shift2 : (() => shift2 || 0);
        g.strokeStyle = color; g.lineWidth = lw;
        [u => u, u => 1 - u].forEach((m, mi) => {
            g.beginPath();
            for (let i = 0; i <= N; i++) { const z = z0 + (z1 - z0) * i / N; const dz = mi ? dzf(z) : 0; const x = W * m(uOf(z - dz, mi)), y = vOf(z) * H; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
            g.stroke();
        });
    }

    // Registration or title text on both hull sides at height band u (right side; left mirrors to
    // 1-u), each side through its own reflection so the letters run nose-to-tail and stay upright.
    function paintHullTextPair(g, W, H, u, y, text, color, px, hs) {
        hs = hs || 1;   // letter-height stretch around the hull, so narrow tail sections don't squeeze the glyphs
        g.fillStyle = color; g.font = 'bold ' + px + 'px sans-serif'; g.textBaseline = 'middle';
        [[u, -1, 1, 'right'], [1 - u, 1, -1, 'left']].forEach(([uu, sx, sy, align]) => {
            g.save(); g.translate(W * uu, y);
            g.rotate(Math.PI / 2); g.scale(sx, sy * hs); g.textAlign = align;
            g.fillText(text, 0, 0); g.restore();
        });
    }

    // Fuselage hull texture. spec: { len, z0, antiGlareZ (aft end of the black nose-crown wedge,
    // or null), paintLivery(g, vOf) (plane-specific bands/sweeps, painted over the white base),
    // windows [{ z, drop }] + windowStyle 'oval'|'circle' (drop lowers a window, the overwing
    // emergency exit), tailWrap { zTop, slope } (navy tail paint sweeping down over the aft
    // fuselage), reg { text, z, u, color } (registration on both hull sides),
    // emblem { z, side, r } (NOAA emblem roundel on the one side the livery carries it) }
    function fuselageTexture(spec) {
        const W = 512, H = 1024;
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        const g = cv.getContext('2d');
        const vOf = z => (z - spec.z0) / spec.len;
        g.fillStyle = NOAA_LIV.white; g.fillRect(0, 0, W, H);
        if (spec.paintLivery) spec.paintLivery(g, vOf);
        // navy tail paint flowing off the fin down over the aft fuselage: highest at the crown,
        // sloping aft as it wraps down the sides toward the belly
        if (spec.tailWrap) {
            const wrapZ = u => spec.tailWrap.zTop + Math.pow(Math.abs(u - 0.5) * 2, 1.5) * spec.tailWrap.slope * 0.5;
            g.fillStyle = NOAA_LIV.navy;
            g.beginPath(); g.moveTo(0, H);
            for (let i = 0; i <= 64; i++) { const u = i / 64; g.lineTo(W * u, vOf(wrapZ(u)) * H); }
            g.lineTo(W, H); g.closePath(); g.fill();
            g.strokeStyle = NOAA_LIV.sky; g.lineWidth = 4;
            g.beginPath();
            for (let i = 0; i <= 64; i++) { const u = i / 64; g[i ? 'lineTo' : 'moveTo'](W * u, vOf(wrapZ(u) - 0.05) * H); }
            g.stroke();
        }
        // black anti-glare panel: only the middle of the nose crown, flowing out of the radome
        // and tapering aft toward the windshield base; the nose cheeks stay white. The visor
        // band (addWindshieldBand) is the windshield itself, nothing else is painted up there.
        if (spec.antiGlareZ != null) {
            g.fillStyle = NOAA_LIV.black;
            g.beginPath();
            g.moveTo(W * 0.38, 0); g.lineTo(W * 0.62, 0);
            g.lineTo(W * 0.555, vOf(spec.antiGlareZ) * H); g.lineTo(W * 0.445, vOf(spec.antiGlareZ) * H);
            g.closePath(); g.fill();
        }
        // cabin windows on both sides, just above the side line; a drop entry sits lower on the
        // hull (toward the belly seam at u 0/1), the overwing emergency exit
        g.fillStyle = NOAA_LIV.black;
        (spec.windows || []).forEach(w => {
            const y = vOf(w.z) * H, du = w.drop ? 0.018 : 0;
            // u 0.285 is the starboard (right) side, 0.715 the port (left); w.side paints one side only
            // (e.g. the WP-3D's middle station is a regular window on the right, a bubble on the left).
            let us = [0.285 - du, 0.715 + du];
            if (w.side === 'right') us = [0.285 - du];
            else if (w.side === 'left') us = [0.715 + du];
            us.forEach(u => {
                g.beginPath();
                if (spec.windowStyle === 'circle') g.arc(W * u, y, spec.windowR || 4.5, 0, Math.PI * 2);
                else g.ellipse(W * u, y, 4.5, 7, 0, 0, Math.PI * 2);
                g.fill();
            });
        });
        // No fuselage titles (the real livery carries none): just the registration and the
        // emblem roundel wherever this airframe's livery puts them.
        if (spec.reg) paintHullTextPair(g, W, H, spec.reg.u, vOf(spec.reg.z) * H, spec.reg.text, spec.reg.color, spec.reg.px || 18, spec.reg.hs || 1.8);
        const tex = makePlaneTexture(cv);
        // The roundel is the official NOAA emblem (the noaa.gov digital logo, inlined below as
        // NOAA_EMBLEM_URI), on the single side the real livery carries it, drawn through that
        // side's orientation transform so it sits upright; the texture refreshes when it decodes.
        if (spec.emblem) {
            noaaEmblemImage().then(logo => {
                if (!logo) return;
                const r = spec.emblem.r || 22;
                // height on the hull as the right-side u (the left side mirrors it); defaults to
                // a touch crown-ward of the window line, riding above the cheatline
                const u0 = spec.emblem.u != null ? spec.emblem.u : 0.300;
                const xf = spec.emblem.side === 'left' ? [1 - u0, 1, -1] : [u0, -1, 1];
                g.save(); g.translate(W * xf[0], vOf(spec.emblem.z) * H);
                g.rotate(Math.PI / 2); g.scale(xf[1], xf[2]);
                g.drawImage(logo, -r, -r, r * 2, r * 2); g.restore();
                tex.needsUpdate = true;
            });
        }
        return tex;
    }

    // The official NOAA emblem (a 160px copy of assets/noaa-emblem.png) inlined as a data URI:
    // data URIs load on file:// too, where fetch() is blocked, and never taint the canvas, so
    // the hull roundel appears no matter how the page is opened.
    const NOAA_EMBLEM_URI = 'data:image/png;base64,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';
    let noaaEmblemPromise = null;
    function noaaEmblemImage() {
        if (!noaaEmblemPromise) noaaEmblemPromise = new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = NOAA_EMBLEM_URI;
        });
        return noaaEmblemPromise;
    }

    // Fin decal texture: navy field, leading-edge sky stripe, the rudder hinge line, and the
    // white NOAA bird (the exact assets/noaa-bird.svg silhouette, drawn as a path). Canvas x =
    // height fraction (root to tip), y = the loft's loop fraction: the +X face maps to y [0, H/2]
    // (LE to TE) and the -X face to y [H, H/2], so each face is painted separately, with a
    // y-shear leaning the decal forward against the fin's sweep. bird overrides the decal span
    // ({ x0, xs } height base/extent, { c0, cs } chordwise): canvas space is height x chord
    // normalized, so a short-chord fin like the G-IV's needs a smaller height extent to keep
    // the bird's proportions; the WP-3D's long-chord fin takes the full root-to-tip default.
    function finTexture(rudderT, bird) {
        bird = bird || {};
        const bx0 = bird.x0 != null ? bird.x0 : 0.05, bxs = bird.xs != null ? bird.xs : 1.04;
        const bc0 = bird.c0 != null ? bird.c0 : 0.26, bcs = bird.cs != null ? bird.cs : 0.66;
        const W = 512, H = 512;
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        const g = cv.getContext('2d');
        g.fillStyle = NOAA_LIV.navy; g.fillRect(0, 0, W, H);
        g.strokeStyle = NOAA_LIV.sky; g.lineWidth = 10;
        g.beginPath(); g.moveTo(W * 0.04, 0); g.lineTo(W * 0.04, H); g.stroke();
        if (rudderT != null) {
            g.strokeStyle = '#12336b'; g.lineWidth = 4;
            [loopV(rudderT, true), loopV(rudderT, false)].forEach(v => {
                g.beginPath(); g.moveTo(0, v * H); g.lineTo(W, v * H); g.stroke();
            });
        }
        [{ cy: c => c * H * 0.5 }, { cy: c => H - c * H * 0.5 }].forEach(f => {
            const B = (x, y) => [W * (bx0 + y * bxs), f.cy(bc0 + x * bcs - y * 0.22)];
            const bez = (x1, y1, x2, y2, x3, y3) => { const a = B(x1, y1), b = B(x2, y2), c = B(x3, y3); g.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]); };
            const lin = (x, y) => { const p = B(x, y); g.lineTo(p[0], p[1]); };
            // assets/noaa-bird.svg normalized to (x right, y up); keep the two in step
            g.fillStyle = '#ffffff';
            g.beginPath();
            const s = B(0.033, 0.876); g.moveTo(s[0], s[1]);
            bez(0.192, 0.750, 0.384, 0.476, 0.529, 0.281);
            bez(0.576, 0.250, 0.610, 0.255, 0.651, 0.286);
            bez(0.715, 0.362, 0.814, 0.583, 0.866, 0.750);
            bez(0.886, 0.805, 0.905, 0.838, 0.921, 0.867);
            bez(0.907, 0.643, 0.858, 0.417, 0.773, 0.286);
            bez(0.758, 0.267, 0.742, 0.255, 0.726, 0.248);
            bez(0.740, 0.248, 0.756, 0.229, 0.770, 0.195);
            lin(0.684, 0.162);
            bez(0.653, 0.095, 0.614, 0.062, 0.584, 0.062);
            lin(0.529, 0.007);
            lin(0.520, 0.114);
            bez(0.372, 0.162, 0.195, 0.457, 0.093, 0.733);
            bez(0.067, 0.800, 0.047, 0.848, 0.033, 0.876);
            g.closePath(); g.fill();
        });
        return makePlaneTexture(cv);
    }

    // Tiny US flag texture for the fin-tip decal quads (stripes horizontal, canton upper left).
    // Plain quads use the standard flipY texture convention, unlike the hull's station-mapped
    // textures, so this one is NOT built through makePlaneTexture.
    function usFlagTexture() {
        const cv = document.createElement('canvas'); cv.width = 66; cv.height = 40;
        const g = cv.getContext('2d');
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, 66, 40);
        g.fillStyle = '#b22234';
        for (let s = 0; s < 4; s++) g.fillRect(0, s * 2 * 40 / 7, 66, 40 / 7);
        g.fillStyle = '#3c3b6e'; g.fillRect(0, 0, 28, 20);
        const tex = new THREE.CanvasTexture(cv);
        if (typeof renderer3D !== 'undefined' && renderer3D && renderer3D.capabilities) tex.anisotropy = renderer3D.capabilities.getMaxAnisotropy();
        return tex;
    }

    // A flat flag quad on each side of the fin near its tip; screen-aligned rectangles, so the
    // fin's sweep cannot shear the stripes.
    function addFinFlags(grp, pos) {
        const mat = new THREE.MeshBasicMaterial({ map: usFlagTexture(), side: THREE.DoubleSide });
        [1, -1].forEach(side => {
            const quad = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.09), mat);
            quad.rotation.y = side * Math.PI / 2;
            quad.position.set(side * pos.halfThick, pos.y, pos.z);
            grp.add(quad);
        });
    }

    // Framed windshield glass: dark glazing with a subtle sheen, white frame, white posts
    // dividing the panes; u runs across the wraparound arc, v up the glass (v=1 is the crown
    // edge). eyebrows reserves a white roof strip above the glass carrying the two small corner
    // panes the WP-3D flight deck has.
    function windshieldTexture(posts, eyebrows, gulfPanes) {
        const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
        const g = cv.getContext('2d');
        g.fillStyle = '#e8ecef'; g.fillRect(0, 0, 256, 128);
        const grad = g.createLinearGradient(0, 0, 0, 110);
        grad.addColorStop(0, 'rgba(140,170,200,0.28)'); grad.addColorStop(0.55, 'rgba(140,170,200,0.06)'); grad.addColorStop(1, 'rgba(140,170,200,0.18)');
        if (gulfPanes) {
            // the Gulfstream windshield, drawn to the head-on photo: four equal-height panes
            // leaning into a strong vertical center post (each wider at its base), the end
            // pair swept back with a rounded upper-outboard corner, all set in thick white
            // frame. Canvas y runs up the visor, so pane tops sit at the larger y. A darker
            // trim line runs along the band's base so the visor-to-nose edge reads defined,
            // like the WP-3D's brow.
            const glass = path => { path(); g.fillStyle = '#10151b'; g.fill(); path(); g.fillStyle = grad; g.fill(); };
            // left end pane (outboard edge swept, rounded upper-outboard corner)
            glass(() => { g.beginPath(); g.moveTo(60, 8); g.lineTo(60, 70); g.lineTo(42, 70); g.quadraticCurveTo(30, 70, 33, 56); g.lineTo(16, 8); g.closePath(); });
            // center pair, straight against the center post, outboard edges leaning in
            glass(() => { g.beginPath(); g.moveTo(124, 8); g.lineTo(124, 70); g.lineTo(86, 70); g.lineTo(72, 8); g.closePath(); });
            glass(() => { g.beginPath(); g.moveTo(132, 8); g.lineTo(132, 70); g.lineTo(170, 70); g.lineTo(184, 8); g.closePath(); });
            // right end pane, mirror of the left
            glass(() => { g.beginPath(); g.moveTo(196, 8); g.lineTo(196, 70); g.lineTo(214, 70); g.quadraticCurveTo(226, 70, 223, 56); g.lineTo(240, 8); g.closePath(); });
            g.fillStyle = '#aeb9c2'; g.fillRect(0, 0, 256, 5);
            return makePlaneTexture(cv);
        }
        const glassTop = eyebrows ? 92 : 108;   // a real white roof frame; eyebrows widens it for the corner panes
        g.fillStyle = '#10151b'; g.fillRect(3, 3, 250, glassTop - 3);
        g.fillStyle = grad; g.fillRect(3, 3, 250, glassTop - 3);
        g.strokeStyle = '#e8ecef'; g.lineWidth = 6;
        posts.forEach(u => { g.beginPath(); g.moveTo(256 * u, 0); g.lineTo(256 * u, glassTop); g.stroke(); });
        if (eyebrows) {
            // Two eyebrow windows above the main glass, shaped to the WP-3D flight deck (1st.jpg):
            // a right-triangle-ish quad (four sides) tall on the OUTBOARD edge with a 90-degree
            // corner at its base, the top sloping down toward the center, tilted a few degrees.
            // Each pane sits near its own outboard edge of the windshield (not toward the middle),
            // and the two mirror each other so both lean outboard.
            const eyebrow = (cx, mirror) => {
                g.save();
                g.translate(cx, glassTop + 21);
                g.rotate(-0.16);             // lean the thick aft base up toward the roof
                if (mirror) g.scale(-1, 1);
                // Texture v (canvas y) runs FORWARD (top) → AFT (bottom) with flipY off, so a wedge
                // that's a narrow point at the top and a wide base at the bottom is thin forward and
                // thick aft; the tilt swings that thick base toward the roof. Large, but each pane
                // stays over its own side (outboard) window, not spanning toward the middle.
                const w = 30, h = 20;
                g.beginPath();
                g.moveTo(-6, -h);            // forward edge, narrow (inboard)
                g.lineTo(6, -h);             // forward edge, narrow (outboard)
                g.lineTo(w, h);              // aft-outboard corner (thick base)
                g.lineTo(-w, h);             // aft-inboard corner (thick base, toward the roof)
                g.closePath();
                g.fillStyle = '#10151b'; g.fill();
                g.restore();
            };
            eyebrow(210, false);   // starboard, above the starboard side window
            eyebrow(46, true);     // port, above the port side window
        }
        return makePlaneTexture(cv);
    }

    // Wraparound cockpit windshield: a partial-arc lathe band centered on the crown, riding the
    // forehead stations a skin's thickness proud of the hull so the glass follows the nose
    // curvature exactly. stations = hull forehead stations with the outward offset already
    // applied; arc = half-angle of the wrap; posts = frame-post positions across the glass.
    function addWindshieldBand(grp, stations, arc, posts, eyebrows, gulfPanes) {
        const mat = new THREE.MeshPhongMaterial({ map: windshieldTexture(posts, eyebrows, gulfPanes), shininess: 90, side: THREE.DoubleSide });
        grp.add(bodyLathe(stations, mat, 24, Math.PI - arc, arc * 2));
    }

    function planeMats(fuselageTex, finTex) {
        return {
            hull: new THREE.MeshPhongMaterial({ map: fuselageTex, shininess: 55 }),
            fin: new THREE.MeshPhongMaterial({ map: finTex, shininess: 45, side: THREE.DoubleSide }),
            white: new THREE.MeshPhongMaterial({ color: NOAA_LIV.white, shininess: 45, side: THREE.DoubleSide }),
            navy: new THREE.MeshPhongMaterial({ color: NOAA_LIV.navy, shininess: 40, side: THREE.DoubleSide }),
            black: new THREE.MeshPhongMaterial({ color: NOAA_LIV.black, shininess: 25 }),
            dark: new THREE.MeshPhongMaterial({ color: NOAA_LIV.dark, shininess: 20 }),
            metal: new THREE.MeshPhongMaterial({ color: NOAA_LIV.metal, shininess: 80 }),
            prop: new THREE.MeshPhongMaterial({ color: NOAA_LIV.prop, shininess: 30 })
        };
    }

    // Thin blade antennas along the spine, a small recognizable AOC detail.
    function addAntennas(grp, mat, spots) {
        spots.forEach(([z, y, up]) => {
            const a = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.038, 0.055), mat);
            a.position.set(0, y + (up ? 0.012 : -0.012), z);
            grp.add(a);
        });
    }

    // ---------------------------------------------------------------------------------------
    // WP-3D Orion (NOAA42/NOAA43): four turboprops, black nose radome, chin + belly radomes,
    // tall fin with dorsal fillet, and the tail Doppler radar boom.
    function buildP3Model(reg) {
        const grp = new THREE.Group();
        // Livery: white hull and belly aft; the navy flank band runs below the window line and
        // keeps going forward into the nose, wrapping down under it so the nose underbelly is
        // navy against the black radome, with the sky pinstripe riding the band's upper edge
        // the whole way. Aft it flows into the all-navy tail.
        // The texture's z frame MUST match the hull lathe's station span (-2.30..2.45), because
        // bodyLathe maps texture v to the lathe's own z fraction; a nominal frame here shifts
        // every painted feature away from the 3D meshes (bubbles, radome) it must line up with.
        const tex = fuselageTexture({
            len: 4.75, z0: -2.30, antiGlareZ: -2.08,
            paintLivery: (g, vOf) => {
                // the top edge descends in one continuous slope all the way forward, meeting the
                // underbelly right before the radome; no flat run along the nose
                const top = z => liveryCurve(z, [[-2.28, 0.015], [-1.341, 0.250]]);
                const bot = z => liveryCurve(z, [[-1.843, 0], [-1.341, 0.187]]);
                paintSweep(g, 512, 1024, vOf, -2.32, 1.765, top, bot, NOAA_LIV.navy);
                strokeSweep(g, 512, 1024, vOf, -2.32, 1.765, z => top(z) + 0.0155, NOAA_LIV.sky, 6.5);
            },
            windows: [{ z: -0.747 }, { z: -0.336, drop: true }, { z: 0.075 }, { z: 0.440 }, { z: -1.25, side: 'right' }],
            windowStyle: 'oval',
            tailWrap: { zTop: 1.372, slope: 1.37 },
            reg: { text: reg, z: 1.683, u: 0.235, color: '#ffffff', px: 14 },
            // centered in the TRUE midpoint of the two forward bubble meshes (-1.55/-1.25),
            // sized well under their 0.236 gap so clear white shows on both sides
            emblem: { z: -1.40, side: 'left', r: 16 }
        });
        const mats = planeMats(tex, finTexture(0.68, { x0: 0.15, xs: 0.72, c0: 0.24, cs: 0.92 }));

        // hull starts behind the radome; the crown climbs steeply between -2.06 and -1.90 (the
        // forehead face) with the windshield band riding that slope, and the aft body funnels
        // down to a third of the fuselage thickness where the tail Doppler radar takes over
        grp.add(bodyLathe([
            { z: -2.30, r: 0.150, y: -0.030 }, { z: -2.18, r: 0.178, y: -0.020 }, { z: -2.06, r: 0.213, y: -0.009 },
            { z: -2.01, r: 0.239, y: -0.002 }, { z: -1.95, r: 0.246, y: 0 }, { z: -1.55, r: 0.25, y: 0 }, { z: -0.60, r: 0.25, y: 0 },
            { z: 0.60, r: 0.25, y: 0 }, { z: 1.20, r: 0.22, y: 0.02 }, { z: 1.80, r: 0.16, y: 0.07 },
            { z: 2.20, r: 0.115, y: 0.105 }, { z: 2.45, r: 0.086, y: 0.125 }
        ], mats.hull, 48));

        // glossy black radome: a SHORT, rounded nose bulb (not a long Concorde point), its base
        // radius matching the hull's front station so the paint just changes color at the seam, and
        // it blunts to a rounded tip close ahead of the windshield
        const radomeMat = new THREE.MeshPhongMaterial({ color: 0x121417, shininess: 95 });
        grp.add(bodyLathe([
            { z: -2.45, r: 0.058, y: -0.052 }, { z: -2.41, r: 0.100, y: -0.046 }, { z: -2.36, r: 0.129, y: -0.039 },
            { z: -2.31, r: 0.145, y: -0.033 }, { z: -2.27, r: 0.150, y: -0.030 }
        ], radomeMat, 32));
        // the lathe is an open surface, so a rounded cap closes the blunt radome tip
        const radomeTip = new THREE.Mesh(new THREE.SphereGeometry(0.058, 14, 12), radomeMat);
        radomeTip.position.set(0, -0.052, -2.45); grp.add(radomeTip);

        // wraparound windshield glass standing near-vertically on the steep forehead (a real
        // P-3 windshield is upright with only a slight rake), with the two corner roof panes
        // eyebrows arg is false: the small corner eyebrow windows are omitted for now (they read
        // worse than without at this scale); the eyebrow-drawing branch in windshieldTexture stays
        // for a future pass.
        addWindshieldBand(grp, [
            { z: -2.065, r: 0.209, y: -0.011 }, { z: -2.02, r: 0.245, y: -0.003 }, { z: -1.96, r: 0.254, y: 0.001 }
        ], 0.62, [0.31, 0.5, 0.69], false);

        // instrumented nose boom (gust probe): finely candy-striped, exiting from the SIDE of
        // the nose (the radome's starboard flank) with a touch of up-tilt
        const boomGrp = new THREE.Group();
        boomGrp.position.set(0.10, -0.035, -2.34); boomGrp.rotation.x = 0.05;
        const boomRed = new THREE.MeshPhongMaterial({ color: 0xd23b2f, shininess: 40 });
        const boomSegs = 14, boomLen = 0.60, segLen = boomLen / boomSegs;
        for (let bi = 0; bi < boomSegs; bi++) {
            const f0 = bi / boomSegs, f1 = (bi + 1) / boomSegs;
            const seg = new THREE.Mesh(
                new THREE.CylinderGeometry(0.009 + 0.005 * (1 - f1), 0.009 + 0.005 * (1 - f0), segLen, 10),
                bi % 2 ? mats.white : boomRed);
            seg.rotation.x = Math.PI / 2;
            seg.position.set(0, 0, -(bi + 0.5) * segLen);
            boomGrp.add(seg);
        }
        grp.add(boomGrp);

        // wings, low mounted with slight sweep and dihedral; flap/aileron grooves on both faces
        const wing = { rootChord: 0.68, tipChord: 0.30, halfSpan: 2.22, sweepDeg: 5, dihedralDeg: 5.5, thick: 0.11, mat: mats.white, root: { x: 0, y: -0.17, z: -0.55 }, grooves: { hinge: 0.72, seps: [0.13, 0.59, 0.97] } };
        grp.add(wingPanel({ ...wing, side: 1 }));
        grp.add(wingPanel({ ...wing, side: -1 }));

        // horizontal stabilizers, navy like the rest of the WP-3D tail, with the elevator groove
        const htail = { rootChord: 0.50, tipChord: 0.22, halfSpan: 0.80, sweepDeg: 8, dihedralDeg: 0, thick: 0.09, mat: mats.white, root: { x: 0, y: 0.12, z: 2.02 }, grooves: { hinge: 0.65, seps: [0.13, 0.97], base: NOAA_LIV.navy, line: '#12336b' } };
        grp.add(wingPanel({ ...htail, side: 1 }));
        grp.add(wingPanel({ ...htail, side: -1 }));

        // fin with the bird decal; a long root chord plus the dorsal fillet slope the tail down
        // into the fuselage instead of standing off it
        const fin = finPanel({ height: 0.88, rootChord: 1.02, tipChord: 0.34, sweepDeg: 35, thick: 0.07, mat: mats.fin });
        fin.position.set(0, 0.14, 1.55); grp.add(fin);
        // flag ahead of the rudder hinge line, so the rudder groove never cuts through it
        addFinFlags(grp, { halfThick: 0.033, y: 0.86, z: 2.19 });
        // Dorsal fillet: a tall spine fairing whose trailing edge runs up the fin's leading edge and
        // OVERLAPS into the fin (TE reaches z~1.61 at the base, past the fin LE at z 1.55, and follows
        // the fin's aft sweep up to ~60% of fin height), so the two panels connect with no gap/notch
        // and the tall fin fairs continuously into the roof spine.
        const dorsal = finPanel({ height: 0.52, rootChord: 0.75, tipChord: 0.06, sweepDeg: 64, thick: 0.055, mat: mats.navy });
        dorsal.position.set(0, 0.15, 0.86); grp.add(dorsal);

        // tail Doppler radar: a stub a third of the fuselage's thickness that the funneled aft
        // body flows straight into; navy like the rest of the WP-3D tail
        const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.076, 0.085, 0.42, 18), mats.navy);
        boom.rotation.x = Math.PI / 2; boom.position.set(0, 0.128, 2.66); grp.add(boom);
        const boomCap = new THREE.Mesh(new THREE.SphereGeometry(0.076, 14, 12), mats.navy);
        boomCap.position.set(0, 0.128, 2.87); grp.add(boomCap);

        // the MMR: the big circular black radar disk on the FORWARD underbelly, well forward toward
        // the nose (between the wing and the navy nose wrap); it hangs proud below the belly so the
        // dome reads clear of the hull rather than half-sunk into it
        const belly = new THREE.Mesh(new THREE.SphereGeometry(1, 30, 20), radomeMat);
        belly.scale.set(0.23, 0.075, 0.30); belly.position.set(0, -0.30, -1.5); grp.add(belly);

        // four turboprops: nacelles hang forward of and below the wing, inners longer (gear bays)
        [[0.55, 1.0], [1.08, 0.78]].forEach(([xs, lenF]) => {
            [1, -1].forEach(side => {
                const x = xs * side, wingY = -0.17 + Math.tan(5.5 * Math.PI / 180) * xs;
                const nac = bodyLathe([
                    { z: 0, r: 0.068 }, { z: 0.05, r: 0.095 }, { z: 0.42, r: 0.10 },
                    { z: 0.42 + 0.30 * lenF, r: 0.078 }, { z: 0.42 + 0.53 * lenF, r: 0.028 }
                ], mats.white, 20);
                nac.position.set(x, wingY - 0.03, -0.98);
                grp.add(nac);
                const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.035, 0.16), mats.dark);
                scoop.position.set(x, wingY + 0.075, -0.86); grp.add(scoop);
                // raised exhaust fairing running aft from each nacelle over the wing's upper
                // surface to the trailing edge, ending in the dark turbine outlet
                const fairLen = xs < 1 ? 0.24 : 0.20, fairZ = xs < 1 ? -0.10 : -0.16;
                const fairY = wingY + (xs < 1 ? 0.062 : 0.052);
                const fair = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mats.white);
                fair.scale.set(0.055, 0.032, fairLen); fair.position.set(x, fairY, fairZ);
                grp.add(fair);
                const outlet = new THREE.Mesh(new THREE.CircleGeometry(0.024, 12), mats.dark);
                outlet.position.set(x, fairY + 0.004, fairZ + fairLen * 0.96);
                outlet.rotation.x = -0.35; grp.add(outlet);
                const prop = buildProp({ bladeLen: 0.26, bladeW: 0.055, spinnerR: 0.055, spinnerLen: 0.14, spinnerMat: mats.black }, mats);
                prop.position.set(x, wingY - 0.03, -1.00);
                grp.add(prop); planeSpinners3D.push(prop);
            });
        });

        // dark walkway strips over the inner wing panels
        [1, -1].forEach(side => {
            const walk = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.004, 0.42), mats.dark);
            walk.position.set(side * 0.36, -0.122, -0.22); grp.add(walk);
        });
        // red anti-collision beacon on the spine
        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 8), new THREE.MeshBasicMaterial({ color: 0xd23b2f }));
        beacon.position.set(0, 0.255, -0.15); grp.add(beacon);

        // bubble observation windows protruding from the hull sides. front (-1.55) and aft (0.95) are
        // on both sides; the middle station (-1.25) is a bubble on the PORT (left, side -1) side only,
        // and a regular cabin window on the STARBOARD (right, side 1) side (the real WP-3D asymmetry),
        // painted right-only via the { z: -1.25, side: 'right' } entry in the windows spec above.
        [[-1.55, false], [-1.25, true], [0.95, false]].forEach(([z, portOnly]) => {
            [1, -1].forEach(side => {
                if (portOnly && side === 1) return;   // side 1 is starboard (right): its middle bubble is a window instead
                const bubble = new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 10), mats.black);
                bubble.scale.set(0.55, 1, 1);
                bubble.position.set(side * 0.245, 0.055, z);
                grp.add(bubble);
            });
        });

        addAntennas(grp, mats.white, [[-1.2, 0.25, true], [-0.4, 0.25, true], [0.8, 0.24, true]]);
        return grp;
    }

    // Aft nacelle livery: navy upper half with sky pinstripes along its edges, white below; the
    // starboard nacelle carries the registration in the navy field on its outboard face.
    function nacelleTexture(regText) {
        const W = 256, H = 128;
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        const g = cv.getContext('2d');
        g.fillStyle = NOAA_LIV.white; g.fillRect(0, 0, W, H);
        g.fillStyle = NOAA_LIV.navy; g.fillRect(W * 0.25, 0, W * 0.50, H);
        g.fillStyle = NOAA_LIV.sky;
        g.fillRect(W * 0.235, 0, W * 0.018, H); g.fillRect(W * 0.747, 0, W * 0.018, H);
        if (regText) {
            g.fillStyle = '#ffffff'; g.font = 'bold 16px sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'center';
            g.save(); g.translate(W * 0.35, H * 0.45);
            g.rotate(Math.PI / 2); g.scale(-1, 1.5);
            g.fillText(regText, 0, 0); g.restore();
        }
        return makePlaneTexture(cv);
    }

    // ---------------------------------------------------------------------------------------
    // Gulfstream IV-SP (NOAA49): swept wings with winglets, twin aft nacelles, T-tail, and the
    // tail Doppler radar tube out the tail cone.
    function buildGIVModel(reg) {
        const grp = new THREE.Group();
        // Livery: one navy sweep, drawn to the N49RF photos. Aft, the navy sits well above the
        // tail radar (the tail cone is white at the TDR's level); going forward the sweep
        // narrows into a THIN band diving diagonally across the side at about the fifth window,
        // then runs forward as the navy underbelly, ending where the two sides' diagonals
        // CONVERGE under the belly still at thickness (a blunt rounded stop under the flight
        // deck, not a hairline pinch; white under the nose). The sky stripe is bold and rides
        // the navy's upper edge the whole way. Registration is on the starboard engine
        // nacelle, not the hull.
        // The texture's z frame MUST match the hull lathe's station span (-2.06..1.98), because
        // bodyLathe maps texture v to the lathe's own z fraction; a nominal frame here shifts
        // every painted feature away from the 3D geometry it must line up with.
        const tex = fuselageTexture({
            len: 4.04, z0: -2.06, antiGlareZ: null,
            paintLivery: (g, vOf) => {
                // the belly stripe holds full thickness to its forward end, then drops to the
                // seam over a very short run: two solid thick bands meeting bluntly, no point
                // The diagonal is a LONG thin straight slit cutting across most of the side,
                // its upper edge passing through the second window from the aft; at the
                // forward belly the two sides' slits come together and wrap into a beret cap
                // sitting on the LOWER PORT flank (the port side carries a rounded bulge, the
                // starboard slit dives to the seam and feeds into it). The port side also
                // samples the sweep shifted aft so the navy wraps the crown like wallpaper,
                // the shift ramping to zero toward the nose so the cap stays joined.
                const base = z => liveryCurve(z, [[-1.82, 0.005], [-1.42, 0.09], [-0.62, 0.285], [0.50, 0.50]]);
                const cap = z => liveryCurve(z, [[-1.92, 0.01], [-1.66, 0.14], [-1.38, 0.16], [-1.05, 0.07], [-0.85, 0]]);
                const top = (z, port) => port ? Math.max(base(z), cap(z)) : base(z);
                const bot = z => liveryCurve(z, [[-1.38, 0], [-1.10, 0.045], [-0.66, 0.20], [0.35, 0.355], [0.90, 0.31], [1.773, 0.32]]);
                const wrapShift = z => { const t = Math.max(0, Math.min(1, (z + 0.9) / 1.0)); return 0.28 * t * t * (3 - 2 * t); };
                paintSweep(g, 512, 1024, vOf, -1.94, 1.98, top, bot, NOAA_LIV.navy, wrapShift);
                strokeSweep(g, 512, 1024, vOf, -1.92, 1.698, (z, mi) => Math.min(top(z, mi) + 0.009, 0.492), NOAA_LIV.sky, 9, wrapShift);
            },
            windows: [{ z: -1.266 }, { z: -1.050 }, { z: -0.833 }, { z: -0.617 }, { z: -0.400 }, { z: -0.184 }],
            windowStyle: 'circle', windowR: 6,
            emblem: { z: -1.407, side: 'right', r: 22, u: 0.325 }
        });
        const mats = planeMats(tex, finTexture(0.66, { x0: 0.18, xs: 0.62, c0: 0.22, cs: 1.0 }));

        // nose tapers to a ROUNDED POINT (a small cap, not the WP-3D's radome bulb and not a
        // blunt blob) and runs a plateau; the forehead then rises abruptly so the windshield
        // stands up as a real visor, more raked than the WP-3D's but not lying along the nose
        grp.add(bodyLathe([
            { z: -2.06, r: 0.018, y: -0.052 }, { z: -2.00, r: 0.052, y: -0.050 }, { z: -1.94, r: 0.080, y: -0.047 },
            { z: -1.88, r: 0.098, y: -0.0445 }, { z: -1.82, r: 0.110, y: -0.0415 }, { z: -1.76, r: 0.116, y: -0.038 },
            { z: -1.74, r: 0.118, y: -0.037 },
            { z: -1.64, r: 0.153, y: -0.017 },
            { z: -1.55, r: 0.176, y: -0.007 }, { z: -1.40, r: 0.186, y: -0.001 },
            { z: -1.20, r: 0.190, y: 0 }, { z: 0.65, r: 0.19, y: 0 },
            { z: 1.25, r: 0.155, y: 0.03 }, { z: 1.70, r: 0.10, y: 0.068 }, { z: 1.98, r: 0.066, y: 0.086 }
        ], mats.hull, 48));
        // rounded cap closing the point
        const noseTip = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 10), mats.white);
        noseTip.position.set(0, -0.052, -2.06); grp.add(noseTip);

        // wraparound windshield riding the forehead rise, kept SHORT vertically and a touch
        // prouder of the skin at its base so it reads as a defined brow over the nose, like
        // the WP-3D's (the gulfPanes texture carries the pane shapes); the band's aft station
        // settles back flush with the hull, so the glass fairs smoothly into the fuselage
        // instead of ending on a ledge
        addWindshieldBand(grp, [
            { z: -1.74, r: 0.128, y: -0.036 }, { z: -1.66, r: 0.157, y: -0.020 },
            { z: -1.585, r: 0.178, y: -0.009 }, { z: -1.50, r: 0.1815, y: -0.004 }
        ], 0.80, null, false, true);

        // swept wings + winglets, flap/aileron grooves on both faces
        const wing = { rootChord: 0.74, tipChord: 0.19, halfSpan: 1.85, sweepDeg: 30, dihedralDeg: 3, thick: 0.09, mat: mats.white, root: { x: 0, y: -0.13, z: -0.48 }, grooves: { hinge: 0.72, seps: [0.14, 0.60, 0.95] } };
        grp.add(wingPanel({ ...wing, side: 1 }));
        grp.add(wingPanel({ ...wing, side: -1 }));
        [1, -1].forEach(side => {
            const wl = finPanel({ height: 0.24, rootChord: 0.19, tipChord: 0.085, sweepDeg: 42, thick: 0.06, mat: mats.white });
            wl.position.set(side * 1.85, -0.13 + Math.tan(3 * Math.PI / 180) * 1.85, -0.48 + Math.tan(30 * Math.PI / 180) * 1.85);
            wl.rotation.z = side * -0.32;   // canted outboard
            grp.add(wl);
        });

        // wing-to-body fairing, white like the belly
        const fair = new THREE.Mesh(new THREE.SphereGeometry(1, 22, 14), mats.white);
        fair.scale.set(0.14, 0.06, 0.50); fair.position.set(0, -0.155, 0.05); grp.add(fair);

        // twin aft-fuselage nacelles on stub pylons: navy over white with the sky stripe, the
        // starboard one carrying N49RF on its outboard face
        [1, -1].forEach(side => {
            const nacMat = new THREE.MeshPhongMaterial({ map: nacelleTexture(side === 1 ? reg : null), shininess: 55 });
            const nac = bodyLathe([
                { z: 0, r: 0.062 }, { z: 0.03, r: 0.098 }, { z: 0.10, r: 0.112 },
                { z: 0.42, r: 0.115 }, { z: 0.64, r: 0.085 }, { z: 0.80, r: 0.045 }
            ], nacMat, 22);
            nac.position.set(side * 0.30, 0.05, 0.92);
            grp.add(nac);
            const inlet = new THREE.Mesh(new THREE.CircleGeometry(0.088, 22), mats.black);
            inlet.position.set(side * 0.30, 0.05, 0.925); inlet.rotation.y = Math.PI; grp.add(inlet);
            const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.28), mats.white);
            pylon.position.set(side * 0.215, 0.06, 1.24); grp.add(pylon);
        });

        // T-tail, all navy up to the tail radar: fin decal, navy bullet fairing, navy
        // stabilizers across the top with darker elevator grooves
        const fin = finPanel({ height: 0.74, rootChord: 0.62, tipChord: 0.36, sweepDeg: 38, thick: 0.07, mat: mats.fin });
        fin.position.set(0, 0.13, 1.62); grp.add(fin);
        // flag ahead of the rudder hinge line, so the rudder groove never cuts through it
        addFinFlags(grp, { halfThick: 0.031, y: 0.72, z: 2.20 });
        const finTipZ = 1.62 + Math.tan(38 * Math.PI / 180) * 0.74, finTipY = 0.13 + 0.74;
        const htail = { rootChord: 0.36, tipChord: 0.16, halfSpan: 0.68, sweepDeg: 25, dihedralDeg: 0, thick: 0.08, mat: mats.white, root: { x: 0, y: finTipY, z: finTipZ }, grooves: { hinge: 0.62, seps: [0.12, 0.94], base: NOAA_LIV.navy, line: '#12336b' } };
        grp.add(wingPanel({ ...htail, side: 1 }));
        grp.add(wingPanel({ ...htail, side: -1 }));
        const bullet = bodyLathe([{ z: -0.10, r: 0.012 }, { z: 0.02, r: 0.038 }, { z: 0.30, r: 0.036 }, { z: 0.46, r: 0.012 }], mats.navy, 14);
        bullet.position.set(0, finTipY, finTipZ - 0.04); grp.add(bullet);

        // tail Doppler radar: a stub a third of the fuselage's thickness that the funneled tail
        // cone flows into; white on the G-IV, unlike the WP-3D's navy one
        const tdr = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.065, 0.36, 16), mats.white);
        tdr.rotation.x = Math.PI / 2; tdr.position.set(0, 0.088, 2.16); grp.add(tdr);
        const tdrCap = new THREE.Mesh(new THREE.SphereGeometry(0.058, 12, 10), mats.white);
        tdrCap.position.set(0, 0.088, 2.34); grp.add(tdrCap);

        addAntennas(grp, mats.white, [[-1.1, 0.19, true], [0.2, 0.195, true]]);
        // the whole airframe shrinks toward the real G-IV's proportions against the WP-3D:
        // smaller in span and diameter, and shorter still along its length; every child
        // (wings, tail, decals, windshield) rides along
        grp.scale.set(0.92, 0.92, 0.81);
        return grp;
    }

    // ---------------------------------------------------------------------------------------

    function disposePlaneObject3D(root) {
        root.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
        });
    }

    // Build (or swap) the airframe inside planeGroup3D to match the loaded flight. No-ops when the
    // right model is already up.
    function setPlaneModel3D() {
        if (typeof planeGroup3D === 'undefined' || !planeGroup3D || typeof THREE === 'undefined') return;
        const type = (typeof isGulfstreamFlight === 'function' && isGulfstreamFlight()) ? 'giv' : 'p3';
        const reg = noaaTailReg(type);
        if (planeModelGroup3D && planeModelType3D === type && planeModelGroup3D.userData.reg === reg) return;
        if (planeModelGroup3D) { planeGroup3D.remove(planeModelGroup3D); disposePlaneObject3D(planeModelGroup3D); }
        planeSpinners3D = [];
        planeModelType3D = type;
        planeModelGroup3D = type === 'giv' ? buildGIVModel(reg) : buildP3Model(reg);
        planeModelGroup3D.userData.reg = reg;
        planeGroup3D.add(planeModelGroup3D);
        if (typeof applyPlaneScale === 'function') applyPlaneScale();   // keep real-scale (if on) after a build/swap
    }
