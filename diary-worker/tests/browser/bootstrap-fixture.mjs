import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

// Reuse each browser fixture's existing session, filters and entry data for the
// new aggregate response. Actual Worker authorization is tested separately.
export function createDiaryFixtureServer(handler) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/diary/diary-bootstrap.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      return response.end(await readFile(new URL("../../public/diary-bootstrap.js", import.meta.url)));
    }
    if (url.pathname !== "/diary/api/bootstrap") return handler(request, response);
    const collect = path => new Promise((resolve, reject) => {
      const input = Object.create(request);
      input.url = `/diary/api${path}${url.search}`;
      const output = {
        statusCode: 200,
        writeHead(status) { this.statusCode = status; return this; },
        setHeader() {},
        end(body) {
          try { resolve({ status: this.statusCode, body: JSON.parse(String(body || "{}")) }); }
          catch (error) { reject(error); }
        }
      };
      Promise.resolve(handler(input, output)).catch(reject);
    });
    const session = await collect("/session");
    if (!session.body.authenticated) {
      response.writeHead(401, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ error: "ログインが必要です。" }));
    }
    const [households, meta, entries] = await Promise.all([
      session.body.isGlobalOwner ? collect("/households") : { body: { households: [], activeHouseholdId: session.body.activeHouseholdId } },
      collect("/meta"), collect("/entries")
    ]);
    const failed = [meta, entries].find(value => value.status >= 400);
    response.writeHead(failed?.status || 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(failed?.body || { session: session.body, households: households.body, meta: meta.body, entries: entries.body }));
  });
}
