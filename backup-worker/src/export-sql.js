// Parse the data-only SQLite dump. Never execute archive SQL, evaluate SQL
// expressions, log it, or persist source columns that the registry excludes.
const MAX_STATEMENT = 16 * 1024 * 1024;
const invalid = () => new Error('ExportInvalid');

export async function* sqlStatements(body) {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', position = 0, start = 0, quote = null, comment = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      text += decoder.decode(value, { stream: !done });
      while (position < text.length) {
        const c = text[position], next = text[position + 1];
        if (!done && position + 1 === text.length) break;
        if (comment === 'line') { if (c === '\n') comment = null; position++; continue; }
        if (comment === 'block') {
          if (c === '*' && next === '/') { comment = null; position += 2; } else position++;
          continue;
        }
        if (quote) {
          if (c === quote) {
            if (next === quote && quote !== ']') { position += 2; continue; }
            quote = null;
          }
          position++; continue;
        }
        if (c === '-' && next === '-') { comment = 'line'; position += 2; continue; }
        if (c === '/' && next === '*') { comment = 'block'; position += 2; continue; }
        if (['\'', '"', '`', '['].includes(c)) { quote = c === '[' ? ']' : c; position++; continue; }
        position++;
        if (position - start > MAX_STATEMENT) throw invalid();
        if (c === ';') { yield text.slice(start, position); start = position; }
      }
      text = text.slice(start); position -= start; start = 0;
      if (text.length > MAX_STATEMENT) throw invalid();
      if (done) {
        if (quote || comment === 'block' || text.replace(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\//g, '').trim()) throw invalid();
        return;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function tokens(sql) {
  const result = []; let i = 0;
  while (i < sql.length) {
    if (result.length > 10000) throw invalid();
    const rest = sql.slice(i);
    const space = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/.exec(rest);
    if (space) { i += space[0].length; continue; }
    const c = sql[i];
    if (['\'', '"', '`', '['].includes(c)) {
      const close = c === '[' ? ']' : c; let value = ''; i++;
      for (;;) {
        if (i >= sql.length) throw invalid();
        if (sql[i] === close) {
          if (close !== ']' && sql[i + 1] === close) { value += close; i += 2; continue; }
          i++; break;
        }
        value += sql[i++];
      }
      result.push({ type: c === '\'' ? 'string' : 'identifier', value }); continue;
    }
    const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) {
      const raw = number[0], value = Number(raw);
      if (!Number.isFinite(value)) throw invalid();
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error('UnsafeInteger');
      result.push({ type: 'number', value }); i += raw.length; continue;
    }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest);
    if (word) { result.push({ type: 'word', value: word[0] }); i += word[0].length; continue; }
    if (rest.startsWith('||')) { result.push({ type: 'symbol', value: '||' }); i += 2; continue; }
    if ('(),;='.includes(c)) { result.push({ type: 'symbol', value: c }); i++; continue; }
    throw invalid();
  }
  return result;
}

export function* exportedRows(sql, tables) {
  const ts = tokens(sql); let i = 0;
  const take = value => { if (ts[i]?.value.toUpperCase?.() !== value.toUpperCase()) throw invalid(); return ts[i++]; };
  const identifier = () => {
    if (!['word', 'identifier'].includes(ts[i]?.type)) throw invalid();
    return ts[i++].value;
  };
  if (!ts.length) return;
  // D1's data-only export may include transaction/foreign-key prologues.
  if (ts[0].value.toUpperCase() === 'PRAGMA') {
    take('PRAGMA'); take('defer_foreign_keys'); take('=');
    if (!['TRUE','ON','1'].includes(String(ts[i++]?.value).toUpperCase())) throw invalid();
    take(';'); if (i !== ts.length) throw invalid(); return;
  }
  if (['BEGIN','COMMIT'].includes(ts[0].value.toUpperCase())) {
    i++; if (ts[i]?.value.toUpperCase() === 'TRANSACTION') i++;
    take(';'); if (i !== ts.length) throw invalid(); return;
  }
  take('INSERT'); take('INTO');
  const name = identifier(), table = tables.find(t => t.name === name);
  if (!table) throw new Error('SchemaReviewRequired');
  let columns = table.sourceColumns.split(',');
  if (ts[i]?.value === '(') {
    i++; columns = [identifier()];
    while (ts[i]?.value === ',') { i++; columns.push(identifier()); }
    take(')');
    if (new Set(columns).size !== columns.length || [...columns].sort().join(',') !== table.sourceColumns.split(',').sort().join(',')) throw new Error('SchemaReviewRequired');
  }
  take('VALUES');
  const expression = (depth = 0) => {
    if (depth > 8) throw invalid();
    const token = ts[i++]; let value;
    if (!token) throw invalid();
    if (token.type === 'number' || token.type === 'string') value = token.value;
    else if (token.type === 'word' && token.value.toUpperCase() === 'NULL') value = null;
    else if (token.type === 'word' && ['char','replace'].includes(token.value.toLowerCase())) {
      take('('); const args = [expression(depth + 1)];
      while (ts[i]?.value === ',') { i++; args.push(expression(depth + 1)); }
      take(')');
      if (token.value.toLowerCase() === 'char') {
        if (args.some(n => !Number.isInteger(n) || n < 0 || n > 0x10ffff)) throw invalid();
        value = String.fromCodePoint(...args);
      } else {
        if (args.length !== 3 || args.some(a => typeof a !== 'string')) throw invalid();
        if (args[0].length * Math.max(1,args[2].length) > MAX_STATEMENT) throw invalid();
        value = args[1] ? args[0].replaceAll(args[1], args[2]) : args[0];
      }
    } else throw invalid();
    while (ts[i]?.value === '||') {
      i++; const right = expression(depth + 1);
      if (String(value).length + String(right).length > MAX_STATEMENT) throw invalid();
      value = value === null || right === null ? null : String(value) + String(right);
    }
    return value;
  };
  for (;;) {
    take('('); const values = [expression()];
    while (ts[i]?.value === ',') { i++; values.push(expression()); }
    take(')');
    if (values.length !== columns.length) throw invalid();
    const row = Object.fromEntries(table.columns.map(c => [c, values[columns.indexOf(c)]]));
    if (Object.values(row).some(v => v === undefined)) throw invalid();
    yield { table: name, row };
    if (ts[i]?.value !== ',') break;
    i++;
  }
  take(';'); if (i !== ts.length) throw invalid();
}
