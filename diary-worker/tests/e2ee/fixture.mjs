import {
  createVault,
  fingerprint,
  makeGrant,
  newKey,
  signed,
  signingKey,
} from "../../e2ee/crypto.mjs";
import {
  canRead,
  publishedScope,
  draftScope,
  preferencesScope,
  trashScope,
} from "../../e2ee/policy.mjs";
import { readSnapshotPages } from "../../e2ee/snapshot.mjs";
import { createStore } from "../../e2ee/store.mjs";
import { EncryptedDiaryClient } from "../../e2ee/client.mjs";
import { memoryDatabase } from "./sqlite.mjs";

// All identities and PRFs here are generated synthetic fixtures, never real WebAuthn.
export async function provision() {
  const securityRecovery = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 4096,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    false,
    ["encrypt", "decrypt"],
  );
  const authority = await signingKey();
  const anchor = await crypto.subtle.exportKey("jwk", authority.publicKey);
  const actors = {
    ownerA: {
      accountId: "ownerA",
      credentialId: "credential-ownerA",
      households: ["A", "B"],
      isGlobalOwner: true,
      trashAliases: { B: ["ownerB"] },
    },
    editorA: {
      accountId: "editorA",
      credentialId: "credential-editorA",
      households: ["A"],
    },
    userA: {
      accountId: "userA",
      credentialId: "credential-userA",
      households: ["A"],
    },
    ownerB: {
      accountId: "ownerB",
      credentialId: "credential-ownerB",
      households: ["B"],
    },
    viewerA: {
      accountId: "viewerA",
      credentialId: "credential-viewerA",
      households: ["A"],
      canManageEntries: false,
      canViewTrash: false,
      canPermanentlyDelete: false,
    },
  };
  for (const actor of Object.values(actors))
    Object.assign(actor, {
      active: true,
      canManageEntries: actor.canManageEntries ?? true,
      canViewTrash: actor.canViewTrash ?? true,
      canPermanentlyDelete: actor.canPermanentlyDelete ?? true,
    });
  const households = {
    A: { owner: "ownerA", independent: false },
    B: { owner: "ownerB", independent: true },
  };
  const definitions = [];
  for (const household of ["A", "B"]) {
    definitions.push(
      {
        household,
        scope: publishedScope(household),
        state: "published",
        author: "owner" + household,
        retainedFor: [],
      },
      {
        household,
        scope: draftScope(household),
        state: "draft",
        author: "owner" + household,
        retainedFor: [],
      },
    );
    for (const actor of Object.values(actors).filter((a) =>
      a.households.includes(household),
    ))
      definitions.push({
        household,
        scope: preferencesScope(household, actor.accountId),
        state: "preferences",
        author: actor.accountId,
        retainedFor: [],
      });
    for (const retainedFor of household === "A"
      ? [
          ["ownerA"],
          ["editorA"],
          ["userA"],
          ["ownerA", "editorA"],
          ["ownerA", "userA"],
        ]
      : [["ownerB"]])
      definitions.push({
        household,
        scope: trashScope(household, retainedFor),
        state: "trash",
        author: "owner" + household,
        retainedFor,
      });
  }
  const secrets = {},
    members = [];
  for (const actor of Object.values(actors)) {
    const prf = crypto.getRandomValues(new Uint8Array(32)),
      vault = await createVault(prf, actor.credentialId);
    const member = {
      canManageEntries: actor.canManageEntries,
      households: actor.households,
      accountId: actor.accountId,
      credentialId: actor.credentialId,
      publicKey: vault.publicKey,
      signPublicKey: vault.signPublicKey,
      fingerprint: await fingerprint(vault.publicKey),
      scopes: definitions
        .filter((row) => canRead(actor, row))
        .map((row) => row.scope),
    };
    members.push(member);
    secrets[actor.accountId] = { prf, vault };
  }
  const epochs = Object.fromEntries(definitions.map((d) => [d.scope, 1]));
  const directory = {
    protocol: "T-lain diary directory",
    recoveryPublicKey: await crypto.subtle.exportKey(
      "jwk",
      securityRecovery.publicKey,
    ),
    recoveryFingerprint: await fingerprint(
      await crypto.subtle.exportKey("jwk", securityRecovery.publicKey),
    ),
    version: 1,
    generation: 1,
    households,
    epochs,
    members,
  };
  const packet = await signed(directory, authority.privateKey),
    profiles = {};
  for (const actor of Object.values(actors))
    profiles[actor.accountId] = {
      actor,
      household: actor.households[0],
      displayName: `Synthetic ${actor.accountId}`,
      directory: packet,
      epochs,
      vault: secrets[actor.accountId].vault,
      grants: [],
    };
  const scopeKeys = new Map();
  for (const definition of definitions) {
    const key = await newKey();
    scopeKeys.set(definition.scope, key);
    for (const member of members.filter((m) =>
      m.scopes.includes(definition.scope),
    ))
      profiles[member.accountId].grants.push(
        await makeGrant(
          key,
          {
            household: definition.household,
            scope: definition.scope,
            epoch: 1,
          },
          member,
          1,
          authority.privateKey,
        ),
      );
  }
  return {
    anchor,
    secrets,
    profiles,
    directory,
    packet,
    households,
    epochs,
    authority,
    scopeKeys,
    securityRecovery,
  };
}
export async function fixture(provisioned, household = "A") {
  const db = memoryDatabase(),
    actors = Object.fromEntries(
      Object.entries(provisioned.profiles).map(([id, p]) => [
        id,
        structuredClone(p.actor),
      ]),
    );
  const registry = {
    households: provisioned.households,
    epochs: provisioned.epochs,
    directory: provisioned.directory,
    photos: {},
  };
  const store = createStore(db, registry),
    wire = [];
  async function client(accountId, home = household) {
    const actor = actors[accountId];
    const profile = {
      ...provisioned.profiles[accountId],
      actor,
      household: home,
    };
    const transport = {
      valid: async () => actor.active,
      timestamp: async () => new Date().toISOString(),
      snapshot: async (h, since) => {
        if (!actor.active)
          throw Object.assign(new Error("SessionExpired"), { status: 401 });
        const reply = await readSnapshotPages(
          (options) => store.snapshotPage(actor, h, options),
          h,
          since,
        );
        wire.push({ operation: "snapshot", household: h, reply });
        return reply;
      },
      mutation: async (p, op) => {
        wire.push({ operation: op, proposal: structuredClone(p) });
        return store.mutation(actor, p, op);
      },
      remove: async (p) => {
        wire.push({ operation: "remove", proposal: p });
        return store.remove(actor, p);
      },
    };
    const instance = new EncryptedDiaryClient({
      transport,
      profile,
      anchor: provisioned.anchor,
      minimumGeneration: 1,
    });
    await instance.unlock(new Uint8Array(provisioned.secrets[accountId].prf));
    return instance;
  }
  return { db, registry, store, actors, wire, client, close: () => db.close() };
}
export const entry = (overrides = {}) => ({
  entryDate: "2026-01-23",
  title: "CANARY_PRIVATE_TITLE",
  content: "CANARY_PRIVATE_BODY 公園 お弁当",
  contentFormat: null,
  tags: ["CANARY_PRIVATE_TAG"],
  weather: "sunny",
  photos: [],
  authorName: "CANARY_PRIVATE_AUTHOR",
  lastPublishedAt: "2026-01-24T00:00:00Z",
  ...overrides,
});
