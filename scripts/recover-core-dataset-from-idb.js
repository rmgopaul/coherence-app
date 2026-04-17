/**
 * One-shot recovery script for accountSolarGeneration and transferHistory
 * when the client-side cloud sync has truncated the source manifest.
 *
 * Usage:
 *   1. Open the Solar REC dashboard in the browser.
 *   2. Open DevTools Console.
 *   3. Type "allow pasting" + Enter (Chrome CSP guard).
 *   4. Paste the ENTIRE contents of this file and press Enter.
 *   5. Call: await window.__solarRecRecovery.run("transferHistory")
 *      and / or: await window.__solarRecRecovery.run("accountSolarGeneration")
 *
 * What it does:
 *   - Reads the full merged dataset (all rows, all headers) directly from
 *     IndexedDB (solarRecDashboardDb → datasets store).
 *   - Builds one CSV text from that data.
 *   - Uploads it to solarRecDashboardStorage as a single _rawSourcesV1
 *     source (chunked through the existing saveDataset mutation).
 *   - Triggers the server's syncCoreDatasetFromStorage mutation.
 *
 * Because the server-side ingestion runs in "append" mode for these two
 * datasets (see serverSideMigration.modeForDataset), uploading the full
 * merged CSV effectively recovers every row: the dedupe-append SQL will
 * skip rows already present in the active batch and insert everything
 * else.
 *
 * Cost: the cloud manifest's per-source history is replaced with a
 * single "recovery-backfill" entry. The actual ROW data is fully
 * preserved and future uploads can still append on top.
 *
 * Tested: browser only, on the live dashboard tab with active session
 * cookies. Does not require a new server endpoint.
 */

