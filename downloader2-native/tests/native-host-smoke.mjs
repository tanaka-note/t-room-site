import { spawn } from "node:child_process";

const [runtime, host] = process.argv.slice(2);
if (!runtime || !host) throw new Error("usage: native-host-smoke.mjs <dotnet|direct> <host.dll|published-host.exe>");
const child = runtime === "direct" ? spawn(host, [], { stdio: ["pipe", "pipe", "pipe"] }) : spawn(runtime, [host], { stdio: ["pipe", "pipe", "pipe"] });
const frame = (message) => {
  const payload = Buffer.from(JSON.stringify(message));
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(payload.length);
  return Buffer.concat([prefix, payload]);
};
child.stdin.end(Buffer.concat([
  frame({ version: 2, type: "host.ping", requestId: "invalid-version", payload: {} }),
  frame({ version: 1, type: "download.start", requestId: "before-pairing", payload: {} }),
  frame({ version: 1, type: "device.pair.prepare", requestId: "prepare", payload: {} }),
  frame({ version: 1, type: "host.ping", requestId: "smoke", payload: {} })
]));
let output = Buffer.alloc(0);
const result = await new Promise((resolve, reject) => {
  let stderr = "";
  const responses = [];
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const timer = setTimeout(() => reject(new Error(`Native Host timeout ${stderr}`)), 5000);
  child.stdout.on("data", (chunk) => {
    output = Buffer.concat([output, chunk]);
    while (output.length >= 4 && output.length >= 4 + output.readUInt32LE(0)) {
      const length = output.readUInt32LE(0);
      responses.push(JSON.parse(output.subarray(4, 4 + length).toString("utf8")));
      output = output.subarray(4 + length);
    }
    if (responses.length === 4) { clearTimeout(timer); resolve(responses); }
  });
  child.once("error", reject);
  child.once("exit", (code) => { if (output.length < 4) reject(new Error(`Native Host exited ${code}`)); });
});
child.kill();
const byId = Object.fromEntries(result.map((item) => [item.requestId, item]));
if (byId["invalid-version"]?.error?.code !== "unsupported_protocol") throw new Error("Invalid protocol was accepted");
if (byId["before-pairing"]?.error?.code !== "pairing_required") throw new Error("Download was accepted before pairing");
const prepare = byId.prepare?.result;
const now = Math.floor(Date.now() / 1000);
if (!prepare?.deviceChallenge || prepare.expiresAt < now + 115 || prepare.expiresAt > now + 120 || "deviceKey" in prepare) throw new Error("Pairing challenge boundary mismatch");
const ping = byId.smoke;
if (!ping?.ok || ping.result?.protocol !== 1 || "deviceKey" in ping.result) throw new Error("Native Host response mismatch");
console.log(JSON.stringify({ ok: ping.ok, protocol: ping.result.protocol, platform: ping.result.platform, paired: ping.result.paired }));
