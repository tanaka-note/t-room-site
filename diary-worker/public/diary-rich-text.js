const ENTRY_TEXT_LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`[\]{}()<>]+/g;
const ENTRY_TEXT_LINK_TRIM_TRAILING = /[.,。、!?！？)\]\}"'”』】〉》）]+$/u;
const ENTRY_TEXT_LINK_TEXT_BODY = /[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/;

export function findEntryTextLinks(text) {
  const source = String(text || "");
  const links = [];
  ENTRY_TEXT_LINK_PATTERN.lastIndex = 0;
  let match;
  while ((match = ENTRY_TEXT_LINK_PATTERN.exec(source)) !== null) {
    const matched = match[0];
    let end = matched.length;
    while (end > 0 && ENTRY_TEXT_LINK_TRIM_TRAILING.test(matched[end - 1])) end -= 1;
    if (end === matched.length) {
      for (let i = end - 1; i > 0; i -= 1) {
        if (!ENTRY_TEXT_LINK_TRIM_TRAILING.test(matched[i])) continue;
        if (ENTRY_TEXT_LINK_TEXT_BODY.test(matched[i + 1])) break;
        end = i + 1;
        while (end > 0 && ENTRY_TEXT_LINK_TRIM_TRAILING.test(matched[end - 1])) end -= 1;
        break;
      }
    }
    if (end === 0) continue;
    const textValue = matched.slice(0, end);
    const href = textValue.startsWith("www.") ? `https://${textValue}` : textValue;
    if (!href.startsWith("http://") && !href.startsWith("https://")) continue;
    try {
      const parsed = new URL(href);
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
    } catch {
      continue;
    }
    const valueStart = match.index;
    links.push({
      start: valueStart,
      end: valueStart + textValue.length,
      text: textValue,
      href
    });
  }
  return links;
}

export function normalizeEntryTextRuns(textLength, runs) {
  return (Array.isArray(runs) ? runs : []).map((run) => {
    const start = Math.max(0, Math.min(Number(run.start) || 0, textLength));
    const end = Math.max(start, Math.min(Number(run.end) || 0, textLength));
    return { ...run, start, end };
  }).filter((run) => run.end > run.start).sort((left, right) => left.start - right.start);
}

export function resolveEntryTextMarks(runs, start, end) {
  const marks = { bold: false, italic: false, underline: false, color: null };
  for (const run of runs) {
    if (run.end <= start || run.start >= end) continue;
    if (run.bold) marks.bold = true;
    if (run.italic) marks.italic = true;
    if (run.underline) marks.underline = true;
    if (run.color) marks.color = run.color;
  }
  return hasTextMarks(marks) ? marks : null;
}

export function tokenizeEntryTextWithLinks(text, runs = []) {
  const source = String(text || "");
  if (!source) return [];
  const linkTokens = findEntryTextLinks(source);
  const normalizedRuns = normalizeEntryTextRuns(source.length, runs);
  const boundaries = new Set([0, source.length]);
  for (const run of normalizedRuns) {
    boundaries.add(run.start);
    boundaries.add(run.end);
  }
  for (const link of linkTokens) {
    boundaries.add(link.start);
    boundaries.add(link.end);
  }
  const points = [...boundaries].sort((left, right) => left - right);
  const tokens = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (start === end) continue;
    const link = linkTokens.find((candidate) => candidate.start <= start && candidate.end >= end);
    tokens.push({
      kind: link ? "link" : "text",
      text: source.slice(start, end),
      start,
      end,
      marks: resolveEntryTextMarks(normalizedRuns, start, end),
      href: link?.href,
      linkText: link?.text
    });
  }
  return tokens;
}

export function getSelectionSegments(contentLength, runs, start, end) {
  const selectionStart = Math.max(0, Math.min(contentLength, Number(start) || 0));
  const selectionEnd = Math.max(selectionStart, Math.min(contentLength, Number(end) || 0));
  const boundaries = new Set([0, contentLength, selectionStart, selectionEnd]);
  for (const run of runs) {
    boundaries.add(Math.max(0, Math.min(contentLength, Number(run.start) || 0)));
    boundaries.add(Math.max(0, Math.min(contentLength, Number(run.end) || 0)));
  }
  const points = [...boundaries].sort((left, right) => left - right);
  return points.slice(0, -1).flatMap((segmentStart, index) => {
    const segmentEnd = points[index + 1];
    if (segmentEnd <= segmentStart) return [];
    const run = runs.find((candidate) => candidate.start <= segmentStart && candidate.end >= segmentEnd);
    return [{
      start: segmentStart,
      end: segmentEnd,
      selected: segmentStart >= selectionStart && segmentEnd <= selectionEnd,
      bold: Boolean(run?.bold),
      italic: Boolean(run?.italic),
      underline: Boolean(run?.underline),
      color: run?.color || null
    }];
  });
}