(() => {
  const DB_NAME = "solarRecDashboardDb";
  // Matches client/src/solar-rec-dashboard/lib/constants.ts
  // DASHBOARD_DB_VERSION. Must be kept in sync or indexedDB.open
  // throws "VersionError: The requested version (N) is less than the
  // existing version (M)".
  const DB_VERSION = 2;
  const STORE_NAME = "datasets";
  const MANIFEST_KEY = "__dataset_manifest_v2__";
  const CHUNK_CHAR_LIMIT = 8 * 1024 * 1024; // matches server's SOLAR_REC_DB_CHUNK_CHARS
  const WRITE_CONCURRENCY = 4;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function readRecord(db, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  function yieldToBrowser() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function csvEscape(value) {
    const s = value == null ? "" : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /**
   * Build CSV text from the v2 columnar format, yielding to the browser
   * every 2000 rows so the tab stays responsive on large datasets.
   */
  async function columnarToCsvText(headers, columnData, rowCount) {
    const parts = [headers.map(csvEscape).join(",")];
    for (let r = 0; r < rowCount; r++) {
      const cells = new Array(headers.length);
      for (let c = 0; c < headers.length; c++) {
        cells[c] = csvEscape(columnData[c]?.[r] ?? "");
      }
      parts.push(cells.join(","));
      if ((r + 1) % 2000 === 0) {
        await yieldToBrowser();
      }
    }
    return parts.join("\n");
  }

  /**
   * Build CSV text from the legacy row-array format (if present).
   */
  async function rowsToCsvText(headers, rows) {
    const parts = [headers.map(csvEscape).join(",")];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      parts.push(headers.map((h) => csvEscape(row[h] ?? "")).join(","));
      if ((i + 1) % 2000 === 0) {
        await yieldToBrowser();
      }
    }
    return parts.join("\n");
  }

  function splitIntoChunks(text, limit) {
    if (text.length <= limit) return [text];
    const chunks = [];
    for (let i = 0; i < text.length; i += limit) {
      chunks.push(text.slice(i, i + limit));
    }
    return chunks;
  }

  /**
   * Post a single tRPC mutation via the HTTP batch endpoint. We avoid
   * pulling in the trpc client from React — a raw fetch is enough and
   * it relies on the same auth cookies the tab already has.
   */
  async function trpcMutation(procedure, input) {
    const body = { "0": { json: input } };
    const res = await fetch(
      `/solar-rec/api/trpc/${procedure}?batch=1`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      throw new Error(
        `tRPC ${procedure} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
      );
    }
    const json = await res.json();
    const entry = Array.isArray(json) ? json[0] : json;
    if (entry?.error) {
      throw new Error(
        `tRPC ${procedure} error: ${entry.error.message ?? entry.error.json?.message ?? JSON.stringify(entry.error).slice(0, 200)}`
      );
    }
    return entry?.result?.data?.json ?? entry?.result?.data ?? null;
  }

  async function saveDatasetKey(key, payload) {
    return trpcMutation("solarRecDashboard.saveDataset", { key, payload });
  }

  async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function runner() {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }
    const runners = Array.from(
      { length: Math.min(limit, items.length) },
      runner
    );
    await Promise.all(runners);
    return results;
  }

  /**
   * Upload one CSV payload as a "remote source" under a storageKey
   * and return the source ref (matching RemoteDatasetSourceRef shape).
   */
  async function uploadSourceFile(datasetKey, fileName, csvText, uploadedAt) {
    const sourceId =
      Math.random().toString(36).slice(2, 8) +
      Date.now().toString(36);
    const storageKey = `src_${datasetKey}_${sourceId}`;

    const chunks = splitIntoChunks(csvText, CHUNK_CHAR_LIMIT);

    if (chunks.length === 1) {
      await saveDatasetKey(storageKey, csvText);
      return {
        id: sourceId,
        fileName,
        uploadedAt: uploadedAt.toISOString(),
        rowCount: undefined, // filled in by caller
        sizeBytes: new Blob([csvText]).size,
        storageKey,
        encoding: "utf8",
        contentType: "text/csv",
      };
    }

    const chunkKeys = chunks.map((_, i) => `${storageKey}_chunk_${String(i).padStart(4, "0")}`);
    await mapWithConcurrency(
      chunks.map((chunk, i) => ({ chunk, i })),
      WRITE_CONCURRENCY,
      async ({ chunk, i }) => saveDatasetKey(chunkKeys[i], chunk)
    );
    await saveDatasetKey(
      storageKey,
      JSON.stringify({ _chunkedDataset: true, chunkKeys })
    );
    return {
      id: sourceId,
      fileName,
      uploadedAt: uploadedAt.toISOString(),
      rowCount: undefined,
      sizeBytes: new Blob([csvText]).size,
      storageKey,
      chunkKeys,
      encoding: "utf8",
      contentType: "text/csv",
    };
  }

  /**
   * The main recovery routine for one dataset key.
   */
  async function runOne(datasetKey) {
    const CORE_APPEND_KEYS = new Set([
      "transferHistory",
      "accountSolarGeneration",
    ]);
    if (!CORE_APPEND_KEYS.has(datasetKey)) {
      throw new Error(
        `Recovery only supports dedupe-append datasets. "${datasetKey}" is not one of ${[...CORE_APPEND_KEYS].join(", ")}`
      );
    }

    console.log(`[recovery] opening IndexedDB…`);
    const db = await openDb();

    try {
      console.log(`[recovery] reading dataset:${datasetKey} from IDB…`);
      const raw = await readRecord(db, `dataset:${datasetKey}`);
      if (!raw) {
        throw new Error(`dataset:${datasetKey} not found in IndexedDB`);
      }

      let headers = [];
      let rowCount = 0;
      let csvText = "";

      if (raw._v === 2 && Array.isArray(raw.columnData)) {
        headers = raw.headers;
        rowCount = raw.rowCount ?? raw.columnData[0]?.length ?? 0;
        console.log(`[recovery] v2 columnar: ${headers.length} headers × ${rowCount} rows`);
        console.log(`[recovery] building CSV text (this can take 10-30s for big datasets)…`);
        csvText = await columnarToCsvText(headers, raw.columnData, rowCount);
      } else if (Array.isArray(raw.rows)) {
        headers = raw.headers;
        rowCount = raw.rows.length;
        console.log(`[recovery] v1 rows: ${headers.length} headers × ${rowCount} rows`);
        csvText = await rowsToCsvText(headers, raw.rows);
      } else {
        throw new Error(`dataset:${datasetKey} has no columnData or rows`);
      }

      const sizeMB = (csvText.length / (1024 * 1024)).toFixed(1);
      console.log(`[recovery] CSV built: ${csvText.length.toLocaleString()} chars (${sizeMB} MB), ${rowCount.toLocaleString()} rows`);

      const uploadedAt = new Date();
      const fileName = `${datasetKey}-recovery-backfill-${uploadedAt.toISOString().slice(0, 10)}.csv`;

      console.log(`[recovery] uploading ${datasetKey} source file in chunks…`);
      const sourceRef = await uploadSourceFile(
        datasetKey,
        fileName,
        csvText,
        uploadedAt
      );
      sourceRef.rowCount = rowCount;

      const manifest = {
        _rawSourcesV1: true,
        version: 1,
        sources: [sourceRef],
      };
      console.log(`[recovery] writing _rawSourcesV1 manifest at dataset:${datasetKey}…`);
      await saveDatasetKey(datasetKey, JSON.stringify(manifest));

      console.log(`[recovery] triggering server-side sync into srDs* tables (this runs append mode)…`);
      const syncResult = await trpcMutation(
        "solarRecDashboard.syncCoreDatasetFromStorage",
        { datasetKey }
      );

      console.log(`[recovery] ✅ ${datasetKey} recovery complete`);
      console.log(`[recovery] server sync result:`, syncResult);
      return syncResult;
    } finally {
      db.close();
    }
  }

  window.__solarRecRecovery = {
    run: runOne,
    runAll: async function () {
      const results = {};
      for (const key of ["transferHistory", "accountSolarGeneration"]) {
        console.log(`\n=== ${key} ===`);
        try {
          results[key] = await runOne(key);
        } catch (err) {
          console.error(`[recovery] ${key} failed:`, err);
          results[key] = { state: "failed", error: err?.message ?? String(err) };
        }
      }
      return results;
    },
  };

  console.log(
    "[recovery] Script loaded. Run: await window.__solarRecRecovery.runAll()"
  );
  console.log(
    "[recovery] Or one at a time: await window.__solarRecRecovery.run('transferHistory')"
  );
})();
