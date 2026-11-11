import { encode } from "./crypto.mjs";
import { validateSnapshot } from "./record.mjs";

// Each server page is a consistent D1 read. A concurrent write invalidates the
// cursor and restarts a bounded number of times; no mixed-version index opens.
export async function readSnapshotPages(fetchPage, household, since = -1) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let after = null,
      at = null,
      bytes = 0;
    const records = [],
      removed = [];
    try {
      do {
        const page = await fetchPage({
          household,
          since,
          after,
          at,
          limit: 50,
        });
        const { nextCursor, ...snapshot } = page;
        validateSnapshot(snapshot);
        if (
          snapshot.household !== household ||
          snapshot.baseSequence !== since ||
          (at !== null && snapshot.sequence !== at) ||
          (nextCursor !== null &&
            (typeof nextCursor !== "string" ||
              nextCursor <= String(after || "")))
        )
          throw new Error("InvalidSnapshotPage");
        bytes += encode(page).length;
        if (
          bytes > 50_000_000 ||
          records.length +
            snapshot.records.length +
            removed.length +
            snapshot.removed.length >
            5000
        )
          throw new Error("SnapshotLimit");
        records.push(...snapshot.records);
        removed.push(...snapshot.removed);
        after = nextCursor;
        at = snapshot.sequence;
        if (snapshot.unchanged && after !== null)
          throw new Error("InvalidSnapshotPage");
        if (after === null)
          return validateSnapshot({ ...snapshot, records, removed });
      } while (after !== null);
    } catch (error) {
      if (error.message !== "SnapshotChanged" || attempt === 2) throw error;
    }
  }
  throw new Error("SnapshotChanged");
}
