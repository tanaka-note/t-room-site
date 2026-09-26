// Device-only, bounded TS/FLV demux/remux. No decoder, encoder or remote API.
import MP4 from './vendor/mp4-generator-1.8.0.mjs';

const BLOCK = 1024 * 1024;
const controller = new AbortController();
const blocks = new Map();
let av, context, packet, tracks, origin, ready, initialPackets, transport, busy = false, eof = false;
let readBudget = 24 * BLOCK;

function join(parts) {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function nals(bytes) {
  const units = [];
  let start = -1;
  for (let i = 0; i + 3 < bytes.length; i++) {
    const length = bytes[i] === 0 && bytes[i + 1] === 0
      ? bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0 : 0;
    if (!length) continue;
    if (start >= 0) units.push(bytes.subarray(start, i));
    start = i + length;
    i += length - 1;
  }
  if (start >= 0) units.push(bytes.subarray(start));
  return units;
}

function avcc(bytes) {
  const units = nals(bytes), sps = units.find(unit => (unit[0] & 31) === 7), pps = units.find(unit => (unit[0] & 31) === 8);
  if (!sps || !pps || sps.length < 4 || sps.length > 65535 || pps.length > 65535) throw new Error('Missing AVC configuration');
  return join([Uint8Array.of(1, sps[1], sps[2], sps[3], 255, 225, sps.length >> 8, sps.length & 255), sps,
    Uint8Array.of(1, pps.length >> 8, pps.length & 255), pps]);
}

function videoData(bytes) {
  return join(nals(bytes).filter(unit => ![7, 8, 9].includes(unit[0] & 31)).map(unit => {
    const data = new Uint8Array(4 + unit.length);
    new DataView(data.buffer).setUint32(0, unit.length);
    data.set(unit, 4);
    return data;
  }));
}

function aacFrames(bytes) {
  const frames = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 7 > bytes.length || bytes[offset] !== 255 || (bytes[offset + 1] & 246) !== 240) throw new Error('Invalid ADTS');
    const profile = (bytes[offset + 2] >> 6) + 1, rateIndex = (bytes[offset + 2] >> 2) & 15;
    const channels = ((bytes[offset + 2] & 1) << 2) | (bytes[offset + 3] >> 6);
    const length = ((bytes[offset + 3] & 3) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5);
    const header = bytes[offset + 1] & 1 ? 7 : 9;
    const rate = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350][rateIndex];
    if (!rate || !channels || profile !== 2 || (bytes[offset + 6] & 3) !== 0 || length <= header || offset + length > bytes.length) throw new Error('Unsupported AAC configuration');
    frames.push({ data: bytes.subarray(offset + header, offset + length), rate, channels,
      config: Uint8Array.of((profile << 3) | (rateIndex >> 1), ((rateIndex & 1) << 7) | (channels << 3)) });
    offset += length;
  }
  return frames;
}

function seconds(value, high, stream) { return av.i64tof64(value, high) * stream.time_base_num / stream.time_base_den; }

