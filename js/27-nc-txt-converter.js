/* QC Mode, NC-to-TXT converter
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   A top-left button (in the QC app brand corner) opens a modal that exports the loaded flight's
   raw data to a delimited text file. Unlike the QC graphs (a curated set of "needed" variables),
   this lists EVERY variable in the file so the user can pick exactly what to include.

   Data source: qcRawDataAll (js/01 state, set in js/12 applyParsedFlight) — the every-variable raw
   parse. Preloaded/cached flights carry it too (persisted to IndexedDB, restored on open by
   js/12b openPreloadedMission), so this only falls back to the catalog-only qcRawData for an older
   cache saved before that existed. Both share the same shape: { timeAxis, raw:{name:Float32Array},
   t0, t1, present }.

   The default window matches the QC graphs' trim: five minutes before the detected (or pinned)
   takeoff through the end of the data. Both ends are editable HHMMSS boxes. */

    let qcConvBuilt = false;
    let qcConvDrag = null;        // { target } while a click-and-drag paint-select is in progress
    let qcConvAnchorRow = null;   // last row acted on directly (click or drag start), the shift+click range anchor

    // Named presets: a curated set that starts PRE-CHECKED while every other variable stays listed but
    // unchecked (so the whole file is still one click away). Nothing here is hardcoded into the general
    // list — "All variables" always enumerates whatever the loaded file actually contains, so a new
    // plane's new variables show up automatically. Presets are just saved name lists: matching is
    // case-insensitive, and a preset name missing from the file simply matches nothing, so a renamed or
    // dropped variable never breaks the preset. To edit a preset, paste names separated by any whitespace.
    const QC_CONV_PRESETS = [
        {
            id: 'rebecca',
            label: "Rebecca's Preset",
            names: `
                YawRateI.2 YawRateI.1 YawRateI-GPS.2 YawRateI-GPS.1 VerrGPS.2 VerrGPS.1 TtADDU.1
                THdgI-GPS.2 THdgI-GPS.1 TasADDU.1 TaADDU.1 RollRateI.2 RollRateI.1 RollRateI-GPS.2
                RollRateI-GPS.1 RollI.2 RollI.1 RollI-GPS.2 RollI-GPS.1 PitchRateI.2 PitchRateI.1
                PitchRateI-GPS.2 PitchRateI-GPS.1 PitchI.2 PitchI.1 PitchI-GPS.2 PitchI-GPS.1 MachADDU.1
                LonGPS.2 LonGPS.1 LonI-GPS.2 LonI-GPS.1 LatGPS.2 LatGPS.1 LatI-GPS.2 LatI-GPS.1 IasADDU.1
                HerrGPS.2 HerrGPS.1 VelZGPS.2 VelZGPS.1 VelYGPS.2 VelYGPS.1 VelXGPS.2 VelXGPS.1 CasADDU.1
                AltRateADDU.1 AltRaStat.2 AltRaStat.1 AltRaRate.2 AltRaRate.1 AltRa.2 AltRa.1 AltGPS.2
                AltGPS.1 AltI-GPS.2 AltI-GPS.1 AltBCADDU.1 AccZI-GPS.2 AccZI-GPS.1 AccYI-GPS.2 AccYI-GPS.1
                AccXI-GPS.2 AccXI-GPS.1 AccAZI.2 AccAZI.1 AccAYI.2 AccAYI.1 AccAXI.2 AccAXI.1 AltPaADDU.1
                VelZI.2 VelZI.1 VelXI-GPS.2 VelXI-GPS.1 VelYI.2 VelYI.1 VelYI-GPS.2 VelYI-GPS.1 VelXI.2
                VelXI.1 VelZI-GPS.2 VelZI-GPS.1 AltRa1.c AltRa2.c AltRaCnt.1 AltRaCnt.2 AltGPS.3 LatGPS.3
                LonGPS.3 LATref LONref PitchI-GPS.3 PitchI-GPS.4 RollI-GPS.3 RollI-GPS.4 THdgI-GPS.3
                THdgI-GPS.4 ALTref PITCHref ROLLref THDGref ALTGA.d ACCXref AccZfilterI-GPS.1
                AccZfilterI-GPS.2 UWINGX.d UWINGY.d UWINGZ.d USLIPX.d USLIPY.d USLIPZ.d ACCZref UTAILX.d
                UTAILY.d UTAILZ.d DIFF.1 GDIFF.1 GDIFF.2 GsXI-GPS.2 GsXI-GPS.1 GsYI-GPS.2 GsYI-GPS.1
                GsZI-GPS.2 GsZI-GPS.1 GSXref GSYref GSZref TRK.d GS.d UIZ.d USLIP_SQ.d UWING_SQ.d VINE.d
                DSLIP.d DWING.d GPS_AltErr.3 GPS_GeoidHt.3 GPS_Hdop.3 GPS_LatErr.3 GPS_LonErr.3
                GPS_Quality.3 GPS_SatNum.3 GPS_GGAcnt.3 GPS_GSAcnt.3 GPS_GSTcnt.3 GPS_Fxtime.3
                AltBCADDUft.1 AltGPSft.1 AltI-GPSft.1 AltPaADDUft.1 AltRaft.2 AltRaft.1 CasADDUkt.1
                TasADDUkt.1 DA.d SST.1 Salinity.1 Time
                TTM.1 TTM.2 TDM.3
                PDALPHA.1 PQALPHA.1 TDM.1
                AltGPS.4 GPS_AltErr.4 GPS_Fxtime.4 GPS_GGAcnt.4 GPS_GSAcnt.4 GPS_GSTcnt.4 GPS_GeoidHt.4
                GPS_Hdop.4 GPS_LatErr.4 GPS_LonErr.4 GPS_Quality.4 GPS_SatNum.4 LatGPS.4 LonGPS.4
                AADChecksum.3 AADQC1Volt.3 AADQC2Volt.3 AADGroundVolt.3 AADStatus1.3 AADStatus2.3
                PDALPHA.2 PDBETA.2 PQM.4 PTM.1 TRadS.1
                PCAB.1 PSM.2 PQM.2 PQM.3 PDBETA.1 PQBETA.1 AA.d SA.d PSM.1 PQM.1 TDM.2 TDMref TTMref
                PQMref PSMref PQ.c PS.c EE.d TD.c ALTPA.d ALTPAft.d MDSHOUR.1 TWC.1 MDSMINUTE.1
                MDSSECOND.1 AA.1 SA.1 AAref SAref UDIRX.d UDIRY.d UDIRZ.d
                HUM_SPEC.d MRkg.d GM.d GO.d MACH.d RGAS.c SPHEATCP.c TTkelvin.c TT.c TAkelvin.d TA.d
                TAS.d HUM_ABS.d MR.d TVIRT.d THETA.d IAS.d IASkt.d DV.d PSURF.d EW.d HUM_REL.d HT.d
                THETAV.d THETAE.d MACH_SQ.d URX.d URY.d URZ.d UWX.d UWY.d UWZ.d WS.d WD.d WSkt.d UTAN.d
                URAD.d TASkt.d TRKdesired.d COURSEcorr.d ASfmrWS.1 ASfmrRainRate.1 TDMfilter.1 EE.1
                MRkg.1 RGAS.1 GM.1 GO.1 SPHEATCP.1 TTkelvin.1 TAkelvin.1 TVIRT.1 PSURF.1 NSfmrWS.1
                NSfmrRainRate.1 SFMRWSref SFMRRAINRATEref
            `
        }
    ];
    // a preset's names as a lowercased Set (built once, cached on the preset object)
    function qcConvPresetSet(id) {
        const p = QC_CONV_PRESETS.find(x => x.id === id);
        if (!p) return null;
        if (!p._set) p._set = new Set(p.names.split(/\s+/).map(s => s.trim().toLowerCase()).filter(Boolean));
        return p._set;
    }
    // the currently-chosen preset's name Set, or null for "All variables"
    function qcConvActivePreset() {
        const sel = document.getElementById('qcConvPreset');
        return (sel && sel.value) ? qcConvPresetSet(sel.value) : null;
    }

    // the source the converter reads: prefer the every-variable set, fall back to the catalog set.
    function qcConvSource() {
        const all = (typeof qcRawDataAll !== 'undefined') ? qcRawDataAll : null;
        const cat = (typeof qcRawData !== 'undefined') ? qcRawData : null;
        return (all && all.raw && Object.keys(all.raw).length) ? all
             : (cat && cat.raw && Object.keys(cat.raw).length) ? cat : null;
    }

    // 6-digit HHMMSS from an absolute axis second (wraps a day, matching qcSecToLabel).
    function qcConvHHMMSS(sec) {
        let s = Math.round(sec) % 86400; if (s < 0) s += 86400;
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
        return String(h).padStart(2, '0') + String(m).padStart(2, '0') + String(ss).padStart(2, '0');
    }

    // an HHMMSS box -> the matching absolute second on this flight's axis. Mirrors the takeoff/landing
    // pin logic (js/23 qcApplyManualPhases): a time earlier than the start by more than 12 h is the
    // next UTC day, so it lifts onto the axis of a flight that crossed midnight.
    function qcConvParseTime(str, t0) {
        const digits = String(str == null ? '' : str).replace(/[^0-9]/g, '');
        if (!digits) return null;
        let sec = timeToSeconds(digits);
        if (sec < t0 - 43200) sec += 86400;
        return sec;
    }

    // one value -> a text cell. Gaps and fills are NaN in the raw arrays (js/11b drops <= -990), so a
    // non-finite value is always "no reading" and gets the chosen missing token. Finite values are
    // trimmed to float32's ~7 significant digits so the file carries clean numbers, not packing noise.
    function qcConvFmtNum(v, missing) {
        if (v == null || !Number.isFinite(v)) return missing;
        return String(Number(v.toPrecision(7)));
    }

    // clamp an absolute second to an index into the source axis
    function qcConvSecToIdx(sec, src) {
        const i = Math.round(sec - src.t0);
        return Math.max(0, Math.min(src.timeAxis.length - 1, i));
    }

    // ---- build the output text -----------------------------------------------------------------
    function qcConvBuildText(src, vars, opts) {
        const delim = opts.delimiter, missing = opts.missing, timeFmt = opts.timeFmt;
        const startIdx = opts.startIdx, endIdx = opts.endIdx;
        const arrs = vars.map(v => src.raw[v]);
        const header = [];
        if (timeFmt !== 'none') header.push('time');
        vars.forEach(v => header.push(v));
        const lines = [header.join(delim)];
        for (let i = startIdx; i <= endIdx; i++) {
            const row = [];
            if (timeFmt === 'hms') row.push(qcSecToLabel(src.timeAxis[i]));
            else if (timeFmt === 'sec') row.push(String(i - startIdx));
            else if (timeFmt === 'hhmmss') row.push(qcConvHHMMSS(src.timeAxis[i]));
            for (let j = 0; j < arrs.length; j++) { const a = arrs[j]; row.push(qcConvFmtNum(a ? a[i] : NaN, missing)); }
            lines.push(row.join(delim));
        }
        return lines.join('\n') + '\n';
    }

    // ---- UI ------------------------------------------------------------------------------------
    // search text AND the "Show unselected" toggle both narrow what's visible; a row must pass both.
    function qcConvApplyVisibility() {
        const list = document.getElementById('qcConvList');
        const q = (document.getElementById('qcConvSearch').value || '').trim().toLowerCase();
        const showUnselEl = document.getElementById('qcConvShowUnsel');
        const showUnsel = !showUnselEl || showUnselEl.checked;
        list.querySelectorAll('.qc-conv-item').forEach(row => {
            const name = row.getAttribute('data-name').toLowerCase();
            const matchesSearch = !q || name.indexOf(q) >= 0;
            const cb = row.querySelector('.qc-conv-cb');
            row.style.display = (matchesSearch && (showUnsel || (cb && cb.checked))) ? '' : 'none';
        });
    }
    function qcConvSelected() {
        return Array.prototype.slice.call(document.querySelectorAll('#qcConvList .qc-conv-cb:checked'))
            .map(cb => cb.value);
    }
    function qcConvUpdateCount() {
        const total = document.querySelectorAll('#qcConvList .qc-conv-cb').length;
        const sel = qcConvSelected().length;
        const el = document.getElementById('qcConvCount'); if (el) el.textContent = sel + ' of ' + total + ' selected';
        qcConvUpdateEstimate();
    }
    // live "rows x columns" estimate from the current window + selection, so the size is no surprise
    function qcConvUpdateEstimate() {
        const src = qcConvSource(); const st = document.getElementById('qcConvStatus');
        if (!src || !st) return;
        const t0 = src.t0;
        const s = qcConvParseTime(document.getElementById('qcConvStart').value, t0);
        const e = qcConvParseTime(document.getElementById('qcConvEnd').value, t0);
        if (s == null || e == null) { st.textContent = ''; return; }
        let si = qcConvSecToIdx(s, src), ei = qcConvSecToIdx(e, src);
        if (si > ei) { const tmp = si; si = ei; ei = tmp; }
        const rows = ei - si + 1;
        const cols = qcConvSelected().length + (document.getElementById('qcConvTimeFmt').value !== 'none' ? 1 : 0);
        st.textContent = '≈ ' + rows.toLocaleString('en-US') + ' rows × ' + cols + ' columns';
    }

    function qcConvSetDefaultTrim() {
        const src = qcConvSource(); if (!src) return;
        const qr = (typeof qcResult !== 'undefined') ? qcResult : null;
        const toSec = (qr && qr.phases && qr.phases.takeoffSec != null) ? qr.phases.takeoffSec : null;
        const startSec = (toSec != null) ? (toSec - 300) : src.t0;      // five minutes before takeoff
        const endSec = src.t1;                                          // through the end of the data
        document.getElementById('qcConvStart').value = qcConvHHMMSS(Math.max(src.t0, startSec));
        document.getElementById('qcConvEnd').value = qcConvHHMMSS(endSec);
        const hint = document.getElementById('qcConvStartHint');
        if (hint) hint.textContent = (toSec != null)
            ? '5 min before takeoff (' + qcSecToLabel(toSec) + ')'
            : 'data start (takeoff not detected)';
    }

    function qcConvPopulateList() {
        const src = qcConvSource(); const list = document.getElementById('qcConvList');
        list.innerHTML = ''; qcConvAnchorRow = null;   // old rows are gone; drop the shift+click anchor with them
        if (!src) return;
        // file/column order (header order), so the txt mirrors the source layout. Every variable is
        // always listed; a preset only changes which ones start checked (its members on, the rest off).
        const preset = qcConvActivePreset();
        const names = Object.keys(src.raw);
        const frag = document.createDocumentFragment();
        names.forEach(name => {
            const present = (src.present && src.present[name] != null) ? src.present[name] : null;
            const row = document.createElement('label');
            row.className = 'qc-conv-item'; row.setAttribute('data-name', name);
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.className = 'qc-conv-cb'; cb.value = name;
            cb.checked = preset ? preset.has(name.toLowerCase()) : true;   // preset pre-checks its members only
            // keyboard toggle (Tab + Space) is the one path pointer-events:none on the checkbox doesn't
            // intercept, so it still reaches here as a real native 'change'; also re-apply "Show
            // unselected" filtering since this row's checked state just moved.
            cb.addEventListener('change', () => { qcConvUpdateCount(); qcConvApplyVisibility(); });
            const nm = document.createElement('span'); nm.className = 'qc-conv-name'; nm.textContent = name;
            const ct = document.createElement('span'); ct.className = 'qc-conv-ct';
            ct.textContent = present != null ? present.toLocaleString('en-US') + ' s' : '';
            row.appendChild(cb); row.appendChild(nm); row.appendChild(ct);
            frag.appendChild(row);
        });
        list.appendChild(frag);
    }

    // ---- mass select: click-and-drag paints a run of checkboxes to one state, shift+click selects
    // a range. With ~150-500 variables in the list, checking them one at a time doesn't scale. -------
    function qcConvVisibleRows() {
        return Array.prototype.filter.call(document.querySelectorAll('#qcConvList .qc-conv-item'), r => r.style.display !== 'none');
    }
    function qcConvSetRowChecked(row, checked) {
        const cb = row.querySelector('.qc-conv-cb');
        if (!cb || cb.checked === checked) return false;
        cb.checked = checked; return true;
    }
    // shift+click: every row between the last-acted row and this one (in on-screen order, so a
    // search filter narrows the range too) takes this checkbox's new state.
    function qcConvSelectRange(row, checked) {
        const visible = qcConvVisibleRows();
        const a = qcConvAnchorRow ? visible.indexOf(qcConvAnchorRow) : -1, b = visible.indexOf(row);
        if (a === -1 || b === -1) return false;
        const lo = Math.min(a, b), hi = Math.max(a, b);
        let changed = false;
        for (let i = lo; i <= hi; i++) { if (qcConvSetRowChecked(visible[i], checked)) changed = true; }
        return changed;
    }
    function qcConvDragStart(e) {
        if (e.button !== undefined && e.button !== 0) return;   // primary mouse button / touch / pen only
        const row = e.target.closest && e.target.closest('.qc-conv-item');
        if (!row || row.style.display === 'none') return;
        e.preventDefault();   // own the whole gesture: no native label/checkbox toggle to fight with
        const cb = row.querySelector('.qc-conv-cb'); if (!cb) return;
        const target = !cb.checked;   // the state this press is moving TOWARD, painted onto every row it crosses
        if (e.shiftKey && qcConvAnchorRow && qcConvAnchorRow.isConnected) qcConvSelectRange(row, target);
        else qcConvSetRowChecked(row, target);
        qcConvAnchorRow = row;
        qcConvUpdateCount();
        qcConvDrag = { target: target, lastRow: row };
        document.body.classList.add('qc-conv-noselect');
        document.addEventListener('pointermove', qcConvDragMove);
        document.addEventListener('pointerup', qcConvDragEnd);
        document.addEventListener('pointercancel', qcConvDragEnd);
    }
    function qcConvDragMove(e) {
        if (!qcConvDrag) return;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const row = el && el.closest && el.closest('.qc-conv-item');
        if (!row || row === qcConvDrag.lastRow || row.style.display === 'none') return;
        qcConvDrag.lastRow = row;
        if (qcConvSetRowChecked(row, qcConvDrag.target)) qcConvUpdateCount();
    }
    function qcConvDragEnd() {
        if (!qcConvDrag) return;
        qcConvDrag = null;
        document.body.classList.remove('qc-conv-noselect');
        document.removeEventListener('pointermove', qcConvDragMove);
        document.removeEventListener('pointerup', qcConvDragEnd);
        document.removeEventListener('pointercancel', qcConvDragEnd);
        // deferred to gesture-end (not every move) so painting a run of unchecks doesn't hide rows,
        // and reflow the grid, out from under the cursor mid-drag when "Show unselected" is off
        qcConvApplyVisibility();
    }

    function qcConvOpen() {
        const src = qcConvSource();
        if (!src) { if (typeof showToast === 'function') showToast('Load a flight first, then convert its data to text.'); return; }
        qcConvBuildUI();
        const id = (typeof flightMetaData !== 'undefined' && flightMetaData.id) ? flightMetaData.id : 'flight';
        const total = Object.keys(src.raw).length;
        // this always reflects whatever flight is CURRENTLY loaded (qcConvSource reads the live
        // qcRawDataAll/qcRawData globals, overwritten by applyParsedFlight on every load), never a
        // fixed file. The badge names the exact source FILE when the client knows it, revision
        // letter included: file revisions are lettered (...H1A.nc, ...H1B.nc, ...) and the archive
        // server always serves the latest letter -- the browser only ever sees the final download
        // URL, so its basename IS the chosen revision. A manual upload's name comes from the
        // drop-zone label. Fallback (e.g. the decimated API preview): just the data format.
        let srcFile = '';
        try {
            if (typeof reconArchiveMeta !== 'undefined' && reconArchiveMeta && reconArchiveMeta.sourceUrl
                && typeof isNcFile !== 'undefined' && isNcFile)   // decimated fallback is NOT the .nc; don't claim it
                srcFile = decodeURIComponent(String(reconArchiveMeta.sourceUrl).split(/[?#]/)[0].split('/').pop() || '');
        } catch (e) {}
        if (!srcFile) {
            const dl = document.getElementById('dataDropLabel');
            const t = dl ? dl.textContent.trim() : '';
            if (/\.(nc|txt)$/i.test(t)) srcFile = t;
        }
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const srcType = (typeof isNcFile !== 'undefined' && isNcFile) ? '.nc' : '.txt';
        const note = document.getElementById('qcConvNote');
        note.innerHTML = '<b>' + total + '</b> variables from <b>' + esc(id) + '</b>' +
            '<span class="qc-badge" title="' + (srcFile
                ? 'The exact file this flight was loaded from. Revisions are lettered (A, B, C…) and the archive always serves the latest.'
                : 'The format of the currently loaded flight data') + '">' +
            (srcFile ? esc(srcFile) : srcType + ' source') + '</span>';
        document.getElementById('qcConvSearch').value = '';
        document.getElementById('qcConvPreset').value = '';   // default to no preset (all selected) each open
        document.getElementById('qcConvShowUnsel').checked = true;   // default to showing everything each open
        qcConvPopulateList();
        qcConvApplyVisibility();
        qcConvSetDefaultTrim();
        qcConvUpdateCount();
        document.getElementById('qcConvModal').style.display = 'flex';
    }
    function qcConvClose() {
        qcConvDragEnd();   // in case the modal closes (e.g. Escape) mid-drag, so no listener is left dangling
        const m = document.getElementById('qcConvModal'); if (m) m.style.display = 'none';
    }

    function qcConvDownload() {
        const src = qcConvSource(); if (!src) return;
        const vars = qcConvSelected();
        const status = document.getElementById('qcConvStatus');
        if (!vars.length) { status.textContent = 'Pick at least one parameter to include.'; return; }
        const t0 = src.t0;
        const startEl = document.getElementById('qcConvStart'), endEl = document.getElementById('qcConvEnd');
        const s = qcConvParseTime(startEl.value, t0), e = qcConvParseTime(endEl.value, t0);
        if (s == null || e == null) { status.textContent = 'Enter a start and end time as HHMMSS.'; return; }
        let si = qcConvSecToIdx(s, src), ei = qcConvSecToIdx(e, src);
        if (si > ei) { const tmp = si; si = ei; ei = tmp; }
        const opts = {
            delimiter: document.getElementById('qcConvDelim').value === 'tab' ? '\t'
                : ({ comma: ',', semicolon: ';', space: ' ', pipe: '|' }[document.getElementById('qcConvDelim').value] || ','),
            missing: ({ nan: 'NaN', blank: '', fill: '-9999' }[document.getElementById('qcConvMissing').value]) ?? 'NaN',
            timeFmt: document.getElementById('qcConvTimeFmt').value,
            startIdx: si, endIdx: ei
        };
        const btn = document.getElementById('qcConvDownload');
        btn.disabled = true; status.textContent = 'Building…';
        // defer so the "Building…" state paints before a large file is assembled on the main thread
        setTimeout(() => {
            try {
                const text = qcConvBuildText(src, vars, opts);
                const id = (typeof flightMetaData !== 'undefined' && flightMetaData.id ? flightMetaData.id : 'flight')
                    .replace(/[^A-Za-z0-9_.-]+/g, '_');
                const fname = id + '_' + qcConvHHMMSS(src.timeAxis[si]) + '-' + qcConvHHMMSS(src.timeAxis[ei]) + '.txt';
                const blob = new Blob([text], { type: 'text/plain' });
                const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 2000);
                status.textContent = 'Saved ' + fname;
                qcConvClose();
            } catch (err) {
                status.textContent = 'Could not build the file: ' + ((err && err.message) || err);
            } finally { btn.disabled = false; }
        }, 30);
    }

    function qcConvBuildUI() {
        if (qcConvBuilt) return; qcConvBuilt = true;
        const m = document.createElement('div');
        m.id = 'qcConvModal'; m.className = 'modal-overlay';
        m.innerHTML =
            '<div class="modal-card qc-conv-card">' +
              '<button id="qcConvCloseX" class="qc-cmd-x" style="position:absolute;top:14px;right:14px" title="Close">✕</button>' +
              '<h2 class="text-ink text-lg font-bold border-b border-hairline pb-2">Convert Flight Data to Text (.txt)</h2>' +
              '<p class="qc-conv-note" id="qcConvNote"></p>' +
              '<div class="qc-conv-toprow">' +
                '<div class="qc-conv-timegroup">' +
                  '<div class="qc-conv-field"><label>Start time (HHMMSS)</label>' +
                    '<input id="qcConvStart" class="qc-ov-input qc-conv-time" maxlength="6" inputmode="numeric" placeholder="HHMMSS">' +
                    '<span class="qc-conv-hint" id="qcConvStartHint">5 min before takeoff</span></div>' +
                  '<div class="qc-conv-field"><label>End time (HHMMSS)</label>' +
                    '<input id="qcConvEnd" class="qc-ov-input qc-conv-time" maxlength="6" inputmode="numeric" placeholder="HHMMSS">' +
                    '<span class="qc-conv-hint">end of data</span></div>' +
                '</div>' +
                '<div class="qc-conv-field qc-conv-field-btn">' +
                  '<button id="qcConvResetTrim" class="qc-ov-btn" title="Reset the window to 5 minutes before takeoff through the end of the data">Reset Times to Default</button>' +
                '</div>' +
              '</div>' +
              '<div class="qc-conv-grid">' +
                '<div class="qc-conv-field"><label>Delimiter</label>' +
                  '<select id="qcConvDelim" class="qc-ov-input qc-conv-sel">' +
                    '<option value="comma" selected>Comma  ,</option><option value="tab">Tab</option>' +
                    '<option value="semicolon">Semicolon  ;</option><option value="space">Space</option>' +
                    '<option value="pipe">Pipe  |</option></select></div>' +
                '<div class="qc-conv-field"><label>Empty / gap cells</label>' +
                  '<select id="qcConvMissing" class="qc-ov-input qc-conv-sel">' +
                    '<option value="nan" selected>NaN</option>' +
                    '<option value="blank">Blank</option><option value="fill">-9999</option></select></div>' +
                '<div class="qc-conv-field"><label>Time column</label>' +
                  '<select id="qcConvTimeFmt" class="qc-ov-input qc-conv-sel">' +
                    '<option value="hhmmss" selected>HHMMSS (number)</option><option value="hms">HH:MM:SS</option>' +
                    '<option value="sec">Seconds since start</option><option value="none">No time column</option></select></div>' +
              '</div>' +
              '<div class="qc-conv-params-wrap">' +
                '<div class="qc-conv-params-head">' +
                  '<span class="qc-conv-params-title">Parameters <b id="qcConvCount"></b></span>' +
                  '<span class="qc-vdiv qc-vdiv-sm"></span>' +
                  '<span class="qc-conv-preset-label">Preset</span>' +
                  '<select id="qcConvPreset" class="qc-ov-input qc-conv-presetsel" title="Pick a saved preset to pre-check only its variables, or leave every variable checked"></select>' +
                  '<span class="qc-vdiv qc-vdiv-sm"></span>' +
                  '<input id="qcConvSearch" class="qc-ov-input qc-conv-search" placeholder="Search variables" autocomplete="off">' +
                  '<label class="qc-conv-showunsel" title="Uncheck to show only the currently-selected parameters"><input type="checkbox" id="qcConvShowUnsel" checked> Show unselected</label>' +
                '</div>' +
                '<div class="qc-conv-bulkrow">' +
                  '<button id="qcConvAll" class="qc-ov-btn" title="Select all shown">Select all</button>' +
                  '<button id="qcConvNone" class="qc-ov-btn" title="Clear all shown">Select none</button>' +
                '</div>' +
              '</div>' +
              '<div id="qcConvList" class="qc-conv-list" title="Click-drag across rows to check or uncheck them together; Shift+click sets a whole range"></div>' +
              '<div class="qc-conv-actions">' +
                '<span id="qcConvStatus" class="qc-conv-status"></span>' +
                '<button id="qcConvCancel" class="qc-ov-btn">Cancel</button>' +
                '<button id="qcConvDownload" class="qc-ov-btn qc-ov-btn-accent">Download .txt</button>' +
              '</div>' +
            '</div>';
        document.body.appendChild(m);

        // preset dropdown: "no preset" first, then each saved preset (built from the data, so
        // adding a preset above is all it takes to surface it here)
        const psel = document.getElementById('qcConvPreset');
        psel.innerHTML = '<option value="">No preset (all selected)</option>' +
            QC_CONV_PRESETS.map(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; return o.outerHTML; }).join('');
        psel.addEventListener('change', () => { qcConvPopulateList(); qcConvApplyVisibility(); qcConvUpdateCount(); });

        document.getElementById('qcConvCloseX').addEventListener('click', qcConvClose);
        document.getElementById('qcConvCancel').addEventListener('click', qcConvClose);
        m.addEventListener('click', e => { if (e.target === m) qcConvClose(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && m.style.display === 'flex') qcConvClose(); });
        document.getElementById('qcConvSearch').addEventListener('input', qcConvApplyVisibility);
        document.getElementById('qcConvShowUnsel').addEventListener('change', qcConvApplyVisibility);
        // delegated on the list container (not the rows), so it survives qcConvPopulateList rebuilding
        // #qcConvList's contents on every open, preset switch, or search
        document.getElementById('qcConvList').addEventListener('pointerdown', qcConvDragStart);
        document.getElementById('qcConvResetTrim').addEventListener('click', () => { qcConvSetDefaultTrim(); qcConvUpdateEstimate(); });
        [document.getElementById('qcConvStart'), document.getElementById('qcConvEnd'), document.getElementById('qcConvTimeFmt')]
            .forEach(el => el.addEventListener('input', qcConvUpdateEstimate));
        // Select all / none act on the currently-shown rows (search AND "Show unselected" both narrow
        // that), so you can filter then bulk-pick. With "Show unselected" off, "Select none" on the
        // shown (== selected) rows empties the view too -- that follows directly from the toggle's
        // own definition, not a bug.
        const setShown = checked => {
            document.querySelectorAll('#qcConvList .qc-conv-item').forEach(row => {
                if (row.style.display === 'none') return;
                const cb = row.querySelector('.qc-conv-cb'); if (cb) cb.checked = checked;
            });
            qcConvUpdateCount();
            qcConvApplyVisibility();
        };
        document.getElementById('qcConvAll').addEventListener('click', () => setShown(true));
        document.getElementById('qcConvNone').addEventListener('click', () => setShown(false));
        document.getElementById('qcConvDownload').addEventListener('click', qcConvDownload);
    }

    // called from qcInitUI (js/23) once the QC app shell exists: append the converter opener and the
    // raw-.nc download link (relocated from the mission loader console) to the BOTTOM of the Export
    // menu, under Share QC Link, past a separator. Both keep real button skins (.qc-ov-btn), not the
    // flat menu-item look. Not .qc-menu-item, so the menu's own close-on-click pass skips them --
    // each closes the menu itself. The link keeps its id, so its existing show/hide (archive
    // missions only, js/12b) and API-offline greying (js/02) still apply untouched. Safe to call
    // more than once.
    function qcInitNcTxtConverter() {
        const menu = document.getElementById('qcExportMenu');
        if (!menu || document.getElementById('qcConvBtn')) return;
        const sep = document.createElement('div'); sep.className = 'qc-menu-sep';
        menu.appendChild(sep);
        const row = document.createElement('div'); row.className = 'qc-menu-btnrow';
        menu.appendChild(row);
        const btn = document.createElement('button');
        // accent skin on both, so the pair reads blue like Share QC Link above them
        btn.id = 'qcConvBtn'; btn.type = 'button'; btn.className = 'qc-ov-btn qc-ov-btn-accent';
        btn.title = 'Convert this flight\'s data to a delimited .txt file (pick parameters, delimiter, and time window)';
        btn.textContent = 'NC → TXT (.txt)';
        btn.addEventListener('click', () => { menu.classList.add('hidden'); qcConvOpen(); });
        row.appendChild(btn);
        const link = document.getElementById('reconSourceLink');
        if (link) {
            link.className = 'qc-ov-btn qc-ov-btn-accent' + (link.classList.contains('hidden') ? ' hidden' : '');
            link.textContent = 'Download Original (.nc)';
            link.addEventListener('click', () => menu.classList.add('hidden'));
            row.appendChild(link);
        }
    }
