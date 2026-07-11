(function () {
  const entries = (window.TRoomDiaryData?.entries || []).slice().sort(compareNewest);

  function getOrder(entry) {
    if (Number.isFinite(Number(entry.order))) return Number(entry.order);
    const match = String(entry.id || "").match(/(\d+)$/);
    return match ? Number(match[1]) : 0;
  }

  function compareNewest(a, b) {
    const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
    return dateCompare || getOrder(b) - getOrder(a);
  }

  function formatDate(date) {
    const [year, month, day] = String(date).split("-").map(Number);
    return `${year}年${month}月${day}日`;
  }

  function monthKey(date) {
    return String(date || "").slice(0, 7);
  }

  function monthLabel(key) {
    const [year, month] = key.split("-").map(Number);
    return `${year}年${month}月`;
  }

  function tagUrl(tag) {
    return `/diary/tags.html?tag=${encodeURIComponent(tag)}`;
  }

  function createTags(tags) {
    const wrap = document.createElement("div");
    wrap.className = "diary-tags";
    (tags || []).forEach((tag) => {
      const link = document.createElement("a");
      link.className = "diary-tag";
      link.href = tagUrl(tag);
      link.textContent = `#${tag}`;
      wrap.appendChild(link);
    });
    return wrap;
  }

  function createEntryCard(entry) {
    const article = document.createElement("article");
    article.className = "diary-entry-card";
    article.innerHTML = `
      <time datetime="${entry.date}">${formatDate(entry.date)}</time>
      <h3><a href="${entry.url}">${entry.title}</a></h3>
      <p>${entry.summary}</p>
    `;
    article.appendChild(createTags(entry.tags));
    return article;
  }

  function renderRecent() {
    document.querySelectorAll("[data-diary-recent]").forEach((root) => {
      const limit = Number(root.dataset.diaryRecent) || 5;
      const items = entries.slice(0, limit);
      root.replaceChildren(...items.map(createEntryCard));
      if (!items.length) root.innerHTML = '<p class="diary-empty">まだ日記はありません。</p>';
    });
  }

  function renderArchiveNav() {
    const counts = new Map();
    entries.forEach((entry) => {
      const key = monthKey(entry.date);
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    document.querySelectorAll("[data-diary-archive-nav]").forEach((root) => {
      root.replaceChildren(...Array.from(counts, ([key, count]) => {
        const link = document.createElement("a");
        link.href = `/diary/archive.html#month-${key}`;
        link.innerHTML = `<span>${monthLabel(key)}</span><small>${count}件</small>`;
        return link;
      }));
      if (!counts.size) root.innerHTML = '<p class="diary-empty">年月別の記録はまだありません。</p>';
    });
  }

  function renderTagCloud() {
    const counts = new Map();
    entries.forEach((entry) => (entry.tags || []).forEach((tag) => {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }));

    document.querySelectorAll("[data-diary-tags]").forEach((root) => {
      root.replaceChildren(...Array.from(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja")).map(([tag, count]) => {
        const link = document.createElement("a");
        link.className = "diary-tag";
        link.href = tagUrl(tag);
        link.textContent = `#${tag} ${count}`;
        return link;
      }));
      if (!counts.size) root.innerHTML = '<p class="diary-empty">#はまだありません。</p>';
    });
  }

  function renderArchive() {
    document.querySelectorAll("[data-diary-archive]").forEach((root) => {
      const groups = new Map();
      entries.forEach((entry) => {
        const key = monthKey(entry.date);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
      });

      root.replaceChildren(...Array.from(groups, ([key, items]) => {
        const section = document.createElement("section");
        section.className = "diary-month-group";
        section.id = `month-${key}`;
        section.innerHTML = `<div class="diary-month-heading"><h2>${monthLabel(key)}</h2><span>${items.length}件</span></div>`;
        const list = document.createElement("div");
        list.className = "diary-entry-list";
        list.append(...items.map(createEntryCard));
        section.appendChild(list);
        return section;
      }));
      if (!groups.size) root.innerHTML = '<p class="diary-empty">まだ日記はありません。</p>';
    });
  }

  function renderTagPage() {
    const root = document.querySelector("[data-diary-tag-results]");
    if (!root) return;
    const activeTag = new URLSearchParams(window.location.search).get("tag") || "";
    const title = document.querySelector("[data-diary-tag-title]");
    const items = activeTag ? entries.filter((entry) => (entry.tags || []).includes(activeTag)) : [];

    if (title) title.textContent = activeTag ? `#${activeTag}` : "#を選ぶ";
    root.replaceChildren(...items.map(createEntryCard));
    if (!activeTag) root.innerHTML = '<p class="diary-empty">上の#を選ぶと、関連する日記をまとめて表示します。</p>';
    else if (!items.length) root.innerHTML = '<p class="diary-empty">この#の日記はまだありません。</p>';
  }

  renderRecent();
  renderArchiveNav();
  renderTagCloud();
  renderArchive();
  renderTagPage();
}());
