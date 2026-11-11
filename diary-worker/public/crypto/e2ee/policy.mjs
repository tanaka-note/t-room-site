// Opaque account IDs and role flags are trusted session claims, never body input.
export const publishedScope = (household) => `${household}:published`;
export const draftScope = (household) => `${household}:drafts`;
export const preferencesScope = (household, account) =>
  `${household}:preferences:${account}`;
export function assertActor(actor, household) {
  if (
    !actor?.active ||
    !actor.credentialId ||
    !actor.accountId ||
    !actor.households?.includes(household)
  )
    throw Object.assign(new Error("AccessDenied"), { status: 403 });
}
export function canRead(actor, row) {
  if (!actor?.active || !actor.households?.includes(row.household))
    return false;
  if (row.state === "published") return true;
  if (row.state === "draft") return Boolean(actor.canManageEntries);
  if (row.state === "preferences") return row.author === actor.accountId;
  if (row.state === "trash")
    return Boolean(
      actor.canViewTrash &&
        retentionIds(actor, row.household).some((id) =>
          row.retainedFor.includes(id),
        ),
    );
  return false;
}
export const retentionIds = (actor, household) => [
  actor.accountId,
  ...(actor.trashAliases?.[household] || []),
];
export function trashAudience(actor, row, ownerAccount, independent = false) {
  // Independent household owner is explicitly supplied by the trusted registry.
  const result = [ownerAccount];
  if (!independent && !actor.isGlobalOwner && row.author === actor.accountId)
    result.push(actor.accountId);
  return [...new Set(result)].sort();
}
export function trashScope(household, accounts) {
  return `${household}:trash:${[...accounts].sort().join(":")}`;
}
export function assertWrite(actor, row) {
  assertActor(actor, row.household);
  if (
    row.state === "preferences"
      ? row.author !== actor.accountId
      : !actor.canManageEntries || !canRead(actor, row)
  )
    throw Object.assign(new Error("AccessDenied"), { status: 403 });
}
