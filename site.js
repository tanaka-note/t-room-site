(() => {
  const grid = document.querySelector("#app-card-grid");
  if (!grid) return;

  const apps = [
    {
      name: "電卓",
      description: "実務で使いやすい卓上電卓風のWebアプリ。四則演算、桁区切り、モード設定に対応します。",
      url: "./apps/calculator/index.html?v=20260621-remake10",
      status: "Calculator",
      cardClass: "app-card-calculator",
    },
    {
      name: "おみくじ",
      description: "六角みくじ箱を振ると木札が出てくる、明るく遊べる小さな運勢アプリです。",
      url: "./apps/omikuji/index.html?v=20260621-omikuji1",
      status: "Fortune",
      cardClass: "app-card-omikuji",
    },
    {
      name: "心の天秤",
      description: "A案とB案を天秤にのせて、ゆらゆら迷ったあとに50%ずつでそっと選ぶアプリです。",
      url: "./apps/kokoro-tenbin/index.html?v=20260622-tenbin2",
      status: "Balance",
      cardClass: "app-card-tenbin",
    },
    {
      name: "今を撮る",
      description: "今を残すためのデジタルインスタントカメラです。",
      url: "./apps/ima-camera/index.html?v=20260623-ima9",
      status: "Camera",
      cardClass: "app-card-ima-camera",
    },
    {
      name: "やる気スイッチ",
      description: "押すたびに、今の自分へ短い一言が返ってくるミニアプリです。",
      url: "./apps/motivation-switch/index.html?v=20260704-switch2",
      status: "Swich",
      cardClass: "app-card-motivation-switch",
    },
  ];

  function createAppCard(app) {
    const card = document.createElement(app.url ? "a" : "article");
    card.className = `app-card ${app.cardClass || ""} ${app.url ? "" : "is-disabled"}`;

    if (app.url) {
      card.href = app.url;
    }

    const label = document.createElement("span");
    label.className = "app-card-label";
    label.textContent = app.status || "App";

    const title = document.createElement("h3");
    title.textContent = app.name;

    const description = document.createElement("p");
    description.textContent = app.description;

    card.append(label, title, description);

    if (app.note) {
      const note = document.createElement("p");
      note.className = "app-card-note";
      note.textContent = app.note;
      card.append(note);
    }

    if (app.url) {
      const arrow = document.createElement("span");
      arrow.className = "app-card-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "→";
      card.append(arrow);
    }

    return card;
  }

  grid.replaceChildren(...apps.map(createAppCard));

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./calculator-install-sw.js", { scope: "./" }).catch(() => {
        // The app list still works if PWA registration is unavailable.
      });
    });
  }
})();

(() => {
  const header = document.querySelector(".site-header");
  if (!header) return;

  let lastY = window.scrollY;
  let ticking = false;
  const topBuffer = 80;
  const movement = 6;

  function updateHeader() {
    const currentY = window.scrollY;
    const focusedInHeader = header.contains(document.activeElement);

    if (currentY <= topBuffer || focusedInHeader) {
      header.classList.remove("header-hidden");
    } else if (currentY > lastY + movement) {
      header.classList.add("header-hidden");
    } else if (currentY < lastY - movement) {
      header.classList.remove("header-hidden");
    }

    lastY = currentY;
    ticking = false;
  }

  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateHeader);
  }, { passive: true });

  header.addEventListener("focusin", () => {
    header.classList.remove("header-hidden");
  });
})();

(() => {
  const recentPosts = [];
  const visibleThemes = new Set(["仕事", "生活"]);
  const list = document.querySelector("#recent-post-list");
  const archiveList = document.querySelector("#article-archive-list");
  if (!list && !archiveList) return;

  const empty = document.querySelector("#recent-empty");
  const toggle = document.querySelector("#recent-toggle");
  const archiveLink = document.querySelector("#recent-archive-link");
  const initialCount = Number(list?.dataset.initialCount) || 3;
  const maxCount = Number(list?.dataset.maxCount) || 9;

  function getDateRank(post) {
    return Number(String(post.date || "").replace(/\D/g, "")) || 0;
  }

  function getPublishedRank(post) {
    const date = String(post.date || "").replaceAll(".", "-");
    const timestamp = Date.parse(post.publishedAt || `${date}T00:00:00+09:00`);
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  function getPostSequence(post) {
    if (Number.isFinite(Number(post.order))) return Number(post.order);
    const source = `${post.title || ""} ${post.url || ""}`;
    const match = source.match(/#\d+-(\d+)|#(\d+)|logs\/(?:\d+-)?(\d+)\.html/);
    return match ? Number(match[1] || match[2] || match[3]) : 0;
  }

  function compareRecentPosts(a, b) {
    const publishedDiff = getPublishedRank(b) - getPublishedRank(a);
    if (publishedDiff !== 0) return publishedDiff;
    const sequenceDiff = getPostSequence(b) - getPostSequence(a);
    if (sequenceDiff !== 0) return sequenceDiff;
    return a.index - b.index;
  }

  const posts = recentPosts
    .map((post, index) => ({ ...post, index }))
    .filter((post) => visibleThemes.has(post.theme))
    .sort(compareRecentPosts);
  let expanded = false;

  function createPostCard(post) {
    const card = document.createElement("a");
    card.className = "post-card";
    card.href = post.url;

    const body = document.createElement("div");
    const meta = document.createElement("div");
    meta.className = "post-meta";

    const tag = document.createElement("span");
    tag.className = "post-tag";
    tag.textContent = post.genre ? `${post.theme}・${post.genre}` : post.theme;

    const date = document.createElement("span");
    date.textContent = post.date;

    const title = document.createElement("h3");
    title.textContent = post.title;

    const excerpt = document.createElement("p");
    excerpt.textContent = post.excerpt;

    const arrow = document.createElement("span");
    arrow.className = "post-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";

    meta.append(tag, date);
    body.append(meta, title, excerpt);
    card.append(body, arrow);
    return card;
  }

  function renderRecentPosts() {
    if (!list) return;
    const visibleCount = expanded ? maxCount : initialCount;
    const visiblePosts = posts.slice(0, visibleCount);

    list.replaceChildren(...visiblePosts.map(createPostCard));
    list.hidden = posts.length === 0;

    if (empty) {
      empty.hidden = posts.length > 0;
    }

    if (toggle) {
      toggle.hidden = expanded || posts.length <= initialCount;
      toggle.setAttribute("aria-expanded", String(expanded));
    }

    if (archiveLink) {
      archiveLink.hidden = !expanded || posts.length <= maxCount;
    }
  }

  if (toggle) {
    toggle.addEventListener("click", () => {
      expanded = !expanded;
      renderRecentPosts();
    });
  }

  if (archiveList) {
    const archiveMax = Number(archiveList.dataset.maxCount) || 100;
    const archivePosts = posts.slice(0, archiveMax);
    archiveList.replaceChildren(...archivePosts.map(createPostCard));
    archiveList.hidden = archivePosts.length === 0;

    const archiveEmpty = document.querySelector("#article-archive-empty");
    if (archiveEmpty) archiveEmpty.hidden = archivePosts.length > 0;
  }

  renderRecentPosts();
})();
