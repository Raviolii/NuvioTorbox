/**
 * treasuremaps – Minimized & Clean
 * - Treasure Maps API search, TMDB API Key, Worker integration, and Language mode.
 * - Configured via onSettings().
 *
 * Key resolution order:
 *   1. In-code overrides below (CODE_* constants) – if you fill them in, they win.
 *   2. onSettings() values (TMDB API Key / Treasure Maps API Key / Worker URL).
 *
 * NOTE: This file is for GitHub – keep the CODE_* constants EMPTY by default.
 * Fill them in only in your private/local copy if you want them to override settings.
 */
var __defProp = Object.defineProperty;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// ─── In-code overrides (OPTIONAL) ─────────────────────────────────────────────
// If any of these are non-empty, they override the values from onSettings().
// Keep them empty for the GitHub copy – then the onSettings values are used.
const CODE_TMDB_API_KEY = "";
const CODE_TREASUREMAPS_API_KEY = "";
const CODE_WORKER_URL = "";

var SCRAPER_ID = "treasuremaps";

function __get_scraper_id() {
  return "treasuremaps";
}

if (typeof globalThis !== "undefined") {
  globalThis.__get_scraper_id = __get_scraper_id;
  globalThis.__scraper_id = "treasuremaps";
  globalThis.SCRAPER_ID = "treasuremaps";
}

var DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Accept": "application/json,text/plain,*/*"
};

var STREAM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
};

function getRuntimePlatform() {
  const settings = typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS || {};
  const values = [
    settings.platform,
    settings.devicePlatform,
    typeof globalThis !== "undefined" && globalThis.__NUVIO_PLATFORM,
    typeof globalThis !== "undefined" && globalThis.Platform && globalThis.Platform.OS,
    typeof globalThis !== "undefined" && globalThis.devicePlatform,
    typeof globalThis !== "undefined" && globalThis.navigator &&
    (globalThis.navigator.userAgent || globalThis.navigator.platform)
  ];
  return values.filter(Boolean).join(" ").toLowerCase();
}

// Detect Nuvio running on a Samsung Tizen TV. On Tizen, chunked uploads must
// be small and strictly sequential (parallel fetches / big in-memory buffers
// are unreliable), so we switch to the proven Tizen upload method.
function isTizenRuntime() {
  const platform = getRuntimePlatform();
  if (/ios|iphone|ipad|ipod/.test(platform)) return false;
  return /tizen|samsung.?tv/.test(platform) ||
    !!(typeof globalThis !== "undefined" && (globalThis.tizen || globalThis.TIZEN));
}

// --- TIZEN-SAFE DELAY -------------------------------------------------------
// On Tizen TV (Nuvio sandbox) the `setTimeout` identifier can be completely
// undefined, which crashes the upload with "setTimeout is not defined".
// This helper resolves a timer function defensively and falls back to
// microtasks / a capped synchronous wait so delays never throw.
function resolveSetTimeout() {
  if (typeof setTimeout === "function") return setTimeout;
  const sources = [
    typeof globalThis !== "undefined" ? globalThis : null,
    typeof window !== "undefined" ? window : null,
    typeof self !== "undefined" ? self : null
  ];
  for (const src of sources) {
    if (src && typeof src.setTimeout === "function") return src.setTimeout;
  }
  return null;
}

function waitMs(ms) {
  const timer = resolveSetTimeout();
  if (timer) return new Promise((resolve) => timer(resolve, ms));

  // No timer API available (e.g. Tizen plugin sandbox): yield via microtasks.
  if (typeof queueMicrotask === "function") {
    return new Promise((resolve) => {
      let ticks = 0;
      const step = () => { if (++ticks >= 24) return resolve(); queueMicrotask(step); };
      queueMicrotask(step);
    });
  }

  // Last resort: bounded synchronous wait (capped at 100 ms so we never
  // lock the TV's UI thread for long).
  const end = Date.now() + Math.min(Math.max(0, ms | 0), 100);
  while (Date.now() < end) { /* spin */ }
  return Promise.resolve();
}

