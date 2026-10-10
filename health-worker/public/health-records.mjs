import { normalizeRecord, normalizeSettings, periods } from './health-domain.mjs';
import { recordId, encryptRecord, decryptRecord } from './health-crypto.mjs';

export function createRepository(state, api) {
  async function idFor(key, generation = state.auth.generation) {
    state.check(generation);
    const id = await recordId(state.auth.master, key, state.auth.accountId);
    state.check(generation);
    return id;
  }
  async function load(generation) {
    const response = await api('/records', {}, generation);
    const records = [], revisions = new Map();
    let settings = {};
    for (const row of response.records) {
      const value = await decryptRecord(state.auth.master, row.id, row, state.auth.accountId);
      state.check(generation);
      const normalized = value.kind === 'settings' ? { kind: 'settings', ...normalizeSettings(value) } : normalizeRecord(value);
      if (row.id !== await idFor(value.kind === 'settings' ? 'settings' : normalized.date, generation)) throw new Error('記録の暗号化識別子が一致しません。');
      if (!Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('記録の更新番号を確認できません。');
      revisions.set(value.kind === 'settings' ? 'settings' : normalized.date, row.revision);
      if (value.kind === 'settings') settings = normalized;
      else records.push(normalized);
    }
    state.check(generation);
    periods(records);
    state.replaceData(records, settings, revisions);
  }
  async function store(key, value, expectedRevision, generation) {
    const id = await idFor(key, generation);
    const encrypted = await encryptRecord(state.auth.master, id, value, state.auth.accountId);
    state.check(generation);
    const result = await api(`/records/${id}`, { method: 'PUT', body: JSON.stringify({ ...encrypted, expectedRevision }) }, generation);
    state.check(generation);
    if (result.ok !== true || !Number.isSafeInteger(result.revision) || result.revision !== expectedRevision + 1) throw new Error('保存結果を確認できませんでした。入力を残したまま、最新の記録を確認してください。');
    state.data.revisions.set(key, result.revision);
  }
  async function remove(key, expectedRevision, generation) {
    const id = await idFor(key, generation);
    const result = await api(`/records/${id}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision }) }, generation);
    state.check(generation);
    if (result.ok !== true || !Number.isSafeInteger(result.revision) || result.revision !== expectedRevision + 1) throw new Error('削除結果を確認できませんでした。最新の記録を確認してください。');
    state.data.revisions.delete(key);
  }
  return { load, store, remove, revision: key => state.data.revisions.get(key) || 0 };
}
