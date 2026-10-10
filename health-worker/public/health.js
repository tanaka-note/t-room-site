import { today, periods, predict } from './health-domain.mjs';
import { buildInsights } from './health-insights.mjs';
import { createState } from './health-state.mjs';
import { createApi } from './health-api.mjs';
import { createRepository } from './health-records.mjs';
import { createSession } from './health-session.mjs';
import { createEditor } from './health-editor.mjs';
import { renderView, clearView } from './health-render.mjs';
import { $ } from './health-format.mjs';

const state = createState();
const nav = TroomDialogNavigation.create({ key: 'health-dialogs' });
const api = createApi(state, lock);
const repository = createRepository(state, api);
const editor = createEditor(state, repository, nav);
const session = createSession(state, api, repository.load, lock);

function setBusy(busy) {
  state.ui.busy = busy;
  document.querySelectorAll('button, input, select, textarea').forEach(control => { control.disabled = busy; });
}
function render() {
  renderView({ ...state.data, month: state.ui.month,
    prediction: predict(state.data.records, state.data.settings),
    spans: periods(state.data.records), insights: buildInsights(state.data.records), edit: editor.edit });
  if (state.ui.busy) setBusy(true);
}
async function task(fn, errorId = 'message') {
  if (state.ui.busy) return;
  const generation = state.auth.generation;
  setBusy(true); $(errorId).textContent = '';
  try {
    await fn(generation);
    state.check(generation);
    if (state.auth.session) render();
  } catch (error) {
    if (generation === state.auth.generation) $(errorId).textContent = error.message;
  } finally { setBusy(false); }
}
function lock(message = '') {
  state.erase(); session.clearExpiry(); nav.reset(); editor.reset(); clearView();
  $('app').hidden = true; $('login').hidden = false; $('message').textContent = message;
}
async function signIn(generation) {
  await session.signIn(generation); state.check(generation);
  $('login').hidden = true; $('app').hidden = false;
}
function moveMonth(delta) {
  const date = new Date(`${state.ui.month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  state.ui.month = date.toISOString().slice(0, 7); render();
}
function showTab(name) {
  state.ui.tab = name;
  for (const tab of ['calendar', 'list', 'insights']) {
    $(`${tab}-panel`).hidden = tab !== name;
    $(`${tab}-tab`).setAttribute('aria-pressed', String(tab === name));
  }
}

// Event binding is the composition layer; persistence, forms and aggregates
// belong to their own modules and share the same generation/lock boundary.
for (const id of ['editor', 'settings', 'export']) {
  nav.register(id, { guard: () => !state.ui.busy && (!editor.dirty() || confirm('入力を破棄しますか？')), blocked: () => state.ui.busy });
  $(`${id}-close`).onclick = () => nav.close(id);
}
$('sign-in').onclick = () => task(signIn);
$('record-today').onclick = () => editor.edit(today());
$('record-end').onclick = () => editor.edit(today(), { end: true });
$('record-form').onsubmit = event => { event.preventDefault(); task(editor.saveRecord, 'editor-error'); };
$('delete').onclick = () => {
  if (confirm('この日の記録を削除しますか？削除した内容は復元できません。')) task(editor.deleteRecord, 'editor-error');
};
$('settings-open').onclick = editor.openSettings;
$('settings-form').onsubmit = event => { event.preventDefault(); task(editor.saveSettings, 'settings-error'); };
$('export-open').onclick = editor.openExport;
$('export-form').onsubmit = event => { event.preventDefault(); task(editor.exportRecords, 'export-error'); };
$('refresh').onclick = () => task(repository.load);
$('logout').onclick = () => task(session.logout);
$('previous').onclick = () => moveMonth(-1);
$('next').onclick = () => moveMonth(1);
$('today').onclick = () => { state.ui.month = today().slice(0, 7); render(); };
for (const name of ['calendar', 'list', 'insights']) $(`${name}-tab`).onclick = () => showTab(name);
window.addEventListener('pagehide', () => lock());
window.addEventListener('beforeunload', event => {
  if (editor.dirty() || state.ui.busy) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('troom:before-auto-update', event => {
  if (editor.dirty() || state.ui.busy || $('export').open) event.preventDefault();
});
