import http from "node:http";
import { pathToFileURL } from "node:url";

export const LARGE_BYTES = 100 * 1024 * 1024;
const SMALL_BYTES = 2 * 1024 * 1024;

export async function startFixtureServer({ port = 0, redirectOrigin = null } = {}) {
  const state = { rangeRequests: 0, fullRequests: 0, flakyRequests: 0, crossOriginCredentials: false, generatedVideo: null };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/") return page(response);
    if (url.pathname === "/generated" && request.method === "POST") {
      try {
        state.generatedVideo = await readBody(request, 5 * 1024 * 1024);
        response.writeHead(204); return response.end();
      } catch { response.writeHead(413); return response.end(); }
    }
    if (url.pathname === "/generated.webm" && state.generatedVideo) return mediaBuffer(response, request, state.generatedVideo, "video/webm", state);
    if (url.pathname === "/master.m3u8") return text(response, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=640x360\nvariant.m3u8?sig=fixture\n", "application/vnd.apple.mpegurl");
    if (url.pathname === "/variant.m3u8") return text(response, "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nsegment-1.ts\n#EXTINF:1,\nsegment-2.ts\n#EXT-X-ENDLIST\n", "application/x-mpegurl");
    if (/^\/segment-\d+\.ts$/.test(url.pathname)) return media(response, request, 188 * 100, { contentType: "video/mp2t", transportStream: true, state });
    if (url.pathname === "/manifest.mpd") return text(response, dashManifest(false), "application/dash+xml");
    if (url.pathname === "/split.mpd") return text(response, dashManifest(false, true), "application/dash+xml");
    if (url.pathname === "/drm.mpd") return text(response, dashManifest(true), "application/dash+xml");
    if (url.pathname === "/protected" && !hasContext(request)) { response.writeHead(403); return response.end("context required"); }
    if (url.pathname === "/origin-required" && request.headers.origin !== originOf(request)) { response.writeHead(403); return response.end("origin required"); }
    if (url.pathname === "/cookie-required" && request.headers.cookie !== "fixture=ok") { response.writeHead(403); return response.end("cookie required"); }
    if (url.pathname === "/referer-required" && request.headers.referer !== `${originOf(request)}/`) { response.writeHead(403); return response.end("referer required"); }
    if (url.pathname === "/signed" && url.searchParams.get("sig") !== "fixture") { response.writeHead(403); return response.end("signature required"); }
    if (url.pathname === "/redirect") { response.writeHead(302, { Location: "/video.mp4" }); return response.end(); }
    if (url.pathname === "/cross-origin-redirect") { response.writeHead(302, { Location: `${redirectOrigin || originOf(request)}/credential-target` }); return response.end(); }
    if (url.pathname === "/credential-target") state.crossOriginCredentials = Boolean(request.headers.cookie || request.headers.authorization);
    if (url.pathname === "/status/403") { response.writeHead(403); return response.end(); }
    if (url.pathname === "/status/429") { response.writeHead(429, { "Retry-After": "1" }); return response.end(); }
    if (url.pathname === "/timeout") return setTimeout(() => media(response, request, SMALL_BYTES, { state }), 5000);
    if (url.pathname === "/flaky" && ++state.flakyRequests < 3) { response.writeHead(503); return response.end(); }
    if (url.pathname === "/candidates") return text(response, JSON.stringify({ media: ["/video.mp4", "/master.m3u8", "/manifest.mpd"] }), "application/json");
    if (url.pathname === "/video.mp4" || url.pathname === "/extensionless" || url.pathname === "/protected" || url.pathname === "/origin-required" || url.pathname === "/cookie-required" || url.pathname === "/referer-required" || url.pathname === "/signed" || url.pathname === "/redirect" || url.pathname === "/credential-target" || url.pathname === "/flaky") return media(response, request, SMALL_BYTES, { state });
    if (url.pathname === "/range-100mb.mp4") return media(response, request, LARGE_BYTES, { state });
    if (url.pathname === "/no-range.mp4") return media(response, request, SMALL_BYTES, { state, range: false });
    if (url.pathname === "/range-mismatch.mp4") return media(response, request, SMALL_BYTES, { state, mismatch: true });
    if (url.pathname === "/video-only.m4s" || url.pathname === "/audio-only.m4s") return media(response, request, 512 * 1024, { state, contentType: url.pathname.includes("audio") ? "audio/mp4" : "video/mp4" });
    response.writeHead(404); response.end();
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, state, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

function page(response) {
  text(response, `<!doctype html><meta charset="utf-8"><title>Downloader 2 Fixture</title><h1>Downloader 2 Fixture</h1>
  <p id="fixture-status">再生可能なローカル動画を生成しています…</p><canvas id="source" width="96" height="54" hidden></canvas>
  <video id="generated-video" controls muted autoplay></video>
  <p><a href="/master.m3u8">HLS</a> <a href="/manifest.mpd">DASH</a> <a href="/protected">Context required</a></p>
  <script>
  (async()=>{const status=document.querySelector('#fixture-status'),canvas=document.querySelector('#source'),ctx=canvas.getContext('2d');
  if(!window.MediaRecorder||!canvas.captureStream){status.textContent='このブラウザではMediaRecorder fixtureを生成できません。';return;}
  const stream=canvas.captureStream(12),chunks=[],recorder=new MediaRecorder(stream,{mimeType:'video/webm'});recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
  let frame=0,timer=setInterval(()=>{ctx.fillStyle=frame++%2?'#587061':'#b8c9bb';ctx.fillRect(0,0,96,54)},80);recorder.start();await new Promise(r=>setTimeout(r,1100));
  const stopped=new Promise(r=>recorder.onstop=r);recorder.stop();await stopped;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());
  const blob=new Blob(chunks,{type:'video/webm'});await fetch('/generated',{method:'POST',headers:{'Content-Type':'video/webm'},body:blob});
  const video=document.querySelector('#generated-video');video.src='/generated.webm?fixture=local';await video.play();status.textContent='ローカル生成WebMを再生中です。';
  })().catch(()=>{document.querySelector('#fixture-status').textContent='fixture動画を生成できませんでした。'});
  </script>`, "text/html; charset=utf-8");
}

function mediaBuffer(response, request, buffer, contentType, state) {
  const parsed = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
  let start = 0, end = buffer.length - 1, status = 200;
  if (parsed) { start = Number(parsed[1]); end = parsed[2] ? Math.min(Number(parsed[2]), end) : end; status = 206; state.rangeRequests++; }
  else state.fullRequests++;
  const headers = { "Content-Type": contentType, "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes" };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${buffer.length}`;
  response.writeHead(status, headers); response.end(buffer.subarray(start, end + 1));
}

function media(response, request, length, { state, range = true, mismatch = false, contentType = "video/mp4", transportStream = false }) {
  const parsed = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
  let start = 0, end = length - 1, status = 200;
  if (parsed && range) {
    start = Number(parsed[1]); end = parsed[2] ? Math.min(Number(parsed[2]), length - 1) : length - 1; status = 206; state.rangeRequests++;
  } else state.fullRequests++;
  const headers = { "Content-Type": contentType, "Content-Length": String(end - start + 1), "Accept-Ranges": range ? "bytes" : "none" };
  if (status === 206) headers["Content-Range"] = `bytes ${mismatch && start > 0 ? start + 1 : start}-${end}/${length}`;
  response.writeHead(status, headers);
  const chunk = Buffer.alloc(64 * 1024);
  let offset = start;
  const write = () => {
    while (offset <= end) {
      const count = Math.min(chunk.length, end - offset + 1);
      for (let index = 0; index < count; index++) chunk[index] = transportStream && (offset + index) % 188 === 0 ? 0x47 : (offset + index) % 251;
      if (!response.write(chunk.subarray(0, count))) { offset += count; return response.once("drain", write); }
      offset += count;
    }
    response.end();
  };
  write();
}

function text(response, body, contentType) { response.writeHead(200, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) }); response.end(body); }
function readBody(request, limit) { return new Promise((resolve, reject) => { const chunks = []; let length = 0; request.on("data", (chunk) => { length += chunk.length; if (length > limit) { reject(new Error("too large")); request.destroy(); } else chunks.push(chunk); }); request.on("end", () => resolve(Buffer.concat(chunks))); request.on("error", reject); }); }
function originOf(request) { return `http://${request.headers.host}`; }
function hasContext(request) { return request.headers.cookie === "fixture=ok" && request.headers.origin === originOf(request) && request.headers.referer === `${originOf(request)}/`; }
function dashManifest(drm, split = false) { return `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period>${drm ? '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" />' : ""}<AdaptationSet contentType="video"><Representation id="v"><BaseURL>video-only.m4s</BaseURL></Representation></AdaptationSet>${split ? '<AdaptationSet contentType="audio"><Representation id="a"><BaseURL>audio-only.m4s</BaseURL></Representation></AdaptationSet>' : ""}</Period></MPD>`; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startFixtureServer({ port: Number(process.env.PORT || 0) });
  console.log(`Downloader 2 fixture: ${fixture.origin}`);
}
