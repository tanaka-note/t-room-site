import { today } from './health-domain.mjs';

// The three state groups have separate lifetimes. Only data is replaced by refresh;
// locking invalidates all asynchronous work and erases the decrypted state.
export function createState() {
  const state = {
    auth: { master: null, accountId: null, session: null, generation: 0 },
    data: { records: [], settings: {}, revisions: new Map() },
    ui: { busy: false, month: today().slice(0, 7), tab: 'calendar' },
  };
  return Object.assign(state, {
    check(generation) {
      if (generation !== state.auth.generation) throw new Error('画面を離れたため処理を中止しました。');
    },
    replaceData(records, settings, revisions) { state.data = { records, settings, revisions }; },
    erase() {
      state.auth.generation++;
      state.auth.master?.fill(0);
      state.auth.master = null;
      state.auth.accountId = null;
      state.auth.session = null;
      state.replaceData([], {}, new Map());
    },
  });
}
