// Cloudflare Worker - Node.js Serverless Function
// Combined TorBox Search, Fast Usenet-First Fallback, Nuvio NZB Relay/Chunking, and Status Coordinator

const sessions = new Map();
const activeDownloads = new Map(); // key: `${tmdbId}${season}${episode}`

function cleanupStaleSessions() {
    const now = Date.now();
    for (const [id, s] of sessions.entries()) {
        if (now - s.createdAt > 5 * 60 * 1000) {
            sessions.delete(id);
        }
    }
    for (const [key, d] of activeDownloads.entries()) {
        if (now - d.createdAt > 20 * 60 * 1000) {
            activeDownloads.delete(key);
        }
    }
}

export default {
    async fetch(request, env, ctx) {
        cleanupStaleSessions();

        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Id, X-Chunk-Index, X-Total-Chunks, X-Is-Last, X-Metadata"
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);

        // --- ENDPOINT: Status Check & Update for Coordinator (/status) ---
        if (url.pathname === "/status" && request.method === "POST") {
            try {
                const body = await request.json();
                const tmdbId = String(body.tmdbId || "");
                const season = String(body.season != null ? body.season : "0");
                const episode = String(body.episode != null ? body.episode : "0");
                const status = body.status || "searching"; 
                const key = `${tmdbId}${season}${episode}`;

                activeDownloads.set(key, {
                    status,
                    tmdbId,
                    season,
                    episode,
                    updatedAt: Date.now(),
                    createdAt: activeDownloads.get(key)?.createdAt || Date.now()
                });

                return jsonResponse({ success: true, key, status }, 200, corsHeaders);
            } catch (err) {
                return jsonResponse({ error: err.message }, 400, corsHeaders);
            }
        }

        if (url.pathname === "/status" && request.method === "GET") {
            const tmdbId = url.searchParams.get("tmdbId") || "";
            const season = url.searchParams.get("season") || "0";
            const episode = url.searchParams.get("episode") || "0";
            const key = `${tmdbId}${season}${episode}`;

            const item = activeDownloads.get(key);
            if (item) {
                return jsonResponse({
                    status: item.status || "downloading",
                    active: item.status === "downloading" || item.status === "searching",
                    tmdbId,
                    season,
                    episode,
                    releaseTitle: item.releaseTitle,
                    torboxDownloadId: item.torboxDownloadId,
                    createdAt: item.createdAt,
                    updatedAt: item.updatedAt
                }, 200, corsHeaders);
            }

            return jsonResponse({ status: "idle", active: false, tmdbId }, 200, corsHeaders);
        }

        // --- ENDPOINT: Delete TorBox Download (/delete) ---
        if (url.pathname === "/delete") {
            try {
                const tmdbId = url.searchParams.get("tmdbId") || "";
                const season = url.searchParams.get("season") || "0";
                const episode = url.searchParams.get("episode") || "0";
                const usenetId = url.searchParams.get("usenetId") || "";
                const torrentId = url.searchParams.get("torrentId") || "";
                const apiKey = url.searchParams.get("apiKey") || (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") || env.TORBOX_API_KEY;

                if (tmdbId) {
                    activeDownloads.delete(`${tmdbId}${season}${episode}`);
                }

                if (apiKey) {
                    if (usenetId) {
                        await fetch("https://api.torbox.app/v1/api/usenet/controlusenetdownload", {
                            method: "POST",
                            headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
                            body: JSON.stringify({ usenet_id: parseInt(usenetId, 10), operation: "delete" })
                        }).catch(() => {});
                    }

                    if (torrentId) {
                        await fetch("https://api.torbox.app/v1/api/torrents/controltorrent", {
                            method: "POST",
                            headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
                            body: JSON.stringify({ torrent_id: parseInt(torrentId, 10), operation: "delete" })
                        }).catch(() => {});
                    }
                }

                return Response.redirect("https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4", 302);
            } catch (err) {
                return jsonResponse({ error: err.message }, 500, corsHeaders);
            }
        }

        // --- ENDPOINT: Direct URL NZB Relay (/relay-url) ---
        if (url.pathname === "/relay-url" && request.method === "POST") {
            try {
                const bodyJson = await request.json();
                const { downloadUrl, metadata } = bodyJson;
                const torboxApiKey = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") || bodyJson.torboxApiKey || env.TORBOX_API_KEY;

                if (!downloadUrl || !torboxApiKey) {
                    return jsonResponse({ error: "Missing downloadUrl or torboxApiKey" }, 400, corsHeaders);
                }

                const nzbRes = await fetch(downloadUrl, {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        "Accept": "*/*"
                    }
                });

                if (!nzbRes.ok) {
                    return jsonResponse({ error: `Failed to fetch NZB (${nzbRes.status})` }, 502, corsHeaders);
                }

                const fullNzb = await nzbRes.arrayBuffer();
                return await forwardNzbToTorBox(fullNzb, metadata, torboxApiKey.trim(), corsHeaders);
            } catch (err) {
                return jsonResponse({ error: err.message || String(err) }, 500, corsHeaders);
            }
        }

        // --- ENDPOINT: Chunked Upload Relay (/upload-chunk) ---
        if (url.pathname === "/upload-chunk" && request.method === "POST") {
            try {
                const sessionId = request.headers.get("X-Session-Id");
                if (!sessionId) {
                    return jsonResponse({ error: "Missing X-Session-Id header" }, 400, corsHeaders);
                }

                const chunkIndex = parseInt(request.headers.get("X-Chunk-Index") || "0", 10);
                const totalChunks = Math.max(1, parseInt(request.headers.get("X-Total-Chunks") || "1", 10));

                const chunkBuffer = await request.arrayBuffer();

                if (!sessions.has(sessionId)) {
                    sessions.set(sessionId, { chunks: [], received: 0, resolving: false, metadata: {}, createdAt: Date.now() });
                }
                const session = sessions.get(sessionId);

                const metaHeader = request.headers.get("X-Metadata");
                if (metaHeader) {
                    try {
                        session.metadata = JSON.parse(decodeURIComponent(metaHeader));
                    } catch (_) {}
                }

                // Idempotent: count a chunk only the first time we see it.
                if (session.chunks[chunkIndex] === undefined) {
                    session.chunks[chunkIndex] = new Uint8Array(chunkBuffer);
                    session.received += 1;
                }

                // Finalize exactly once when the full set has arrived (order-independent,
                // safe for parallel uploads). The lock is set synchronously before any
                // await so concurrent requests can't double-forward to TorBox.
                if (!session.resolving && session.received >= totalChunks) {
                    session.resolving = true;
                    const meta = session.metadata || {};
                    const torboxApiKey = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") || meta.torboxApiKey || env.TORBOX_API_KEY;
                
                    if (!torboxApiKey) {
                        sessions.delete(sessionId);
                        return jsonResponse({ error: "Missing TorBox API Key" }, 400, corsHeaders);
                    }

                    let totalLength = 0;
                    for (let i = 0; i < session.chunks.length; i++) {
                        if (session.chunks[i]) totalLength += session.chunks[i].length;
                    }

                    const fullNzb = new Uint8Array(totalLength);
                    let offset = 0;
                    for (let i = 0; i < session.chunks.length; i++) {
                        if (session.chunks[i]) {
                            fullNzb.set(session.chunks[i], offset);
                            offset += session.chunks[i].length;
                        }
                    }
                    // Only drop the session once TorBox has accepted the NZB.
                    // If forwarding fails (network blip, TorBox 5xx, ...), keep
                    // the session and release the lock so the client can simply
                    // resend the final chunk and we re-forward the same
                    // assembled file (chunk counting is idempotent, so this is
                    // safe and can't double-upload).
                    // DIAG: capture full session state right before the forward so Cloudflare
                    // worker logs record exactly what the worker assembled and was about to send.
                    try {
                        console.log(`[upload-chunk] forwarding to TorBox session=${sessionId} received=${session.received}/${totalChunks} assembledBytes=${fullNzb.length} chunkSizes=[${session.chunks.map(c => (c ? c.length : "-")).join(",")}] hasChunks=[${session.chunks.map(k => (k ? 1 : 0)).join("")}] file=${session.metadata && session.metadata.fileName || "?"}`);
                    } catch (_) { /* never let logging break the request */ }
                    const forwardResult = await forwardNzbToTorBox(fullNzb, meta, torboxApiKey.trim(), corsHeaders);
                    if (forwardResult.status === 200) {
                        sessions.delete(sessionId);
                    } else {
                        session.resolving = false;
                        session.createdAt = Date.now(); // refresh TTL for the retry window
                    }
                    return forwardResult;
                }

                return jsonResponse({ status: "chunk_received", chunkIndex, received: session.received, totalChunks }, 200, corsHeaders);
            } catch (err) {
                return jsonResponse({ error: err.message || String(err) }, 500, corsHeaders);
            }
        }

        // --- ROOT ENDPOINT: Fast Search & Stream Resolution (TorBox Lookup) ---
        if (url.pathname === "/" || url.pathname === "") {
            if (request.method === 'OPTIONS') {
                return new Response(null, { headers: corsHeaders });
            }

            const tmdbId = url.searchParams.get('tmdb')?.trim() || null;
            const title = url.searchParams.get('title')?.trim() || null;
            const season = url.searchParams.get('s')?.trim() || null;
            const episode = url.searchParams.get('e')?.trim() || null;
            const redirectMode = url.searchParams.get('redirect') === 'true';

            if (!tmdbId && !title) {
                return jsonResponse({ status: 'Nuvio TorBox Master Worker Ready', endpoints: ['status', 'delete', 'relay-url', 'upload-chunk', 'tmdb=...'] }, 200, corsHeaders);
            }

            if (!env.TORBOX_API_KEY) {
                return jsonResponse({ error: 'TORBOX_API_KEY secret is missing or empty in Cloudflare settings.' }, 500, corsHeaders);
            }

            const apiKey = env.TORBOX_API_KEY.trim();
            const searchParams = { tmdbId, title, season, episode };

            try {
                // 1. Check Usenet FIRST (Fastest)
                const usenetResult = await fetchTorboxList('usenet', apiKey);
                let match = findMatchingFile(usenetResult.list, 'usenet', searchParams);

                // 2. Fall back to Torrents ONLY if no Usenet match was found
                let torrentResult = { status: null, list: [], error: null };
                if (!match) {
                    torrentResult = await fetchTorboxList('torrents', apiKey);
                    match = findMatchingFile(torrentResult.list, 'torrents', searchParams);
                }

                if (!match) {
                    // Status protocol: expected states always come back as 200 with a
                    // `status` field, so clients can parse the body instead of
                    // guessing from 404/502 error codes (which Nuvio TVs surface
                    // as opaque failures).
                    return jsonResponse({
                        status: 'not_found',
                        tmdb: tmdbId,
                        season: season,
                        episode: episode,
                        debug: {
                            usenet_count: usenetResult.list.length,
                            torrents_count: torrentResult.list.length,
                        }
                    }, 200, corsHeaders);
                }

                const streamUrl = await getDirectLink(match, apiKey);

                if (!streamUrl) {
                    // The file exists in the TorBox list but the link is not
                    // ready yet — i.e. it is almost certainly still being
                    // downloaded/processed. Report that as a normal state
                    // (200) instead of a 502 so clients can simply poll again.
                    return jsonResponse({
                        status: 'downloading',
                        source: match.type,
                        release_name: match.itemName,
                        file_name: match.fileName,
                        reason: 'link_not_ready'
                    }, 200, corsHeaders);
                }

                if (redirectMode) {
                    return Response.redirect(streamUrl, 302);
                }

                return jsonResponse({
                    status: 'ready',
                    source: match.type,
                    release_name: match.itemName,
                    file_name: match.fileName,
                    stream_url: streamUrl,
                }, 200, corsHeaders);
            } catch (err) {
                return jsonResponse({ error: err.message || 'Internal Server Error' }, 500, corsHeaders);
            }
        }

        return jsonResponse({ error: "Not Found" }, 404, corsHeaders);
    }
};