export function getSelectionFormatState(contentLength, runs, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const selected = getSelectionSegments(contentLength, runs, start, end).filter((segment) => segment.selected);
  if (!selected.length) return null;
  const colors = new Set(selected.map((segment) => segment.color || "default"));
  return {
    bold: selected.every((segment) => segment.bold),
    italic: selected.every((segment) => segment.italic),
    underline: selected.every((segment) => segment.underline),
    color: colors.size === 1 ? [...colors][0] : null
  };
}

export function applyFormatToSelection(contentLength, runs, start, end, command, value) {
  const segments = getSelectionSegments(contentLength, runs, start, end);
  const selected = segments.filter((segment) => segment.selected);
  const enableCommand = ["bold", "italic", "underline"].includes(command)
    ? !selected.every((segment) => segment[command])
    : false;
  return mergeRichTextRuns(segments.map((segment) => {
    const marks = {
      start: segment.start,
      end: segment.end,
      bold: segment.bold,
      italic: segment.italic,
      underline: segment.underline,
      color: segment.color
    };
    if (segment.selected && command === "color") marks.color = value === "default" ? null : value;
    if (segment.selected && ["bold", "italic", "underline"].includes(command)) marks[command] = enableCommand;
    return marks;
  }));
}

export function hasTextMarks(marks) {
  return Boolean(marks.bold || marks.italic || marks.underline || marks.color);
}

export function sameTextMarks(left, right) {
  return Boolean(left?.bold) === Boolean(right?.bold)
    && Boolean(left?.italic) === Boolean(right?.italic)
    && Boolean(left?.underline) === Boolean(right?.underline)
    && (left?.color || null) === (right?.color || null);
}

export function mergeRichTextRuns(runs) {
  const merged = [];
  for (const run of runs) {
    if (run.end <= run.start || !hasTextMarks(run)) continue;
    const previous = merged.at(-1);
    if (previous && previous.end === run.start && sameTextMarks(previous, run)) previous.end = run.end;
    else merged.push({
      start: run.start,
      end: run.end,
      bold: Boolean(run.bold),
      italic: Boolean(run.italic),
      underline: Boolean(run.underline),
      color: run.color || null
    });
  }
  return merged;
}

export function shiftRichTextRunsForInsertion(runs, offset, insertedLength) {
  return mergeRichTextRuns(runs.flatMap((run) => {
    if (run.end <= offset) return [run];
    if (run.start >= offset) return [{ ...run, start: run.start + insertedLength, end: run.end + insertedLength }];
    return [
      { ...run, end: offset },
      { ...run, start: offset + insertedLength, end: run.end + insertedLength }
    ];
  }));
}

export function insertTextIntoRichDocument(documentValue, requestedOffset, insertedText) {
  const content = String(documentValue?.content || "");
  const offset = Math.max(0, Math.min(content.length, Number(requestedOffset) || 0));
  const text = String(insertedText || "");
  const runs = shiftRichTextRunsForInsertion(
    Array.isArray(documentValue?.contentFormat?.runs) ? documentValue.contentFormat.runs : [],
    offset,
    text.length
  );
  return {
    content: content.slice(0, offset) + text + content.slice(offset),
    contentFormat: runs.length ? { version: 1, runs } : null
  };
}

export function removeTextFromRichDocument(documentValue, textToRemove) {
  let content = documentValue.content;
  let runs = documentValue.contentFormat?.runs || [];
  let index = content.lastIndexOf(textToRemove);
  while (index >= 0) {
    const end = index + textToRemove.length;
    content = content.slice(0, index) + content.slice(end);
    runs = runs.flatMap((run) => {
      if (run.end <= index) return [run];
      if (run.start >= end) return [{ ...run, start: run.start - textToRemove.length, end: run.end - textToRemove.length }];
      const newStart = run.start < index ? run.start : index;
      const newEnd = run.end > end ? run.end - textToRemove.length : index;
      return newEnd > newStart ? [{ ...run, start: newStart, end: newEnd }] : [];
    });
    index = content.lastIndexOf(textToRemove, index - 1);
  }
  return {
    content,
    contentFormat: runs.length ? { version: 1, runs: mergeRichTextRuns(runs) } : null
  };
}

export function withoutPhotoMarkers(documentValue, photoIds) {
  const withoutMarkers = photoIds.reduce(
    (current, photoId) => removeTextFromRichDocument(current, photoMarker(photoId)),
    documentValue
  );
  const content = withoutMarkers.content;
  if (!content) return withoutMarkers;
  const leading = content.search(/\S/);
  const trailing = content.length - content.trimEnd().length;
  const start = leading < 0 ? content.length : leading;
  const end = content.length - trailing;
  const runs = (withoutMarkers.contentFormat?.runs || []).flatMap((run) => {
    const runStart = Math.max(run.start, start);
    const runEnd = Math.min(run.end, end);
    return runEnd > runStart ? [{ ...run, start: runStart - start, end: runEnd - start }] : [];
  });
  return {
    content: content.slice(start, end),
    contentFormat: runs.length ? { version: 1, runs: mergeRichTextRuns(runs) } : null
  };
}

export function photoMarker(id) {
  return `[[写真:${id}]]`;
}
