/* QC Mode, flight-file parse worker.
   Runs the pure parser core off the main thread so a large .nc/.txt load never freezes the page.
   Receives { tsv } or { nc: ArrayBuffer } and posts back { rows, stats, qc }: the cleaned playback
   rows AND the QC-Mode raw dataset (every sample on a continuous 1-second axis). Posts { error } if
   the file can't be read. The ?v= cache-buster arrives via the worker URL's query string and is
   forwarded to the core imports so they bust together. 00b-qc-catalog.js is imported so the raw
   parser can use the catalog allow-list off-thread. */
importScripts('../lib/netcdfjs.min.js', '00b-qc-catalog.js' + self.location.search, '11b-parser-core.js' + self.location.search);

self.onmessage = (e) => {
    try {
        // forward decode progress to the page so the loading overlay can show which variable is being
        // processed. the main thread is free during this worker phase, so the spinner keeps animating.
        const onProgress = (p) => self.postMessage({ progress: p });
        const tsv = e.data.nc ? ncArrayBufferToTsv(e.data.nc, onProgress) : e.data.tsv;
        const result = parseFlightTextToRows(tsv);
        // the QC raw dataset is a second, independent pass over the same tsv (no cleanup, all vars).
        // transfer its typed-array buffers back so the big Float32Arrays are not structure-cloned.
        try {
            result.qc = parseFlightRawQC(tsv);
            const transfers = [];
            if (result.qc) {
                if (result.qc.timeAxis && result.qc.timeAxis.buffer) transfers.push(result.qc.timeAxis.buffer);
                Object.keys(result.qc.raw || {}).forEach(k => { const a = result.qc.raw[k]; if (a && a.buffer) transfers.push(a.buffer); });
            }
            self.postMessage(result, transfers);
        } catch (qcErr) {
            // QC extraction is best-effort; if it throws, still return the playback rows.
            result.qc = null; result.qcError = String((qcErr && qcErr.message) || qcErr);
            self.postMessage(result);
        }
    } catch (err) {
        self.postMessage({ error: String((err && err.message) || err) });
    }
};