async function fetchTorboxList(type, apiKey) {
    const apiUrl = `https://api.torbox.app/v1/api/${type}/mylist?bypass_cache=true`;

    try {
        const res = await fetch(apiUrl, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(3500),
        });

        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch {
            return { status: res.status, list: [], error: text.slice(0, 200) };
        }

        if (!res.ok || !json.success) {
            return { status: res.status, list: [], error: json };
        }

        return { status: res.status, list: Array.isArray(json.data) ? json.data : [], error: null };
    } catch (err) {
        return { status: 504, list: [], error: err.message || 'Fetch timeout' };
    }
}

function findMatchingFile(items, type, { tmdbId, title, season, episode }) {
    if (!items || !items.length) return null;

    const videoExtensions = /\.(mkv|mp4|avi|mov|webm)$/i;
    const tmdbRegex = tmdbId ? new RegExp('\\b' + escapeRegex(tmdbId) + '\\b', 'i') : null;
    const cleanTitle = title ? normalize(title) : null;

    let epRegex = null;
    if (season && episode) {
        const sNum = Number(season);
        const ePad = String(episode).padStart(2, '0');
        epRegex = new RegExp(`(s0?${sNum}e${ePad}\\b|${sNum}x${ePad}\\b)`, 'i');
    }

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.files || !item.files.length) continue;

        const itemNameNormalized = normalize(item.name || '');
        const matchesItem = tmdbRegex
            ? (tmdbRegex.test(item.name) || (item.slug && tmdbRegex.test(item.slug)))
            : cleanTitle && itemNameNormalized.includes(cleanTitle);

        if (!matchesItem) continue;

        const videoFiles = [];
        for (let j = 0; j < item.files.length; j++) {
            if (videoExtensions.test(item.files[j].name)) {
                videoFiles.push(item.files[j]);
            }
        }

        if (!videoFiles.length) continue;

        if (epRegex) {
            // Filter all video files matching the episode pattern, then pick the biggest one
            const matchedEpisodeFiles = videoFiles.filter(
                (f) => epRegex.test(f.name) || epRegex.test(f.short_name || '') || epRegex.test(item.name)
            );

            if (matchedEpisodeFiles.length > 0) {
                matchedEpisodeFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
                const mainFile = matchedEpisodeFiles[0];
                return {
                    type,
                    itemId: item.id,
                    itemName: item.name,
                    fileId: mainFile.id,
                    fileName: mainFile.short_name || mainFile.name,
                };
            }
        } else {
            // For movies or items without an episode filter, sort by size descending and pick the biggest
            videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
            const mainFile = videoFiles[0];
            return {
                type,
                itemId: item.id,
                itemName: item.name,
                fileId: mainFile.id,
                fileName: mainFile.short_name || mainFile.name,
            };
        }
    }

    return null;
}

