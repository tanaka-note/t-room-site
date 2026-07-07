(function () {
  const data = window.TRoomLearningData || {};
  const logs = data.learningLogs || [];
  const subjects = data.learningSubjects || [];
  const topics = data.learningTopics || [];

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
      const limit = Number(container.dataset.learningRecent) || 3;
      const items = logs.slice(0, limit);
      container.replaceChildren(...items.map(createLogCard));
      if (!items.length) container.innerHTML = '<p class="learning-empty">まだ学習ログはありません。</p>';
    });
  }

  function renderAllLogs() {
    const container = document.querySelector("[data-learning-logs]");
    if (!container) return;
    container.replaceChildren(...logs.map(createLogCard));
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
        <div><dt>要確認</dt><dd>${subject.reviewCount}</dd></div>
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

  function renderReviewNotes() {
    document.querySelectorAll("[data-learning-review]").forEach((container) => {
      const items = logs.filter((log) => log.needsReview);
      container.replaceChildren(...items.map((log) => {
        const article = document.createElement("a");
        article.className = "learning-sticky-note";
        article.href = log.url;
        article.innerHTML = `
          <span>${log.subject}</span>
          <strong>${log.title}</strong>
          <p>${log.summary}</p>
        `;
        return article;
      }));
      if (!items.length) container.innerHTML = '<p class="learning-empty">要確認のログはありません。</p>';
    });
  }

  renderRecentLogs();
  renderAllLogs();
  renderSubjects();
  renderTopics();
  renderReviewNotes();
}());
