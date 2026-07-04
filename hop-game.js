(() => {
  const canvas = document.querySelector("#defenderGame");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const startButton = document.querySelector("#gameStartButton");
  const message = document.querySelector("#gameMessage");
  const messageButton = document.querySelector("#gameMessageButton");
  const scoreText = document.querySelector("#gameScore");
  const bestText = document.querySelector("#gameBest");
  const livesText = document.querySelector("#gameLives");
  const comboText = document.querySelector("#gameLevel");
  const jumpButton = document.querySelector("[data-control='jump']");

  const world = { width: 960, height: 540 };
  const groundY = 422;
  const gravity = 1780;
  const jumpPower = -650;
  const secondJumpPower = -585;
  const maxJumps = 2;
  const storageKey = "tRoomGardenHopBest";
  const introSafeTime = 10;
  const invincibleTime = 1.5;
  const desktopInputQuery = window.matchMedia("(hover: hover) and (pointer: fine)");

  const colors = {
    ink: "#2f3b35",
    leaf: "#74b889",
    leafDark: "#3e8f65",
    blush: "#f3a5a2",
    cream: "#fff8e7",
    gold: "#f5bf4f",
    teal: "#7bc5bf",
    soil: "#d8c6a6",
    obstacle: "#b9d7c1",
    obstacleDark: "#86ae94"
  };

  let state = "idle";
  let lastTime = 0;
  let elapsed = 0;
  let score = 0;
  let scoreBank = 0;
  let bestScore = readBestScore();
  let lives = 3;
  let combo = 1;
  let speedLevel = 0;
  let obstacleTimer = 1.4;
  let pickupTimer = 1.15;
  let runner = createRunner();
  let obstacles = [];
  let pickups = [];
  let clouds = createClouds();
  let gardenBits = createGardenBits();
  let popups = [];
  let sparkles = [];
  let screenShake = 0;

  bestText.textContent = bestScore;
  updateHud();
  draw();

  function readBestScore() {
    try {
      return Number(localStorage.getItem(storageKey)) || 0;
    } catch {
      return 0;
    }
  }

  function saveBestScore(value) {
    try {
      localStorage.setItem(storageKey, String(value));
    } catch {
      // The game can still be played when storage is unavailable.
    }
  }

  function createRunner() {
    return {
      x: 152,
      y: groundY,
      width: 52,
      height: 64,
      vy: 0,
      grounded: true,
      jumpCount: 0,
      invincible: 0,
      blink: 0,
      squash: 0,
      damage: 0,
      landing: 0,
      face: "smile"
    };
  }

  function createClouds() {
    return [
      { x: 96, y: 78, speed: 16, scale: 0.95 },
      { x: 398, y: 118, speed: 10, scale: 0.72 },
      { x: 734, y: 82, speed: 13, scale: 0.86 }
    ];
  }

  function createGardenBits() {
    return Array.from({ length: 18 }, (_, index) => ({
      x: index * 64 + random(0, 30),
      y: groundY + random(18, 58),
      size: random(5, 12),
      speed: random(18, 35),
      tilt: random(-0.5, 0.5)
    }));
  }

  function startGame() {
    state = "running";
    lastTime = 0;
    elapsed = 0;
    score = 0;
    scoreBank = 0;
    lives = 3;
    combo = 1;
    speedLevel = 0;
    obstacleTimer = 1.65;
    pickupTimer = 0.85;
    runner = createRunner();
    obstacles = [];
    pickups = [];
    clouds = createClouds();
    gardenBits = createGardenBits();
    popups = [];
    sparkles = [];
    screenShake = 0;
    hideMessage();
    startButton.textContent = "RETRY";
    updateHud();
    requestAnimationFrame(loop);
  }

  function loop(timestamp) {
    if (state !== "running") return;

    const delta = lastTime ? Math.min((timestamp - lastTime) / 1000, 0.033) : 0;
    lastTime = timestamp;
    update(delta);
    draw();
    requestAnimationFrame(loop);
  }

  function update(delta) {
    elapsed += delta;
    speedLevel = Math.floor(Math.max(0, score - 250) / 450);

    const speed = currentSpeed();
    scoreBank += speed * delta * 0.07;
    score = Math.floor(scoreBank);

    updateRunner(delta);
    updateObstacles(delta, speed);
    updatePickups(delta, speed);
    updateBackground(delta);
    updateEffects(delta);
    updateHud();
  }

  function currentSpeed() {
    const ease = Math.min(elapsed / introSafeTime, 1);
    const base = 195 + ease * 52;
    return Math.min(base + speedLevel * 13, 390);
  }

  function updateRunner(delta) {
    const wasGrounded = runner.grounded;

    runner.vy += gravity * delta;
    runner.y += runner.vy * delta;
    runner.invincible = Math.max(0, runner.invincible - delta);
    runner.blink += delta * 12;
    runner.squash = Math.max(0, runner.squash - delta * 5.5);
    runner.damage = Math.max(0, runner.damage - delta * 4.5);
    runner.landing = Math.max(0, runner.landing - delta * 4);

    if (runner.y >= groundY) {
      runner.y = groundY;
      runner.vy = 0;
      runner.grounded = true;
      if (!wasGrounded) {
        runner.squash = 1;
        runner.landing = 1;
        runner.jumpCount = 0;
        addSparkles(runner.x, groundY - 6, "#b9d7c1", 8);
      }
    } else {
      runner.grounded = false;
    }
  }

  function updateObstacles(delta, speed) {
    obstacleTimer -= delta;

    if (obstacleTimer <= 0) {
      spawnObstacle();
      obstacleTimer = nextObstacleDelay();
    }

    obstacles.forEach((obstacle) => {
      obstacle.x -= speed * delta;
      obstacle.wobble += delta * 4;

      if (!obstacle.passed && obstacle.x + obstacle.width < runner.x - runner.width / 2) {
        obstacle.passed = true;
        addPoints(18 + speedLevel * 2, obstacle.x + obstacle.width, obstacle.y - obstacle.height - 12, "#3e8f65");
      }

      if (!obstacle.hit && runner.invincible <= 0 && intersects(runnerBox(), obstacleBox(obstacle))) {
        obstacle.hit = true;
        takeDamage();
      }
    });

    obstacles = obstacles.filter((obstacle) => obstacle.x + obstacle.width > -80);
  }

  function updatePickups(delta, speed) {
    pickupTimer -= delta;

    if (pickupTimer <= 0) {
      spawnPickup();
      pickupTimer = random(0.85, 1.45);
    }

    pickups.forEach((pickup) => {
      pickup.x -= speed * delta;
      pickup.spin += delta * 3.2;
      pickup.float += delta * 4;

      if (!pickup.collected && intersects(runnerBox(), pickupBox(pickup))) {
        pickup.collected = true;
        const earned = pickup.value * combo;
        addPoints(earned, pickup.x, pickup.y - 20, pickup.kind === "drop" ? "#5f8fd8" : "#c27803");
        combo = Math.min(9, combo + 1);
        addSparkles(pickup.x, pickup.y, pickup.kind === "drop" ? "#9ed7ff" : "#f5bf4f", 18);
      }
    });

    pickups = pickups.filter((pickup) => pickup.x > -60 && !pickup.collected);
  }

  function updateBackground(delta) {
    clouds.forEach((cloud) => {
      cloud.x -= cloud.speed * delta;
      if (cloud.x < -140) cloud.x = world.width + 120;
    });

    gardenBits.forEach((bit) => {
      bit.x -= bit.speed * delta;
      if (bit.x < -30) {
        bit.x = world.width + random(20, 90);
        bit.y = groundY + random(18, 58);
        bit.size = random(5, 12);
      }
    });
  }

  function updateEffects(delta) {
    screenShake = Math.max(0, screenShake - delta * 5);

    popups.forEach((popup) => {
      popup.y -= 36 * delta;
      popup.life -= delta;
    });
    popups = popups.filter((popup) => popup.life > 0);

    sparkles.forEach((sparkle) => {
      sparkle.x += sparkle.vx * delta;
      sparkle.y += sparkle.vy * delta;
      sparkle.vy += 360 * delta;
      sparkle.life -= delta;
      sparkle.spin += delta * 5;
    });
    sparkles = sparkles.filter((sparkle) => sparkle.life > 0);
  }

  function spawnObstacle() {
    const type = elapsed < introSafeTime
      ? "mound"
      : pick(["mound", "mound", "sprout", "step", "notebook"]);

    const obstacle = {
      type,
      x: world.width + 56,
      y: groundY,
      width: 38,
      height: 42,
      passed: false,
      hit: false,
      wobble: random(0, Math.PI)
    };

    if (type === "sprout") {
      obstacle.width = 34;
      obstacle.height = 56;
    } else if (type === "step") {
      obstacle.width = 64;
      obstacle.height = 30;
    } else if (type === "notebook") {
      obstacle.width = 48;
      obstacle.height = 44;
    }

    obstacles.push(obstacle);
  }

  function nextObstacleDelay() {
    const ease = Math.min(elapsed / introSafeTime, 1);
    const minDelay = Math.max(0.95, 1.75 - speedLevel * 0.05);
    const maxDelay = Math.max(1.35, 2.35 - speedLevel * 0.07);
    const introBonus = elapsed < introSafeTime ? 0.55 : 0;
    return random(minDelay + introBonus, maxDelay + introBonus * (1 - ease * 0.4));
  }

  function spawnPickup() {
    const kind = Math.random() > 0.62 ? "drop" : "sprout";
    const y = random(groundY - 190, groundY - 98);

    pickups.push({
      kind,
      x: world.width + random(30, 130),
      y,
      size: kind === "drop" ? 20 : 24,
      value: kind === "drop" ? 38 : 28,
      spin: random(0, Math.PI * 2),
      float: random(0, Math.PI * 2),
      collected: false
    });
  }

  function jump() {
    if (state !== "running") {
      startGame();
      return;
    }

    if (runner.jumpCount >= maxJumps) return;

    const isSecondJump = !runner.grounded && runner.jumpCount === 1;
    runner.vy = isSecondJump ? secondJumpPower : jumpPower;
    runner.grounded = false;
    runner.jumpCount += 1;
    runner.squash = isSecondJump ? 0.55 : 0.72;
    runner.face = "focus";
    addSparkles(runner.x - 8, runner.y - 8, isSecondJump ? "#b8d8c4" : "#d9c886", isSecondJump ? 3 : 2);
  }

  function takeDamage() {
    lives -= 1;
    combo = 1;
    runner.invincible = invincibleTime;
    runner.damage = 1;
    runner.face = "ouch";
    screenShake = 1;
    addPopup("MISS", runner.x + 36, runner.y - 82, "#b7475a");
    addSparkles(runner.x, runner.y - runner.height / 2, "#f3a5a2", 24);

    if (lives <= 0) {
      endGame();
    }
  }

  function addPoints(value, x, y, color) {
    scoreBank += value;
    score = Math.floor(scoreBank);
    popups.push({ text: `+${value}`, x, y, color, life: 0.85 });
  }

  function addPopup(text, x, y, color) {
    popups.push({ text, x, y, color, life: 0.9 });
  }

  function addSparkles(x, y, color, count) {
    for (let i = 0; i < count; i += 1) {
      sparkles.push({
        x: x + random(-12, 12),
        y: y + random(-10, 10),
        vx: random(-95, 95),
        vy: random(-220, -70),
        size: random(3, 7),
        color,
        life: random(0.35, 0.75),
        maxLife: 0.75,
        spin: random(0, Math.PI * 2)
      });
    }
  }

  function endGame() {
    state = "gameover";

    if (score > bestScore) {
      bestScore = score;
      saveBestScore(bestScore);
    }

    updateHud();
    draw();
    showMessage(
      "Game Over",
      `Score ${score} / Best ${bestScore}。もう一度、知の庭を進もう。`,
      "もう一度遊ぶ"
    );
    startButton.textContent = "PLAY AGAIN";
  }

  function pauseGame() {
    if (state !== "running" || !isDesktopInput()) return;
    state = "paused";
    showMessage("PAUSE", "Enterで続ける。Escでもう一度タイトルへ戻ります。", "Enterで再開");
  }

  function resumeGame() {
    if (state !== "paused") return;
    state = "running";
    lastTime = 0;
    hideMessage();
    requestAnimationFrame(loop);
  }

  function showTitle() {
    state = "idle";
    lastTime = 0;
    startButton.textContent = "PLAY";
    showMessage(
      "T-ROOM Garden Hop",
      "クリック・タップ・Spaceで2回までジャンプ。知の芽と星のしずくを集めよう。",
      "PLAY"
    );
    draw();
  }

  function updateHud() {
    scoreText.textContent = score;
    bestText.textContent = bestScore;
    livesText.textContent = "♥".repeat(Math.max(lives, 0)) || "0";
    comboText.textContent = `x${combo}`;
  }

  function hideMessage() {
    message.classList.add("hidden");
  }

  function showMessage(title, copy, buttonText = "PLAY") {
    message.querySelector("strong").textContent = title;
    message.querySelector("span").textContent = copy;
    messageButton.textContent = buttonText;
    message.classList.remove("hidden");
  }

  function runnerBox() {
    const shrinkX = 12;
    const shrinkTop = 12;
    const shrinkBottom = 7;
    return {
      x: runner.x - runner.width / 2 + shrinkX,
      y: runner.y - runner.height + shrinkTop,
      width: runner.width - shrinkX * 2,
      height: runner.height - shrinkTop - shrinkBottom
    };
  }

  function obstacleBox(obstacle) {
    const shrink = 7;
    return {
      x: obstacle.x + shrink,
      y: obstacle.y - obstacle.height + shrink,
      width: Math.max(10, obstacle.width - shrink * 2),
      height: Math.max(10, obstacle.height - shrink * 1.5)
    };
  }

  function pickupBox(pickup) {
    return {
      x: pickup.x - pickup.size * 0.48,
      y: pickup.y - pickup.size * 0.48,
      width: pickup.size * 0.96,
      height: pickup.size * 0.96
    };
  }

  function intersects(a, b) {
    return a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y;
  }

  function draw() {
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (screenShake > 0) {
      ctx.translate(random(-4, 4) * screenShake, random(-3, 3) * screenShake);
    }

    drawSky();
    drawGarden();
    drawPickups();
    drawObstacles();
    drawRunner();
    drawEffects();
    drawGuideText();

    ctx.restore();
  }

  function drawSky() {
    const sky = ctx.createLinearGradient(0, 0, 0, groundY);
    sky.addColorStop(0, "#ecfbff");
    sky.addColorStop(0.62, "#f8fbf1");
    sky.addColorStop(1, "#fff8e7");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, world.width, world.height);

    ctx.fillStyle = "rgba(255, 244, 199, 0.92)";
    drawCircle(838, 76, 30);
    ctx.fill();

    clouds.forEach(drawCloud);

    ctx.fillStyle = "rgba(142, 194, 154, 0.22)";
    drawHill(-70, groundY + 18, 320, 96);
    drawHill(160, groundY + 24, 440, 104);
    drawHill(560, groundY + 30, 380, 90);
  }

  function drawCloud(cloud) {
    ctx.save();
    ctx.translate(cloud.x, cloud.y);
    ctx.scale(cloud.scale, cloud.scale);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    fillCircle(0, 12, 24);
    fillCircle(26, 0, 30);
    fillCircle(58, 14, 22);
    ctx.fillRect(-4, 13, 72, 22);
    ctx.restore();
  }

  function drawGarden() {
    const ground = ctx.createLinearGradient(0, groundY, 0, world.height);
    ground.addColorStop(0, "#c9e1c8");
    ground.addColorStop(1, "#b8d5b5");
    ctx.fillStyle = ground;
    ctx.fillRect(0, groundY, world.width, world.height - groundY);

    ctx.fillStyle = "rgba(77, 117, 85, 0.18)";
    ctx.fillRect(0, groundY, world.width, 4);

    ctx.fillStyle = colors.soil;
    ctx.fillRect(0, groundY + 52, world.width, world.height - groundY - 52);

    ctx.strokeStyle = "rgba(86, 123, 95, 0.2)";
    ctx.lineWidth = 2;
    for (let x = -20; x < world.width + 30; x += 44) {
      ctx.beginPath();
      ctx.moveTo(x, groundY + 52);
      ctx.quadraticCurveTo(x + 20, groundY + 42, x + 42, groundY + 52);
      ctx.stroke();
    }

    gardenBits.forEach((bit) => {
      ctx.save();
      ctx.translate(bit.x, bit.y);
      ctx.rotate(bit.tilt);
      ctx.fillStyle = "rgba(62, 143, 101, 0.42)";
      drawLeaf(0, 0, bit.size, bit.size * 1.8);
      ctx.fill();
      ctx.restore();
    });
  }

  function drawPickups() {
    pickups.forEach((pickup) => {
      const floatY = Math.sin(pickup.float) * 5;
      ctx.save();
      ctx.translate(pickup.x, pickup.y + floatY);
      ctx.rotate(Math.sin(pickup.spin) * 0.12);

      if (pickup.kind === "drop") {
        drawStarDrop(pickup.size);
      } else {
        drawKnowledgeSprout(pickup.size);
      }

      ctx.restore();
    });
  }

  function drawKnowledgeSprout(size) {
    ctx.fillStyle = "#fff4c7";
    drawCircle(0, 2, size * 0.62);
    ctx.fill();

    ctx.fillStyle = colors.leaf;
    drawLeaf(-6, -10, size * 0.45, size * 0.75);
    ctx.fill();
    drawLeaf(6, -10, size * 0.45, size * 0.75);
    ctx.fill();

    ctx.strokeStyle = "rgba(47, 59, 53, 0.22)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 5);
    ctx.lineTo(0, -9);
    ctx.stroke();
  }

  function drawStarDrop(size) {
    ctx.fillStyle = "#d9f1ff";
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.75);
    ctx.bezierCurveTo(size * 0.5, -size * 0.25, size * 0.55, size * 0.45, 0, size * 0.75);
    ctx.bezierCurveTo(-size * 0.55, size * 0.45, -size * 0.5, -size * 0.25, 0, -size * 0.75);
    ctx.fill();

    ctx.fillStyle = colors.gold;
    drawStar(0, 2, size * 0.36, size * 0.15, 5);
    ctx.fill();
  }

  function drawObstacles() {
    obstacles.forEach((obstacle) => {
      ctx.save();
      ctx.translate(obstacle.x, obstacle.y);
      if (obstacle.type === "mound") drawMound(obstacle);
      if (obstacle.type === "sprout") drawTallSprout(obstacle);
      if (obstacle.type === "step") drawSoftStep(obstacle);
      if (obstacle.type === "notebook") drawNotebook(obstacle);
      ctx.restore();
    });
  }

  function drawMound(obstacle) {
    ctx.fillStyle = colors.obstacle;
    drawRoundedRect(0, -obstacle.height, obstacle.width, obstacle.height, 16);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.36)";
    drawCircle(obstacle.width * 0.38, -obstacle.height + 13, 6);
    ctx.fill();
  }

  function drawTallSprout(obstacle) {
    ctx.strokeStyle = colors.obstacleDark;
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(obstacle.width / 2, -4);
    ctx.quadraticCurveTo(obstacle.width * 0.42, -obstacle.height * 0.52, obstacle.width / 2, -obstacle.height);
    ctx.stroke();
    ctx.fillStyle = colors.obstacle;
    drawLeaf(obstacle.width * 0.34, -obstacle.height * 0.62, 15, 28);
    drawLeaf(obstacle.width * 0.66, -obstacle.height * 0.76, 15, 28);
    ctx.fill();
  }

  function drawSoftStep(obstacle) {
    ctx.fillStyle = "#d5e7d8";
    drawRoundedRect(0, -obstacle.height, obstacle.width, obstacle.height, 8);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillRect(8, -obstacle.height + 8, obstacle.width - 16, 5);
  }

  function drawNotebook(obstacle) {
    ctx.fillStyle = "#fff7df";
    drawRoundedRect(0, -obstacle.height, obstacle.width, obstacle.height, 8);
    ctx.fill();
    ctx.strokeStyle = "rgba(47,59,53,0.18)";
    ctx.lineWidth = 2;
    for (let y = -obstacle.height + 13; y < -8; y += 10) {
      ctx.beginPath();
      ctx.moveTo(8, y);
      ctx.lineTo(obstacle.width - 8, y);
      ctx.stroke();
    }
    ctx.fillStyle = "#9bc7b0";
    ctx.fillRect(6, -obstacle.height, 6, obstacle.height);
  }

  function drawRunner() {
    const shouldBlink = runner.invincible > 0 && Math.floor(runner.blink) % 2 === 0;
    if (shouldBlink) ctx.globalAlpha = 0.55;

    const jumpLean = runner.grounded ? 0 : -0.08;
    const squashX = 1 + runner.squash * 0.1;
    const squashY = 1 - runner.squash * 0.08;
    const damageLean = runner.damage ? Math.sin(runner.damage * 18) * 0.08 : 0;

    ctx.save();
    ctx.translate(runner.x, runner.y);
    ctx.rotate(jumpLean + damageLean);
    ctx.scale(squashX, squashY);

    ctx.fillStyle = "#fbf7e9";
    drawCircle(0, -34, 30);
    ctx.fill();

    ctx.fillStyle = colors.leaf;
    drawLeaf(-14, -64, 14, 28);
    ctx.fill();
    drawLeaf(8, -67, 15, 30);
    ctx.fill();

    ctx.strokeStyle = colors.leafDark;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-2, -58);
    ctx.quadraticCurveTo(0, -72, 10, -80);
    ctx.stroke();

    drawRunnerFace();

    ctx.fillStyle = "rgba(62,143,101,0.3)";
    drawCircle(-13, -10, 8);
    ctx.fill();
    drawCircle(14, -10, 8);
    ctx.fill();

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawRunnerFace() {
    ctx.fillStyle = colors.ink;

    if (runner.damage > 0) {
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(-13, -40);
      ctx.lineTo(-6, -33);
      ctx.moveTo(-6, -40);
      ctx.lineTo(-13, -33);
      ctx.moveTo(6, -40);
      ctx.lineTo(13, -33);
      ctx.moveTo(13, -40);
      ctx.lineTo(6, -33);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -22, 5, 0.1, Math.PI - 0.1);
      ctx.stroke();
      return;
    }

    if (!runner.grounded) {
      drawCircle(-10, -37, 3.4);
      ctx.fill();
      drawCircle(10, -37, 3.4);
      ctx.fill();
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, -27, 6, 0.1, Math.PI - 0.1);
      ctx.stroke();
    } else {
      drawCircle(-10, -37, 3.2);
      ctx.fill();
      drawCircle(10, -37, 3.2);
      ctx.fill();
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, -30, 9, 0.15, Math.PI - 0.15);
      ctx.stroke();
    }

    ctx.fillStyle = colors.blush;
    drawCircle(-18, -29, 4);
    ctx.fill();
    drawCircle(18, -29, 4);
    ctx.fill();
  }

  function drawEffects() {
    sparkles.forEach((sparkle) => {
      ctx.save();
      ctx.globalAlpha = Math.max(sparkle.life / sparkle.maxLife, 0);
      ctx.translate(sparkle.x, sparkle.y);
      ctx.rotate(sparkle.spin);
      ctx.fillStyle = sparkle.color;
      drawStar(0, 0, sparkle.size, sparkle.size * 0.42, 5);
      ctx.fill();
      ctx.restore();
    });

    popups.forEach((popup) => {
      ctx.save();
      ctx.globalAlpha = Math.min(popup.life, 1);
      ctx.fillStyle = popup.color;
      ctx.font = "800 20px 'Noto Sans JP', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(popup.text, popup.x, popup.y);
      ctx.restore();
    });
  }

  function drawGuideText() {
    if (state === "running") return;

    ctx.save();
    ctx.fillStyle = "rgba(47,59,53,0.72)";
    ctx.font = "700 18px 'Noto Sans JP', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("クリック / タップ / Spaceでジャンプ", world.width / 2, 74);
    ctx.restore();
  }

  function drawCircle(x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
  }

  function fillCircle(x, y, radius) {
    drawCircle(x, y, radius);
    ctx.fill();
  }

  function drawRoundedRect(x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawLeaf(x, y, width, height) {
    ctx.beginPath();
    ctx.ellipse(x, y, width, height, -0.58, 0, Math.PI * 2);
  }

  function drawHill(x, y, width, height) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + width * 0.5, y - height, x + width, y);
    ctx.lineTo(x + width, world.height);
    ctx.lineTo(x, world.height);
    ctx.closePath();
    ctx.fill();
  }

  function drawStar(x, y, outer, inner, points) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i += 1) {
      const radius = i % 2 === 0 ? outer : inner;
      const angle = -Math.PI / 2 + (Math.PI * i) / points;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function random(min, max) {
    return min + Math.random() * (max - min);
  }

  function pick(items) {
    return items[Math.floor(Math.random() * items.length)];
  }

  function isDesktopInput() {
    return desktopInputQuery.matches;
  }

  function handleMessageAction() {
    if (state === "paused") {
      resumeGame();
      return;
    }
    startGame();
  }

  startButton?.addEventListener("click", startGame);
  messageButton?.addEventListener("click", handleMessageAction);
  jumpButton?.addEventListener("click", jump);

  canvas.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) return;
    event.preventDefault();
    jump();
  });

  window.addEventListener("keydown", (event) => {
    if (isDesktopInput() && event.code === "Escape") {
      event.preventDefault();
      if (state === "running") pauseGame();
      else if (state === "paused") showTitle();
      return;
    }
    if (state === "paused") {
      if (isDesktopInput() && event.code === "Enter") {
        event.preventDefault();
        resumeGame();
      }
      return;
    }
    if (event.code !== "Space") return;
    event.preventDefault();
    jump();
  });

  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    window.tRoomGardenHopDebug = {
      start: startGame,
      jump,
      getState: () => ({
        state,
        score,
        bestScore,
        lives,
        combo,
        elapsed,
        speed: currentSpeed(),
        obstacleCount: obstacles.length,
        pickupCount: pickups.length,
        jumpCount: runner.jumpCount,
        invincible: runner.invincible
      }),
      forceDamage: takeDamage,
      forceEnd: endGame,
      setScoreForTest: (value) => {
        scoreBank = value;
        score = value;
        updateHud();
      }
    };
  }
})();
