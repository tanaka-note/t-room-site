import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { normalizeSourceUrl, DomainError } from '../src/downloader-domain.js';
import { markEgressResponse } from '../src/main-video.js';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const slice = (a, b) => source.slice(source.indexOf(a), source.indexOf(b));
// Public application identifier from yt-dlp 2026.08.19, not a user credential.
const publicBearer = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const activation = 'https://api.x.com/1.1/guest/activate.json';
const tweet = 'https://x.com/i/api/graphql/2ICDjqPd81tulZcYrtpTuQ/TweetResultByRestId?variables=%7B%7D';
function harness() {
  const sent = [], checked = [];
  // Node requires duplex for streaming request bodies; Workers does not.
  class WorkerRequest extends Request { constructor(url, init) { super(url, { ...init, duplex: 'half' }); } }
  const ctx = { Request: WorkerRequest, Response, Headers, URL, AbortSignal, crypto, Uint8Array, TextEncoder,
    encoder: new TextEncoder(), DomainError, normalizeSourceUrl, markEgressResponse,
    DownloaderContainer: {}, isPolicyRestrictedHost: h => h === 'youtube.com', YOUTUBE_ANALYSIS_HOSTS: ['youtube.com'],
    async assertPublicDestination(url) { checked.push(url); if (ctx.dnsBlocked) throw new Error('main_video_dns_blocked'); },
    async fetch(req) { sent.push(req); return new Response('{}', { status: ctx.status || 200, headers: ctx.responseHeaders }); }
  };
  vm.createContext(ctx);
  vm.runInContext(slice('const PRIVACY_EGRESS_USER_AGENT', 'const YOUTUBE_ANALYSIS_HOSTS') +
    slice('function isAllowedExtractorPost(', 'function decodeHeaderValue(') +
    slice('async function configureContainerEgress(', 'async function requireHealthyContainer(') +
    slice('DownloaderContainer.outbound =', 'DownloaderContainer.outboundHandlers ='), ctx);
  return { ctx, sent, checked, send: req => ctx.DownloaderContainer.outbound(req) };
}
const auth = { Authorization: publicBearer, 'x-guest-token': '1234567890123456789', Cookie: 'private', 'x-csrf-token': 'private', Referer: 'https://private.example/?secret', Origin: 'https://private.example' };

test('public X activation and tweet GET keep only pinned public bearer and numeric guest token', async () => {
  const h = harness();
  assert.equal((await h.send(new Request(activation, { method: 'POST', headers: auth, body: '' }))).status, 200);
  assert.equal((await h.send(new Request(tweet, { headers: auth }))).status, 200);
  assert.equal(h.sent[0].method, 'POST');
  assert.equal(await h.sent[0].text(), '');
  assert.equal(h.sent[0].headers.get('Content-Type'), 'application/x-www-form-urlencoded');
  assert.equal(h.sent[0].headers.get('x-guest-token'), null);
  assert.equal(h.sent[1].headers.get('x-guest-token'), auth['x-guest-token']);
  for (const req of h.sent) {
    assert.equal(req.headers.get('Authorization'), publicBearer);
    assert.equal(req.redirect, 'manual');
    for (const name of ['Cookie', 'x-csrf-token', 'Referer', 'Origin']) assert.equal(req.headers.get(name), null);
  }
  assert.equal(h.checked.length, 2);
});

test('X refuses arbitrary credentials, payloads, methods and activation variants before sending', async () => {
  const h = harness();
  for (const req of [
    new Request(activation, { method: 'POST', headers: { Authorization: 'Bearer user-secret' } }),
    new Request(activation, { method: 'POST', headers: auth, body: 'payload' }),
    new Request(activation, { headers: auth }),
    new Request(activation + '?unexpected=1', { method: 'POST', headers: auth }),
    new Request(activation.replace('https:', 'http:'), { method: 'POST', headers: auth }),
    new Request(activation.replace('api.x.com', 'api.x.com.evil.example'), { method: 'POST', headers: auth }),
    new Request(tweet, { method: 'POST', headers: auth }),
    new Request(tweet, { headers: { ...auth, 'x-guest-token': 'private-token' } }),
    new Request(tweet, { headers: { ...auth, Authorization: 'Bearer user-secret' } })
  ]) assert.ok([403,405].includes((await h.send(req)).status));
  assert.equal(h.sent.length, 0);
});

test('public API auth never follows redirects or leaks to CDN, unrelated API or other sites', async () => {
  const h = harness(); h.ctx.status = 302; h.ctx.responseHeaders = { Location: 'https://other.example/' };
  assert.equal((await h.send(new Request(tweet, { headers: auth }))).status, 302);
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].redirect, 'manual');
  for (const url of ['https://video.twimg.com/fixture.mp4', 'https://other.example/', 'https://x.com/i/api/graphql/other/Mutation']) {
    await h.send(new Request(url, { headers: auth }));
    for (const name of ['Authorization', 'x-guest-token', 'Cookie']) assert.equal(h.sent.at(-1).headers.get(name), null);
  }
  h.ctx.dnsBlocked = true;
  const count = h.sent.length;
  assert.equal((await h.send(new Request(tweet, { headers: auth }))).status, 403);
  assert.equal(h.sent.length, count);
});

test('public post URL grants only exact X dependencies in both analysis and selected-route setup', async () => {
  const h = harness(); const calls = []; const c = { async setAllowedHosts(hosts) { calls.push([...hosts]); } };
  for (const url of ['https://x.com/NASA/status/123/video/1', 'https://twitter.com/NASA/status/123']) {
    await h.ctx.configureContainerEgress(c, new URL(url));
    for (const host of ['x.com', 'api.x.com', 'video.twimg.com', 'cdn.syndication.twimg.com']) assert.ok(calls.at(-1).includes(host));
    assert.ok(!calls.at(-1).includes('*.twimg.com'));
  }
  for (const url of ['https://example.com/status/123', 'https://x.com/home', 'https://x.com.evil.example/NASA/status/123']) {
    await h.ctx.configureContainerEgress(c, new URL(url));
    assert.ok(!calls.at(-1).includes('video.twimg.com'));
  }
  await h.ctx.configureContainerEgress(c, new URL('https://x.com/NASA/status/123'), ['video.twimg.com']);
  assert.ok(calls.at(-1).includes('api.x.com'));
});

test('existing YouTube POST and direct Range keep their prior behavior', async () => {
  const h = harness();
  const body = '{"context":{}}';
  assert.equal((await h.send(new Request('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST', body, headers: { ...auth, 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': '2.20260912' }
  }))).status, 200);
  assert.equal(await h.sent[0].text(), body);
  assert.equal(h.sent[0].headers.get('Origin'), 'https://www.youtube.com');
  assert.equal(h.sent[0].headers.get('X-Youtube-Client-Name'), '1');
  assert.equal(h.sent[0].headers.get('Authorization'), null);
  await h.send(new Request('https://example.com/video.mp4', { headers: { Range: 'bytes=0-9', ...auth } }));
  assert.equal(h.sent[1].headers.get('Range'), 'bytes=0-9');
  assert.equal(h.checked.length, 0);
});