async function getDirectLink(match, apiKey) {
    const idParam = match.type === 'torrents' ? 'torrent_id' : 'usenet_id';
    const endpoint = `https://api.torbox.app/v1/api/${match.type}/requestdl?token=${encodeURIComponent(apiKey)}&${idParam}=${match.itemId}&file_id=${match.fileId}`;

    try {
        const res = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return null;
        const json = await res.json();
        return json.data || null;
    } catch {
        return null;
    }
}

async function forwardNzbToTorBox(fullNzb, meta, torboxApiKey, corsHeaders) {
    const tmdbId = meta && meta.tmdbId ? String(meta.tmdbId) : "media";

    // Append the "S##E##" tag whenever a valid season + episode pair is present.
    // Season/episode only ever exist for episodes (movies never carry them), so the
    // naming no longer depends on the exact "mediaType" string the runtime sends —
    // this is what caused the tag to be silently dropped before.
    const hasSeasonEpisode = !!(meta && meta.season != null && meta.episode != null);
    const episodeTag = hasSeasonEpisode
        ? ` S${String(meta.season).padStart(2, '0')}E${String(meta.episode).padStart(2, '0')}`
        : "";
    const cleanRelease = ((meta && meta.releaseTitle) || "release")
        .replace(/[\/\\?%*:|"<>\[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const displayName = `tmdb-${tmdbId}${episodeTag}.${cleanRelease}`;
    const fileName = `${displayName}.nzb`.replace(/[\r\n"]/g, "_");

    const boundary = `----TorBoxWorker${Date.now()}`;
    const encoder = new TextEncoder();
    const fileHeader = encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/x-nzb\r\n\r\n`
    );
    const middlePart = encoder.encode(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${displayName}\r\n--${boundary}--\r\n`
    );

    const fileBytes = fullNzb instanceof Uint8Array ? fullNzb : new Uint8Array(fullNzb);
    const bodyArray = new Uint8Array(fileHeader.length + fileBytes.length + middlePart.length);
    bodyArray.set(fileHeader, 0);
    bodyArray.set(fileBytes, fileHeader.length);
    bodyArray.set(middlePart, fileHeader.length + fileBytes.length);

    // --- TorBox forward with bounded retry ------------------------------------
    // TorBox's createusenetdownload intermittently returns a transient 5xx
    // ("DOWNLOAD_SERVER_ERROR — Failed to create download. Please try again later."),
    // most often for larger NZBs (reproduced: 500s on ~777 KB NZBs, ~900 ms each).
    // It self-heals on retry, but the client-side retries fire only a few ms apart
    // (postChunk: 300*attempt, round: 1000*round), so they all land inside the SAME
    // short TorBox outage window and fail together. We therefore retry HERE — the one
    // place both /upload-chunk and /relay-url converge — with a small backoff so
    // consecutive attempts are spread across the outage.
    //
    // Retry policy: ONLY transient failures are retried (network errors / timeouts, or
    // HTTP 5xx). Definitive 4xx client errors (e.g. a malformed request) are returned
    // immediately — hammering them just wastes TorBox capacity.
    const TORBOX_URL = "https://api.torbox.app/v1/api/usenet/createusenetdownload";
    const MAX_ATTEMPTS = 3;
    const TORBOX_TIMEOUT_MS = 10000; // generous for a queue-API call, bounded so total time stays client-safe
    const BACKOFF_MS = [600, 1500];  // wait after attempt 1 and attempt 2
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let torboxRes;
        try {
            torboxRes = await fetch(TORBOX_URL, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${torboxApiKey}`,
                    "Content-Type": `multipart/form-data; boundary=${boundary}`
                },
                body: bodyArray,
                signal: AbortSignal.timeout(TORBOX_TIMEOUT_MS)
            });
        } catch (torboxErr) {
            // DIAG: network/timeout/TLS failure reaching TorBox (NOT a TorBox rejection).
            const retrying = attempt < MAX_ATTEMPTS;
            try {
                console.error(`[forwardNzbToTorBox] NETWORK/TIMEOUT attempt=${attempt}/${MAX_ATTEMPTS}: file=${fileName} fileSize=${fileBytes.length} err=${torboxErr.message || String(torboxErr)} name=${torboxErr && torboxErr.name}${retrying ? " — retrying" : ""}`);
            } catch (_) { /* ignore */ }
            if (retrying) {
                await sleep(BACKOFF_MS[attempt - 1] || BACKOFF_MS[BACKOFF_MS.length - 1]);
                continue;
            }
            return jsonResponse({
                error: `Failed to reach TorBox createusenetdownload: ${torboxErr.message || String(torboxErr)}`,
                fileName,
                fileSize: fileBytes.length,
                attempts: attempt
            }, 502, corsHeaders);
        }

        const torboxText = await torboxRes.text();
        let torboxJson;
        try {
            torboxJson = JSON.parse(torboxText);
        } catch (_) {
            torboxJson = { raw: torboxText, httpStatus: torboxRes.status };
        }

        const isSuccess = torboxRes.ok && (torboxJson.success === undefined || torboxJson.success !== false);

        if (isSuccess) {
            const season = meta && meta.season != null ? String(meta.season) : "0";
            const episode = meta && meta.episode != null ? String(meta.episode) : "0";
            const downloadKey = `${tmdbId}${season}${episode}`;
            const torboxDownloadId = (torboxJson && (torboxJson.download_id || torboxJson.usenet_id || (torboxJson.data && torboxJson.data.id))) || null;

            activeDownloads.set(downloadKey, {
                status: "downloading",
                tmdbId,
                season,
                episode,
                releaseTitle: cleanRelease,
                torboxDownloadId,
                createdAt: Date.now()
            });

            if (attempt > 1) {
                try { console.log(`[forwardNzbToTorBox] succeeded on attempt ${attempt}/${MAX_ATTEMPTS} after an earlier transient failure`); } catch (_) { /* ignore */ }
            }
            return jsonResponse(Object.assign({ status: "queued" }, torboxJson), 200, corsHeaders);
        }

        // TorBox explicitly rejected the download (or the response was non-JSON).
        const isTransient = torboxRes.status >= 500; // 5xx = server-side/transient; 4xx = definitive
        const retrying = isTransient && attempt < MAX_ATTEMPTS;

        // DIAG: log the FULL raw body to Cloudflare worker logs — this is the exact
        // message that was previously hidden in the worker relay.
        try {
            console.error(`[forwardNzbToTorBox] TORBOX REJECTION attempt=${attempt}/${MAX_ATTEMPTS}: file=${fileName} fileSize=${fileBytes.length} httpStatus=${torboxRes.status} rawBodyBytes=${torboxText.length} rawBody=${torboxText}${retrying ? " — retrying" : ""}`);
        } catch (_) { /* ignore */ }

        if (retrying) {
            await sleep(BACKOFF_MS[attempt - 1] || BACKOFF_MS[BACKOFF_MS.length - 1]);
            continue;
        }

        // Prefer TorBox's human-readable `detail` (e.g. "Failed to create download. Please try
        // again later.") over the cryptic short `error` code (e.g. "DOWNLOAD_SERVER_ERROR") so the
        // iOS/Android client log shows something meaningful.
        const torboxDetail = torboxJson && (torboxJson.detail || torboxJson.message || torboxJson.error);
        const torboxCode = torboxJson && torboxJson.error;
        return jsonResponse({
            error: torboxDetail || `TorBox returned HTTP ${torboxRes.status}`,
            torboxCode: torboxCode || null,
            torboxHttpStatus: torboxRes.status,
            torbox: torboxJson,
            fileName,
            fileSize: fileBytes.length,
            attempts: attempt
        }, 502, corsHeaders);
    }
}

function normalize(str) {
    return str ? str.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : '';
}

function escapeRegex(str) {
    return str.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function jsonResponse(body, status = 200, corsHeaders = {}) {
    return new Response(JSON.stringify(body, null, 2), {
        status: status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
        },
    });
}