function getSettings() {
  const settings = (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) || {};
  const clean = (value) => (typeof value === "string" ? value.trim() : "");
  const toInt = (value, fallback) => {
    const n = parseInt(clean(value), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    tmdbApiKey: clean(CODE_TMDB_API_KEY) || clean(settings.tmdbApiKey),
    treasureMapsApiKey: clean(CODE_TREASUREMAPS_API_KEY) || clean(settings.treasureMapsApiKey),
    workerUrl: clean(CODE_WORKER_URL) || clean(settings.workerUrl),
    languageMode: clean(settings.languageMode) || "de_first",
    chunkSizeKB: toInt(settings.chunkSizeKB, 768),
    uploadConcurrency: toInt(settings.uploadConcurrency, 3)
  };
}

function extractQuality(title) {
  if (!title) return "Unknown";
  const t = title.toLowerCase();
  const is4k = t.includes("2160p") || t.includes("4k") || t.includes("uhd");
  const is1080p = t.includes("1080p");
  const is720p = t.includes("720p");
  const isRemux = t.includes("remux");
  const isHdr = t.includes("hdr");
  const isDv = t.includes("dv") || t.includes("dolby vision") || t.includes("dovi");

  let base = is4k ? "2160p" : is1080p ? "1080p" : is720p ? "720p" : "";
  if (!base) {
    if (t.includes("web-dl") || t.includes("webdl")) base = "WEB-DL";
    else if (t.includes("bluray") || t.includes("bdrip")) base = "BluRay";
    else base = "Unknown";
  }

  const tags = [];
  if (isDv) tags.push("DV");
  if (isHdr) tags.push("HDR");
  if (isRemux) tags.push("Remux");

  return tags.length ? `${base} ${tags.join(" ")}` : base;
}

function getQualityScore(title) {
  if (!title) return 0;
  const n = title.toLowerCase();
  let score = 0;

  if (n.includes("2160p") || n.includes("4k") || n.includes("uhd")) score += 1000;
  else if (n.includes("1080p")) score += 700;
  else if (n.includes("720p")) score += 400;
  else if (n.includes("480p")) score += 200;
  else score += 100;

  if (n.includes("remux")) score += 200;
  else if (n.includes("bluray") || n.includes("bdrip")) score += 150;
  else if (n.includes("web-dl") || n.includes("webdl")) score += 100;
  else if (n.includes("webrip")) score += 80;
  else if (n.includes("hdtv")) score += 50;

  if (n.includes("dv") || n.includes("dolby vision") || n.includes("dovi")) score += 40;
  if (n.includes("hdr10+") || n.includes("hdr")) score += 30;
  if (n.includes("atmos") || n.includes("truehd") || n.includes("dts-hd") || n.includes("dts")) score += 20;
  if (/\b(cam|tele-sync|telesync|hdcam|ts|tc|screener|scr)\b/i.test(n)) score -= 800;

  return score;
}

function fetchJson(url, headers = {}) {
  return __async(this, null, function* () {
    const response = yield fetch(url, {
      headers: __spreadValues(__spreadValues({}, DEFAULT_HEADERS), headers)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response.json();
  });
}

function readBodyAsBytes(response) {
  return __async(this, null, function* () {
    // ORDER MATTERS FOR iOS: Nuvio on iOS runs in WebKit (WKWebView). There,
    // `response.body.getReader()` exists but the cross-origin stream often
    // yields 0 bytes, while `response.arrayBuffer()` reliably returns the full
    // body. So we try arrayBuffer()/text() FIRST (works on iOS + PC + Node),
    // and only use the Web ReadableStream as a last resort — with a 0-byte
    // guard so an empty stream falls through instead of returning nothing.
    // This is why PC worked but iOS returned "Empty NZB body" / results=0.

    // 1) Response.arrayBuffer() — the most reliable across WebKit / Chromium / undici.
    if (response && typeof response.arrayBuffer === "function") {
      try {
        const buf = yield response.arrayBuffer();
        if (buf && buf.byteLength > 0) return new Uint8Array(buf);
      } catch (_) { /* fall through */ }
    }

    // 2) Response.text() then UTF-8 encode (fallback if arrayBuffer is unavailable/empty).
    if (response && typeof response.text === "function") {
      try {
        const txt = yield response.text();
        if (txt && txt.length > 0 && typeof TextEncoder !== "undefined") return new TextEncoder().encode(txt);
      } catch (_) { /* fall through */ }
    }

    // 3) Body already materialized (Uint8Array / ArrayBuffer / Buffer / string).
    const b = response && response.body;
    if (b) {
      if (b instanceof Uint8Array && b.length > 0) return b;
      if (typeof ArrayBuffer !== "undefined" && b instanceof ArrayBuffer && b.byteLength > 0) return new Uint8Array(b);
      if (typeof b === "string" && b.length > 0 && typeof TextEncoder !== "undefined") return new TextEncoder().encode(b);
      if (b.buffer && b.byteLength > 0) {
        try { return new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength); } catch (_) { /* ignore */ }
      }
    }

    // 4) LAST resort: Web ReadableStream (Chromium / Node 18+). Guard against 0 bytes.
    if (response && response.body && typeof response.body.getReader === "function") {
      try {
        const reader = response.body.getReader();
        const parts = [];
        while (true) {
          const readResult = yield reader.read();
          if (readResult.done) break;
          if (readResult.value && readResult.value.length > 0) parts.push(new Uint8Array(readResult.value));
        }
        const total = parts.reduce((n, p) => n + p.length, 0);
        if (total > 0) {
          const out = new Uint8Array(total);
          let off = 0;
          for (const p of parts) { out.set(p, off); off += p.length; }
          return out;
        }
      } catch (_) { /* fall through */ }
    }

    throw new Error("No readable NZB body available (tried arrayBuffer, text, body, stream).");
  });
}

function postChunk(cleanWorkerUrl, sessionId, index, totalChunks, slice, metaHeader, maxRetries) {
  return __async(this, null, function* () {
    let attempt = 0;
    let lastError = null;
    while (attempt <= maxRetries) {
      try {
        const res = yield fetch(`${cleanWorkerUrl}/upload-chunk`, {
          method: "POST",
          headers: {
            "X-Session-Id": sessionId,
            "X-Chunk-Index": String(index),
            "X-Total-Chunks": String(totalChunks),
            "X-Metadata": metaHeader,
            "Content-Type": "application/octet-stream"
          },
          body: slice
        });
        let rawBody = "";
        try {
          rawBody = yield res.text();
        } catch (_) {
          rawBody = "";
        }
        let parsed = null;
        try {
          parsed = rawBody ? JSON.parse(rawBody) : null;
        } catch (_) {
          parsed = null;
        }
        if (!res.ok) {
          const detail = (parsed && (parsed.error || parsed.detail || parsed.message)) || rawBody || res.statusText || "no response";
          throw new Error(`TorBox upload failed (HTTP ${res.status}): ${detail}`);
        }
        if (parsed && (parsed.error || parsed.success === false)) {
          throw new Error(`TorBox upload rejected: ${parsed.error || JSON.stringify(parsed)}`);
        }
        return { index, json: parsed || { status: "chunk_received", chunkIndex: index } };
      } catch (err) {
        lastError = err;
        attempt += 1;
        if (attempt <= maxRetries) {
          yield waitMs(300 * attempt);
        }
      }
    }
    throw new Error(`Chunk ${index} failed after ${maxRetries + 1} attempts: ${lastError && (lastError.message || lastError)}`);
  });
}

function uploadNzbToWorker(cleanWorkerUrl, nzbBytes, metadata, opts = {}) {
  return __async(this, null, function* () {
    const isTizen = isTizenRuntime();

    // --- TIZEN TV METHOD (proven to work with Nuvio on Samsung Tizen) ---
    // Tizen's webview is unreliable with parallel uploads and large buffers,
    // so on a Tizen TV we force the working method: small (350 KB) chunks
    // uploaded strictly one at a time, with a couple of extra retries.
    // The true X-Total-Chunks is still sent on every chunk, which the worker
    // needs to know when the complete file has arrived.
    const TIZEN_CHUNK_SIZE = 350 * 1024;
    const chunkSize = Math.max(16 * 1024, isTizen ? TIZEN_CHUNK_SIZE : (opts.chunkSize || (768 * 1024)));
    const concurrency = Math.max(1, isTizen ? 1 : (opts.concurrency || 3));
    const maxRetries = isTizen ? (opts.maxRetries != null ? Math.max(opts.maxRetries, 3) : 3) : (opts.maxRetries != null ? opts.maxRetries : 2);

    if (isTizen) {
      console.log("[TreasureMaps] Tizen TV detected — using sequential 350KB chunk upload method.");
    }

    const totalChunks = Math.max(1, Math.ceil(nzbBytes.length / chunkSize));
    const sessionId = `nuvio-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const metaHeader = encodeURIComponent(JSON.stringify(metadata || {}));

    const results = [];
    for (let start = 0; start < totalChunks; start += concurrency) {
      const end = Math.min(start + concurrency, totalChunks);
      const batch = [];
      for (let i = start; i < end; i++) {
        batch.push(
          postChunk(
            cleanWorkerUrl,
            sessionId,
            i,
            totalChunks,
            nzbBytes.slice(i * chunkSize, (i + 1) * chunkSize),
            metaHeader,
            maxRetries
          )
        );
      }
      const batchResults = yield Promise.all(batch);
      for (const r of batchResults) results.push(r);
    }

    const nonAck = results.filter((r) => r.json && r.json.status !== "chunk_received");
    if (nonAck.length > 0) {
      const finalJson = nonAck[0].json;
      if (finalJson.error || finalJson.success === false) {
        throw new Error(`TorBox upload rejected: ${finalJson.error || JSON.stringify(finalJson)}`);
      }
      return finalJson;
    }

    throw new Error("Chunked upload completed but no final TorBox response was received.");
  });
}

function queueNzbToTorBoxFromDevice(downloadUrl, releaseTitle, apiKey, metadata = {}) {
  return __async(this, null, function* () {
    if (!downloadUrl) throw new Error("Missing downloadUrl");

    const settings = getSettings();
    const workerUrl = (metadata && metadata.workerUrl) || settings.workerUrl || "";
    const cleanWorkerUrl = workerUrl && /^https?:\/\//i.test(workerUrl.trim()) ? workerUrl.trim().replace(/\/+$/, "") : "";

    if (!cleanWorkerUrl) throw new Error("Worker URL is not configured.");

    // The device downloads the NZB file, then uploads it to the worker in
    // chunks. The worker holds the TorBox API key and forwards the full file
    // to TorBox — only the NZB bytes are sent over the wire, never the URL.
    // The body is read defensively so this works whether the Nuvio runtime
    // exposes a Web ReadableStream, arrayBuffer(), or text().
    // On a Tizen TV, uploadNzbToWorker() automatically switches to the
    // Tizen-compatible method (small, strictly sequential chunks).
    const nzbResponse = yield fetch(downloadUrl, { headers: DEFAULT_HEADERS });
    if (!nzbResponse.ok) {
      throw new Error(`Failed to fetch NZB file from provider (${nzbResponse.status})`);
    }

    const nzbBytes = yield readBodyAsBytes(nzbResponse);
    if (!nzbBytes || nzbBytes.length === 0) {
      throw new Error("Empty NZB body — nothing to upload.");
    }

    return uploadNzbToWorker(cleanWorkerUrl, nzbBytes, metadata, {
      chunkSize: (settings.chunkSizeKB || 768) * 1024,
      concurrency: settings.uploadConcurrency || 3
    });
  });
}

function isSeasonPack(title) {
  if (!title) return false;
  const leaf = (title || "").split("/").pop().toLowerCase();
  if (/\b(complete|vollstaendig|ganze\s+staffel)\b/i.test(leaf)) return true;
  if (/\b(season|staffel|s)\s*\d{1,2}\b/i.test(leaf) && !/\b[eE]\d{1,2}\b/i.test(leaf) && !/\bfolge\s*\d{1,2}\b/i.test(leaf) && !/\d{1,2}x\d{1,2}\b/i.test(leaf)) {
    return true;
  }
  return false;
}

function extractSeasonEpisode(str) {
  if (!str) return null;
  const leaf = (str || "").split("/").pop();
  let m = leaf.match(/[sS](\d{1,2})[eE](\d{1,2})(?:(?:-[eE]|-)(\d{1,2}))?/);
  if (m) {
    const season = parseInt(m[1], 10);
    const epStart = parseInt(m[2], 10);
    const epEnd = m[3] ? parseInt(m[3], 10) : epStart;
    return { season, episode: epStart, epStart, epEnd };
  }
  m = leaf.match(/\b(\d{1,2})x(\d{1,2})\b/);
  if (m) {
    return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), epStart: parseInt(m[2], 10), epEnd: parseInt(m[2], 10) };
  }
  m = leaf.match(/\b(?:staffel|season)\s*(\d{1,2})\b.*?\b(?:folge|episode)\s*(\d{1,2})\b/i);
  if (m) {
    return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), epStart: parseInt(m[2], 10), epEnd: parseInt(m[2], 10) };
  }
  return null;
}

function isExactEpisode(title, season, episode) {
  if (season == null || episode == null) return true;
  const leaf = (title || "").split("/").pop();
  if (isSeasonPack(leaf)) return false;
  const se = extractSeasonEpisode(leaf);
  if (!se) return false;
  if (se.season !== season) return false;
  return episode >= se.epStart && episode <= se.epEnd;
}

function isVideoMediaRelease(title, item = {}) {
  if (!title) return false;
  const t = title.toLowerCase();
  if (/\b(xxx|porn|adult|sex)\b/i.test(t)) return false;
  return /\b(2160p|1080p|720p|480p|uhd|bluray|web-dl|webdl|webrip|hdtv|x264|x265|hevc|remux|mkv|mp4)\b/i.test(t);
}

function matchesMediaTitle(releaseTitle, targetTitle, mediaType, releaseYear = null) {
  if (!releaseTitle || !targetTitle) return false;
  if (mediaType === "movie" && /\b[sS]\d{1,2}[eE]\d{1,2}\b/.test(releaseTitle)) return false;

  const relClean = releaseTitle.toLowerCase().replace(/[\._\-]/g, " ");
  const targetClean = targetTitle.toLowerCase().replace(/[:\-–—]/g, " ").replace(/[^\w\s]/g, " ").trim();
  const targetWords = targetClean.split(/\s+/).filter(w => w.length > 1);
  if (!targetWords.length) return false;

  const relTokens = relClean.split(/\s+/).filter(Boolean);
  let startIdx = 0;
  if (targetWords[0] !== "the" && relTokens[0] === "the") startIdx = 1;
  if (relTokens.length <= startIdx) return false;

  for (let i = 0; i < targetWords.length; i++) {
    if (relTokens[startIdx + i] !== targetWords[i]) return false;
  }
  return true;
}

function searchTreasureMaps(tmdbId, mediaType, season, episode, settings) {
  return __async(this, null, function* () {
    if (!tmdbId) return { results: [], titleHint: "" };

    const infoApiUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${settings.tmdbApiKey}&language=en-US`;
    const info = yield fetchJson(infoApiUrl).catch(() => ({}));
    const titleHint = info.title || info.name || info.original_name || info.original_title || "";
    const releaseYear = (info.release_date || info.first_air_date || "").slice(0, 4);

    let items = [];
    const v1Headers = { "X-API-Key": settings.treasureMapsApiKey, "Accept": "application/json" };

    try {
      if (mediaType === "tv" || mediaType === "series") {
        const v1TvParams = new URLSearchParams({ tmdbid: String(tmdbId), extended: "true" });
        if (season != null) v1TvParams.set("season", String(season));
        if (episode != null) v1TvParams.set("ep", String(episode));

        const v1TvRes = yield fetch(`https://treasure-maps.com/api/v1/tv?${v1TvParams.toString()}`, { headers: v1Headers });
        if (v1TvRes.ok) {
          const json = yield v1TvRes.json();
          if (Array.isArray(json.items)) items = json.items;
        }
      } else {
        const cleanMovieTitle = titleHint.replace(/[:]/g, " ").replace(/\s+/g, " ").trim();
        const v1MovieParams = new URLSearchParams({ tmdbid: String(tmdbId), title: cleanMovieTitle || "movie", extended: "true" });
        if (releaseYear) v1MovieParams.set("year", releaseYear);

        const v1MovieRes = yield fetch(`https://treasure-maps.com/api/v1/movie?${v1MovieParams.toString()}`, { headers: v1Headers });
        if (v1MovieRes.ok) {
          const json = yield v1MovieRes.json();
          if (Array.isArray(json.items)) items = json.items;
        }
      }
    } catch (_) {}

    if (!Array.isArray(items) || items.length === 0) return { results: [], titleHint };

    const mapped = items
      .map((item, index) => {
        const rawTitle = item.title || `Result ${index + 1}`;
        if (!isVideoMediaRelease(rawTitle, item)) return null;
        if (!matchesMediaTitle(rawTitle, titleHint, mediaType, releaseYear)) return null;
        if (!isExactEpisode(rawTitle, season, episode)) return null;

        let downloadUrl = "";
        if (item.guid && /^[a-f0-9]{32}$/i.test(item.guid)) {
          downloadUrl = `https://file.treasure-maps.com/getnzb/${item.guid}?r=${settings.treasureMapsApiKey}`;
        } else if (item.links && item.links.download) {
          const dl = item.links.download;
          downloadUrl = dl.startsWith("http") ? dl : `https://treasure-maps.com${dl}`;
        } else {
          downloadUrl = item.link || item.url || "";
        }

        const isGerman = (item.audio_languages && Array.isArray(item.audio_languages) && item.audio_languages.includes("German")) ||
          /(german|ger|deutsch|deu|german\.dl|\.dl|\.de\b)/i.test(rawTitle);
        const qualityScore = getQualityScore(rawTitle);
        const formattedTitle = `[${mediaType === "movie" ? "Movie" : "TV"} - ${isGerman ? "DE" : "EN"}] ${rawTitle}`;

        return {
          id: `result-${index + 1}`,
          name: formattedTitle,
          title: formattedTitle,
          downloadUrl,
          releaseTitle: rawTitle,
          quality: extractQuality(rawTitle),
          provider: "treasuremaps",
          headers: DEFAULT_HEADERS,
          isGerman,
          qualityScore
        };
      })
      .filter(Boolean);

    mapped.sort((a, b) => (a.isGerman !== b.isGerman ? (a.isGerman ? -1 : 1) : b.qualityScore - a.qualityScore));
    return { results: mapped, titleHint };
  });
}

function pickCandidateReleases(results, languageMode = "de_first") {
  if (!results || !results.length) return [];
  const germanReleases = results.filter(r => r.isGerman && r.downloadUrl);
  if (languageMode === "de_only") return germanReleases;
  const nonGermanReleases = results.filter(r => !r.isGerman && r.downloadUrl);
  return [...germanReleases, ...nonGermanReleases];
}

// --- Worker "status protocol" helpers -------------------------------------
// The Worker always answers the root lookup with HTTP 200 plus a `status`
// field ("ready" | "downloading" | "not_found"). We never have to rely on
// 404/502 error codes, which Nuvio TVs surface as opaque fetch failures.

function workerLookupUrl(cleanWorkerUrl, tmdbId, season, episode) {
  return `${cleanWorkerUrl}/?tmdb=${tmdbId}&s=${season || ""}&e=${episode || ""}&redirect=false`;
}

function makeReadyStream(json) {
  return [{
    name: `TorBox · ${json.file_name || json.release_name}`,
    title: `TorBox · ${json.file_name || json.release_name}`,
    url: json.stream_url,
    quality: "Cached",
    headers: DEFAULT_HEADERS,
    description: `Ready to play from TorBox (${json.source})`,
    provider: "torbox-library"
  }];
}

function pollWorkerForReady(cleanWorkerUrl, tmdbId, season, episode, maxAttempts, delayMs) {
  return __async(this, null, function* () {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) yield waitMs(delayMs);
      try {
        const res = yield fetch(workerLookupUrl(cleanWorkerUrl, tmdbId, season, episode));
        if (res.ok) {
          const json = yield res.json();
          if (json && json.status === "ready" && json.stream_url) {
            return makeReadyStream(json);
          }
        }
      } catch (_) {}
    }
    return null;
  });
}

