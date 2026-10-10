import { today, conditionLabel, symptomLabel, INTENSITIES } from './health-domain.mjs';
export const $ = id => document.getElementById(id);
export const dateFormat = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', timeZone: 'UTC' });
export function shortDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return `${year === Number(today().slice(0, 4)) ? '' : `${year}/`}${month}/${day}`;
}
export function healthText(record) {
  return [record.condition ? `今日の調子：${conditionLabel(record.condition)}` : '',
    ...record.symptoms.map(item => `${symptomLabel(item.id)}${item.intensity ? `（${INTENSITIES[item.intensity]}）` : ''}`),
    record.note.trim()].filter(Boolean).join(' / ');
}
export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
