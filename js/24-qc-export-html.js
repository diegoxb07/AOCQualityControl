/* QC Mode, standalone interactive report export
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   Builds ONE self-contained .html file: every family graph (zoom, pan, hover, legend), the gap
   and check shading with their markers, the flight track with a synced playhead, the summary
   pills, per-graph badges, and the chip strips. Chart.js, the zoom plugin, and hammer are
   inlined, so the file opens anywhere with no internet and no flight load. */

    function qcB64FromF32(arr) {
        const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        let s = '';
        for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
        return btoa(s);
    }

    // lat/lon per axis second, sampled from the player rows (nearest row at or after the second),
    // so the exported track matches the in-app 2d tracker without guessing variable names
    function qcExportTrack() {
        if (typeof filteredData === 'undefined' || !filteredData || !filteredData.length || !qcAxisRef) return null;
        const n = qcAxisRef.length;
        const lat = new Float32Array(n), lon = new Float32Array(n);
        let r = 0;
        for (let i = 0; i < n; i++) {
            const sec = Math.round(qcAxisRef[i]);
            while (r < filteredData.length - 1 && filteredData[r].absSeconds < sec) r++;
            const row = filteredData[r];
            lat[i] = (row && isFinite(row.lat)) ? row.lat : NaN;
            lon[i] = (row && isFinite(row.lon)) ? row.lon : NaN;
        }
        return { lat: qcB64FromF32(lat), lon: qcB64FromF32(lon) };
    }

    async function qcExportInteractiveHTML() {
        if (!qcResult || !qcAxisRef || !qcAxisRef.length) return;
        const btn = document.getElementById('qcExportHtmlBtn');
        if (btn) btn.textContent = 'Building file...';
        try {
            // the vendored libs ride inside the file; </script tags inside them must not close ours
            const inline = async p => (await (await fetch(p)).text()).replace(/<\/script/gi, '<\\/script');
            const libs = (await Promise.all(['lib/chart.umd.min.js', 'lib/hammer.min.js', 'lib/chartjs-plugin-zoom.min.js'].map(inline))).join('\n;\n');

            const fams = [];
            (qcResult.families || []).forEach(fam => {
                const chart = qcCharts['qc_' + fam.key];
                if (!chart) return;
                const head = document.querySelector('#qcpanel_' + fam.key + ' .qc-chart-head');
                const issues = document.querySelector('#qcpanel_' + fam.key + ' .qc-issues');
                const series = [];
                chart.data.datasets.forEach((d, k) => {
                    if (d.$qcBand || !d.$full) return;
                    series.push({
                        label: d.label, color: String(d.borderColor),
                        dash: (d.borderDash && d.borderDash.length) ? 1 : 0,
                        w: d.$qcBaseWidth || 1.4,
                        on: chart.isDatasetVisible(k) ? 1 : 0,
                        b64: qcB64FromF32(d.$full)
                    });
                });
                if (!series.length) return;
                const pack = list => (list || []).map(g => [g.fromIdx, g.toIdx]);
                fams.push({
                    key: fam.key, label: fam.label, unit: qcUnitLabel(fam.unit),
                    headHtml: head ? head.innerHTML : '', issuesHtml: issues ? issues.innerHTML : '',
                    gaps: pack(chart.$qcGapRanges), marks: pack(chart.$qcGapMarks), checks: pack(chart.$qcCheckMarks),
                    series: series
                });
            });
            if (!fams.length) { if (btn) btn.textContent = 'Interactive Report (.html)'; return; }

            const payload = {
                mission: (flightMetaData && flightMetaData.id) || 'flight',
                date: (flightMetaData && flightMetaData.date) || '',
                aircraft: qcResult.aircraft || '',
                t0: Math.round(qcAxisRef[0]), n: qcAxisRef.length,
                toIdx: qcResult.phases ? qcResult.phases.toIdx : 0,
                landIdx: qcResult.phases ? qcResult.phases.landIdx : qcAxisRef.length - 1,
                summaryHtml: (document.getElementById('qcSummaryPills') || { innerHTML: '' }).innerHTML,
                track: qcExportTrack(),
                fams: fams
            };

            const html = qcExportHtmlShell(libs, JSON.stringify(payload).replace(/<\/script/gi, '<\\/script'));
            const blob = new Blob([html], { type: 'text/html' });
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
            a.download = payload.mission + '_QC_Interactive.html'; a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        } catch (e) { console.warn('interactive export failed:', e); }
        if (btn) btn.textContent = 'Interactive Report (.html)';
    }

    // the exported page: dark, self-contained, system fonts. the viewer reimplements the QC
    // graph essentials (min/max decimation, gap pillars and markers, playhead, track) compactly.
    function qcExportHtmlShell(libs, dataJson) {
        const css = [
            "body { margin:0; background:#0d1117; color:#e2e8f0; font-family:ui-sans-serif,system-ui,sans-serif; }",
            ".top { position:sticky; top:0; z-index:5; display:flex; align-items:center; gap:14px; flex-wrap:wrap; padding:10px 16px; background:#161b22; border-bottom:1px solid #30363d; }",
            ".top h1 { margin:0; font-size:15px; color:#7ad9ff; font-weight:700; }",
            ".top .sub { font-size:11px; color:#8b949e; }",
            ".clock { margin-left:auto; font-family:ui-monospace,monospace; font-size:13px; color:#7ad9ff; font-weight:700; }",
            ".pills { padding:8px 16px 0; font-size:11px; color:#8b949e; }",
            ".pills .qc-pill { display:inline-block; font-family:ui-monospace,monospace; font-size:9.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; padding:1px 7px; border-radius:3px; margin-right:5px; border:1px solid #30363d; }",
            ".wrap { display:flex; gap:14px; align-items:flex-start; padding:12px 16px; }",
            ".charts { flex:1; min-width:0; }",
            ".side { width:300px; flex:none; position:sticky; top:52px; }",
            ".panel { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:10px 12px; margin-bottom:14px; }",
            ".head { font-size:13px; font-weight:700; margin-bottom:2px; }",
            ".head .qc-unit { font-family:ui-monospace,monospace; font-size:10px; color:#7ad9ff; margin-left:6px; }",
            ".head .qc-chart-meta { font-size:10px; color:#8b949e; }",
            ".head .qc-badge { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:4px; background:#21262d; border:1px solid #30363d; color:#8b949e; font-size:9.5px; font-variant-numeric:tabular-nums; }",
            ".head .qc-badge-warn { color:#f0be3c; border-color:#6a5b23; }",
            ".issues { margin:4px 0 6px; font-family:ui-monospace,monospace; font-size:9.5px; color:#8b949e; display:flex; flex-wrap:wrap; gap:4px; }",
            ".issues .qc-issue { padding:1px 7px; border-radius:3px; background:#21262d; white-space:nowrap; }",
            ".issues .qc-issue-gap { color:#f0be3c; background:#2a2413; }",
            ".issues .qc-issue-check { color:#ea5455; background:#2a1516; font-weight:600; }",
            ".issues .qc-issue-more, .issues .qc-issue-totals { color:#58a6ff; background:none; }",
            ".cwrap { position:relative; height:260px; }",
            ".legend { display:flex; flex-wrap:wrap; gap:10px; margin-top:6px; font-family:ui-monospace,monospace; font-size:10px; }",
            ".legend label { display:inline-flex; align-items:center; gap:5px; cursor:pointer; }",
            ".legend .sw { width:11px; height:11px; border-radius:3px; display:inline-block; }",
            ".note { font-size:10px; color:#8b949e; margin-top:4px; }",
            "#track { width:100%; height:280px; background:#0d1117; border-radius:6px; }",
            ".sideh { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#8b949e; margin-bottom:6px; }",
            "@media (max-width: 900px) { .wrap { flex-direction:column; } .side { width:100%; position:static; } }"
        ].join('\n');
        const viewer = qcExportViewerSrc();
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
            '<title>QC Interactive Report</title><style>' + css + '</style></head><body>' +
            '<script>' + libs + '<\/script>' +
            '<script id="qcx-data" type="application/json">' + dataJson + '<\/script>' +
            '<div class="top"><h1 id="ttl"></h1><span class="sub" id="sub"></span><span class="clock" id="clock">--:--:--</span></div>' +
            '<div class="pills" id="pills"></div>' +
            '<div class="wrap"><div class="charts" id="charts"></div>' +
            '<div class="side"><div class="panel"><div class="sideh">Flight track</div><canvas id="track"></canvas>' +
            '<div class="note">click any graph to move the playhead; the dot follows. wheel zooms a graph, drag pans it, double click resets.</div></div></div></div>' +
            '<script>' + viewer + '<\/script></body></html>';
    }

    // viewer source, kept as one plain string so nothing here runs in the app itself
    function qcExportViewerSrc() {
        return [
"var QCX = JSON.parse(document.getElementById('qcx-data').textContent);",
"function f32(b64){ var s=atob(b64), u=new Uint8Array(s.length); for(var i=0;i<s.length;i++)u[i]=s.charCodeAt(i); return new Float32Array(u.buffer); }",
"function hms(sec){ var s=Math.round(sec)%86400; if(s<0)s+=86400; var h=Math.floor(s/3600),m=Math.floor(s%3600/60),ss=s%60; return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0'); }",
"function lbl(i){ return hms(QCX.t0+i); }",
"var PLAY={i:QCX.toIdx}, charts=[];",
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
"var overlay={id:'ov',afterDraw:function(ch){ var xa=ch.scales.x, a=ch.chartArea, ctx=ch.ctx; if(!a) return; ctx.save();",
"  function fill(list,color,minw){ ctx.fillStyle=color; (list||[]).forEach(function(g){ var x0=xa.getPixelForValue(g[0]),x1=xa.getPixelForValue(g[1]); if(x1<a.left||x0>a.right)return; var L=Math.max(x0,a.left); ctx.fillRect(L,a.top,Math.max(minw,Math.min(x1,a.right)-L),a.bottom-a.top); }); }",
"  var merged=(ch.$gaps||[]).concat(ch.$marks||[]).slice().sort(function(p,q){return p[0]-q[0];}).reduce(function(acc,g){ var m=acc[acc.length-1]; if(m&&g[0]<=m[1]){ if(g[1]>m[1])m[1]=g[1]; } else acc.push([g[0],g[1]]); return acc; },[]);",
"  fill(merged,'rgba(240,190,60,0.10)',2); fill(ch.$checks,'rgba(234,84,85,0.14)',4);",
"  function carets(list,color){ ctx.fillStyle=color; (list||[]).forEach(function(g){ var x0=Math.max(xa.getPixelForValue(g[0]),a.left),x1=Math.min(xa.getPixelForValue(g[1]),a.right); if(x1<x0)return; var cx=(x0+x1)/2; ctx.beginPath(); ctx.moveTo(cx-5,a.top+1); ctx.lineTo(cx+5,a.top+1); ctx.lineTo(cx,a.top+9); ctx.closePath(); ctx.fill(); }); }",
"  carets(merged,'rgba(240,190,60,0.95)'); carets(ch.$checks,'rgba(234,84,85,0.95)');",
"  [[QCX.toIdx,'takeoff'],[QCX.landIdx,'landing']].forEach(function(mk){ var x=xa.getPixelForValue(mk[0]); if(x<a.left||x>a.right)return; ctx.strokeStyle='rgba(148,163,184,0.4)'; ctx.setLineDash([2,3]); ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(x,a.top); ctx.lineTo(x,a.bottom); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle='rgba(148,163,184,0.6)'; ctx.font='8.5px ui-monospace,monospace'; ctx.textBaseline='top'; ctx.fillText(mk[1],Math.min(x+3,a.right-40),a.top+2); });",
"  var px=xa.getPixelForValue(PLAY.i); if(px>=a.left&&px<=a.right){ ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(px,a.top); ctx.lineTo(px,a.bottom); ctx.stroke(); }",
"  ctx.restore(); }};",
"function refresh(ch){ var x=ch.scales.x; ch.data.datasets.forEach(function(ds){ ds.data=decim(ds.$full,x.min,x.max); }); ch.update('none'); }",
"function setPlay(i,skip){ PLAY.i=Math.max(0,Math.min(QCX.n-1,Math.round(i))); document.getElementById('clock').textContent=lbl(PLAY.i)+' UTC'; charts.forEach(function(c){ if(c!==skip) c.draw(); }); if(skip)skip.draw(); drawTrack(); }",
"QCX.fams.forEach(function(fam){",
"  var panel=document.createElement('div'); panel.className='panel';",
"  panel.innerHTML='<div class=\"head\">'+fam.headHtml+'</div>'+(fam.issuesHtml?'<div class=\"issues\">'+fam.issuesHtml+'</div>':'')+'<div class=\"cwrap\"><canvas></canvas></div><div class=\"legend\"></div>';",
"  document.getElementById('charts').appendChild(panel);",
"  var dsets=fam.series.map(function(s){ var full=f32(s.b64); return { label:s.label, data:decim(full,0,QCX.n-1), $full:full, parsing:false, normalized:true, borderColor:s.color, borderWidth:s.w, borderDash:s.dash?[4,3]:[], pointRadius:0, pointHitRadius:6, spanGaps:false, fill:false, hidden:!s.on }; });",
"  var ch=new Chart(panel.querySelector('canvas'),{ type:'line', data:{datasets:dsets}, options:{",
"    responsive:true, maintainAspectRatio:false, animation:false, interaction:{mode:'nearest',axis:'xy',intersect:false},",
"    onClick:function(e,els,c){ var v=c.scales.x.getValueForPixel(e.x); if(v!=null) setPlay(v,c); },",
"    scales:{ x:{type:'linear',bounds:'data',grid:{color:'rgba(148,163,184,0.08)'},ticks:{maxTicksLimit:10,color:'#8b949e',font:{family:'ui-monospace,monospace',size:10},callback:function(v){return lbl(Math.round(v));}}},",
"             y:{type:'linear',grid:{color:'rgba(148,163,184,0.10)'},ticks:{color:'#8b949e',font:{family:'ui-monospace,monospace',size:10}},title:{display:true,text:fam.label+' ('+fam.unit+')',color:'#8b949e',font:{size:11,weight:'600'}}} },",
"    plugins:{ legend:{display:false},",
"      tooltip:{ bodyFont:{family:'ui-monospace,monospace',size:11}, callbacks:{ title:function(it){return it.length?lbl(Math.round(it[0].parsed.x))+' UTC':'';}, label:function(it){ var y=it.parsed.y; return (it.dataset.label||'')+': '+(y===y?Math.round(y*1000)/1000:'no data'); } } },",
"      zoom:{ zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'x',onZoomComplete:function(o){refresh(o.chart);}},",
"             pan:{enabled:true,mode:'x',onPanComplete:function(o){refresh(o.chart);}},",
"             limits:{x:{min:'original',max:'original'}} } } }, plugins:[overlay]});",
"  ch.$gaps=fam.gaps; ch.$marks=fam.marks; ch.$checks=fam.checks; charts.push(ch);",
"  panel.querySelector('canvas').addEventListener('dblclick',function(){ ch.resetZoom('none'); ch.zoomScale('x',{min:0,max:QCX.n-1},'none'); refresh(ch); });",
"  var lg=panel.querySelector('.legend');",
"  dsets.forEach(function(d,k){ var l=document.createElement('label'); var on=!d.hidden;",
"    l.innerHTML='<input type=\"checkbox\" '+(on?'checked':'')+'><span class=\"sw\" style=\"background:'+(on?d.borderColor:'transparent')+';border:1px solid '+d.borderColor+'\"></span>'+d.label;",
"    l.querySelector('input').addEventListener('change',function(e){ ch.setDatasetVisibility(k,e.target.checked); l.querySelector('.sw').style.background=e.target.checked?d.borderColor:'transparent'; ch.update('none'); });",
"    lg.appendChild(l); });",
"});",
"var TRK=null; if(QCX.track){ TRK={lat:f32(QCX.track.lat),lon:f32(QCX.track.lon)}; }",
"function drawTrack(){ var cv=document.getElementById('track'); if(!cv||!TRK){ if(cv)cv.parentElement.style.display=TRK?'':'none'; return; }",
"  var dpr=window.devicePixelRatio||1, W=cv.clientWidth||280, H=280; cv.width=W*dpr; cv.height=H*dpr;",
"  var ctx=cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);",
"  var mnLa=Infinity,mxLa=-Infinity,mnLo=Infinity,mxLo=-Infinity;",
"  for(var i=0;i<TRK.lat.length;i++){ var la=TRK.lat[i],lo=TRK.lon[i]; if(isNaN(la)||isNaN(lo))continue; if(la<mnLa)mnLa=la; if(la>mxLa)mxLa=la; if(lo<mnLo)mnLo=lo; if(lo>mxLo)mxLo=lo; }",
"  if(mnLa===Infinity) return; var pad=14, sx=(W-2*pad)/Math.max(1e-6,mxLo-mnLo), sy=(H-2*pad)/Math.max(1e-6,mxLa-mnLa), sc=Math.min(sx,sy);",
"  var ox=(W-(mxLo-mnLo)*sc)/2, oy=(H-(mxLa-mnLa)*sc)/2;",
"  function X(lo){return ox+(lo-mnLo)*sc;} function Y(la){return H-oy-(la-mnLa)*sc;}",
"  ctx.strokeStyle='#58a6ff'; ctx.lineWidth=1.5; ctx.beginPath(); var pen=false;",
"  for(var i=0;i<TRK.lat.length;i++){ var la=TRK.lat[i],lo=TRK.lon[i]; if(isNaN(la)||isNaN(lo)){pen=false;continue;} if(pen)ctx.lineTo(X(lo),Y(la)); else {ctx.moveTo(X(lo),Y(la)); pen=true;} }",
"  ctx.stroke();",
"  [[QCX.toIdx,'#28c76f'],[QCX.landIdx,'#ea5455']].forEach(function(mk){ var la=TRK.lat[mk[0]],lo=TRK.lon[mk[0]]; if(isNaN(la)||isNaN(lo))return; ctx.fillStyle=mk[1]; ctx.beginPath(); ctx.arc(X(lo),Y(la),4,0,7); ctx.fill(); });",
"  var la=TRK.lat[PLAY.i],lo=TRK.lon[PLAY.i]; if(!isNaN(la)&&!isNaN(lo)){ ctx.fillStyle='#fff'; ctx.strokeStyle='#0d1117'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.arc(X(lo),Y(la),5,0,7); ctx.fill(); ctx.stroke(); } }",
"document.getElementById('ttl').textContent='QC Interactive Report · '+QCX.mission;",
"document.getElementById('sub').textContent=(QCX.date?QCX.date+' · ':'')+(QCX.aircraft?'airframe '+QCX.aircraft+' · ':'')+'takeoff '+lbl(QCX.toIdx)+' · landing '+lbl(QCX.landIdx);",
"document.getElementById('pills').innerHTML=QCX.summaryHtml;",
"window.addEventListener('resize',drawTrack);",
"document.addEventListener('keydown',function(e){ if(e.key==='ArrowLeft'||e.key==='ArrowRight'){ e.preventDefault(); setPlay(PLAY.i+(e.shiftKey?10:1)*(e.key==='ArrowLeft'?-1:1)); } });",
"setPlay(QCX.toIdx);"
        ].join('\n');
    }
