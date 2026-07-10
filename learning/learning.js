(function () {
  const data = window.TRoomLearningData || {};
  const logs = data.learningLogs || [];
  const subjects = data.learningSubjects || [];
  const topics = data.learningTopics || [];

  function getLogNumber(log) {
    if (Number.isFinite(Number(log.order))) return Number(log.order);
    const match = String(log.id || "").match(/(\d+)$/);
    return match ? Number(match[1]) : 0;
  }

  function compareLogsByNewest(a, b) {
    const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
    if (dateCompare !== 0) return dateCompare;
    return getLogNumber(b) - getLogNumber(a);
  }

  const sortedLogs = logs.slice().sort(compareLogsByNewest);

  function formatDate(value) {
    return value || "なし";
  }

  function createTag(text) {
    const span = document.createElement("span");
    span.className = "learning-tag";
    span.textContent = text;
    return span;
  }

  function renderRecentLogs() {
    document.querySelectorAll("[data-learning-recent]").forEach((container) => {
      const initialCount = Number(container.dataset.learningRecentInitial || container.dataset.learningRecent) || 3;
      const maxCount = Number(container.dataset.learningRecentMax || container.dataset.learningRecent) || initialCount;
      const toggle = container.closest(".learning-panel")?.querySelector("[data-learning-recent-toggle]");
      let expanded = false;

      function render() {
        const limit = expanded ? maxCount : initialCount;
        const items = sortedLogs.slice(0, limit);
        container.replaceChildren(...items.map(createLogCard));
        if (!items.length) container.innerHTML = '<p class="learning-empty">まだ学習ログはありません。</p>';

        if (toggle) {
          toggle.hidden = sortedLogs.length <= initialCount;
          toggle.setAttribute("aria-expanded", String(expanded));
          toggle.textContent = expanded ? "閉じる" : "開く";
        }
      }

      if (toggle) {
        toggle.addEventListener("click", () => {
          expanded = !expanded;
          render();
        });
      }

      render();
    });
  }

  function renderAllLogs() {
    const container = document.querySelector("[data-learning-logs]");
    if (!container) return;
    container.replaceChildren(...sortedLogs.map(createLogCard));
    if (!logs.length) container.innerHTML = '<p class="learning-empty">まだ学習ログはありません。</p>';
  }

  function createLogCard(log) {
    const card = document.createElement("a");
    card.className = "learning-log-card";
    card.href = log.url;
    card.innerHTML = `
      <div class="learning-card-meta">
        <span>${log.date}</span>
        <span>${log.subject}</span>
      </div>
      <h3>${log.title}</h3>
      <p>${log.summary}</p>
    `;
    const tags = document.createElement("div");
    tags.className = "learning-tags";
    (log.tags || []).forEach((tag) => tags.appendChild(createTag(tag)));
    card.appendChild(tags);
    return card;
  }

  function renderSubjects() {
    document.querySelectorAll("[data-learning-subjects]").forEach((container) => {
      const group = container.dataset.learningSubjects;
      const items = group === "all" ? subjects : subjects.filter((subject) => subject.group === group);
      container.replaceChildren(...items.map(createSubjectCard));
    });
  }

  function createSubjectCard(subject) {
    const article = document.createElement("article");
    article.className = `learning-subject-card is-${subject.status === "未学習" ? "idle" : "active"}`;
    article.innerHTML = `
      <div class="learning-card-meta">
        <span>${subject.group}</span>
        <span>${subject.status}</span>
      </div>
      <h3>${subject.name}</h3>
      <dl class="learning-mini-stats">
        <div><dt>記事数</dt><dd>${subject.articleCount}</dd></div>
        <div><dt>最終更新</dt><dd>${formatDate(subject.lastUpdated)}</dd></div>
      </dl>
      <p>${subject.memo}</p>
    `;
    return article;
  }

  function renderTopics() {
    document.querySelectorAll("[data-learning-topics]").forEach((container) => {
      container.replaceChildren(...topics.map((topic) => {
        const article = document.createElement("article");
        article.className = "learning-topic-card";
        article.innerHTML = `
          <span class="learning-status">${topic.status}</span>
          <h3>${topic.title}</h3>
          <p>${topic.memo}</p>
        `;
        return article;
      }));
    });
  }

  renderRecentLogs();
  renderAllLogs();
  renderSubjects();
  renderTopics();
}());
