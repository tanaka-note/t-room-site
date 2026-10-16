import { today, validDate } from './health-domain.mjs';
import { $, dateFormat, shortDate, healthText, element } from './health-format.mjs';
import { renderCalendar } from './health-calendar.mjs';

function renderToday(records) {
  const date = today(), record = records.find(row => row.date === date);
  $('today-date').textContent = dateFormat.format(new Date(`${date}T00:00:00Z`));
  const text = record && healthText(record);
  $('today-status').textContent = text ? text.length > 100 ? `${text.slice(0, 100)}…` : text : record ? '記録済み（体調・備考は未入力）' : 'まだ記録はありません。';
  $('record-today').textContent = record ? '今日の記録を編集' : '今日の体調を記録';
}
function renderCycle(prediction, spans, settings) {
  const latest = spans.at(-1), lastStart = latest?.start || (validDate(settings.lastStart) ? settings.lastStart : null);
  $('prediction-window').textContent = prediction.date ? shortDate(prediction.date) : '開始日を記録すると表示';
  $('last-period-start').textContent = lastStart ? shortDate(lastStart) : '未記録';
  $('prediction').textContent = prediction.date || '開始日を記録すると表示します';
  $('prediction-range').textContent = prediction.date
    ? `参考範囲：${prediction.from} 〜 ${prediction.to}（${prediction.personalized ? '記録した周期の最短〜最長' : '仮予測の前後3日'}）${today() > prediction.to ? ' — 参考範囲を過ぎています' : ''}` : '';
  $('prediction-basis').textContent = prediction.date ? prediction.personalized ? `中心日：直近${prediction.count}周期の中央値（${prediction.cycle}日）から算出` : `中心日：${prediction.cycle}日周期による仮予測` : '';
  $('latest-cycle').textContent = prediction.latestCycle ? `${prediction.latestCycle}日` : '記録不足';
  $('period-reminder').hidden = !latest || Boolean(latest.end);
  $('period-reminder-message').textContent = latest && !latest.end ? `${shortDate(latest.start)} 開始・終了未記録` : '';
}
function recordEntry(record, edit) {
  const button = element('button', null, 'entry');
  const heading = element('span', null, 'entry-heading');
  heading.append(element('strong', record.date), element('span', [record.start ? '生理開始' : '', record.end ? '生理終了' : '', record.flow ? `経血量：${record.flow}` : ''].filter(Boolean).join(' / '), 'entry-meta'));
  button.append(heading, element('span', healthText(record) || '体調・備考は未入力', 'entry-content'));
  button.onclick = () => edit(record.date);
  return button;
}
function renderRecords(records, edit) {
  $('records').replaceChildren(...[...records].sort((a, b) => b.date.localeCompare(a.date)).map(record => recordEntry(record, edit)));
  if (!records.length) $('records').append(element('p', '記録はまだありません。今日の体調や、カレンダーの日付から記録できます。', 'empty-records'));
}
function fact(label, value) {
  const row = element('div'); row.append(element('dt', label), element('dd', value)); return row;
}
function renderInsights(model) {
  const { current, previous, symptoms, cycles } = model;
  $('insight-range').textContent = `${current.from} 〜 ${current.to}`;
  $('insight-recorded').textContent = `${current.recordedDays}日 / 30日`;
  $('insight-unrecorded').textContent = `${model.unrecordedDays}日（調子は未判定）`;
  $('insight-notes').textContent = `${current.noteDays}日`;
  $('insight-previous').textContent = `比較期間：${previous.from} 〜 ${previous.to}。記録${previous.recordedDays}日、備考${previous.noteDays}日。`;
  const conditionRows = current.conditions.map((item, index) => fact(item.label, `${item.days}日（前期間 ${previous.conditions[index].days}日）`));
  conditionRows.push(fact('調子が未入力の記録', `${current.missingConditionDays}日（前期間 ${previous.missingConditionDays}日）`));
  $('insight-conditions').replaceChildren(...conditionRows);
  $('insight-symptoms').replaceChildren(...symptoms.map(item => {
    const tr = element('tr'), th = element('th', item.label); th.scope = 'row';
    tr.append(th, element('td', `${item.days}日`), element('td', `${item.previousDays}日`)); return tr;
  }));
  $('insight-cycles').hidden = !cycles;
  $('insight-cycle-facts').replaceChildren();
  $('insight-cycle-history').replaceChildren();
  if (cycles) {
    $('insight-cycle-facts').append(fact('前回の開始日', cycles.lastStart),
      fact('直近の周期', cycles.latestCycle ? `${cycles.latestCycle}日` : '記録不足'),
      fact('直近最大6周期の中央値', cycles.medianCycle ? `${cycles.medianCycle}日` : '記録不足'),
      fact('最短〜最長', cycles.shortest ? `${cycles.shortest}〜${cycles.longest}日` : '記録不足'));
    $('insight-cycle-history').append(...[...cycles.history].reverse().map(item => element('li', `${item.from} → ${item.to}：${item.days}日`)));
  }
  $('insight-periods').replaceChildren(...model.periods.map(span => element('li', `${span.start} 開始 ／ ${span.end ? `${span.end} 終了` : '終了未記録'}`)));
  if (!model.periods.length) $('insight-periods').append(element('li', 'この期間に開始・終了を確認できる記録はありません。'));
  $('insight-daily').replaceChildren(...current.records.map(record => {
    const row = element('div', null, 'summary-record');
    row.append(element('h3', record.date), element('p', healthText(record) || '調子・症状・備考は未入力'),
      element('p', [record.start ? '生理開始' : '', record.end ? '生理終了' : '', record.flow ? `経血量：${record.flow}` : ''].filter(Boolean).join(' / '), 'hint'));
    return row;
  }));
  if (!current.records.length) $('insight-daily').append(element('p', 'この期間の記録はありません。', 'hint'));
}
export function renderView({ records, settings, month, prediction, spans, insights, edit }) {
  renderToday(records); renderCycle(prediction, spans, settings);
  renderCalendar({ month, records, prediction, spans, edit }); renderRecords(records, edit); renderInsights(insights);
}
export function clearView() {
  for (const id of ['records', 'calendar', 'insight-conditions', 'insight-symptoms', 'insight-cycle-facts', 'insight-cycle-history', 'insight-periods', 'insight-daily']) $(id).replaceChildren();
  for (const id of ['today-date', 'today-status', 'prediction-window', 'last-period-start', 'period-reminder-message', 'prediction', 'prediction-basis', 'prediction-range', 'latest-cycle', 'insight-range', 'insight-recorded', 'insight-unrecorded', 'insight-notes', 'insight-previous']) $(id).textContent = '';
  document.querySelectorAll('#app details').forEach(details => { details.open = false; });
  $('period-reminder').hidden = true; $('insight-cycles').hidden = true;
  $('record-today').textContent = '今日の体調を記録';
}
