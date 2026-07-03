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
  const recentPosts = [
    {
      theme: "思考",
      date: "2026.07.04",
      title: "見えすぎる男女、育ちにくい未来",
      excerpt: "SNSで可視化される男女対立が、恋愛や結婚への想像力をどう変えているのかを考えます。",
      url: "./thought.html#sns-gender-division-low-birthrate",
    },
    {
      theme: "投資",
      date: "2026.06.25",
      title: "BTCの長らく続く下落と4年サイクル",
      excerpt: "長い低迷期の中で、BTCを持つ理由と4年サイクルについて考えます。",
      url: "./investment-btc-four-year-cycle.html",
    },
    {
      theme: "投資",
      date: "2026.06.18",
      title: "ビットコイン下落と今後",
      excerpt: "トランプラリー後の調整と、暗号資産市場に残る可能性を整理します。",
      url: "./investment-bitcoin-decline.html",
    },
    {
      theme: "投資",
      date: "2026.06.16",
      title: "日銀、1％程度への利上げ決定",
      excerpt: "コストプッシュインフレ下の利上げと、円安・株式市場への影響を整理します。",
      url: "./investment-boj-rate-hike.html",
    },
  ];
  const visibleThemes = new Set(["仕事", "投資", "生活", "思考"]);
  const list = document.querySelector("#recent-post-list");
  if (!list) return;

  const empty = document.querySelector("#recent-empty");
  const toggle = document.querySelector("#recent-toggle");
  const initialCount = Number(list.dataset.initialCount) || 3;
  const maxCount = Number(list.dataset.maxCount) || 10;
  const posts = recentPosts
    .filter((post) => visibleThemes.has(post.theme))
    .slice(0, maxCount);
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
    tag.textContent = post.theme;

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
    const visibleCount = expanded ? maxCount : initialCount;
    const visiblePosts = posts.slice(0, visibleCount);

    list.replaceChildren(...visiblePosts.map(createPostCard));
    list.hidden = posts.length === 0;

    if (empty) {
      empty.hidden = posts.length > 0;
    }

    if (toggle) {
      toggle.hidden = posts.length <= initialCount;
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.textContent = expanded ? "閉じる" : "もっと見る";
    }
  }

  if (toggle) {
    toggle.addEventListener("click", () => {
      expanded = !expanded;
      renderRecentPosts();
    });
  }

  renderRecentPosts();
})();

