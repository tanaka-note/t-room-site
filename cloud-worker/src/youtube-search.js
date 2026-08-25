const CACHE_ORIGIN = "https://troom-player-cache.invalid";
const encoder = new TextEncoder();

export async function handleYouTubeSearchRequest(url, env, dependencies = {}) {
  try {
    const query = String(url.searchParams.get("q") || "").trim();
    if (query.length < 2 || query.length > 100) {
      return errorResponse(400, "YouTube検索語を2〜100文字で指定してください。");
    }
    const maxResults = Math.min(10, Math.max(1, Number.parseInt(url.searchParams.get("maxResults") || "8", 10) || 8));
    const cache = dependencies.cache || globalThis.caches?.default;
    const cacheId = `search/${await sha256Base64Url(`${query.toLowerCase()}|${maxResults}`)}`;
    const cacheUrl = `${CACHE_ORIGIN}/${cacheId}`;
    const cached = cache ? await cache.match(cacheUrl).catch(() => null) : null;
    if (cached) return json(await cached.json());

    const apiKey = String(env.YOUTUBE_API_KEY || "").trim();
    if (!apiKey) return errorResponse(503, "YouTube Data APIの設定が完了していません。");

    const fetcher = dependencies.fetcher || globalThis.fetch;
    const searchParams = new URLSearchParams({
      part: "snippet",
      type: "video",
      q: query,
      maxResults: String(maxResults),
      safeSearch: "moderate",
      regionCode: "JP",
      relevanceLanguage: "ja",
      videoEmbeddable: "true",
      videoSyndicated: "true",
      key: apiKey,
    });
    const searchResponse = await fetcher(`https://www.googleapis.com/youtube/v3/search?${searchParams}`);
    if (!searchResponse.ok) return errorResponse(502, "YouTube APIから検索結果を取得できませんでした。");
    const searchPayload = await searchResponse.json();
    const ids = [...new Set((Array.isArray(searchPayload.items) ? searchPayload.items : [])
      .map((item) => normalizeVideoId(item?.id?.videoId)).filter(Boolean))];
    const items = ids.length ? await fetchVideoDetails(fetcher, apiKey, ids) : [];
    const result = { items };
    if (cache) {
      await cache.put(cacheUrl, new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=21600" },
      })).catch(() => {});
    }
    return json(result);
  } catch (_error) {
    return errorResponse(502, "YouTube検索中に問題が発生しました。時間をおいてもう一度お試しください。");
  }
}

async function fetchVideoDetails(fetcher, apiKey, ids) {
  const params = new URLSearchParams({
    part: "snippet,contentDetails,status",
    id: ids.join(","),
    key: apiKey,
  });
  const response = await fetcher(`https://www.googleapis.com/youtube/v3/videos?${params}`);
  if (!response.ok) throw new Error("youtube video details unavailable");
  const payload = await response.json();
  const byId = new Map((Array.isArray(payload.items) ? payload.items : [])
    .filter((item) => item?.status?.embeddable === true)
    .map((item) => [item.id, {
      videoId: item.id,
      title: String(item.snippet?.title || "YouTube動画").slice(0, 300),
      channel: String(item.snippet?.channelTitle || "").slice(0, 200),
      thumbnailUrl: String(item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || ""),
      durationMs: parseYouTubeDuration(item.contentDetails?.duration),
      embeddable: true,
    }]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function normalizeVideoId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

function parseYouTubeDuration(value) {
  const match = String(value || "").match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return 0;
  return (((Number(match[1] || 0) * 24 + Number(match[2] || 0)) * 60
    + Number(match[3] || 0)) * 60 + Number(match[4] || 0)) * 1000;
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function errorResponse(status, message) {
  return json({ error: message }, status);
}