function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
  return __async(this, null, function* () {
    const settings = getSettings();
    const cleanWorkerUrl = settings.workerUrl && /^https?:\/\//i.test(settings.workerUrl.trim())
      ? settings.workerUrl.trim().replace(/\/+$/, "")
      : "";

    if (!cleanWorkerUrl) {
      console.warn("[TreasureMaps] Worker URL is not configured.");
      return [];
    }

    // 1. Check Worker for existing ready streams (status protocol: ready / downloading / not_found)
    let localJson = null;
    try {
      const res = yield fetch(workerLookupUrl(cleanWorkerUrl, tmdbId, season, episode));
      if (res.ok) {
        localJson = yield res.json();
      }
    } catch (err) {
      console.warn(`[TreasureMaps] Worker local stream check failed: ${err.message || err}`);
    }

    const localStatus = (localJson && localJson.status) || null;

    if (localStatus === "ready" && localJson.stream_url) {
      return makeReadyStream(localJson);
    }

    // 2. Already queued on TorBox (Worker reports "downloading") → the NZB was
    //    uploaded before and TorBox is still processing. Poll patiently instead
    //    of re-uploading the same NZB (Tizen TVs are slower to report readiness).
    if (localStatus === "downloading") {
      console.log(`[TreasureMaps] Worker reports download in progress (${localJson.file_name || localJson.release_name || "queued"}) — polling for readiness.`);
      const isTizen = isTizenRuntime();
      const readyStream = yield pollWorkerForReady(cleanWorkerUrl, tmdbId, season, episode, isTizen ? 8 : 6, isTizen ? 2500 : 2000);
      if (readyStream) {
        return readyStream;
      }
      // Still not ready — fall through to (re-)queue below so the user always
      // gets the same "Downloading" placeholder flow as before.
    }

    // 3. Not found locally, search TreasureMaps and upload the single best NZB via Worker (exactly once)
    const searchData = yield searchTreasureMaps(tmdbId, mediaType, season, episode, settings);
    const { results } = searchData;
    const candidates = pickCandidateReleases(results, settings.languageMode);

    if (!candidates || !candidates.length) {
      console.warn("[TreasureMaps] No candidate releases found to upload.");
      return [];
    }

    const chosen = candidates[0];

    try {
      const queueResult = yield queueNzbToTorBoxFromDevice(chosen.downloadUrl, chosen.releaseTitle, settings.treasureMapsApiKey, {
        tmdbId,
        mediaType,
        season,
        episode,
        releaseTitle: chosen.releaseTitle,
        workerUrl: settings.workerUrl
      });

      if (queueResult) {
        // Briefly poll the Worker (read-only) to see if the file is already ready to stream.
        // Tizen TVs are slower to report readiness — use more, longer polls (matches the old Tizen method).
        const isTizen = isTizenRuntime();
        const readyStream = yield pollWorkerForReady(cleanWorkerUrl, tmdbId, season, episode, isTizen ? 4 : 3, isTizen ? 2000 : 1500);
        if (readyStream) {
          return readyStream;
        }

        return [{
          name: `TorBox · Downloading 0% · ${chosen.releaseTitle}`,
          title: `TorBox · [0%] · ${chosen.releaseTitle}`,
          url: chosen.downloadUrl,
          quality: "Downloading (0%)",
          headers: STREAM_HEADERS,
          description: "Submitted to TorBox queue via device download & upload. Processing...",
          provider: "treasuremaps"
        }];
      }
    } catch (err) {
      console.error(`[TreasureMaps] Upload to TorBox failed (${chosen.releaseTitle}): ${err.message || err}`);
    }

    return [];
  });
}

