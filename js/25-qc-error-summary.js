/* QC Mode, error summary PDF export (qc_Error_Summary_1.1.py, semi-automated)
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   Reproduces the ES script's reportlab layout exactly: Courier text at the script's own inch
   coordinates on letter pages, the same title rule, sensor table, directory line, corrections,
   wrapped notes with its page breaks, expendables table, and the flight director block. The
   modal prefills what the tool knows (flight id, takeoff/landing times, sensor designations
   from what the refs actually rode); everything stays editable, like the script's form. */

    // ---- tiny pdf writer: base-14 fonts (Courier + Helvetica), text, lines, polylines, fills,
    // dots, clipping, portrait or landscape pages, multi page --------------------------------------
    function qcPdfDoc() {
        const pages = []; let cur = null;
        const esc = s => String(s == null ? '' : s).replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, ' ');
        const n = v => Math.round(v * 100) / 100;
        const rgb = c => c ? (n(c[0]) + ' ' + n(c[1]) + ' ' + n(c[2])) : '0 0 0';
        return {
            H: 792,
            page(landscape) { cur = { ops: [], w: landscape ? 792 : 612, h: landscape ? 612 : 792 }; pages.push(cur); return { w: cur.w, h: cur.h }; },
            text(x, y, str, size, bold) { cur.ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf 1 0 0 1 ' + n(x) + ' ' + n(y) + ' Tm (' + esc(str) + ') Tj ET'); },
            // helvetica label, optional fill color (used by the flight-track map)
            mtext(x, y, str, size, bold, color) { cur.ops.push(rgb(color) + ' rg BT /' + (bold ? 'F4' : 'F3') + ' ' + size + ' Tf 1 0 0 1 ' + n(x) + ' ' + n(y) + ' Tm (' + esc(str) + ') Tj ET 0 0 0 rg'); },
            line(x1, y1, x2, y2) { cur.ops.push('1 w ' + n(x1) + ' ' + n(y1) + ' m ' + n(x2) + ' ' + n(y2) + ' l S'); },
            poly(pts, w, color, close) { if (!pts || !pts.length) return; let s = n(w || 1) + ' w ' + rgb(color) + ' RG ' + n(pts[0][0]) + ' ' + n(pts[0][1]) + ' m '; for (let i = 1; i < pts.length; i++) s += n(pts[i][0]) + ' ' + n(pts[i][1]) + ' l '; cur.ops.push(s + (close ? 'h ' : '') + 'S 0 0 0 RG'); },
            fill(pts, color) { if (!pts || pts.length < 3) return; let s = rgb(color) + ' rg ' + n(pts[0][0]) + ' ' + n(pts[0][1]) + ' m '; for (let i = 1; i < pts.length; i++) s += n(pts[i][0]) + ' ' + n(pts[i][1]) + ' l '; cur.ops.push(s + 'h f 0 0 0 rg'); },
            dot(x, y, r, color) { const k = r * 0.5523; cur.ops.push(rgb(color) + ' rg ' + n(x + r) + ' ' + n(y) + ' m ' + n(x + r) + ' ' + n(y + k) + ' ' + n(x + k) + ' ' + n(y + r) + ' ' + n(x) + ' ' + n(y + r) + ' c ' + n(x - k) + ' ' + n(y + r) + ' ' + n(x - r) + ' ' + n(y + k) + ' ' + n(x - r) + ' ' + n(y) + ' c ' + n(x - r) + ' ' + n(y - k) + ' ' + n(x - k) + ' ' + n(y - r) + ' ' + n(x) + ' ' + n(y - r) + ' c ' + n(x + k) + ' ' + n(y - r) + ' ' + n(x + r) + ' ' + n(y - k) + ' ' + n(x + r) + ' ' + n(y) + ' c f 0 0 0 rg'); },
            save() { cur.ops.push('q'); },
            restore() { cur.ops.push('Q'); },
            clip(x, y, w, h) { cur.ops.push(n(x) + ' ' + n(y) + ' ' + n(w) + ' ' + n(h) + ' re W n'); },
            blob() {
                const objs = [];   // 1 catalog, 2 pages, 3-6 fonts, then page+stream pairs from 7
                const kids = pages.map((_, i) => (7 + i * 2) + ' 0 R').join(' ');
                objs.push('<< /Type /Catalog /Pages 2 0 R >>');
                objs.push('<< /Type /Pages /Kids [' + kids + '] /Count ' + pages.length + ' >>');
                objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
                objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>');
                objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
                objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
                pages.forEach((pg, i) => {
                    objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pg.w + ' ' + pg.h + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ' + (8 + i * 2) + ' 0 R >>');
                    const s = pg.ops.join('\n');
                    objs.push('<< /Length ' + s.length + ' >>\nstream\n' + s + '\nendstream');
                });
                let out = '%PDF-1.4\n';
                const offs = [];
                objs.forEach((o, i) => { offs.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
                const xref = out.length;
                out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' +
                    offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
                    'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
                return new Blob([out], { type: 'application/pdf' });
            }
        };
    }

    // courier is fixed width (0.6 em): the script's Paragraph wraps at 6.5in = 78 chars of 10pt
    function qcEsWrapNotes(text) {
        const lines = [];
        String(text || '').split('\n').forEach(seg => {
            if (seg === '') { lines.push(''); return; }
            let line = '';
            seg.split(/\s+/).forEach(w => {
                while (w.length > 78) { if (line) { lines.push(line); line = ''; } lines.push(w.slice(0, 78)); w = w.slice(78); }
                if (!line) line = w;
                else if (line.length + 1 + w.length <= 78) line += ' ' + w;
                else { lines.push(line); line = w; }
            });
            if (line) lines.push(line);
        });
        return lines;
    }

    const QC_ES_SENSORS = [
        ['Static Pressure Probe', ['PSM.1', 'PSM.2', 'N/A']],
        ['Dynamic Pressure Probe', ['PQM.1', 'PQM.2', 'N/A']],
        ['Total Temperature Probe', ['TTM.1', 'TTM.2', 'TTM.3', 'TTM.4', 'N/A']],
        ['Dewpoint Temp. Probe', ['TDM.1', 'TDM.2', 'N/A']],
        ['Vertical Accelerometer', ['AccZfilterI-GPS.1', 'AccZfilterI-GPS.2', 'N/A']],
        ['Altimeter', ['AltGPS.1', 'AltGPS.2', 'AltGPS.3', 'N/A']],
        ['INE Selection', ['1', '2', '3', 'N/A']],
        ['Differential Attack Pressure Probe', ['PDALPHA.1', 'PDALPHA.2', 'N/A']],
        ['Differential Sideslip Pressure Probe', ['PDBETA.1', 'PDBETA.2', 'N/A']],
        ['Dynamic Attack Pressure Probe', ['PQALPHA.1', 'PQALPHA.2', 'N/A']],
        ['Dynamic Sideslip Pressure Probe', ['PQBETA.1', 'PQBETA.2', 'N/A']]
    ];
    const QC_ES_EXPENDABLES = ['Dropsondes', 'Test sondes', 'AXBTs', 'AXCPs', 'AXCTDs', 'UAS'];

    // the airport table is the ourairports public domain list, every large and medium airport
    // worldwide (data/airports.json, ~5k entries as [code, lat, lon, tier]), loaded once the
    // first time the modal needs it. small private strips are excluded on purpose: the fleet
    // cannot land on one, and a strip near a mis-detected position would label the form wrong.
    let qcEsAirports = null, qcEsAirportsReq = null;
    function qcEsLoadAirports() {
        if (qcEsAirports) return Promise.resolve(qcEsAirports);
        if (!qcEsAirportsReq) qcEsAirportsReq = fetch('data/airports.json')
            .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(a => { qcEsAirports = a; return a; })
            .catch(() => { qcEsAirportsReq = null; return null; });
        return qcEsAirportsReq;
    }
    // nearest airport, big fields first: a large airport registers within 8 km of the aircraft
    // position (their runways run far from the reference point), a medium field within 6 km.
    // farther than that the field stays blank, never guessed.
    function qcEsNearestAirport(lat, lon) {
        if (!qcEsAirports || !isFinite(lat) || !isFinite(lon)) return '';
        const rad = Math.PI / 180, gates = [8, 6];
        const best = [null, null], bd = [Infinity, Infinity];
        for (let i = 0; i < qcEsAirports.length; i++) {
            const a = qcEsAirports[i], t = a[3];
            const s = Math.sin((a[1] - lat) * rad / 2) ** 2 + Math.cos(lat * rad) * Math.cos(a[1] * rad) * Math.sin((a[2] - lon) * rad / 2) ** 2;
            const km = 12742 * Math.asin(Math.sqrt(s));
            if (km < bd[t]) { bd[t] = km; best[t] = a; }
        }
        for (let t = 0; t < 2; t++) if (best[t] && bd[t] <= gates[t]) return best[t][0];
        return '';
    }

    // the ref lat/lon at a moment: first finite pair within two minutes of the index
    function qcEsLatLonAt(idx) {
        const famBy = k => qcResult.families.find(f => f.key === k);
        const pick = f => { if (!f) return null; const mm = f.members.find(x => x.isRef && x.series) || f.members.find(x => x.series); return mm ? mm.series : null; };
        const la = pick(famBy('lat')), lo = pick(famBy('lon'));
        if (!la || !lo) return null;
        for (let d = 0; d <= 120; d++) {
            for (const i of [idx + d, idx - d]) {
                if (i >= 0 && i < la.length && !Number.isNaN(la[i]) && !Number.isNaN(lo[i])) return { lat: la[i], lon: lo[i] };
            }
        }
        return null;
    }
    function qcEsSyncLocations() {
        if (!qcResult || !qcResult.phases) return;
        if (!qcEsAirports) { qcEsLoadAirports().then(a => { if (a) qcEsSyncLocations(); }); return; }
        const toEl = document.getElementById('qcEsToLoc'), ldEl = document.getElementById('qcEsLandLoc');
        if (!toEl || !ldEl) return;
        const to = qcEsLatLonAt(qcResult.phases.toIdx), ld = qcEsLatLonAt(qcResult.phases.landIdx);
        toEl.value = to ? qcEsNearestAirport(to.lat, to.lon) : '';
        ldEl.value = ld ? qcEsNearestAirport(ld.lat, ld.lon) : '';
        qcEsPaintRequired();
    }

    // a designation is prefilled ONLY when a ref variable actually names it: the dominant source
    // first, a secondary source next. everything else (INE, the alpha/beta pressure probes, and
    // any row whose ref never rode a candidate) stays EMPTY: mere data presence cannot say which
    // unit was selected, and a wrong guess on an official form is worse than a blank.
    function qcEsGuessSensor(options) {
        if (!qcResult) return '';
        const primary = new Set(), any = new Set();
        qcResult.families.forEach(f => {
            if (!f.refInfo) return;
            if (f.refInfo.source) primary.add(f.refInfo.source);
            (f.refInfo.sources || []).forEach(s => any.add(s));
        });
        for (const o of options) if (primary.has(o)) return o;
        for (const o of options) if (any.has(o)) return o;
        return '';
    }

    // ine selection is a combined ref: the vertical, north south, and east west velocity refs
    // (GSZref, GSYref, GSXref) all ride the same inertial unit. only when ALL THREE name the
    // same .N suffix is that digit the selection; any disagreement or unknown leaves it empty.
    function qcEsGuessINE() {
        if (!qcResult) return '';
        const digits = ['velz', 'vely', 'velx'].map(key => {
            const f = qcResult.families.find(x => x.key === key);
            const src = f && f.refInfo && f.refInfo.source;
            const m = src ? /\.(\d)\s*$/.exec(src) : null;
            return m ? m[1] : null;
        });
        return (digits[0] && digits.every(d => d === digits[0])) ? digits[0] : '';
    }

    // re-pull every designation from the current refs; runs on open and again after any
    // takeoff/landing change, since a new window can change which sensor a ref rode
    function qcEsSyncSensors() {
        QC_ES_SENSORS.forEach(([label, opts], i) => {
            const el = document.getElementById('qcEsSensor' + i);
            if (el) el.value = label === 'INE Selection' ? qcEsGuessINE() : qcEsGuessSensor(opts);
        });
    }

    // ---- the modal: the script's form, prefilled ------------------------------------------------
    let qcEsModal = null;
    function qcShowErrorSummary() {
        if (!qcResult) return;
        if (!qcEsModal) {
            qcEsModal = document.createElement('div');
            qcEsModal.id = 'qcEsModal'; qcEsModal.className = 'modal-overlay';
            // every select opens with a blank choice: rows no ref can verify stay empty on purpose
            const sensorRows = QC_ES_SENSORS.map(([label, opts], i) =>
                '<label class="qc-es-row qc-es-sensor-row" data-si="' + i + '" title="Click to graph the candidate sensors"><span>' + label + '</span><select id="qcEsSensor' + i + '" class="qc-ov-input qc-es-sel">' +
                '<option></option>' + opts.map(o => '<option>' + o + '</option>').join('') + '</select></label>').join('').replace(/class="qc-ov-input qc-es-sel"/g, 'class="qc-ov-input qc-es-sel qc-es-req"');
            const expRows = QC_ES_EXPENDABLES.map((t, i) =>
                '<div class="qc-es-exp-row"><span>' + t + '</span>' +
                [0, 1, 2].map(c => '<input id="qcEsExp' + i + '_' + c + '" class="qc-ov-input" style="width:70px">').join('') + '</div>').join('');
            qcEsModal.innerHTML =
                '<div class="qc-es-wrap">' +
                '<div class="modal-card qc-es-card">' +
                  '<button id="qcEsClose" class="qc-cmd-x" style="position:absolute;top:14px;right:14px" title="Close">✕</button>' +
                  '<h2 class="text-ink text-lg font-bold border-b border-hairline pb-2">Error Summary (.pdf)</h2>' +
                  '<div class="qc-es-cols">' +
                  '<div class="qc-es-col">' +
                    '<div class="qc-es-sec">Flight information</div>' +
                    '<label class="qc-es-row"><span>Flight ID</span><input id="qcEsFlightId" class="qc-ov-input qc-es-wide qc-es-req"></label>' +
                    '<label class="qc-es-row"><span>Flight Director</span><input id="qcEsDirector" class="qc-ov-input qc-es-wide qc-es-req"></label>' +
                    '<label class="qc-es-row"><span>Email</span><input id="qcEsEmail" class="qc-ov-input qc-es-wide qc-es-req"></label>' +
                    '<label class="qc-es-row"><span>Flight Directory</span><input id="qcEsDir" class="qc-ov-input qc-es-wide" readonly tabindex="-1" title="Derived from the flight id"></label>' +
                    '<div class="qc-es-sec">Takeoff / landing</div>' +
                    '<label class="qc-es-row"><span>Takeoff Location</span><input id="qcEsToLoc" class="qc-ov-input qc-es-req"></label>' +
                    '<label class="qc-es-row"><span>Takeoff Time (Z)</span><input id="qcEsToTime" class="qc-ov-input qc-es-req" maxlength="6" placeholder="HHMMSS"></label>' +
                    '<label class="qc-es-row"><span>Landing Location</span><input id="qcEsLandLoc" class="qc-ov-input qc-es-req"></label>' +
                    '<label class="qc-es-row"><span>Landing Time (Z)</span><input id="qcEsLandTime" class="qc-ov-input qc-es-req" maxlength="6" placeholder="HHMMSS"></label>' +
                    '<div class="qc-es-sec">Dynamic corrections</div>' +
                    '<label class="qc-es-row"><span>AttackAngleIntercept</span><input id="qcEsAtkInt" class="qc-ov-input"></label>' +
                    '<label class="qc-es-row"><span>AttackAngleSlope</span><input id="qcEsAtkSlp" class="qc-ov-input"></label>' +
                    '<label class="qc-es-row"><span>SlipAngleIntercept</span><input id="qcEsSlipInt" class="qc-ov-input"></label>' +
                    '<label class="qc-es-row"><span>SlipAngleSlope</span><input id="qcEsSlipSlp" class="qc-ov-input"></label>' +
                  '</div>' +
                  '<div class="qc-es-col">' +
                    '<div class="qc-es-sec">Sensor designations</div>' +
                    sensorRows +
                    '<div class="qc-es-sec">Expendables</div>' +
                    '<div class="qc-es-exp-row qc-es-exp-head"><span></span><b># deployed</b><b># good</b><b># transmitted</b></div>' +
                    expRows +
                  '</div>' +
                  '</div>' +
                  '<div class="qc-es-sec">Notes</div>' +
                  '<textarea id="qcEsNotes" rows="8" class="qc-es-notes"></textarea>' +
                  '<div class="qc-picker-foot"><span style="flex:1"></span><button id="qcEsGenerate" class="qc-ov-btn qc-ov-btn-accent">Generate PDF</button></div>' +
                '</div>' +
                '<div class="qc-es-graphbox" id="qcEsGraphBox">' +
                  '<div class="qc-es-graphhead"><span id="qcEsGraphTitle"></span><button id="qcEsGraphClose" class="qc-cmd-x" title="Close">✕</button></div>' +
                  '<div class="qc-es-graphcanvas"><canvas id="qcEsGraphCv"></canvas></div>' +
                  '<div class="qc-es-graphnote" id="qcEsGraphNote"></div>' +
                '</div>' +
                '</div>';
            document.body.appendChild(qcEsModal);
            const esClose = () => { qcEsModal.style.display = 'none'; qcEsHideGraph(); };
            document.getElementById('qcEsClose').addEventListener('click', esClose);
            qcEsModal.addEventListener('click', e => { if (e.target === qcEsModal) esClose(); });
            document.addEventListener('keydown', e => { if (e.key === 'Escape') esClose(); });
            document.getElementById('qcEsGraphClose').addEventListener('click', qcEsHideGraph);
            // clicking a designation row graphs its candidate sensors beside the form
            qcEsModal.querySelectorAll('.qc-es-sensor-row').forEach(row => row.addEventListener('click', () => qcEsShowGraph(parseInt(row.dataset.si, 10))));
            // required fields stay red while empty, live as the user types or picks
            qcEsModal.addEventListener('input', qcEsPaintRequired);
            qcEsModal.addEventListener('change', qcEsPaintRequired);
            // the directory derives from the flight id as it is typed
            document.getElementById('qcEsFlightId').addEventListener('input', qcEsSyncDir);
            // editing a time re-runs the tool's whole pipeline right away, then re-syncs the field
            const applyTimes = () => {
                const changed = qcApplyManualPhases(document.getElementById('qcEsToTime').value, document.getElementById('qcEsLandTime').value,
                    document.getElementById('qcEsToTime'), document.getElementById('qcEsLandTime'));
                if (changed) { qcEsSyncTimes(); qcEsSyncSensors(); qcEsSyncLocations(); }
                qcEsPaintRequired();
            };
            ['qcEsToTime', 'qcEsLandTime'].forEach(id => document.getElementById(id).addEventListener('change', applyTimes));
            document.getElementById('qcEsGenerate').addEventListener('click', qcEsGenerate);
        }
        // prefill from the current flight: the bare id only, no storm or training parenthetical
        document.getElementById('qcEsFlightId').value = String((flightMetaData && flightMetaData.id) || '').replace(/\s*\([^)]*\)/g, '').trim();
        try {
            const fd = JSON.parse(localStorage.getItem('qcEsDirector') || '{}');
            if (fd.name) document.getElementById('qcEsDirector').value = fd.name;
            if (fd.email) document.getElementById('qcEsEmail').value = fd.email;
        } catch (e) {}
        qcEsSyncSensors();
        qcEsSyncTimes();
        qcEsSyncLocations();
        qcEsSyncDir();
        qcEsPaintRequired();
        qcEsModal.style.display = 'flex';
    }

    // flight directory: acdata/YEAR/MET/MISSIONID, both already known from the id
    function qcEsSyncDir() {
        const el = document.getElementById('qcEsDir'); if (!el) return;
        const id = String(document.getElementById('qcEsFlightId').value || '').replace(/\s*\([^)]*\)/g, '').trim();
        const year = id.length >= 4 ? id.slice(0, 4) : 'YYYY';
        el.value = 'acdata/' + year + '/MET/' + (id || 'MISSIONID');
    }

    // an empty required field wears red until it is filled (or a blank designation is a
    // deliberate choice the user still sees flagged before generating)
    function qcEsPaintRequired() {
        if (!qcEsModal) return;
        qcEsModal.querySelectorAll('.qc-es-req').forEach(el => el.classList.toggle('qc-bad', !String(el.value || '').trim()));
    }

    function qcEsSyncTimes() {
        if (!qcResult || !qcResult.phases) return;
        document.getElementById('qcEsToTime').value = qcSecToLabel(qcResult.phases.takeoffSec).replace(/:/g, '');
        document.getElementById('qcEsLandTime').value = qcSecToLabel(qcResult.phases.landingSec).replace(/:/g, '');
    }

    // ---- mini graph beside the form: the row's candidate sensors, with the family ref dashed
    // on top, so a designation can be judged and set by eye when no ref names it ----------------
    let qcEsGraphChart = null;
    function qcEsHideGraph() {
        const box = document.getElementById('qcEsGraphBox');
        if (box) box.classList.remove('show');
        if (qcEsGraphChart) { try { qcEsGraphChart.destroy(); } catch (e) {} qcEsGraphChart = null; }
    }
    function qcEsShowGraph(si) {
        const box = document.getElementById('qcEsGraphBox');
        if (!box || !qcResult || !QC_ES_SENSORS[si]) return;
        const label = QC_ES_SENSORS[si][0], opts = QC_ES_SENSORS[si][1].filter(o => o !== 'N/A');
        const found = [], fams = new Set();
        opts.forEach(name => qcResult.families.forEach(f => f.members.forEach(m => {
            if (m.name === name && m.series) { found.push(m); fams.add(f); }
        })));
        let refM = null, refFam = null;
        fams.forEach(f => f.members.forEach(m => { if (!refM && m.isRef && m.series) { refM = m; refFam = f; } }));
        document.getElementById('qcEsGraphTitle').textContent = label;
        box.classList.add('show');
        if (qcEsGraphChart) { try { qcEsGraphChart.destroy(); } catch (e) {} qcEsGraphChart = null; }
        const note = document.getElementById('qcEsGraphNote');
        if (!found.length) { note.textContent = 'No graphable variables behind this row in this flight; it stays a manual call.'; return; }
        note.textContent = (refFam && refFam.refInfo && refFam.refInfo.sources && refFam.refInfo.sources.length)
            ? refFam.ref + ' rode ' + refFam.refInfo.sources.join(', then ')
            : 'No ref variable names one of these; judge by eye and set the dropdown.';
        const dsets = found.map((m, k) => ({
            label: m.name, data: qcDecimate(m.series, 0, m.series.length - 1), parsing: false, normalized: true,
            borderColor: QC_SERIES_COLORS[k % QC_SERIES_COLORS.length], borderWidth: 1.3, pointRadius: 0, spanGaps: false, fill: false
        }));
        if (refM) dsets.unshift({
            label: refM.name, data: qcDecimate(refM.series, 0, refM.series.length - 1), parsing: false, normalized: true,
            borderColor: qcRefColor(), borderWidth: 1.8, borderDash: [5, 3], pointRadius: 0, spanGaps: false, fill: false
        });
        const tick = { color: qcAxisTickColor(), font: { family: "'IBM Plex Mono', monospace", size: 9 } };
        qcEsGraphChart = new Chart(document.getElementById('qcEsGraphCv').getContext('2d'), {
            type: 'line', data: { datasets: dsets },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                interaction: { mode: 'nearest', axis: 'xy', intersect: false },
                scales: {
                    x: { type: 'linear', bounds: 'data', grid: { color: 'rgba(148,163,184,0.08)' }, ticks: Object.assign({ maxTicksLimit: 6, callback: v => (qcTimeLabels && qcTimeLabels[Math.round(v)]) || '' }, tick) },
                    y: { grid: { color: 'rgba(148,163,184,0.10)' }, ticks: tick }
                },
                plugins: {
                    legend: { labels: Object.assign({ boxWidth: 10, boxHeight: 10 }, tick) },
                    tooltip: { callbacks: { title: items => items.length ? (((qcTimeLabels && qcTimeLabels[Math.round(items[0].parsed.x)]) || '') + ' UTC') : '' } },
                    zoom: { zoom: { wheel: { enabled: true }, mode: 'x' }, pan: { enabled: true, mode: 'x' }, limits: { x: { min: 'original', max: 'original' } } }
                }
            }
        });
    }

    // ---- the pdf itself: the script's create_pdf, coordinate for coordinate ---------------------
    function qcEsGenerate() {
        const val = id => document.getElementById(id).value;
        // the id stays bare everywhere (title, directory line, file name), parentheticals dropped
        const flightId = val('qcEsFlightId').replace(/\s*\([^)]*\)/g, '').trim();
        const idEl = document.getElementById('qcEsFlightId');
        idEl.classList.toggle('qc-bad', !flightId);
        if (!flightId) return;   // the script's required field, shown in place instead of a popup
        try { localStorage.setItem('qcEsDirector', JSON.stringify({ name: val('qcEsDirector'), email: val('qcEsEmail') })); } catch (e) {}

        const IN = 72, doc = qcPdfDoc(), H = doc.H;
        doc.page();
        const up = flightId.toUpperCase();
        const title = up.includes('N') ? 'N49RF ERROR SUMMARY' : up.includes('I') ? 'N43RF ERROR SUMMARY' : up.includes('H') ? 'N42RF ERROR SUMMARY' : 'AOC ERROR SUMMARY';
        doc.text(1 * IN, H - 1 * IN, title, 12);
        doc.text(7 * IN, H - 1 * IN, flightId, 12);

        doc.text(1.1 * IN, H - 1.5 * IN, 'Sensor or System', 10);
        doc.text(4.6 * IN, H - 1.5 * IN, 'Number or Name', 10);
        doc.line(1 * IN, H - 1.6 * IN, 7.5 * IN, H - 1.6 * IN);
        doc.line(4.5 * IN, H - 1.3 * IN, 4.5 * IN, H - 4.4 * IN);

        let y = H - 1.8 * IN;
        QC_ES_SENSORS.forEach(([label], i) => {
            doc.text(1.1 * IN, y, label, 10);
            doc.text(4.6 * IN, y, val('qcEsSensor' + i), 10);
            y -= 0.25 * IN;
        });
        const year = flightId.length >= 4 ? flightId.slice(0, 4) : 'YYYY';
        doc.text(1.1 * IN, y, 'Flight Directory', 10);
        doc.text(4.6 * IN, y, 'acdata/' + year + '/MET/' + flightId, 10);
        y -= 0.4 * IN;

        doc.text(1.1 * IN, y, 'Ground Location:', 10);
        doc.text(3.6 * IN, y, 'Takeoff ' + val('qcEsToLoc') + ' (' + val('qcEsToTime') + 'Z)', 10);
        doc.text(6.1 * IN, y, 'Landing ' + val('qcEsLandLoc') + ' (' + val('qcEsLandTime') + 'Z)', 10);
        y -= 0.2 * IN;
        doc.text(1.1 * IN, y, 'Dynamic Corrections:', 10);
        y -= 0.2 * IN;
        [['AttackAngleIntercept', val('qcEsAtkInt')], ['AttackAngleSlope', val('qcEsAtkSlp')],
         ['SlipAngleIntercept', val('qcEsSlipInt')], ['SlipAngleSlope', val('qcEsSlipSlp')]].forEach(p => {
            doc.text(1.1 * IN, y, p[0], 10);
            doc.text(4.6 * IN, y, p[1], 10);
            y -= 0.2 * IN;
        });

        // notes: courier 10 on 14pt leading, wrapped at the script's 6.5in, same page-break rule
        y -= 0.3 * IN;
        doc.text(1 * IN, y, 'Notes:', 10, true);
        const noteLines = qcEsWrapNotes(val('qcEsNotes').trim());
        const noteH = noteLines.length * 14;
        if (y < noteH + 1 * IN) {
            doc.page();
            y = H - 1 * IN;
            doc.text(1 * IN, y, 'Notes:', 10, true);
        }
        let ny = y - 11;   // first baseline inside the paragraph box, top aligned like reportlab
        noteLines.forEach(ln => { if (ln) doc.text(1 * IN, ny, ln, 10); ny -= 14; });
        y -= (noteH + 0.4 * IN);

        if (y < 3 * IN) { doc.page(); y = H - 1 * IN; }
        doc.text(1.1 * IN, y, 'Expendable Type', 10);
        doc.text(3.6 * IN, y, '# deployed', 10);
        doc.text(5.1 * IN, y, '# good', 10);
        doc.text(6.6 * IN, y, '# transmitted', 10);
        doc.line(1 * IN, y - 0.1 * IN, 7.5 * IN, y - 0.1 * IN);
        y -= 0.3 * IN;
        QC_ES_EXPENDABLES.forEach((t, i) => {
            doc.text(1.1 * IN, y, t, 10);
            doc.text(3.6 * IN, y, val('qcEsExp' + i + '_0'), 10);
            doc.text(5.1 * IN, y, val('qcEsExp' + i + '_1'), 10);
            doc.text(6.6 * IN, y, val('qcEsExp' + i + '_2'), 10);
            y -= 0.25 * IN;
        });

        y -= 0.5 * IN;
        if (y < 1.5 * IN) { doc.page(); y = H - 1 * IN; }
        doc.text(1 * IN, y, 'Flight Director: ' + val('qcEsDirector'), 12);
        doc.text(1 * IN, y - 0.3 * IN, 'Email: ' + val('qcEsEmail'), 12);

        const a = document.createElement('a');
        a.href = URL.createObjectURL(doc.blob());
        a.download = flightId + '_ES.pdf'; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        qcEsModal.style.display = 'none';
        qcEsHideGraph();
    }