(() => {
  const grid = document.querySelector("#market-card-grid");
  if (!grid) return;

  const MARKET_API_URL = "https://troom-market-worker.atsushi-vip.workers.dev";
  const MARKET_ORDER = ["nikkei225_ref", "sp500_ref", "nasdaq100_ref", "bitcoin", "nifty50_ref"];
  const MARKET_DISPLAY = {
    nikkei225_ref: { label: "日本株参考", name: "日本株ETF参考値" },
    sp500_ref: { label: "S＆P500", name: "SPY" },
    nasdaq100_ref: { label: "NASDAQ100", name: "QQQ" },
    bitcoin: { label: "Bitcoin", name: "BTC" },
    nifty50_ref: { label: "Nifty50", name: "インド株 Nifty50ETF" },
  };

  function formatUpdatedAt(value) {
    if (!value) return "--";

    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function formatFetchedAt(value) {
    if (!value) return { date: "取得後表示", time: "--" };

    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      return { date: String(value).replaceAll("-", "/"), time: "--" };
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return { date: String(value).replaceAll("-", "/"), time: "--" };
    }

    const day = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);

    const time = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);

    return { date: day, time };
  }

  function formatPrice(price, currency) {
    if (price == null) return "--";

    const options = currency === "JPY"
      ? { maximumFractionDigits: 0 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    const formatted = new Intl.NumberFormat("ja-JP", options).format(price);

    if (currency === "JPY") return `¥${formatted}`;
    if (currency === "USD") return `$${formatted}`;
    return formatted;
  }

  function formatChange(value) {
    if (value == null) return "--";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  }

  function normalizeCurrency(item) {
    if (item.currency) return item.currency;
    if (item.symbol?.endsWith("/USD")) return "USD";
    if (item.symbol?.endsWith("/JPY")) return "JPY";
    return "";
  }

  function normalizedItem(item) {
    const display = MARKET_DISPLAY[item.id] || {};
    const percentChange = item.percentChange ?? item.changePercent ?? null;

    return {
      ...item,
      label: display.label || item.label,
      name: display.name || item.name || item.symbol || "",
      currency: normalizeCurrency(item),
      percentChange,
      waiting_market: item.waiting_market || item.status === "waiting_market" || (item.kind === "market" && item.activeNow === false),
    };
  }

  function getStatus(item) {
    if (item.stale) {
      return { label: "前回取得値", className: "stale" };
    }
    if (item.waiting_market) {
      return { label: "市場時間外", className: "waiting" };
    }
    if (item.ok) {
      return { label: "取得済み", className: "ok" };
    }
    return { label: "取得待ち", className: "waiting" };
  }

  function createMarketCard(item) {
    const normalized = normalizedItem(item);
    const status = getStatus(normalized);
    const direction = normalized.percentChange > 0 ? "up" : normalized.percentChange < 0 ? "down" : "";
    const card = document.createElement("article");
    card.className = `market-card ${normalized.waiting_market ? "is-waiting" : ""} ${normalized.stale ? "is-stale" : ""}`;

    const head = document.createElement("div");
    head.className = "market-card-head";

    const titleGroup = document.createElement("div");
    const label = document.createElement("h3");
    label.className = "market-label";
    label.textContent = normalized.label;

    const name = document.createElement("p");
    name.className = "market-name";
    name.textContent = normalized.name;

    const statusBadge = document.createElement("span");
    statusBadge.className = `market-status ${status.className}`;
    statusBadge.textContent = status.label;

    const price = document.createElement("p");
    price.className = "market-price";
    price.textContent = formatPrice(normalized.price, normalized.currency);

    const change = document.createElement("span");
    change.className = `market-change ${direction}`;
    change.textContent = formatChange(normalized.percentChange);

    const fetchedAt = formatFetchedAt(normalized.fetchedAt || normalized.datetime);
    const date = document.createElement("p");
    date.className = "market-trade-date";

    const dateLabel = document.createElement("span");
    dateLabel.className = "market-trade-label";
    dateLabel.textContent = "最終取得";

    const dateDay = document.createElement("span");
    dateDay.className = "market-trade-day";
    dateDay.textContent = fetchedAt.date;

    const dateTime = document.createElement("span");
    dateTime.className = "market-trade-time";
    dateTime.textContent = fetchedAt.time;

    date.append(dateLabel, dateDay, dateTime);

    titleGroup.append(label, name);
    head.append(titleGroup, statusBadge);
    card.append(head, price, change, date);

    return card;
  }

  function emptyMarketItems() {
    return MARKET_ORDER.map((id) => ({
      id,
      ...MARKET_DISPLAY[id],
      price: null,
      currency: "",
      percentChange: null,
      ok: false,
      waiting_market: true,
      stale: false,
    }));
  }

  function orderItems(items) {
    const byId = new Map(items.map((item) => [item.id, item]));
    return MARKET_ORDER.map((id) => byId.get(id) || emptyMarketItems().find((item) => item.id === id));
  }

  async function loadMarketData() {
    const updated = document.querySelector("#market-updated");

    try {
      const response = await fetch(MARKET_API_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const items = Array.isArray(data.items) && data.items.length ? orderItems(data.items) : emptyMarketItems();

      if (updated) {
        updated.textContent = `最終更新：${formatUpdatedAt(data.updatedAt)}`;
      }

      grid.replaceChildren(...items.map(createMarketCard));
    } catch (error) {
      if (updated) {
        updated.textContent = "最終更新：取得できませんでした";
      }

      const items = emptyMarketItems().map((item) => ({
        ...item,
        error: error.message,
      }));
      grid.replaceChildren(...items.map(createMarketCard));
    }
  }

  const updated = document.querySelector("#market-updated");
  if (updated) {
    updated.textContent = "最終更新：読み込み中";
  }

  grid.replaceChildren(...emptyMarketItems().map(createMarketCard));
  loadMarketData();
})();
