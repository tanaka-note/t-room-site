import "../../public/dialog-navigation.js";
import "../../public/troom-date-picker.js";
import { readSnapshotPages } from "../../e2ee/snapshot.mjs";
import { EncryptedDiaryClient } from "../../e2ee/client.mjs";
import { startDiary } from "../../public/diary.js";
import { uiFixtureApi } from "./ui-fixture.mjs";

// Synthetic PRF and trust anchor arrive through Playwright's isolated fixture
// injection, never a network API. This is deliberately not a login mechanism.
const fixture = window.syntheticEncryptionFixture;
const nativeFetch = window.fetch.bind(window);
const request = async (path, body) => {
  const response = await nativeFetch(
    "/__encrypted/" + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error), { status: response.status });
  return result;
};
const transport = {
  valid: async () => {
    try {
      return (await request("valid")).valid;
    } catch {
      return false;
    }
  },
  timestamp: async () => (await request("time")).timestamp,
  snapshot: (h, since) =>
    readSnapshotPages(
      (options) => {
        const query = new URLSearchParams(
          Object.entries(options).filter(([, v]) => v !== null),
        );
        return request(`snapshot?${query}`);
      },
      h,
      since,
    ),
  mutation: (proposal, operation) =>
    request("mutation", { proposal, operation }),
  remove: (proposal) => request("remove", proposal),
};
const client = new EncryptedDiaryClient({
  transport,
  profile: fixture.profile,
  anchor: fixture.anchor,
});
await client.unlock(new Uint8Array(fixture.prf));
delete window.syntheticEncryptionFixture;
const api = uiFixtureApi(client, fixture.session);
window.fetch = async (input, init) => {
  const url = new URL(input, location.href);
  if (!url.pathname.startsWith("/diary/api/")) return nativeFetch(input, init);
  try {
    return Response.json(await api(url, init));
  } catch (e) {
    return Response.json({ error: e.message }, { status: e.status || 500 });
  }
};
window.encryptedClient = client;
await startDiary(fixture.session);
window.encryptionFixtureReady = true;
