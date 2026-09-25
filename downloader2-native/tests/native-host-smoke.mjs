import { spawn } from "node:child_process";

const [dotnet, host] = process.argv.slice(2);
if (!dotnet || !host) throw new Error("usage: native-host-smoke.mjs <dotnet> <build-output-host.dll>");
const child = spawn(dotnet, [host], { stdio: ["pipe", "pipe", "pipe"] });
const request = Buffer.from(JSON.stringify({ version: 1, type: "host.ping", requestId: "smoke", payload: {} }));
const prefix = Buffer.alloc(4); prefix.writeUInt32LE(request.length);
child.stdin.end(Buffer.concat([prefix, request]));
let output = Buffer.alloc(0);
const result = await new Promise((resolve, reject) => {
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const timer = setTimeout(() => reject(new Error(`Native Host timeout ${stderr}`)), 5000);
  child.stdout.on("data", (chunk) => {
    output = Buffer.concat([output, chunk]);
    if (output.length < 4 || output.length < 4 + output.readUInt32LE(0)) return;
    clearTimeout(timer);
    resolve(JSON.parse(output.subarray(4, 4 + output.readUInt32LE(0)).toString("utf8")));
  });
  child.once("error", reject);
  child.once("exit", (code) => { if (output.length < 4) reject(new Error(`Native Host exited ${code}`)); });
});
child.kill();
if (!result.ok || result.requestId !== "smoke" || result.result?.protocol !== 1) throw new Error("Native Host response mismatch");
console.log(JSON.stringify({ ok: result.ok, protocol: result.result.protocol, platform: result.result.platform, paired: result.result.paired }));
