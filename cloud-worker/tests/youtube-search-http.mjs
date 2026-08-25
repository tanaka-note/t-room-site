import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { handleYouTubeSearchRequest } from "../src/youtube-search.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

function memoryCache() {
  const values = new Map();
  return {
    async match(key) { return values.get(String(key))?.clone() || null; },
    async put(key, response) { values.set(String(key), response.clone()); },
  };
}

const calls = [];
const fetcher = async (input) => {
  const url = new URL(input);
  calls.push(url);
  if (url.pathname.endsWith("/search")) {
    return Response.json({
      items: [
        { id: { videoId: "abcdefghijk" } },
        { id: { videoId: "lmnopqrstuv" } },
      ],
    });
  }
  return Response.json({
    items: [
      {
        id: "abcdefghijk",
        snippet: {
          title: "平沢進 公式動画",
          channelTitle: "公式チャンネル",
          thumbnails: { medium: { url: "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg" } },
        },
        contentDetails: { duration: "PT4M5S" },
        status: { embeddable: true },
      },
      {
        id: "lmnopqrstuv",
        snippet: { title: "埋め込み不可", channelTitle: "非表示", thumbnails: {} },
        contentDetails: { duration: "PT1M" },
        status: { embeddable: false },
      },
    ],
  });
};

const cache = memoryCache();
const requestUrl = new URL("https://tanaka-note.com/cloud/api/player/youtube/search?q=%E5%B9%B3%E6%B2%A2%E9%80%B2&maxResults=10");
const response = await handleYouTubeSearchRequest(requestUrl, { YOUTUBE_API_KEY: "test-only-key" }, { fetcher, cache });
assert.equal(response.status, 200);
const result = await response.json();
assert.deepEqual(result, {
  items: [{
    videoId: "abcdefghijk",
    title: "平沢進 公式動画",
    channel: "公式チャンネル",
    thumbnailUrl: "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg",
    durationMs: 245000,
    embeddable: true,
  }],
});
assert.equal(calls.length, 2);
assert.equal(calls[0].searchParams.get("q"), "平沢進");
assert.equal(calls[0].searchParams.get("type"), "video");
assert.equal(calls[0].searchParams.get("regionCode"), "JP");
assert.equal(calls[0].searchParams.get("relevanceLanguage"), "ja");
assert.equal(calls[0].searchParams.get("videoEmbeddable"), "true");
assert.equal(calls[0].searchParams.get("videoSyndicated"), "true");
assert.equal(calls[0].searchParams.get("maxResults"), "10");
assert.equal(calls[1].searchParams.get("part"), "snippet,contentDetails,status");
assert.equal(calls[1].searchParams.get("id"), "abcdefghijk,lmnopqrstuv");

const cached = await handleYouTubeSearchRequest(requestUrl, { YOUTUBE_API_KEY: "test-only-key" }, {
  fetcher: async () => { throw new Error("cache was not used"); },
  cache,
});
assert.equal(cached.status, 200);
assert.deepEqual(await cached.json(), result);

const empty = await handleYouTubeSearchRequest(
  new URL("https://tanaka-note.com/cloud/api/player/youtube/search?q=%E6%9C%AA%E7%99%BB%E9%8C%B2"),
  { YOUTUBE_API_KEY: "test-only-key" },
  { fetcher: async () => Response.json({ items: [] }), cache: memoryCache() },
);
assert.equal(empty.status, 200);
assert.deepEqual(await empty.json(), { items: [] });

const missing = await handleYouTubeSearchRequest(requestUrl, {}, {
  fetcher: async () => { throw new Error("must not call API without a key"); },
  cache: memoryCache(),
});
assert.equal(missing.status, 503);
assert.deepEqual(await missing.json(), { error: "YouTube Data APIの設定が完了していません。" });

for (const upstreamStatus of [403, 500]) {
  const failed = await handleYouTubeSearchRequest(
    new URL(`https://tanaka-note.com/cloud/api/player/youtube/search?q=%E5%A4%B1%E6%95%97${upstreamStatus}`),
    { YOUTUBE_API_KEY: "test-only-key" },
    { fetcher: async () => new Response("upstream raw details", { status: upstreamStatus }), cache: memoryCache() },
  );
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: "YouTube APIから検索結果を取得できませんでした。" });
}

const invalid = await handleYouTubeSearchRequest(
  new URL("https://tanaka-note.com/cloud/api/player/youtube/search?q=x"),
  { YOUTUBE_API_KEY: "test-only-key" },
  { fetcher, cache: memoryCache() },
);
assert.equal(invalid.status, 400);

console.log("YouTube keyword search handler with mocked Data API: ok");
