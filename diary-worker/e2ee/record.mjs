import {
  RECOVERY_RECIPIENT,
  b64,
  encode,
  unb64,
  validateEnvelope,
  verifySigned,
} from "./crypto.mjs";
import {
  publishedScope,
  draftScope,
  preferencesScope,
  trashScope,
} from "./policy.mjs";

const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const token = (value) =>
  typeof value === "string" && /^[\w:-]{1,160}$/.test(value);
const ROW_KEYS = [
  "id",
  "household",
  "scope",
  "state",
  "author",
  "revision",
  "epoch",
  "sourceId",
  "sourceRevision",
  "retainedFor",
  "envelope",
  "summary",
  "photoIds",
  "keyBox",
  "attestation",
];
export const bindingOf = (row) =>
  Object.fromEntries(
    [
      "id",
      "household",
      "state",
      "author",
      "revision",
      "retainedFor",
      "sourceId",
      "sourceRevision",
      "epoch",
      "scope",
      "photoIds",
    ].map((key) => [key, row[key]]),
  );
export const proofOf = (row) => ({
  binding: bindingOf(row),
  envelope: row.envelope,
  summary: row.summary,
  keyBox: row.keyBox,
  writer: row.attestation.writer,
});

export function validateRecord(row) {
  if (
    !exact(row, ROW_KEYS) ||
    !["id", "household", "scope", "author"].every((k) => token(row[k])) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 1 ||
    !["published", "draft", "trash", "preferences"].includes(row.state)
  )
    throw new Error("InvalidRecord");
  if (
    (row.sourceId !== null && !token(row.sourceId)) ||
    (row.sourceRevision !== null &&
      (!Number.isSafeInteger(row.sourceRevision) || row.sourceRevision < 1)) ||
    Boolean(row.sourceId) !== Boolean(row.sourceRevision)
  )
    throw new Error("InvalidRecord");
  if (
    !Array.isArray(row.retainedFor) ||
    row.retainedFor.length > 100 ||
    row.retainedFor.some((id) => !token(id)) ||
    new Set(row.retainedFor).size !== row.retainedFor.length ||
    (row.state === "trash") !== Boolean(row.retainedFor.length)
  )
    throw new Error("InvalidRecord");
  if (
    row.state === "preferences"
      ? row.id !== preferencesScope(row.household, row.author)
      : !/^[1-9][0-9]{0,15}$/.test(row.id) ||
        !Number.isSafeInteger(Number(row.id))
  )
    throw new Error("InvalidRecord");
  const scope =
    row.state === "published"
      ? publishedScope(row.household)
      : row.state === "draft"
        ? draftScope(row.household)
        : row.state === "preferences"
          ? preferencesScope(row.household, row.author)
          : trashScope(row.household, row.retainedFor);
  if (
    scope !== row.scope ||
    !Array.isArray(row.photoIds) ||
    row.photoIds.length > 5000 ||
    new Set(row.photoIds).size !== row.photoIds.length ||
    row.photoIds.some(
      (id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id),
    )
  )
    throw new Error("InvalidRecord");
  validateEnvelope(row.envelope);
  validateEnvelope(row.summary);
  if (
    !exact(row.attestation, ["writer", "signature"]) ||
    !/^[\w-]{1,2048}$/.test(row.attestation.writer) ||
    unb64(row.attestation.signature, 100).length !== 64 ||
    !row.keyBox ||
    typeof row.keyBox !== "object" ||
    Array.isArray(row.keyBox) ||
    Object.keys(row.keyBox).length > 100
  )
    throw new Error("InvalidRecord");
  for (const [id, value] of Object.entries(row.keyBox))
    if (
      !/^[\w-]{1,2048}$/.test(id) ||
      unb64(value, id === RECOVERY_RECIPIENT ? 684 : 512).length !==
        (id === RECOVERY_RECIPIENT ? 512 : 384)
    )
      throw new Error("InvalidRecord");
  return row;
}

export async function verifyRecord(row, directory) {
  validateRecord(row);
  const member = directory.members.find(
    (m) => m.credentialId === row.attestation.writer,
  );
  if (
    !member ||
    !member.households.includes(row.household) ||
    (row.state === "preferences"
      ? member.accountId !== row.author
      : !member.canManageEntries)
  )
    throw new Error("UnauthorizedWriter");
  if (directory.epochs[row.scope] !== row.epoch)
    throw new Error("KeyEpochConflict");
  const expected = directory.members
    .filter((m) => m.scopes.includes(row.scope))
    .map((m) => m.credentialId)
    .sort();
  expected.push(RECOVERY_RECIPIENT);
  expected.sort();
  const actual = Object.keys(row.keyBox).sort();
  if (actual.length && b64(encode(actual)) !== b64(encode(expected)))
    throw new Error("InvalidRecipients");
  await verifySigned(
    { value: proofOf(row), signature: row.attestation.signature },
    member.signPublicKey,
  );
  return row;
}

export function validateSnapshot(snapshot) {
  if (
    !exact(snapshot, [
      "version",
      "household",
      "sequence",
      "unchanged",
      "delta",
      "baseSequence",
      "removed",
      "records",
    ]) ||
    snapshot.version !== 1 ||
    !token(snapshot.household) ||
    !Number.isSafeInteger(snapshot.sequence) ||
    snapshot.sequence < 0 ||
    typeof snapshot.unchanged !== "boolean" ||
    typeof snapshot.delta !== "boolean" ||
    !Number.isSafeInteger(snapshot.baseSequence) ||
    snapshot.baseSequence < -1 ||
    snapshot.delta !== snapshot.baseSequence >= 0 ||
    !Array.isArray(snapshot.removed) ||
    snapshot.removed.some((id) => !token(id)) ||
    new Set(snapshot.removed).size !== snapshot.removed.length ||
    (!snapshot.delta && snapshot.removed.length) ||
    !Array.isArray(snapshot.records) ||
    snapshot.records.length + snapshot.removed.length > 5000 ||
    (snapshot.unchanged && (snapshot.records.length || snapshot.removed.length))
  )
    throw new Error("InvalidSnapshot");
  const ids = new Set();
  for (const row of snapshot.records) {
    validateRecord(row);
    if (
      row.household !== snapshot.household ||
      ids.has(row.id) ||
      snapshot.removed.includes(row.id)
    )
      throw new Error("InvalidSnapshot");
    ids.add(row.id);
  }
  return snapshot;
}
