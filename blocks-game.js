(() => {
  const canvas = document.querySelector("#blocksGame");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const message = document.querySelector("#blockMessage");
  const scoreText = document.querySelector("#blockScore");
  const bestText = document.querySelector("#blockBest");
  const linesText = document.querySelector("#blockLines");
  const levelText = document.querySelector("#blockLevel");
  const soundOffButton = document.querySelector("#blockSoundOff");
  const soundOnButton = document.querySelector("#blockSoundOn");

  const cols = 10;
  const rows = 22;
  const size = 30;
  const colors = {
    I: "#8ecbd2",
    O: "#f3d78b",
    T: "#c9b7e8",
    S: "#a9d9bd",
    Z: "#e8a6a8",
    J: "#9fb8d9",
    L: "#efc49d",
    Seed: "#f7edc8"
  };
  const shapes = {
    I: [[1, 1, 1, 1]],
    O: [[1, 1], [1, 1]],
    T: [[0, 1, 0], [1, 1, 1]],
    S: [[0, 1, 1], [1, 1, 0]],
    Z: [[1, 1, 0], [0, 1, 1]],
    J: [[1, 0, 0], [1, 1, 1]],
    L: [[0, 0, 1], [1, 1, 1]],
    Seed: [[1]]
  };
  const mainPieceNames = ["I", "O", "T", "S", "Z", "J", "L"];
  const rarePieceName = "Seed";
  const gentlePiecePool = ["I", "I", "I", "I", "O", "O", "O", "O", "T", "T", "T", "L", "L", "J", "J", "S", "Z"];
  const steadyPiecePool = ["I", "I", "I", "O", "O", "O", "T", "T", "T", "L", "L", "J", "J", "S", "S", "Z", "Z"];
  const hardPiecePool = ["I", "O", "T", "S", "Z", "J", "L"];
  const gentleScoreLimit = 1000;
  const fullRandomScore = 2600;

  let board = createBoard();
  let current = null;
  let score = 0;
  let pieceHistory = [];
  let lines = 0;
  let level = 1;
  let next = randomPiece();
  let state = "idle";
  let best = readBest();
  let dropCounter = 0;
  let lastTime = 0;
  let clearing = null;
  let particles = [];
  let bursts = [];
  let touchInput = null;
  let soundEnabled = false;
  let audioContext = null;

  bestText.textContent = best;
  updateHud();
  updateSoundButtons();
  setPlayingMode(false);
  draw();

  function readBest() {
    try {
      return Number(localStorage.getItem("tRoomBlocksBest")) || 0;
    } catch {
      return 0;
    }
  }

  function saveBest(value) {
    try {
      localStorage.setItem("tRoomBlocksBest", String(value));
    } catch {
      // Best score is optional.
    }
  }

  function createBoard() {
    return Array.from({ length: rows }, () => Array(cols).fill(null));
  }

  function randomPiece() {
    const name = randomPieceName();

    return {
      name,
      matrix: shapes[name].map((row) => row.slice()),
      color: colors[name],
      row: 0,
      col: 0
    };
  }

  function randomPieceName() {
    if (shouldUseRarePiece()) {
      return rememberPiece(rarePieceName);
    }

    return rememberPiece(guidedPieceName());
  }

  function guidedPieceName() {
    const pool = piecePoolForDifficulty();
    let candidate = pick(pool);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (isAllowedPiece(candidate)) return candidate;
      candidate = pick(pool);
    }

    return candidate;
  }

  function piecePoolForDifficulty() {
    const difficulty = difficultyScore();

    if (difficulty < gentleScoreLimit) return gentlePiecePool;
    if (difficulty < fullRandomScore) return steadyPiecePool;
    return hardPiecePool;
  }

  function isAllowedPiece(name) {
    const lastTwo = pieceHistory.slice(-2);
    const wouldTriple = lastTwo.length === 2 && lastTwo.every((pieceName) => pieceName === name);
    if (wouldTriple) return false;

    const recentSameCount = pieceHistory.slice(-5).filter((pieceName) => pieceName === name).length;
    return recentSameCount < 3;
  }

  function shouldUseRarePiece() {
    if (pieceHistory.slice(-4).includes(rarePieceName)) return false;

    const difficulty = difficultyScore();
    const chance = difficulty < gentleScoreLimit
      ? 0.018
      : difficulty < fullRandomScore
        ? 0.035
        : 0.06;
    return Math.random() < chance;
  }

  function difficultyScore() {
    return Math.max(score, lines * 180);
  }

  function rememberPiece(name) {
    pieceHistory.push(name);
    if (pieceHistory.length > 6) pieceHistory.shift();
    return name;
  }

  function startGame() {
    board = createBoard();
    current = null;
    pieceHistory = [];
    state = "running";
    setPlayingMode(true);
    score = 0;
    lines = 0;
    level = 1;
    next = randomPiece();
    dropCounter = 0;
    lastTime = 0;
    clearing = null;
    particles = [];
    bursts = [];
    touchInput = null;
    spawnPiece();
    updateHud();
    hideMessage();
    requestAnimationFrame(loop);
  }

  function loop(time = 0) {
    if (state !== "running") return;

    const delta = lastTime ? time - lastTime : 0;
    lastTime = time;
    updateEffects(delta);

    if (clearing) {
      clearing.timer += delta;
      if (clearing.timer >= clearing.duration) {
        finishLineClear();
      }
      draw();
      requestAnimationFrame(loop);
      return;
    }

    dropCounter += delta;

    if (dropCounter > dropInterval()) {
      softDrop();
      dropCounter = 0;
    }

    draw();
    requestAnimationFrame(loop);
  }

  function dropInterval() {
    return Math.max(90, 660 - (level - 1) * 52);
  }

  function spawnPiece() {
    current = next;
    current.row = 0;
    current.col = Math.floor((cols - current.matrix[0].length) / 2);
    next = randomPiece();

    if (collides(current.matrix, current.row, current.col)) {
      gameOver();
    }
  }

  function move(dir) {
    if (state !== "running") {
      return;
    }

    if (!collides(current.matrix, current.row, current.col + dir)) {
      current.col += dir;
      draw();
    }
  }

  function rotate() {
    if (state !== "running") {
      return;
    }

    const rotated = rotateMatrix(current.matrix);
    for (const offset of [0, -1, 1, -2, 2]) {
      if (!collides(rotated, current.row, current.col + offset)) {
        current.matrix = rotated;
        current.col += offset;
        draw();
        return;
      }
    }
  }

  function softDrop() {
    if (!current || state !== "running") return;

    if (!collides(current.matrix, current.row + 1, current.col)) {
      current.row += 1;
      score += 1;
      updateHud();
      return;
    }

    lockPiece();
  }

  function hardDrop() {
    if (state !== "running") {
      return;
    }

    let dropped = 0;
    while (!collides(current.matrix, current.row + 1, current.col)) {
      current.row += 1;
      dropped += 1;
    }
    score += dropped * 2;
    lockPiece();
  }

  function lockPiece() {
    current.matrix.forEach((row, y) => {
      row.forEach((value, x) => {
        if (!value) return;
        const boardY = current.row + y;
        const boardX = current.col + x;
        if (board[boardY]) board[boardY][boardX] = current.color;
      });
    });

    const rowsToClear = findFullRows();
    if (rowsToClear.length > 0) {
      beginLineClear(rowsToClear);
    } else {
      spawnPiece();
    }
    updateHud();
  }

  function findFullRows() {
    const fullRows = [];
    for (let y = 0; y < rows; y += 1) {
      if (board[y].every(Boolean)) fullRows.push(y);
    }
    return fullRows;
  }

  function beginLineClear(fullRows) {
    const cells = fullRows.map((row) => ({
      row,
      colors: board[row].slice()
    }));

    clearing = {
      rows: fullRows,
      cells,
      timer: 0,
      duration: 460
    };
    current = null;

    cells.forEach((line) => {
      board[line.row] = Array(cols).fill(null);
      spawnLineParticles(line);
      bursts.push({
        x: canvas.width / 2,
        y: line.row * size + size / 2,
        radius: 10,
        life: 360,
        maxLife: 360
      });
    });
    playLineClearSound(fullRows.length);
  }

  function finishLineClear() {
    const clearedRows = clearing.rows.slice().sort((a, b) => a - b);
    const cleared = clearedRows.length;
    board = board.filter((_, index) => !clearedRows.includes(index));
    while (board.length < rows) board.unshift(Array(cols).fill(null));
    clearing = null;

    if (!cleared) {
      spawnPiece();
      return;
    }

    const table = [0, 100, 300, 500, 800];
    score += table[cleared] * level;
    lines += cleared;
    updateHud();
    spawnPiece();
  }

  function gameOver() {
    state = "gameover";
    setPlayingMode(false);
    if (score > best) {
      best = score;
      saveBest(best);
    }
    updateHud();
    draw();
    showMessage("GAME OVER", "画面をタップして再挑戦できます。");
  }

  function collides(matrix, row, col) {
    return matrix.some((line, y) =>
      line.some((value, x) => {
        if (!value) return false;
        const boardY = row + y;
        const boardX = col + x;
        return boardX < 0 || boardX >= cols || boardY >= rows || (boardY >= 0 && board[boardY][boardX]);
      })
    );
  }

  function rotateMatrix(matrix) {
    return matrix[0].map((_, index) => matrix.map((row) => row[index]).reverse());
  }

  function updateHud() {
    level = Math.max(1 + Math.floor(lines / 8), 1 + Math.floor(score / 1000));
    scoreText.textContent = score;
    bestText.textContent = best;
    linesText.textContent = lines;
    levelText.textContent = level;
  }

  function setPlayingMode(isPlaying) {
    document.body.classList.toggle("blocks-game-playing", isPlaying);
    canvas.classList.toggle("is-playing", isPlaying);
    if (!isPlaying) touchInput = null;
  }

  function showMessage(title, copy) {
    message.innerHTML = `<strong>${title}</strong><span>${copy}</span>`;
    message.classList.remove("hidden");
  }

  function hideMessage() {
    message.classList.add("hidden");
  }

  function setSoundEnabled(enabled) {
    soundEnabled = enabled;
    if (soundEnabled) {
      resumeAudioContext(ensureAudioContext());
    }
    updateSoundButtons();
  }

  function updateSoundButtons() {
    if (!soundOffButton || !soundOnButton) return;

    soundOffButton.classList.toggle("active", !soundEnabled);
    soundOnButton.classList.toggle("active", soundEnabled);
    soundOffButton.setAttribute("aria-pressed", String(!soundEnabled));
    soundOnButton.setAttribute("aria-pressed", String(soundEnabled));
  }

  function ensureAudioContext() {
    if (audioContext) return audioContext;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    audioContext = new AudioContextClass();
    return audioContext;
  }

  function resumeAudioContext(audio) {
    const resumePromise = audio?.resume?.();
    resumePromise?.catch?.(() => {});
  }

  function playLineClearSound(lineCount) {
    if (!soundEnabled) return;

    const audio = ensureAudioContext();
    if (!audio) return;

    resumeAudioContext(audio);
    const start = audio.currentTime;
    const volume = Math.min(0.24 + lineCount * 0.04, 0.42);

    playBlockRattle(audio, start, 0.08, volume, 520, 1500);
    playBlockRattle(audio, start + 0.045, 0.12, volume * 0.72, 340, 1100);

    const extraClacks = Math.min(3 + lineCount * 2, 10);
    for (let i = 0; i < extraClacks; i += 1) {
      const offset = 0.08 + i * 0.028 + random(0, 0.014);
      playBlockRattle(audio, start + offset, random(0.035, 0.075), volume * random(0.18, 0.34), random(460, 900), random(900, 1900));
    }
  }

  function playBlockRattle(audio, start, duration, volume, lowFrequency, highFrequency) {
    const sampleRate = audio.sampleRate;
    const length = Math.max(1, Math.floor(sampleRate * duration));
    const buffer = audio.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i += 1) {
      const progress = i / length;
      const snap = progress < 0.06 ? 1 : Math.pow(1 - progress, 2.8);
      data[i] = (Math.random() * 2 - 1) * snap;
    }

    const source = audio.createBufferSource();
    const band = audio.createBiquadFilter();
    const highpass = audio.createBiquadFilter();
    const gain = audio.createGain();

    source.buffer = buffer;
    band.type = "bandpass";
    band.frequency.setValueAtTime(random(lowFrequency, highFrequency), start);
    band.Q.setValueAtTime(random(0.9, 1.8), start);
    highpass.type = "highpass";
    highpass.frequency.setValueAtTime(170, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(volume, 0.0002), start + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    source.connect(band);
    band.connect(highpass);
    highpass.connect(gain);
    gain.connect(audio.destination);
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawBoardBackground();
    drawMatrix(board, 0, 0);
    if (current) {
      drawGhost();
      drawPiece(current);
    }
    drawGrid();
    drawClearFlash();
    drawBursts();
    drawParticles();
  }

  function drawBoardBackground() {
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#f8fbf7");
    gradient.addColorStop(1, "#eef7f2");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawMatrix(matrix, offsetRow, offsetCol) {
    matrix.forEach((row, y) => {
      row.forEach((color, x) => {
        if (!color) return;
        drawBlock(offsetCol + x, offsetRow + y, color, 1);
      });
    });
  }

  function drawPiece(piece) {
    piece.matrix.forEach((row, y) => {
      row.forEach((value, x) => {
        if (!value) return;
        drawBlock(piece.col + x, piece.row + y, piece.color, 1);
      });
    });
  }

  function drawGhost() {
    let ghostRow = current.row;
    while (!collides(current.matrix, ghostRow + 1, current.col)) ghostRow += 1;
    current.matrix.forEach((row, y) => {
      row.forEach((value, x) => {
        if (!value) return;
        drawBlock(current.col + x, ghostRow + y, "rgba(104,128,118,0.18)", 0.55);
      });
    });
  }

  function drawBlock(x, y, color, alpha) {
    const pad = 2.5;
    const blockX = x * size + pad;
    const blockY = y * size + pad;
    const blockSize = size - pad * 2;

    ctx.globalAlpha = alpha;
    ctx.shadowColor = "rgba(31, 41, 51, 0.1)";
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = color;
    drawRoundedRect(blockX, blockY, blockSize, blockSize, 7);
    ctx.fill();

    ctx.shadowColor = "transparent";
    ctx.fillStyle = "rgba(255,255,255,0.38)";
    drawRoundedRect(blockX + 4, blockY + 4, blockSize - 8, 5, 3);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
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

  function drawGrid() {
    ctx.strokeStyle = "rgba(89, 115, 105, 0.14)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= cols; x += 1) {
      ctx.beginPath();
      ctx.moveTo(x * size, 0);
      ctx.lineTo(x * size, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= rows; y += 1) {
      ctx.beginPath();
      ctx.moveTo(0, y * size);
      ctx.lineTo(canvas.width, y * size);
      ctx.stroke();
    }
  }

  function drawClearFlash() {
    if (!clearing) return;

    const progress = Math.min(clearing.timer / clearing.duration, 1);
    const pulse = Math.max(0, 0.7 - progress * 0.9);
    clearing.rows.forEach((row) => {
      ctx.fillStyle = `rgba(255, 255, 255, ${pulse})`;
      ctx.fillRect(0, row * size, canvas.width, size);

      ctx.fillStyle = `rgba(245, 185, 66, ${Math.max(0, 0.82 - progress)})`;
      ctx.fillRect(0, row * size + size / 2 - 4, canvas.width, 8);
    });
  }

  function spawnLineParticles(line) {
    for (let x = 0; x < cols; x += 1) {
      const color = line.colors[x] || "#f8faf9";
      const centerX = x * size + size / 2;
      const centerY = line.row * size + size / 2;
      for (let i = 0; i < 9; i += 1) {
        const angle = random(-Math.PI * 0.96, -Math.PI * 0.04);
        const force = random(110, 360);
        particles.push({
          x: centerX + random(-4, 4),
          y: centerY + random(-4, 4),
          vx: Math.cos(angle) * force + random(-70, 70),
          vy: Math.sin(angle) * force,
          size: random(5, 12),
          color,
          life: random(520, 820),
          maxLife: 820,
          spin: random(0, Math.PI * 2)
        });
      }
      particles.push({
        x: centerX,
        y: centerY,
        vx: random(-80, 80),
        vy: random(-260, -120),
        size: random(3, 5),
        color: "#ffffff",
        life: random(240, 420),
        maxLife: 420,
        spin: random(0, Math.PI * 2)
      });
    }
  }

  function updateEffects(delta) {
    particles.forEach((particle) => {
      particle.x += particle.vx * (delta / 1000);
      particle.y += particle.vy * (delta / 1000);
      particle.vy += 620 * (delta / 1000);
      particle.spin += 0.018 * delta;
      particle.life -= delta;
    });
    particles = particles.filter((particle) => particle.life > 0);

    bursts.forEach((burst) => {
      burst.radius += 0.44 * delta;
      burst.life -= delta;
    });
    bursts = bursts.filter((burst) => burst.life > 0);
  }

  function drawBursts() {
    bursts.forEach((burst) => {
      const alpha = Math.max(burst.life / burst.maxLife, 0);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(burst.x, burst.y, burst.radius, burst.radius * 0.18, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#f5b942";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(burst.x, burst.y, burst.radius * 0.72, burst.radius * 0.13, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    });
  }

  function drawParticles() {
    particles.forEach((particle) => {
      ctx.save();
      ctx.globalAlpha = Math.max(particle.life / particle.maxLife, 0);
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.spin);
      ctx.fillStyle = particle.color;
      ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size);
      ctx.restore();
      ctx.globalAlpha = 1;
    });
  }

  function handleControl(action) {
    if (clearing) return;
    if (action === "left") move(-1);
    if (action === "right") move(1);
    if (action === "rotate") rotate();
    if (action === "down") softDrop();
    if (action === "drop") hardDrop();
  }

  soundOffButton?.addEventListener("click", () => setSoundEnabled(false));
  soundOnButton?.addEventListener("click", () => setSoundEnabled(true));

  canvas.addEventListener("click", (event) => {
    if (state === "running") return;
    event.preventDefault();
    startGame();
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) return;
    if (state !== "running") return;
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    touchInput = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false
    };
  });

  canvas.addEventListener("pointermove", (event) => {
    if (state !== "running") return;
    if (!touchInput || touchInput.id !== event.pointerId || clearing) return;
    event.preventDefault();

    const deltaX = event.clientX - touchInput.lastX;
    const deltaY = event.clientY - touchInput.lastY;
    const totalX = event.clientX - touchInput.startX;
    const totalY = event.clientY - touchInput.startY;
    const horizontalIntent = Math.abs(totalX) > Math.abs(totalY) * 1.2;
    const downwardIntent = totalY > 18 && totalY > Math.abs(totalX) * 1.15;

    if (downwardIntent && deltaY >= size) {
      const steps = Math.floor(deltaY / size);
      for (let i = 0; i < steps; i += 1) {
        handleControl("down");
      }
      touchInput.lastY += steps * size;
      touchInput.lastX = event.clientX;
      touchInput.moved = true;
      dropCounter = 0;
      return;
    }

    if (horizontalIntent && Math.abs(deltaX) >= 28) {
      handleControl(deltaX > 0 ? "right" : "left");
      touchInput.lastX = event.clientX;
      touchInput.lastY = event.clientY;
      touchInput.moved = true;
    }
  });

  canvas.addEventListener("pointerup", (event) => {
    if (state !== "running") return;
    if (!touchInput || touchInput.id !== event.pointerId) return;
    event.preventDefault();

    const totalX = event.clientX - touchInput.startX;
    const totalY = event.clientY - touchInput.startY;
    const isTap = Math.hypot(totalX, totalY) < 14 && !touchInput.moved;
    touchInput = null;
    canvas.releasePointerCapture?.(event.pointerId);

    if (isTap) handleControl("rotate");
  });

  canvas.addEventListener("pointercancel", (event) => {
    if (touchInput?.id === event.pointerId) {
      touchInput = null;
      canvas.releasePointerCapture?.(event.pointerId);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "Enter"].includes(event.code)) return;
    if (state !== "running") {
      if (event.code === "Enter") {
        event.preventDefault();
        startGame();
      }
      return;
    }
    event.preventDefault();
    if (clearing) return;

    if (event.code === "ArrowLeft") move(-1);
    if (event.code === "ArrowRight") move(1);
    if (event.code === "ArrowUp") rotate();
    if (event.code === "ArrowDown") softDrop();
    if (event.code === "Space") hardDrop();
  });

  function random(min, max) {
    return min + Math.random() * (max - min);
  }

  function pick(items) {
    return items[Math.floor(Math.random() * items.length)];
  }
})();