async function open({ url, size, time = 0, container = 'mpeg-ts' }) {
  const source = new URL(url, self.location.href);
  if (source.origin !== self.location.origin || !source.pathname.startsWith('/cloud/local-media/') || !Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid local media source');
  if (!['mpeg-ts', 'flv'].includes(container)) throw new Error('Unsupported remux container');
  transport = container === 'mpeg-ts';
  const { default: LibAV } = await import(`./vendor/libav/libav-6.7.7.1.1-demuxer-${transport ? 'mpegts' : 'flv'}.mjs`);
  av = await LibAV.LibAV({ noworker: true, nothreads: true });
  await av.av_log_set_level(8);
  av.onblockread = async (name, position, length) => {
    if (position >= size) { await av.ff_block_reader_dev_send(name, position, new Uint8Array()); return; }
    const start = Math.floor(position / BLOCK) * BLOCK;
    let bytes = blocks.get(start);
    if (!bytes) {
      const end = Math.min(size, start + BLOCK);
      readBudget -= end - start;
      if (readBudget < 0) throw new Error('Remux read budget exceeded');
      const response = await fetch(source.href, { headers: { Range: `bytes=${start}-${end - 1}` }, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${start}-${end - 1}/${size}`) throw new Error('Local media Range unavailable');
      bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== end - start) throw new Error('Local media Range length mismatch');
      blocks.set(start, bytes);
      while (blocks.size > 4) { const key = blocks.keys().next().value; blocks.get(key).fill(0); blocks.delete(key); }
    }
    await av.ff_block_reader_dev_send(name, position, bytes.slice(position - start, position - start + Math.min(BLOCK, Math.max(length, 65536))));
  };
  await av.mkblockreaderdev('input', size);
  const opened = await av.ff_init_demuxer_file('input');
  context = opened[0];
  // Unknown private streams may be audio (e.g. Blu-ray private AAC). Do not
  // silently accept a video-only remux by filtering those streams away.
  if (opened[1].some(stream => stream.codec_type !== 0 && stream.codec_type !== 1)) throw new Error('Unsupported private stream');
  const streams = opened[1];
  if (streams.length > 2 || streams.filter(stream => stream.codec_type === 0).length !== 1 || streams.some(stream => stream.codec_type === 0 ? stream.codec_id !== 27 : stream.codec_id !== 86018)) throw new Error('Remux supports AVC and AAC only');
  packet = await av.av_packet_alloc();
  const [, initial] = await av.ff_read_frame_multi(context, packet, { limit: 256 * 1024, unify: true });
  const first = initial[0] || [], videoStream = streams.find(stream => stream.codec_type === 0);
  const firstVideo = first.find(input => input.stream_index === videoStream.index && (input.flags & 1));
  if (!firstVideo) throw new Error('AVC keyframe unavailable');
  origin = seconds(firstVideo.dts, firstVideo.dtshi, videoStream);
  const contextDuration = av.i64tof64(await av.c('AVFormatContext_duration', context), await av.c('AVFormatContext_durationhi', context)) / 1e6;
  const duration = Math.max(contextDuration, ...streams.map(stream => stream.duration));
  if (!Number.isFinite(duration) || duration <= 0 || duration > 12 * 3600) throw new Error('Static duration unavailable');
  tracks = await Promise.all(streams.map(async stream => {
    const par = await av.c('ff_copyout_codecpar', stream.codecpar);
    const scale = 90000;
    if (!(stream.time_base_num > 0) || !(stream.time_base_den > 0)) throw new Error('Unsupported stream time base');
    const meta = { id: stream.index + 1, type: stream.codec_type === 0 ? 'video' : 'audio', timescale: scale, duration: Math.ceil(duration * scale), sequenceNumber: 0 };
    if (stream.codec_type === 0) {
      meta.avcc = transport ? avcc(firstVideo.data) : par.extradata;
      if (!meta.avcc || meta.avcc[0] !== 1 || (meta.avcc[4] & 3) !== 3) throw new Error('Unsupported AVC configuration');
      meta.codecWidth = meta.presentWidth = par.width;
      meta.codecHeight = meta.presentHeight = par.height;
      meta.sarRatio = { width: 1, height: 1 };
      meta.codec = 'avc1.' + Array.from(meta.avcc.slice(1,4), byte => byte.toString(16).padStart(2,'0')).join('');
    } else {
      const input = first.find(input => input.stream_index === stream.index);
      if (!input) throw new Error('AAC configuration unavailable');
      let frame;
      if (transport) frame = aacFrames(input.data)[0];
      else {
        const config = par.extradata;
        if (!config || config.length < 2 || config[0] >> 3 !== 2) throw new Error('Unsupported AAC configuration');
        const rateIndex = ((config[0] & 7) << 1) | (config[1] >> 7);
        frame = { config: Array.from(config.slice(0, 2)), rate: [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350][rateIndex], channels: (config[1] >> 3) & 15 };
        if (!frame.rate || !frame.channels || frame.channels > 7) throw new Error('Unsupported AAC configuration');
      }
      Object.assign(meta, { config: Array.from(frame.config), codec: 'mp4a.40.2', audioSampleRate: frame.rate, channelCount: frame.channels });
      meta.timescale = frame.rate;
      meta.duration = Math.ceil(duration * frame.rate);
    }
    return { stream, meta, started: false };
  }));
  // FFmpeg's timestamp seeking reads only bounded device ranges, including TS/M2TS.
  if (time > 0) {
    const [lo, hi] = av.f64toi64((origin + Math.max(0, time - 2)) * 1e6);
    const result = await av.av_seek_frame(context, -1, lo, hi, av.AVSEEK_FLAG_BACKWARD);
    if (result < 0) throw new Error('Container seek failed');
  } else {
    initialPackets = {};
    for (const input of first) (initialPackets[input.stream_index] ||= []).push(input);
  }
  ready = true;
  self.postMessage({ type: 'ready', duration, tracks: tracks.map(({ meta }) => ({ type: meta.type, mime: `${meta.type}/mp4; codecs="${meta.codec}"`, init: MP4.generateInitSegment(meta) })) });
}

async function pull() {
  if (!ready || busy || eof) return;
  busy = true;
  readBudget = 16 * BLOCK;
  try {
    const [result, packets] = initialPackets ? [0, initialPackets] : await av.ff_read_frame_multi(context, packet, { limit: 512 * 1024 });
    initialPackets = null;
    const fragments = [];
    let end = 0;
    for (const track of tracks) {
      const samples = [], data = [];
      let base;
      const inputs = packets[track.stream.index] || [];
      for (let index = 0; index < inputs.length; index++) {
        const input = inputs[index];
        const frames = track.meta.type === 'audio'
          ? transport ? aacFrames(input.data) : [{ data: input.data, rate: track.meta.audioSampleRate }]
          : [{ data: transport ? videoData(input.data) : input.data }];
        let timestamp = input.dtshi === av.AV_NOPTS_VALUE_HI ? track.nextDts : seconds(input.dts, input.dtshi, track.stream);
        if (!Number.isFinite(timestamp)) continue;
        if (track.meta.type === 'audio') {
          if (Number.isFinite(track.nextDts) && Math.abs(timestamp - track.nextDts) < .1) timestamp = track.nextDts;
          track.nextDts = timestamp + frames.reduce((sum, frame) => sum + 1024 / frame.rate, 0);
        }
        const dts = timestamp - origin;
        if (dts < 0) continue;
        if (!track.started && track.meta.type === 'video' && !(input.flags & 1)) continue;
        track.started = true;
        const pts = track.meta.type === 'audio' ? dts : seconds(input.pts, input.ptshi, track.stream) - origin;
        let offset = 0;
        for (const frame of frames) {
          const next = inputs[index + 1];
          const duration = track.meta.type === 'audio' ? 1024 / frame.rate
            : next ? seconds(next.dts, next.dtshi, track.stream) - timestamp : seconds(input.duration, input.durationhi, track.stream);
          const scale = track.meta.timescale;
          const cts = Math.round((pts - dts) * scale);
          if (!(duration > 0) || cts < 0) throw new Error('Unsupported packet timeline');
          base ??= Math.round((dts + offset) * scale);
          data.push(frame.data);
          samples.push({ duration: Math.max(1, Math.round(duration * scale)), size: frame.data.length, cts, flags: { isLeading: 0, dependsOn: input.flags & 1 ? 2 : 1, isDependedOn: 0, hasRedundancy: 0, isNonSync: input.flags & 1 ? 0 : 1 } });
          offset += duration;
          end = Math.max(end, dts + offset);
        }
      }
      if (samples.length) {
        track.meta.sequenceNumber++;
        fragments.push({ type: track.meta.type, bytes: join([MP4.moof({ ...track.meta, samples }, base), MP4.mdat(join(data))]) });
      }
    }
    eof = result === av.AVERROR_EOF;
    self.postMessage({ type: 'data', fragments, end, eof }, fragments.map(fragment => fragment.bytes.buffer));
  } finally { busy = false; }
}

self.addEventListener('message', async ({ data }) => {
  try {
    if (data.type === 'open') await open(data);
    else if (data.type === 'pull') await pull();
  } catch { self.postMessage({ type: 'error' }); controller.abort(); }
});
