// Local UI compatibility fixture ONLY. This is not imported by the public app.
// Unsupported media routes fail closed, rather than fall back to plaintext APIs.
export function uiFixtureApi(client, session) {
  return async (url, init = {}) => {
    const path = url.pathname.slice("/diary/api".length),
      method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === "/logout") {
      client.lock();
      return { ok: true };
    }
    await client.check();
    if (path === "/session") return session;
    await client.sync();
    const households = {
      households: [{ id: client.household, name: "Synthetic household" }],
      activeHouseholdId: client.household,
    };
    if (path === "/bootstrap")
      return {
        session,
        households,
        meta: client.meta(),
        entries: client.list(url.searchParams),
      };
    if (path === "/households") return households;
    if (path === "/meta") return client.meta();
    if (path === "/entries")
      return method === "POST"
        ? client.saveEntry(body)
        : client.list(url.searchParams);
    const entry = path.match(/^\/entries\/(\d+)$/);
    if (entry) {
      if (method === "PUT") return client.saveEntry(body, entry[1]);
      if (method === "DELETE")
        return client.transition(entry[1], "trash", body.revision);
      return { entry: client.entry(entry[1]) };
    }
    const action = path.match(
      /^\/entries\/(\d+)\/(favorite|restore|permanent)$/,
    );
    if (action) {
      if (action[2] === "favorite")
        return client.setFavorite(action[1], method === "POST");
      return client.transition(
        action[1],
        action[2] === "restore" ? "restore" : "purge",
        body.revision,
      );
    }
    const draft = path.match(/^\/drafts\/(\d+)$/);
    if (draft && method === "DELETE")
      return client.transition(draft[1], "discard", body.revision);
    throw Object.assign(new Error("MediaIntegrationPending"), { status: 503 });
  };
}
