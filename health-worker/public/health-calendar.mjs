import { today } from './health-domain.mjs';
import { $ } from './health-format.mjs';

export function renderCalendar({ month, records, prediction, spans, edit }) {
  $('month').textContent = `${month.slice(0, 4)}年${Number(month.slice(5))}月`;
  const calendar = $('calendar');
  calendar.replaceChildren();
  for (const name of ['日', '月', '火', '水', '木', '金', '土']) {
    const weekday = document.createElement('div');
    weekday.className = 'weekday';
    weekday.textContent = name;
    calendar.append(weekday);
  }
  const first = new Date(`${month}-01T00:00:00Z`);
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  for (let index = 0; index < first.getUTCDay(); index++) calendar.append(document.createElement('div'));
  for (let day = 1; day <= count; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const record = records.find(row => row.date === date);
    const button = document.createElement('button');
    button.className = 'day';
    const labels = [date, record ? '記録あり' : '', record?.start ? '生理開始' : '', record?.end ? '生理終了' : ''];
    if (record?.start && !spans.find(span => span.start === date)?.end) labels.push('終了未記録');
    button.setAttribute('aria-label', labels.filter(Boolean).join(' '));
    button.textContent = day;
    if (date === today()) button.classList.add('current');
    if (spans.some(span => span.end && date >= span.start && date <= span.end)) button.classList.add('period');
    if (prediction.date && date >= prediction.from && date <= prediction.to) button.classList.add('predicted');
    if (record) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '●';
      button.append(dot);
    }
    if (record?.start || record?.end) {
      const label = document.createElement('small');
      label.textContent = record.start && record.end ? '開始\n終了' : record.start ? '開始' : '終了';
      button.append(label);
    }
    button.onclick = () => edit(date);
    calendar.append(button);
  }
}
