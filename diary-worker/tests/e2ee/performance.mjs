import { entry } from "./fixture.mjs";

export async function seedPerformanceData(f) {
  const client = await f.client("ownerA");
  for (let i = 0; i < 1200; i++) {
    const photos = Array.from({ length: 18 }, (_, j) => {
      const id = crypto.randomUUID();
      f.registry.photos[id] = { household: "A", accountId: "ownerA" };
      return {
        id,
        fileName: `synthetic-${i}-${j}.jpg`,
        contentType: "image/jpeg",
        originalSize: 3_400_000,
        width: 4000,
        height: 3000,
        createdByName: "Synthetic owner",
        createdAt: "2026-01-23T00:00:00Z",
        thumbnailUrl: `/diary/api/photos/${id}/thumbnail`,
        displayUrl: `/diary/api/photos/${id}/display`,
        originalUrl: `/diary/api/photos/${id}/original`,
      };
    });
    await client.commit(
      entry({
        title: `Synthetic ${i}`,
        content: "合成日記の本文。".repeat(40),
        photos,
      }),
      {},
      { refresh: false },
    );
    f.wire.length = 0;
  }
  client.lock();
  return { entries: 1200, photos: 21600 };
}

export async function measurePerformance(page) {
  return page.evaluate(async () => {
    const client = window.encryptedClient;
    const now = () => performance.now();
    const round = (n) => Math.round(n * 100) / 100;
    let t = now();
    await client.sync();
    const firstHttpSyncMs = now() - t;
    const snapshot = await client.transport.snapshot("A", -1),
      native = client.transport.snapshot;
    const cipherSnapshotBytes = new TextEncoder().encode(
      JSON.stringify(snapshot),
    ).length;
    const cold = [];
    // PRF is explicitly excluded. This isolates actual candidate record signature,
    // base64, AES-GCM, JSON/index work from localhost HTTP and render timing.
    try {
      client.transport.snapshot = async () => structuredClone(snapshot);
      for (let i = 0; i < 7; i++) {
        client.records.clear();
        client.revisionFloor.clear();
        client.sequence = undefined;
        t = now();
        await client.sync();
        cold.push(now() - t);
      }
    } finally {
      client.transport.snapshot = native;
    }
    const search = [];
    for (let i = 0; i < 21; i++) {
      t = now();
      client.list(new URLSearchParams({ q: "合成 本文" }));
      search.push(now() - t);
    }
    const unchanged = [];
    for (let i = 0; i < 7; i++) {
      t = now();
      await client.sync();
      unchanged.push(now() - t);
    }
    const target = [...client.records.values()].find(
      (r) => r.row.state === "published" && r.entry.photos?.length === 18,
    );
    const before = client.sequence;
    t = now();
    await client.saveEntry(
      { ...client.entry(target.row.id), title: "Synthetic updated" },
      target.row.id,
    );
    const singleEditMs = now() - t;
    const delta = await native("A", before);
    const deltaBytes = new TextEncoder().encode(JSON.stringify(delta)).length;
    const stats = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        samples: values.length,
        medianMs: round(sorted[Math.floor(sorted.length / 2)]),
        p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
      };
    };
    return {
      firstHttpSyncMs: round(firstHttpSyncMs),
      cipherSnapshotBytes,
      singleEditMs: round(singleEditMs),
      singleEditDeltaBytes: deltaBytes,
      singleEditDeltaRecords: delta.records.length,
      coldIndexCpuOnly: stats(cold),
      localSearch: stats(search),
      unchangedHttpSync: stats(unchanged),
      records: client.records.size,
      realWebAuthn: false,
      network: "localhost; no mobile/network throttling",
      renderMeasured: false,
    };
  });
}
