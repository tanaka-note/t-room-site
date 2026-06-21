(() => {
  const fortunes = [
    {
      rank: "大吉",
      weight: 8,
      className: "is-daikichi",
      sub: "きらり",
      message: "今日は小さな一歩が大きく育つ日。気になっていたことをひとつ始めると、流れが明るくなりそうです。",
    },
    {
      rank: "中吉",
      weight: 17,
      className: "is-chukichi",
      sub: "ほほえみ",
      message: "ほどよく追い風。急がず、でも止まらずに進むと、ちゃんと手応えが返ってきます。",
    },
    {
      rank: "小吉",
      weight: 22,
      className: "is-shokichi",
      sub: "ひといき",
      message: "整えるほど運が寄ってきます。机の上や予定を少し片づけると、気分も軽くなりそうです。",
    },
    {
      rank: "吉",
      weight: 33,
      className: "is-kichi",
      sub: "ふつうに良",
      message: "いつもの道に小さな発見がありそう。無理に特別なことをしなくても、今日はちゃんと吉です。",
    },
    {
      rank: "凶",
      weight: 15,
      className: "is-kyo",
      sub: "ねこむ前に休",
      message: "少し空回りしやすい日。大事な判断は一呼吸置いて、甘いものか温かい飲み物で立て直しましょう。",
    },
    {
      rank: "大凶",
      weight: 5,
      className: "is-daikyo",
      sub: "逆にレア",
      message: "かなりレアです。今日は慎重モードでいけば大丈夫。落とし物と勢い余った返信だけ気をつけて。",
    },
  ];

  const drawButton = document.querySelector("#drawButton");
  const box = document.querySelector("#omikujiBox");
  const stick = document.querySelector("#fortuneStick");
  const fortuneWord = document.querySelector("#fortuneWord");
  const fortuneSub = document.querySelector("#fortuneSub");
  const statusText = document.querySelector("#statusText");
  const resultPanel = document.querySelector("#resultPanel");
  const resultRank = document.querySelector("#resultRank");
  const resultMessage = document.querySelector("#resultMessage");

  if (!drawButton || !box || !stick || !fortuneWord || !fortuneSub || !statusText || !resultPanel || !resultRank || !resultMessage) {
    return;
  }

  let audioContext = null;
  let isDrawing = false;

  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function pickFortune() {
    const total = fortunes.reduce((sum, fortune) => sum + fortune.weight, 0);
    let cursor = Math.random() * total;

    for (const fortune of fortunes) {
      cursor -= fortune.weight;
      if (cursor < 0) return fortune;
    }

    return fortunes[fortunes.length - 1];
  }

  function getAudioContext() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;

    if (!audioContext) {
      audioContext = new AudioCtor();
    }

    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }

    return audioContext;
  }

  function playTone({ start, frequency, duration, type = "sine", gain = 0.08 }) {
    const context = getAudioContext();
    if (!context) return;

    const oscillator = context.createOscillator();
    const volume = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    volume.gain.setValueAtTime(0.0001, start);
    volume.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(volume);
    volume.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  function playRattle() {
    const context = getAudioContext();
    if (!context) return;

    const now = context.currentTime;
    const notes = [520, 690, 470, 760, 560, 720, 500, 650];
    notes.forEach((frequency, index) => {
      playTone({
        start: now + index * 0.16,
        frequency,
        duration: 0.075,
        type: "triangle",
        gain: 0.07,
      });
    });
  }

  function playReveal() {
    const context = getAudioContext();
    if (!context) return;

    const now = context.currentTime;
    playTone({ start: now, frequency: 160, duration: 0.18, type: "sawtooth", gain: 0.11 });
    playTone({ start: now + 0.12, frequency: 110, duration: 0.28, type: "triangle", gain: 0.12 });
    playTone({ start: now + 0.18, frequency: 330, duration: 0.2, type: "sine", gain: 0.06 });
  }

  function resetVisuals() {
    box.classList.remove("is-shaking");
    stick.className = "fortune-stick";
    resultPanel.className = "result-panel";
    resultPanel.hidden = true;
  }

  async function draw() {
    if (isDrawing) return;

    isDrawing = true;
    drawButton.disabled = true;
    drawButton.textContent = "振っています";
    resetVisuals();

    const fortune = pickFortune();
    fortuneWord.textContent = fortune.rank;
    fortuneSub.textContent = fortune.sub;
    stick.classList.add(fortune.className);

    statusText.textContent = "カラン、カラン。木札が箱の中で踊っています。";
    playRattle();
    box.classList.add("is-shaking");

    await wait(1900);
    statusText.textContent = "箱の口から、木札がすっと出てきました。";
    stick.classList.add("is-out");

    await wait(950);
    playReveal();
    resultRank.textContent = fortune.rank;
    resultMessage.textContent = fortune.message;
    resultPanel.hidden = false;
    resultPanel.classList.add("is-showing", fortune.className);
    statusText.textContent = "今日の運勢が出ました。";
    drawButton.disabled = false;
    drawButton.textContent = "もう一度引く";
    isDrawing = false;
  }

  drawButton.addEventListener("click", draw);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
        // The app works normally even when offline caching is unavailable.
      });
    });
  }
})();
