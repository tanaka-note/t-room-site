(() => {
  const choiceA = document.querySelector("#choiceA");
  const choiceB = document.querySelector("#choiceB");
  const seesaw = document.querySelector("#seesaw");
  const statusText = document.querySelector("#statusText");
  const judgeButton = document.querySelector("#judgeButton");
  const resetButton = document.querySelector("#resetButton");
  const resultPanel = document.querySelector("#resultPanel");
  const resultLead = document.querySelector("#resultLead");
  const resultText = document.querySelector("#resultText");

  if (!choiceA || !choiceB || !seesaw || !statusText || !judgeButton || !resetButton || !resultPanel || !resultLead || !resultText) {
    return;
  }

  let judging = false;

  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function getChoices() {
    return {
      a: choiceA.value.trim(),
      b: choiceB.value.trim(),
    };
  }

  function updateInputState() {
    const choices = getChoices();
    const ready = choices.a.length > 0 && choices.b.length > 0;
    judgeButton.disabled = !ready || judging;
  }

  function clearResult() {
    seesaw.classList.remove("is-weighing", "result-a", "result-b");
    resultPanel.classList.remove("is-visible");
    resultPanel.hidden = true;
    resultLead.textContent = "";
    resultText.textContent = "";
  }

  async function judge() {
    const choices = getChoices();
    if (judging || !choices.a || !choices.b) return;

    judging = true;
    updateInputState();
    clearResult();

    const winner = Math.random() < 0.5 ? "a" : "b";
    const winnerLabel = winner === "a" ? "A" : "B";
    const winnerText = winner === "a" ? choices.a : choices.b;

    statusText.textContent = "心の天秤が、ゆらゆら迷っています。";
    seesaw.classList.add("is-weighing");

    await wait(2700);
    seesaw.classList.remove("is-weighing");
    seesaw.classList.add(winner === "a" ? "result-a" : "result-b");
    statusText.textContent = `${winnerLabel}側へ、そっと傾きました。`;

    await wait(560);
    resultLead.textContent = `今回は${winnerLabel}！`;
    resultText.textContent = `心の天秤は ${winnerLabel}：${winnerText} に傾きました`;
    resultPanel.hidden = false;
    resultPanel.classList.add("is-visible");

    judging = false;
    updateInputState();
  }

  function reset() {
    judging = false;
    choiceA.value = "";
    choiceB.value = "";
    clearResult();
    statusText.textContent = "AとBを入力すると、天秤にかけられます。";
    updateInputState();
    choiceA.focus();
  }

  choiceA.addEventListener("input", () => {
    if (!judging) clearResult();
    updateInputState();
  });

  choiceB.addEventListener("input", () => {
    if (!judging) clearResult();
    updateInputState();
  });

  judgeButton.addEventListener("click", judge);
  resetButton.addEventListener("click", reset);
  updateInputState();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
        // The app works normally even when offline caching is unavailable.
      });
    });
  }
})();
