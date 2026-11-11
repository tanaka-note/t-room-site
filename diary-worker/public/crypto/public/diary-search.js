// Shared by the API and browser. Matching is literal and case-sensitive, like SQLite instr.
export function splitSearchTerms(value) {
  const query = String(value || "").trim().slice(0, 100).replace(/[\uD800-\uDBFF]$/, "");
  return [...new Set(query.split(/[\s\u3000]+/u).filter(Boolean))];
}

export function findSearchMatches(text, terms) {
  const matches = [];
  for (const term of terms) {
    if (!term) continue;
    let start = text.indexOf(term);
    while (start !== -1) {
      matches.push({ start, end: start + term.length, term });
      start = text.indexOf(term, start + 1);
    }
  }
  return matches.sort((a, b) => a.start - b.start || b.end - a.end);
}

function graphemeBoundaries(text) {
  return [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text)]
    .map((part) => part.index).concat(text.length);
}

function lowerBound(values, value) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function mergeRanges(ranges, gap = 0) {
  const merged = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + gap) previous.end = Math.max(previous.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

// At most two passages, with the complete displayed string (including …) <= 160 graphemes.
export function createSearchExcerpt(value, terms) {
  const text = String(value || "").replace(/\[\[写真:[0-9a-f-]{36}\]\]/gi, " ").replace(/\s+/gu, " ").trim();
  const boundaries = graphemeBoundaries(text);
  const length = boundaries.length - 1;
  if (length <= 160) return text;
  const hits = findSearchMatches(text, terms).map((hit) => ({
    ...hit,
    start: Math.max(0, lowerBound(boundaries, hit.start + 1) - 1),
    end: lowerBound(boundaries, hit.end)
  }));
  if (!hits.length) return text.slice(0, boundaries[159]) + "…";

  const starts = hits.map((hit) => hit.start);
  // Protect matches at passage edges; adjacent words remain separate boundaries.
  const protectedRanges = mergeRanges(hits, -1).flatMap((range) => {
    if (range.end - range.start <= 158) return [range];
    // Repeated overlapping words can form an arbitrarily long cluster. Keep complete,
    // non-overlapping occurrences as cut boundaries rather than showing only an ellipsis.
    const occurrences = [];
    for (let index = lowerBound(starts, range.start); index < hits.length && hits[index].start < range.end; index += 1) {
      const hit = hits[index];
      if (!occurrences.length || hit.start >= occurrences.at(-1).end) occurrences.push({ start: hit.start, end: hit.end });
    }
    return occurrences;
  });
  const protectedEnds = protectedRanges.map((range) => range.end);
  function safeWindow(hit, size) {
    if (hit.end - hit.start > size) return null;
    let start = Math.max(0, hit.start - Math.floor((size - (hit.end - hit.start)) / 2));
    let end = Math.min(length, start + size);
    start = Math.max(0, end - size);
    const left = protectedRanges[lowerBound(protectedEnds, start + 1)];
    if (left && left.start < start) start = left.end;
    const right = protectedRanges[lowerBound(protectedEnds, end)];
    if (right && right.start < end && right.end > end) end = right.start;
    return start <= hit.start && end >= hit.end ? { start, end } : null;
  }
  function coveredTerms(range) {
    const covered = new Set();
    for (let index = lowerBound(starts, range.start); index < hits.length && hits[index].start < range.end; index += 1) {
      if (hits[index].end <= range.end) covered.add(hits[index].term);
    }
    return covered;
  }
  function display(ranges) {
    return (ranges[0].start ? "…" : "")
      + ranges.map((range) => text.slice(boundaries[range.start], boundaries[range.end])).join("…")
      + (ranges.at(-1).end < length ? "…" : "");
  }
  const candidates = new Map();
  for (const hit of protectedRanges) {
    const range = safeWindow(hit, Math.max(76, hit.end - hit.start));
    if (range) candidates.set(`${range.start}:${range.end}`, { ...range, terms: coveredTerms(range) });
  }
  const ranked = [...candidates.values()].sort((a, b) => b.terms.size - a.terms.size || a.start - b.start);
  const first = ranked[0];
  if (!first) return text.slice(0, boundaries[159]) + "…";
  let selected = [{ start: first.start, end: first.end }];
  let bestGain = 0;
  for (const candidate of ranked) {
    const gain = [...candidate.terms].filter((term) => !first.terms.has(term)).length;
    if (gain <= bestGain) continue;
    const combined = mergeRanges([first, candidate], 12);
    const count = combined.reduce((sum, range) => sum + range.end - range.start, 0)
      + combined.length - 1 + Number(combined[0].start > 0) + Number(combined.at(-1).end < length);
    if (count <= 160) {
      selected = combined;
      bestGain = gain;
    }
  }
  if (selected.length === 1) {
    // Use the remaining budget for context when a second distinct term adds nothing.
    const expanded = safeWindow(selected[0], 158);
    if (expanded) selected = [expanded];
  }
  return display(selected);
}

// Walk only text nodes, after rich text, links and photos have been rendered.
// Offsets span formatting boundaries, so a word split across spans is still highlighted.
export function highlightSearchTerms(root, terms) {
  for (const mark of root.querySelectorAll("mark.diary-search-match")) mark.replaceWith(...mark.childNodes);
  root.normalize();
  if (!terms.length) return;
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, 4);
  const nodes = [];
  let text = "";
  while (walker.nextNode()) {
    const node = walker.currentNode;
    nodes.push({ node, start: text.length, end: text.length + node.data.length });
    text += node.data;
  }
  const boundaries = graphemeBoundaries(text);
  const ranges = mergeRanges(findSearchMatches(text, terms).map((hit) => ({
    start: boundaries[Math.max(0, lowerBound(boundaries, hit.start + 1) - 1)],
    end: boundaries[lowerBound(boundaries, hit.end)]
  })));
  let rangeIndex = 0;
  for (const { node, start, end } of nodes) {
    while (ranges[rangeIndex]?.end <= start) rangeIndex += 1;
    if (!ranges[rangeIndex] || ranges[rangeIndex].start >= end) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (let index = rangeIndex; index < ranges.length && ranges[index].start < end; index += 1) {
      const from = Math.max(start, ranges[index].start) - start;
      const to = Math.min(end, ranges[index].end) - start;
      fragment.append(document.createTextNode(node.data.slice(cursor, from)));
      const mark = document.createElement("mark");
      mark.className = "diary-search-match";
      mark.textContent = node.data.slice(from, to);
      fragment.append(mark);
      cursor = to;
    }
    fragment.append(document.createTextNode(node.data.slice(cursor)));
    node.replaceWith(fragment);
  }
}