function getSearchResults(tmdbId, mediaType = "movie", season = null, episode = null) {
  return __async(this, null, function* () {
    const { results } = yield searchTreasureMaps(tmdbId, mediaType, season, episode, getSettings());
    return results;
  });
}

function onSettings() {
  return [
    { type: "header", label: "Treasure Maps Configuration" },
    { type: "text", key: "tmdbApiKey", label: "TMDB API Key", placeholder: "Enter TMDB API key", description: "Used unless overridden by the in-code CODE_TMDB_API_KEY constant." },
    { type: "text", key: "treasureMapsApiKey", label: "Treasure Maps API Key", placeholder: "Enter Treasure Maps API key", description: "Used unless overridden by the in-code CODE_TREASUREMAPS_API_KEY constant." },
    { type: "text", key: "workerUrl", label: "TorBox Worker URL", placeholder: "https://your-worker.workers.dev", description: "Cloudflare Worker URL handling lookups and relays. Used unless overridden by the in-code CODE_WORKER_URL constant." },
    { type: "text", key: "languageMode", label: "Language Mode", placeholder: "de_first (or de_only)", description: "Set to 'de_first' for German first, or 'de_only' for strictly German." },
    { type: "text", key: "chunkSizeKB", label: "Upload Chunk Size (KB)", placeholder: "768", description: "KB per chunk. Larger = fewer round trips = faster. Keep around 1024 or below for safety. (Tizen TVs always use 350 KB automatically.)" },
    { type: "text", key: "uploadConcurrency", label: "Upload Concurrency", placeholder: "3", description: "How many chunks upload at once. 1 = sequential (safest). Higher = faster; lower if uploads fail. (Tizen TVs always use 1 — sequential — automatically.)" }
  ];
}

if (typeof globalThis !== "undefined") {
  globalThis.onSettings = onSettings;
  globalThis.getStreams = getStreams;
  globalThis.getSearchResults = getSearchResults;
  globalThis.treasuremaps = { getStreams, getSearchResults, onSettings, __get_scraper_id };
}

module.exports = { getStreams, getSearchResults, onSettings, __get_scraper_id };
