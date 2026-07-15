/* QC Mode, standalone interactive report export
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   Builds ONE self-contained .html file that mirrors the QC tool: the same stylesheet and
   bundled fonts, every family graph (zoom, pan, hover, legend, gap and check markers), the
   flight-track map with geography, the summary pills, per-graph badges, and the chip strips.
   Chart.js, the zoom plugin, hammer, the fonts, and app.css are all inlined, so the file opens
   anywhere with no internet and no flight load. Mission loading is left out (API). */

    function qcB64FromF32(arr) {
        const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        let s = '';
        for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
        return btoa(s);
    }
    async function qcFetchB64(url) {
        const buf = await (await fetch(url)).arrayBuffer();
        const u8 = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
        return btoa(s);
    }
    const qcHtmlOf = sel => { const el = document.querySelector(sel); return el ? el.innerHTML : ''; };

    // country and state outlines clipped to the flight's region (with margin), rounded to 3
    // decimals, so the exported map carries the same faint geography without the whole basemap
    function qcExportGeo(latArr, lonArr) {
        if (typeof mapFeatures === 'undefined' || !mapFeatures || !mapFeatures.length) return [];
        let mnLa = Infinity, mxLa = -Infinity, mnLo = Infinity, mxLo = -Infinity;
        for (let i = 0; i < latArr.length; i++) {
            const a = latArr[i], b = lonArr[i];
            if (Number.isNaN(a) || Number.isNaN(b)) continue;
            if (a < mnLa) mnLa = a; if (a > mxLa) mxLa = a; if (b < mnLo) mnLo = b; if (b > mxLo) mxLo = b;
        }
        if (mnLa === Infinity) return [];
        const mLa = (mxLa - mnLa) * 0.35 + 0.5, mLo = (mxLo - mnLo) * 0.35 + 0.5;
        const box = [mnLo - mLo, mnLa - mLa, mxLo + mLo, mxLa + mLa];
        const rings = [];
        const round = pts => pts.map(p => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]);
        mapFeatures.forEach(f => {
            const bb = f.properties && f.properties.bbox;
            if (bb && (bb[2] < box[0] || bb[0] > box[2] || bb[3] < box[1] || bb[1] > box[3])) return;
            const g = f.geometry; if (!g) return;
            if (g.type === 'Polygon') g.coordinates.forEach(r => rings.push(round(r)));
            else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => poly.forEach(r => rings.push(round(r))));
            else if (g.type === 'LineString') rings.push(round(g.coordinates));
            else if (g.type === 'MultiLineString') g.coordinates.forEach(r => rings.push(round(r)));
        });
        return rings;
    }

    // build one export panel from a family's live chart (a line graph, or the fused lat/lon map);
    // null when the family has no chart or folds into another panel
    function qcBuildExportPanel(fam) {
        if (fam.key === 'lon' && qcCharts['qc_latlon']) return null;   // folded into the lat map panel
        const isMap = fam.key === 'lat' && qcCharts['qc_latlon'];
        const chart = qcCharts[isMap ? 'qc_latlon' : 'qc_' + fam.key];
        if (!chart) return null;
        const pid = '#qcpanel_' + fam.key + ' ';
        const common = {
            key: fam.key, label: fam.label, unit: qcUnitLabel(fam.unit),
            headHtml: qcHtmlOf(pid + '.qc-chart-head'),
            issuesHtml: qcHtmlOf(pid + '.qc-issues'),
            legendHtml: (chart.$qcLegendBar && chart.$qcLegendBar.innerHTML) || '',
            bandHtml: qcHtmlOf(pid + '.qc-band-slot'),
            groups: (chart.$qcGroups || []).map(g => ({ label: g.label, names: g.names.slice() }))
        };
        if (isMap) {
            const tracks = chart.data.datasets.map(d => ({
                label: d.label, name: d.$qcName || d.label, color: String(d.borderColor),
                isRef: !!d.$qcIsRef, w: d.borderWidth || 1.4, on: chart.isDatasetVisible(chart.data.datasets.indexOf(d)) ? 1 : 0,
                pts: (d.data || []).map(p => [p.x, p.y, p.i])
            }));
            return Object.assign(common, {
                type: 'map', tracks: tracks,
                refLat: chart.$qcMapLat ? qcB64FromF32(chart.$qcMapLat) : null,
                refLon: chart.$qcMapLon ? qcB64FromF32(chart.$qcMapLon) : null,
                geo: chart.$qcMapLat && chart.$qcMapLon ? qcExportGeo(chart.$qcMapLat, chart.$qcMapLon) : []
            });
        }
        const series = [];
        chart.data.datasets.forEach((d, k) => {
            if (d.$qcBand || !d.$full) return;
            series.push({ label: d.label, name: d.$qcName || d.label, color: String(d.borderColor), dash: (d.borderDash && d.borderDash.length) ? 1 : 0, w: d.$qcBaseWidth || 1.4, on: chart.isDatasetVisible(k) ? 1 : 0, b64: qcB64FromF32(d.$full) });
        });
        if (!series.length) return null;
        const pack = list => (list || []).map(g => [g.fromIdx, g.toIdx]);
        return Object.assign(common, { type: 'line', series: series, gaps: pack(chart.$qcGapRanges), marks: pack(chart.$qcGapMarks), checks: pack(chart.$qcCheckMarks), allEmpty: !!chart.$qcAllEmpty });
    }

    const qcMissionSlug = () => String((flightMetaData && flightMetaData.id) || 'flight').replace(/\s*\([^)]*\)/g, '').trim();

    // shared assembly: inline the libs, app css, and bundled fonts, wrap the panels in the viewer
    // shell, and download the one self-contained file
    async function qcAssembleExport(panels, filename) {
        if (!panels.length) return;
        const scrub = /<\/script/gi;
        const inline = async p => (await (await fetch(p)).text()).replace(scrub, '<\\/script');
        const libs = (await Promise.all(['lib/chart.umd.min.js', 'lib/hammer.min.js', 'lib/chartjs-plugin-zoom.min.js'].map(inline))).join('\n;\n');
        const appCss = (await (await fetch('css/app.css')).text());
        const fontFiles = [['Manrope', '400 800', 'fonts/Manrope-400.woff2'], ['IBM Plex Mono', '400', 'fonts/IBMPlexMono-400.woff2'], ['IBM Plex Mono', '500', 'fonts/IBMPlexMono-500.woff2'], ['IBM Plex Mono', '600', 'fonts/IBMPlexMono-600.woff2']];
        const fontCss = (await Promise.all(fontFiles.map(async f =>
            "@font-face{font-family:'" + f[0] + "';font-style:normal;font-weight:" + f[1] + ";font-display:swap;src:url(data:font/woff2;base64," + await qcFetchB64(f[2]) + ") format('woff2');}"
        ))).join('\n');
        const payload = {
            theme: document.documentElement.dataset.theme || 'dark',
            mission: (flightMetaData && flightMetaData.id) || 'flight',
            date: (flightMetaData && flightMetaData.date) || '',
            aircraft: qcResult.aircraft || '',
            t0: Math.round(qcAxisRef[0]), n: qcAxisRef.length,
            toIdx: qcResult.phases ? qcResult.phases.toIdx : 0,
            landIdx: qcResult.phases ? qcResult.phases.landIdx : qcAxisRef.length - 1,
            summaryHtml: qcHtmlOf('#qcSummaryPills'),
            icons: (typeof QC_TOOL_ICONS !== 'undefined') ? QC_TOOL_ICONS : {},
            panels: panels
        };
        const html = qcExportHtmlShell(libs, appCss, fontCss, payload.theme, JSON.stringify(payload).replace(scrub, '<\\/script'));
        const blob = new Blob([html], { type: 'text/html' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    // the whole report: every family graph plus the flight-track map, one interactive file
    async function qcExportInteractiveHTML() {
        if (!qcResult || !qcAxisRef || !qcAxisRef.length) return;
        const btn = document.getElementById('qcExportHtmlBtn');
        if (btn) btn.textContent = 'Building file...';
        try {
            const panels = [];
            (qcResult.families || []).forEach(fam => { const p = qcBuildExportPanel(fam); if (p) panels.push(p); });
            await qcAssembleExport(panels, qcMissionSlug() + '_QC_Interactive.html');
        } catch (e) { console.warn('interactive export failed:', e); }
        if (btn) btn.textContent = 'Interactive Report (.html)';
    }

    // one graph on its own, downloaded as the same self-contained interactive file (the per-graph
    // download button, so a single graph travels with zoom, pan, hover, and the playhead intact)
    async function qcExportSingleGraphHTML(famKey) {
        if (!qcResult || !qcAxisRef || !qcAxisRef.length || !famKey) return;
        const key = (famKey === 'lon' && qcCharts['qc_latlon']) ? 'lat' : famKey;
        const fam = (qcResult.families || []).find(f => f.key === key);
        if (!fam) return;
        try {
            const p = qcBuildExportPanel(fam);
            if (p) await qcAssembleExport([p], qcMissionSlug() + '_' + key + '_Interactive.html');
        } catch (e) { console.warn('single graph export failed:', e); }
    }

    // the exported page: the app's own stylesheet and fonts, plus a thin frame for the report
    function qcExportHtmlShell(libs, appCss, fontCss, theme, dataJson) {
        const frame = [
            ".qcx-body { margin:0; padding-bottom:24px; background:var(--bg); color:var(--text); font-family:'Manrope',ui-sans-serif,system-ui,sans-serif; }",
            ".qcx-top { position:sticky; top:0; z-index:20; display:flex; align-items:center; gap:14px; flex-wrap:wrap; padding:9px 16px; background:var(--panel); border-bottom:1px solid var(--border); }",
            ".qcx-top h1 { margin:0; font-size:14px; font-weight:700; color:var(--accent); }",
            ".qcx-sub { font-size:11px; color:var(--text-muted); font-family:'IBM Plex Mono',monospace; }",
            ".qcx-clock { margin-left:auto; font-family:'IBM Plex Mono',monospace; font-size:13px; font-weight:700; color:var(--accent); }",
            ".qcx-pills { display:flex; flex-wrap:wrap; gap:6px; padding:9px 16px 0; }",
            ".qcx-charts { padding:12px clamp(16px,4vw,90px); display:flex; flex-direction:column; gap:12px; }",
            ".qcx-note { font-size:10px; color:var(--text-faint); font-family:'IBM Plex Mono',monospace; margin:2px 0 0; }",
            ".qc-chart-panel { flex:none; }"
        ].join('\n');
        return '<!DOCTYPE html><html data-theme="' + (theme === 'light' ? 'light' : 'dark') + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
            '<title>QC Interactive Report</title><style>' + fontCss + '\n' + appCss + '\n' + frame + '</style></head><body class="qcx-body">' +
            '<script>' + libs + '<\/script>' +
            '<script id="qcx-data" type="application/json">' + dataJson + '<\/script>' +
            '<div class="qcx-top"><h1 id="ttl"></h1><span class="qcx-sub" id="sub"></span><span class="qcx-clock" id="clock">--:--:--</span></div>' +
            '<div class="qcx-pills" id="pills"></div>' +
            '<div class="qcx-charts" id="charts"></div>' +
            '<script>' + qcExportViewerSrc() + '<\/script></body></html>';
    }

    // viewer source, kept as one plain string so nothing here runs in the app itself
    function qcExportViewerSrc() {
        return [
"var QCX = JSON.parse(document.getElementById('qcx-data').textContent);",
"var LIGHT = QCX.theme === 'light';",
"document.documentElement.dataset.theme = QCX.theme;",
"function f32(b64){ var s=atob(b64), u=new Uint8Array(s.length); for(var i=0;i<s.length;i++)u[i]=s.charCodeAt(i); return new Float32Array(u.buffer); }",
"function hms(sec){ var s=Math.round(sec)%86400; if(s<0)s+=86400; var h=Math.floor(s/3600),m=Math.floor(s%3600/60),ss=s%60; return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0'); }",
"function lbl(i){ return hms(QCX.t0+i); }",
"function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }",
"var PLAY={i:QCX.toIdx}, charts=[], maps=[];",
// min/max decimation, matching the app so spikes and gap breaks survive
"function decim(a,start,end){ start=Math.max(0,Math.floor(start)); end=Math.min(a.length-1,Math.ceil(end)); var span=end-start+1, out=[];",
"  if(span<=2400){ for(var i=start;i<=end;i++) out.push({x:i,y:isNaN(a[i])?NaN:a[i]}); return out; }",
"  var bs=span/1200;",
"  for(var b=0;b<1200;b++){ var s=start+Math.floor(b*bs), e=Math.min(end,start+Math.floor((b+1)*bs)-1);",
"    var mn=Infinity,mx=-Infinity,mi=-1,xi=-1,gap=false;",
"    for(var i=s;i<=e;i++){ var v=a[i]; if(isNaN(v)){gap=true;continue;} if(v<mn){mn=v;mi=i;} if(v>mx){mx=v;xi=i;} }",
"    if(mi<0){ out.push({x:s,y:NaN}); continue; }",
"    if(mi<=xi){ out.push({x:mi,y:mn}); if(xi!==mi) out.push({x:xi,y:mx}); } else { out.push({x:xi,y:mx}); out.push({x:mi,y:mn}); }",
"    if(gap) out.push({x:e+0.5,y:NaN});",
"  } return out; }",
// family overlay: gap and check shading + fixed carets + takeoff/landing + playhead, like the app
"var overlay={id:'ov',afterDraw:function(ch){ var xa=ch.scales.x, a=ch.chartArea, ctx=ch.ctx; if(!a) return; ctx.save();",
"  function fill(list,color,minw){ ctx.fillStyle=color; (list||[]).forEach(function(g){ var x0=xa.getPixelForValue(g[0]),x1=xa.getPixelForValue(g[1]); if(x1<a.left||x0>a.right)return; var L=Math.max(x0,a.left); ctx.fillRect(L,a.top,Math.max(minw,Math.min(x1,a.right)-L),a.bottom-a.top); }); }",
"  var merged=(ch.$gaps||[]).concat(ch.$marks||[]).slice().sort(function(p,q){return p[0]-q[0];}).reduce(function(acc,g){ var m=acc[acc.length-1]; if(m&&g[0]<=m[1]){ if(g[1]>m[1])m[1]=g[1]; } else acc.push([g[0],g[1]]); return acc; },[]);",
"  fill(merged,'rgba(240,190,60,0.10)',2); fill(ch.$checks,'rgba(234,84,85,0.14)',4);",
"  function carets(list,color,word){ ctx.fillStyle=color; ctx.font=\"8px 'IBM Plex Mono',monospace\"; ctx.textAlign='center'; ctx.textBaseline='top'; var lastX=-1e9; (list||[]).forEach(function(g){ var x0=Math.max(xa.getPixelForValue(g[0]),a.left),x1=Math.min(xa.getPixelForValue(g[1]),a.right); if(x1<x0)return; var cx=(x0+x1)/2; ctx.beginPath(); ctx.moveTo(cx-5,a.top+1); ctx.lineTo(cx+5,a.top+1); ctx.lineTo(cx,a.top+9); ctx.closePath(); ctx.fill(); if(word&&cx-lastX>=22){ ctx.fillText(word,cx,a.top+11); lastX=cx; } }); ctx.textAlign='left'; }",
"  carets(merged, LIGHT?'rgba(170,120,20,0.95)':'rgba(240,190,60,0.95)','');",
"  carets(ch.$checks, LIGHT?'rgba(198,40,40,0.95)':'rgba(234,84,85,0.95)','check');",
"  if(ch.$allEmpty){ ctx.fillStyle=LIGHT?'rgba(71,85,105,0.7)':'rgba(148,163,184,0.7)'; ctx.font=\"700 26px 'IBM Plex Mono',monospace\"; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('NO DATA',(a.left+a.right)/2,(a.top+a.bottom)/2); ctx.textAlign='left'; ctx.textBaseline='alphabetic'; }",
"  var faint=LIGHT?'rgba(71,85,105,0.45)':'rgba(148,163,184,0.4)'; ctx.strokeStyle=faint; ctx.fillStyle=faint; ctx.lineWidth=1; ctx.setLineDash([2,3]); ctx.font=\"8.5px 'IBM Plex Mono',monospace\"; ctx.textBaseline='top';",
"  [[QCX.toIdx,'takeoff'],[QCX.landIdx,'landing']].forEach(function(mk){ var x=xa.getPixelForValue(mk[0]); if(x<a.left||x>a.right)return; ctx.beginPath(); ctx.moveTo(x,a.top); ctx.lineTo(x,a.bottom); ctx.stroke(); ctx.fillText(mk[1],Math.min(x+3,a.right-42),a.top+2); }); ctx.setLineDash([]);",
"  var px=xa.getPixelForValue(PLAY.i); if(px>=a.left&&px<=a.right){ ctx.strokeStyle=LIGHT?'#0f172a':'#ffffff'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(px,a.top); ctx.lineTo(px,a.bottom); ctx.stroke(); }",
"  ctx.restore(); }};",
// map overlay: faint geography under the tracks, takeoff/landing/playhead dots on top
"function mapOverlay(geo,refLa,refLo){ return {id:'mov', beforeDatasetsDraw:function(ch){ var a=ch.chartArea,x=ch.scales.x,y=ch.scales.y,ctx=ch.ctx; if(!a||!geo||!geo.length)return; ctx.save(); ctx.beginPath(); ctx.rect(a.left,a.top,a.right-a.left,a.bottom-a.top); ctx.clip(); ctx.strokeStyle=LIGHT?'rgba(71,85,105,0.28)':'rgba(148,163,184,0.16)'; ctx.lineWidth=1; geo.forEach(function(r){ ctx.beginPath(); for(var i=0;i<r.length;i++){ var px=x.getPixelForValue(r[i][0]),py=y.getPixelForValue(r[i][1]); if(i)ctx.lineTo(px,py); else ctx.moveTo(px,py);} ctx.stroke(); }); ctx.restore(); },",
"  afterDraw:function(ch){ var a=ch.chartArea,x=ch.scales.x,y=ch.scales.y,ctx=ch.ctx; if(!a||!refLa)return; function dot(i,fill,r){ if(i==null||i<0||i>=refLa.length)return; var la=refLa[i],lo=refLo[i]; if(isNaN(la)||isNaN(lo))return; var px=x.getPixelForValue(lo),py=y.getPixelForValue(la); if(px<a.left||px>a.right||py<a.top||py>a.bottom)return; ctx.beginPath(); ctx.arc(px,py,r,0,2*Math.PI); ctx.fillStyle=fill; ctx.fill(); ctx.strokeStyle=LIGHT?'#ffffff':'#0d1117'; ctx.lineWidth=1.4; ctx.stroke(); } dot(QCX.toIdx,'#28c76f',4); dot(QCX.landIdx,'#ea5455',4); dot(PLAY.i,LIGHT?'#0f172a':'#ffffff',5); } }; }",
"function refresh(ch){ var x=ch.scales.x; ch.data.datasets.forEach(function(ds){ if(ds.$full) ds.data=decim(ds.$full,x.min,x.max); }); ch.update('none'); }",
"function setPlay(i){ PLAY.i=Math.max(0,Math.min(QCX.n-1,Math.round(i))); document.getElementById('clock').textContent=lbl(PLAY.i)+' UTC'; charts.forEach(function(c){ c.draw(); }); maps.forEach(function(c){ c.draw(); }); }",
"var tickColor=function(){ return LIGHT?'#475569':'#94a3b8'; };",
"var MONO={family:\"'IBM Plex Mono', monospace\",size:10};",
// wire a captured legend: variable items toggle their series, group chips toggle their set
"function wireLegend(panelEl, ch){",
"  panelEl.querySelectorAll('.qc-lg-item').forEach(function(it){ var sp=it.querySelector('span:not([class])'); var label=sp?sp.textContent:''; var k=ch.data.datasets.findIndex(function(d){return d.label===label;}); if(k<0)return;",
"    it.style.cursor='pointer'; it.addEventListener('click', function(){ var on=!ch.isDatasetVisible(k); ch.setDatasetVisibility(k,on); ch.update('none'); it.classList.toggle('off',!on); var box=it.querySelector('.qc-lg-box'); if(box){ box.classList.toggle('off',!on); box.style.background=on?String(ch.data.datasets[k].borderColor):''; box.style.borderColor=on?String(ch.data.datasets[k].borderColor):''; } }); });",
"  panelEl.querySelectorAll('.qc-lg-chip').forEach(function(chip){ var g=(ch.$groups||[]).find(function(x){return x.label===chip.textContent;}); if(!g)return;",
"    chip.style.cursor='pointer'; chip.addEventListener('click', function(){ var idx=g.names.map(function(nm){return ch.data.datasets.findIndex(function(d){return (d.$qcName||d.label)===nm;});}).filter(function(x){return x>=0;}); var allOn=idx.length>0&&idx.every(function(k){return ch.isDatasetVisible(k);}); idx.forEach(function(k){ch.setDatasetVisibility(k,!allOn);}); ch.update('none'); chip.classList.toggle('active',!allOn);",
"      idx.forEach(function(k){ var d=ch.data.datasets[k]; panelEl.querySelectorAll('.qc-lg-item').forEach(function(it){ var sp=it.querySelector('span:not([class])'); if(sp&&sp.textContent===d.label){ it.classList.toggle('off',allOn); var box=it.querySelector('.qc-lg-box'); if(box){ box.classList.toggle('off',allOn); box.style.background=allOn?'':String(d.borderColor); box.style.borderColor=allOn?'':String(d.borderColor);} } }); }); }); });",
"}",
// clickable switch times inside a captured head badge
"function wireHead(panelEl){ panelEl.querySelectorAll('.qc-ref-jump').forEach(function(el){ el.style.cursor='pointer'; el.addEventListener('click', function(){ var i=parseInt(el.dataset.idx,10); if(!isNaN(i)) setPlay(i); }); });",
"  panelEl.querySelectorAll('.qc-ref-morebtn').forEach(function(b){ b.style.cursor='pointer'; b.addEventListener('click', function(){ var badge=b.closest('.qc-switch-badge'); if(!badge)return; var open=badge.classList.toggle('qc-switch-open'); b.textContent=open?'less':(b.dataset.n||''); }); }); }",
// per-graph tools matching the app: scrub / pan / select zoom, plus a floating reset, png, fullscreen
"function zoomVisual(ch){ var z=false; try{z=ch.isZoomedOrPanned();}catch(e){} if(ch.$resetBtn) ch.$resetBtn.classList.toggle('show',z); }",
"function doReset(ch,home,isMap){ try{ch.resetZoom('none');}catch(e){} ch.zoomScale('x',home.x,'none'); if(isMap&&home.y) ch.zoomScale('y',home.y,'none'); refresh(ch); zoomVisual(ch); if(ch.$resetBtn) ch.$resetBtn.classList.remove('show'); if(ch.$selectTool) ch.$selectTool(isMap?'pan':'scrub'); }",
"function toolbar(ch, home, isMap){ var tb=document.createElement('div'); tb.className='qc-chart-tools';",
"  function mk(icon,label,title){ var b=document.createElement('button'); b.type='button'; b.className='qc-tool'; b.innerHTML=(QCX.icons[icon]||'')+'<span>'+label+'</span>'; b.title=title; tb.appendChild(b); return b; }",
"  var scrubBtn=isMap?null:mk('scrub','scrub','Drag anywhere on the graph and the playhead follows the cursor');",
"  var pan=mk('pan','pan',isMap?'Drag moves the map, wheel zooms':'Drag moves the time window, wheel zooms');",
"  var box=mk('box','select zoom','Drag a box to zoom into that area');",
"  var btns=scrubBtn?[scrubBtn,pan,box]:[pan,box];",
"  function tool(t){ ch.$tool=t; var z=ch.options.plugins.zoom; z.pan.enabled=(t==='pan'); z.zoom.drag.enabled=(t==='box'); z.zoom.mode=(t==='box'||isMap)?'xy':'x'; ch.canvas.style.cursor=(t==='scrub'?'ew-resize':t==='pan'?'grab':'crosshair'); btns.forEach(function(b){ b.classList.toggle('active', b===(t==='pan'?pan:t==='box'?box:scrubBtn)); }); ch.update('none'); }",
"  if(scrubBtn) scrubBtn.addEventListener('click',function(){tool('scrub');}); pan.addEventListener('click',function(){tool('pan');}); box.addEventListener('click',function(){tool('box');});",
"  ch.$selectTool=tool; tool(isMap?'pan':'scrub'); return tb; }",
"function cornerTools(ch, wrap, name){ var c=document.createElement('div'); c.className='qc-graph-corner';",
"  var png=document.createElement('button'); png.type='button'; png.className='qc-fs-btn'; png.innerHTML=QCX.icons.png||'PNG'; png.title='Save this graph as a PNG image';",
"  png.addEventListener('click',function(){ try{ var a=document.createElement('a'); a.href=ch.toBase64Image(); a.download=name; a.click(); }catch(e){} });",
"  var fs=document.createElement('button'); fs.type='button'; fs.className='qc-fs-btn'; fs.textContent='\\u26f6'; fs.title='Fullscreen this graph';",
"  fs.addEventListener('click',function(){ var t=ch.canvas.closest('.qc-chart-panel')||ch.canvas.parentElement; if(!t)return; if(document.fullscreenElement===t){ if(document.exitFullscreen)document.exitFullscreen(); } else if(t.requestFullscreen) t.requestFullscreen(); });",
"  c.appendChild(png); c.appendChild(fs); wrap.appendChild(c); }",
"function resetFloat(ch, wrap, home, isMap){ var b=document.createElement('button'); b.type='button'; b.className='qc-reset-float'; b.textContent='\\u27f2 Reset Zoom'; b.title='Zoom back out to the full view (double-click the graph too)'; b.addEventListener('click',function(){ doReset(ch,home,isMap); }); wrap.appendChild(b); ch.$resetBtn=b; }",
// build every panel in catalog order
"QCX.panels.forEach(function(p){",
"  var panel=document.createElement('div'); panel.className='qc-chart-panel'; panel.id='qcxp_'+p.key;",
"  var head=document.createElement('div'); head.className='qc-chart-head'; head.innerHTML=p.headHtml; panel.appendChild(head);",
"  if(p.issuesHtml){ var iss=document.createElement('div'); iss.className='qc-issues'; iss.innerHTML=p.issuesHtml; panel.appendChild(iss); }",
"  var barRow=document.createElement('div'); barRow.className='qc-graph-bar'; var tools=document.createElement('div'); tools.className='qc-graph-tools-group'; barRow.appendChild(document.createElement('span')); barRow.appendChild(tools); panel.appendChild(barRow);",
"  if(p.legendHtml){ var lg=document.createElement('div'); lg.className='qc-legend-bar'; lg.innerHTML=p.legendHtml; panel.appendChild(lg); }",
"  var wrap=document.createElement('div'); wrap.className='qc-canvas-wrap'+(p.type==='map'?' qc-canvas-map':''); var cv=document.createElement('canvas'); wrap.appendChild(cv); panel.appendChild(wrap);",
"  if(p.bandHtml){ var bottom=document.createElement('div'); bottom.className='qc-fam-bottom'; var slot=document.createElement('div'); slot.className='qc-band-slot'; slot.innerHTML=p.bandHtml; bottom.appendChild(slot); panel.appendChild(bottom); }",
"  document.getElementById('charts').appendChild(panel);",
"  p.__panelEl=panel; p.__tools=tools; p.__wrap=wrap; p.__legend=panel.querySelector('.qc-legend-bar');",
"  if(p.type==='map') buildMap(p); else buildLine(p);",
"  wireHead(panel);",
"});",
// a family line graph
"function buildLine(p){",
"  var dsets=p.series.map(function(s){ var full=f32(s.b64); return { label:s.label, $qcName:s.name, data:decim(full,0,QCX.n-1), $full:full, parsing:false, normalized:true, borderColor:s.color, borderWidth:s.w, borderDash:s.dash?[4,3]:[], pointRadius:0, pointHitRadius:6, spanGaps:false, fill:false, tension:0, hidden:!s.on }; });",
"  var home={x:{min:0,max:QCX.n-1}};",
"  var ch=new Chart(p.__panelEl.querySelector('canvas'),{ type:'line', data:{datasets:dsets}, options:{",
"    responsive:true, maintainAspectRatio:false, animation:false, interaction:{mode:'nearest',axis:'xy',intersect:false},",
"    onClick:function(e,els,c){ if(c.$tool==='scrub')return; if(e.native&&c.$downX!=null&&(Math.abs(e.native.clientX-c.$downX)>5||Math.abs(e.native.clientY-c.$downY)>5))return; var v=c.scales.x.getValueForPixel(e.x); if(v!=null) setPlay(v); },",
"    scales:{ x:{type:'linear',bounds:'data',grid:{color:'rgba(148,163,184,0.08)'},ticks:Object.assign({maxTicksLimit:10,callback:function(v){return lbl(Math.round(v));}},{color:tickColor(),font:MONO})},",
"             y:{type:'linear',position:'left',grid:{color:'rgba(148,163,184,0.10)'},ticks:{color:tickColor(),font:MONO},title:{display:true,text:p.label+' ('+p.unit+')',color:tickColor(),font:{family:\"'Manrope', sans-serif\",size:11,weight:'600'}}, afterDataLimits:function(s){ var o=s.options; if(typeof o.min==='number'||typeof o.max==='number')return; var r=s.max-s.min; if(r>0&&isFinite(r)) s.max+=r*0.10; }} },",
"    plugins:{ legend:{display:false},",
"      tooltip:{ bodyFont:{family:\"'IBM Plex Mono', monospace\",size:11,weight:'700'}, footerFont:{family:\"'IBM Plex Mono', monospace\",size:10}, footerColor:'#94a3b8', callbacks:{ title:function(it){return it.length?lbl(Math.round(it[0].parsed.x))+' UTC':'';}, label:function(it){ var y=it.parsed.y; return (it.dataset.label||'')+': '+(y===y?Math.round(y*1000)/1000:'no data'); }, footer:function(items){ if(!items.length)return''; var it=items[0], c=it.chart, i=Math.round(it.parsed.x), out=[]; c.data.datasets.forEach(function(d,k){ if(k===it.datasetIndex||!d.$full||!c.isDatasetVisible(k))return; var v=d.$full[i]; out.push((d.label||'')+': '+(v===v?Math.round(v*1000)/1000:'no data')); }); return out; } } },",
"      zoom:{ zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'x',drag:{enabled:false,backgroundColor:'rgba(91,157,255,0.14)',borderColor:'#5b9dff',borderWidth:1},onZoomComplete:function(o){refresh(o.chart); zoomVisual(o.chart);}}, pan:{enabled:true,mode:'x',onPanComplete:function(o){refresh(o.chart); zoomVisual(o.chart);}}, limits:{x:{min:'original',max:'original'}} } } }, plugins:[overlay]});",
"  ch.$gaps=p.gaps; ch.$marks=p.marks; ch.$checks=p.checks; ch.$allEmpty=p.allEmpty; ch.$groups=p.groups; charts.push(ch);",
"  var cv=p.__wrap.querySelector('canvas');",
"  cv.addEventListener('dblclick',function(){ doReset(ch,home,false); });",
"  var scrubbing=false;",
"  cv.addEventListener('mousedown',function(e){ ch.$downX=e.clientX; ch.$downY=e.clientY; });",
"  cv.addEventListener('mousedown',function(e){ if(ch.$tool!=='scrub'||!ch.chartArea)return; var r=cv.getBoundingClientRect(),a=ch.chartArea,px=e.clientX-r.left,py=e.clientY-r.top; if(px<a.left||px>a.right||py<a.top||py>a.bottom)return; scrubbing=true; setPlay(ch.scales.x.getValueForPixel(px)); });",
"  window.addEventListener('mousemove',function(e){ if(!scrubbing||!ch.chartArea)return; var r=cv.getBoundingClientRect(),a=ch.chartArea,px=Math.max(a.left,Math.min(a.right,e.clientX-r.left)); setPlay(ch.scales.x.getValueForPixel(px)); });",
"  window.addEventListener('mouseup',function(){ scrubbing=false; });",
"  p.__tools.appendChild(toolbar(ch,home,false)); cornerTools(ch,p.__wrap,(p.label||'graph')+'.png'); resetFloat(ch,p.__wrap,home,false);",
"  if(p.__legend) wireLegend(p.__legend,ch);",
"}",
// the fused flight-track map
"function buildMap(p){",
"  var mnx=Infinity,mxx=-Infinity,mny=Infinity,mxy=-Infinity;",
"  p.tracks.forEach(function(t){ t.pts.forEach(function(pt){ if(isNaN(pt[0])||isNaN(pt[1]))return; if(pt[0]<mnx)mnx=pt[0]; if(pt[0]>mxx)mxx=pt[0]; if(pt[1]<mny)mny=pt[1]; if(pt[1]>mxy)mxy=pt[1]; }); });",
"  if(mnx===Infinity){ mnx=-100;mxx=-60;mny=0;mxy=40; }",
"  var padX=Math.max(0.2,(mxx-mnx)*0.08), padY=Math.max(0.2,(mxy-mny)*0.08);",
"  var home={x:{min:mnx-padX,max:mxx+padX},y:{min:mny-padY,max:mxy+padY}};",
"  var dsets=p.tracks.map(function(t){ return { label:t.label, $qcName:t.name, $qcIsRef:t.isRef, data:t.pts.map(function(pt){return {x:pt[0],y:pt[1],i:pt[2]};}), borderColor:t.color, borderWidth:t.w, pointRadius:0, pointHitRadius:6, fill:false, showLine:true, spanGaps:false, tension:0, hidden:!t.on }; });",
"  var refLa=p.refLat?f32(p.refLat):null, refLo=p.refLon?f32(p.refLon):null;",
"  var ax=function(t){return {display:true,text:t,color:tickColor(),font:{family:\"'Manrope', sans-serif\",size:11,weight:'600'}};};",
"  var ch=new Chart(p.__panelEl.querySelector('canvas'),{ type:'scatter', data:{datasets:dsets}, options:{",
"    responsive:true, maintainAspectRatio:false, animation:false, interaction:{mode:'nearest',axis:'xy',intersect:false},",
"    onClick:function(e,els,c){ if(e.native&&c.$downX!=null&&(Math.abs(e.native.clientX-c.$downX)>5||Math.abs(e.native.clientY-c.$downY)>5))return; var best=null,bd=18; c.data.datasets.forEach(function(d,k){ if(!c.isDatasetVisible(k))return; d.data.forEach(function(pt){ if(pt.i==null||isNaN(pt.x))return; var dist=Math.hypot(c.scales.x.getPixelForValue(pt.x)-e.x,c.scales.y.getPixelForValue(pt.y)-e.y); if(dist<bd){bd=dist;best=pt;} }); }); if(best) setPlay(best.i); },",
"    scales:{ x:{type:'linear',min:mnx-padX,max:mxx+padX,grid:{color:'rgba(148,163,184,0.08)'},ticks:{maxTicksLimit:9,color:tickColor(),font:MONO},title:ax('Longitude (degrees)')},",
"             y:{type:'linear',min:mny-padY,max:mxy+padY,grid:{color:'rgba(148,163,184,0.10)'},ticks:{color:tickColor(),font:MONO},title:ax('Latitude (degrees)')} },",
"    plugins:{ legend:{display:false},",
"      tooltip:{ bodyFont:{family:\"'IBM Plex Mono', monospace\",size:11,weight:'700'}, callbacks:{ title:function(items){return (items.length&&items[0].raw&&items[0].raw.i!=null)?(lbl(items[0].raw.i)+' UTC'):'';}, label:function(it){ return (it.dataset.label||'')+': '+Math.round(it.parsed.y*10000)/10000+', '+Math.round(it.parsed.x*10000)/10000; } } },",
"      zoom:{ zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'xy',drag:{enabled:false,backgroundColor:'rgba(91,157,255,0.14)',borderColor:'#5b9dff',borderWidth:1},onZoomComplete:function(o){o.chart.update('none'); zoomVisual(o.chart);}}, pan:{enabled:true,mode:'xy',onPanComplete:function(o){o.chart.update('none'); zoomVisual(o.chart);}} } } }, plugins:[mapOverlay(p.geo,refLa,refLo)]});",
"  ch.$groups=p.groups; maps.push(ch);",
"  var cv=p.__wrap.querySelector('canvas');",
"  cv.addEventListener('mousedown',function(e){ ch.$downX=e.clientX; ch.$downY=e.clientY; });",
"  cv.addEventListener('dblclick',function(){ doReset(ch,home,true); });",
"  p.__tools.appendChild(toolbar(ch,home,true)); cornerTools(ch,p.__wrap,'flight-track.png'); resetFloat(ch,p.__wrap,home,true);",
"  if(p.__legend) wireLegend(p.__legend,ch);",
"}",
"document.getElementById('ttl').textContent='QC Interactive Report \\u00b7 '+QCX.mission;",
"document.getElementById('sub').textContent=(QCX.date?QCX.date+' \\u00b7 ':'')+(QCX.aircraft?'airframe '+QCX.aircraft+' \\u00b7 ':'')+'takeoff '+lbl(QCX.toIdx)+' \\u00b7 landing '+lbl(QCX.landIdx);",
"document.getElementById('pills').innerHTML=QCX.summaryHtml;",
"document.addEventListener('keydown',function(e){ if(e.key==='ArrowLeft'||e.key==='ArrowRight'){ e.preventDefault(); setPlay(PLAY.i+(e.shiftKey?10:1)*(e.key==='ArrowLeft'?-1:1)); } });",
"setPlay(QCX.toIdx);"
        ].join('\n');
    }
