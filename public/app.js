/* global io */
(() => {
  "use strict";

  const EMOJIS = [
    "😀", "😎", "🤓", "🥳", "🤠", "😺", "🐶", "🦊", "🐼", "🐨", "🐯", "🦁",
    "🐸", "🐵", "🦄", "🐙", "🦖", "🐝", "🦉", "🐧", "🐢", "🦋", "🐳", "🦈",
    "👻", "👽", "🤖", "🎃", "💀", "🧙", "🧛", "🥷", "🦸", "🧜", "🧚", "🎅",
    "🍕", "🌮", "🍩", "🍉", "🥑", "🌶️", "⚽", "🏀", "🎸", "🎮", "🚀", "🌈",
    "⭐", "🔥", "⚡", "💎", "🍀", "🌵", "🌻", "🎲", "🏆", "👑", "🎯", "🧠",
  ];
  const SHAPES = ["▲", "◆", "●", "■"];

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- local identity ----------
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  const playerId = store.get("trivia.playerId") || uuid();
  store.set("trivia.playerId", playerId);
  let profile = {
    name: store.get("trivia.name", ""),
    emoji: store.get("trivia.emoji", EMOJIS[Math.floor(Math.random() * EMOJIS.length)]),
  };

  const socket = io();
  let state = null;
  let renderedKey = "";
  let timerRaf = 0;
  let animatedLeaderboardFor = -1;
  let confettiFiredFor = null;

  // ---------- helpers ----------
  let toastTimer;
  function toast(msg, isError = false) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast"), 3200);
  }
  function emit(event, payload = {}) {
    return new Promise((resolve) => {
      socket.emit(event, payload, (res) => {
        if (!res?.ok) toast(res?.error || "Something went wrong", true);
        resolve(res || { ok: false });
      });
    });
  }
  function show(screen) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === `screen-${screen}`));
  }
  const me = () => state?.players.find((p) => p.id === playerId);
  const isHost = () => state && state.hostId === playerId;
  // Only touch the DOM when markup actually changed, so entry animations don't replay.
  function setHTML(el, html) {
    if (el._html !== html) {
      el._html = html;
      el.innerHTML = html;
    }
  }

  // ---------- home ----------
  function initHome() {
    const grid = $("emoji-grid");
    grid.innerHTML = EMOJIS.map((e) => `<button type="button" role="option" data-e="${e}">${e}</button>`).join("");
    const sync = () => {
      $("avatar-preview").textContent = profile.emoji;
      grid.querySelectorAll("button").forEach((b) => b.classList.toggle("selected", b.dataset.e === profile.emoji));
    };
    grid.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      profile.emoji = b.dataset.e;
      store.set("trivia.emoji", profile.emoji);
      sync();
    });
    $("name-input").value = profile.name;
    $("name-input").addEventListener("input", (e) => {
      profile.name = e.target.value;
      store.set("trivia.name", profile.name);
    });
    $("pin-input").addEventListener("input", (e) => (e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6)));
    $("pin-input").addEventListener("keydown", (e) => e.key === "Enter" && $("join-btn").click());
    sync();

    const needName = () => {
      if (!profile.name.trim()) {
        toast("Enter your name first", true);
        $("name-input").focus();
        return true;
      }
      return false;
    };
    $("host-btn").onclick = async () => {
      if (needName()) return;
      const res = await emit("createRoom", { playerId, name: profile.name, emoji: profile.emoji });
      if (res.ok) store.set("trivia.pin", res.pin);
    };
    $("join-btn").onclick = async () => {
      if (needName()) return;
      const pin = $("pin-input").value.trim();
      if (pin.length !== 6) return toast("Enter the 6-digit PIN", true);
      const res = await emit("joinRoom", { pin, playerId, name: profile.name, emoji: profile.emoji });
      if (res.ok) store.set("trivia.pin", res.pin);
    };

    // Allow ?pin=123456 links.
    const urlPin = new URLSearchParams(location.search).get("pin");
    if (urlPin) $("pin-input").value = urlPin.replace(/\D/g, "").slice(0, 6);
  }

  // ---------- lobby ----------
  function initLobby() {
    const sel = $("count-input");
    sel.innerHTML = [3, 5, 8, 10, 12, 15, 20, 25].map((n) => `<option value="${n}" ${n === 5 ? "selected" : ""}>${n} Qs</option>`).join("");
    $("category-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const topic = $("topic-input").value.trim();
      if (!topic) return;
      const res = await emit("addCategory", { topic, count: Number(sel.value) });
      if (res.ok) $("topic-input").value = "";
    });
    $("pack-list").addEventListener("click", (e) => {
      const b = e.target.closest(".pack-chip");
      if (!b) return;
      $("topic-input").value = b.dataset.topic;
      const size = Number(b.dataset.size);
      // Default to 10 (or the whole pack if smaller), snapped to an available option.
      const opts = [...sel.options].map((o) => Number(o.value));
      const want = Math.min(10, size);
      sel.value = String(opts.filter((n) => n <= want).pop() ?? opts[0]);
      $("topic-input").focus();
    });
    $("category-list").addEventListener("click", (e) => {
      const b = e.target.closest(".remove");
      if (b) emit("removeCategory", { id: Number(b.dataset.id) });
    });
    const time = $("time-input");
    time.addEventListener("input", () => ($("time-label").textContent = `${time.value}s`));
    time.addEventListener("change", () => emit("updateSettings", { timeLimit: Number(time.value) }));
    $("start-btn").onclick = () => emit("startGame");
    $("leave-btn").onclick = async () => {
      if (isHost() && !confirm("Leaving will end the game for everyone. Continue?")) return;
      await emit("leaveRoom");
      store.del("trivia.pin");
      state = null;
      renderedKey = "";
      document.body.classList.remove("is-host");
      show("home");
    };
    $("first-btn").onclick = () => emit("nextQuestion");
    $("next-btn").onclick = () => emit("nextQuestion");
    $("menu-btn").onclick = () => emit("backToMenu");
  }

  function categoryStatus(c) {
    if (c.status === "building") return `<span class="cat-status"><span class="spinner"></span>Building ${c.count} questions…</span>`;
    if (c.status === "error") return `<span class="cat-status error" title="${esc(c.error)}">Couldn't build — try another topic</span>`;
    if (c.source === "pack") return `<span class="cat-status ready">✓ ${c.built} hidden questions from pack</span>`;
    if (c.source === "fallback")
      return `<span class="cat-status warn" title="${esc(c.error)}">⚠ No pack by that name — ${c.built} general questions</span>`;
    return `<span class="cat-status ready">✓ ${c.built} hidden questions ready</span>`;
  }

  function renderLobby() {
    $("lobby-pin").textContent = state.pin;
    const host = isHost();
    $("host-setup").style.display = host ? "" : "none";
    $("player-wait").style.display = host ? "none" : "";

    setHTML($("category-list"), state.categories.length
      ? state.categories
          .map(
            (c) => `<li><span class="cat-name">${esc(c.topic)}</span>${categoryStatus(c)}
            <button class="remove" data-id="${c.id}" title="Remove" aria-label="Remove ${esc(c.topic)}">×</button></li>`,
          )
          .join("")
      : `<li class="muted">No categories yet — try "Christmas", "90s movies", or "Space".</li>`);

    setHTML($("player-category-list"), state.categories
      .map((c) => `<li><span class="cat-name">${esc(c.topic)}</span><span class="cat-status">${c.count} Qs</span></li>`)
      .join(""));

    if (host) {
      const packs = state.packs || [];
      setHTML($("pack-list"), packs
        .map((p) => `<button type="button" class="pack-chip" data-topic="${esc(p.topic)}" data-size="${p.size}" title="${esc(p.description)}">${esc(p.topic)}<small>${p.size}</small></button>`)
        .join(""));
      setHTML($("pack-options"), packs.map((p) => `<option value="${esc(p.topic)}"></option>`).join(""));
      $("setup-hint").textContent = state.aiAvailable
        ? "Tap a question pack or type any topic for AI-written questions. Questions and answers stay secret — even from you."
        : packs.length
          ? "Tap a question pack to add it. Questions and answers stay secret — even from you."
          : "No question packs found yet. Add some to the questions/ folder.";
    }

    const time = $("time-input");
    if (document.activeElement !== time) {
      time.value = state.settings.timeLimit;
      $("time-label").textContent = `${state.settings.timeLimit}s`;
    }

    const building = state.categories.some((c) => c.status === "building");
    const ready = state.categories.filter((c) => c.status === "ready");
    const total = ready.reduce((s, c) => s + c.built, 0);
    $("start-btn").disabled = building || !ready.length;
    $("start-hint").textContent = building
      ? "Hang tight — building questions…"
      : ready.length
        ? `${total} questions across ${ready.length} categor${ready.length === 1 ? "y" : "ies"}`
        : "Add at least one category to start";

    renderPlayers();
  }

  function renderPlayers() {
    const players = state.players;
    $("player-count").textContent = players.filter((p) => p.connected).length;
    setHTML($("player-list"), players
      .map(
        (p) => `<li class="${p.connected ? "" : "offline"}"><span class="avatar">${esc(p.emoji)}</span>
        <span>${esc(p.name)}${p.id === playerId ? " (you)" : ""}</span>${p.isHost ? '<span class="tag">HOST</span>' : ""}</li>`,
      )
      .join(""));
  }

  // ---------- question ----------
  function renderQuestion() {
    const q = state.question;
    const key = `q:${q.index}`;
    const answersEl = $("answers");
    if (renderedKey !== key) {
      renderedKey = key;
      $("q-progress").textContent = `Question ${q.index + 1} / ${q.total}`;
      $("q-topic").textContent = q.topic;
      $("q-text").textContent = q.question;
      $("q-status").innerHTML = "";
      answersEl.className = "answers" + (q.type === "true_false" ? " tf" : "");
      answersEl.innerHTML = q.choices
        .map((c, i) => {
          const color = q.type === "true_false" ? (i === 0 ? 3 : 0) : i;
          const shape = q.type === "true_false" ? (i === 0 ? "✔" : "✖") : SHAPES[i];
          return `<button class="btn answer c${color}" data-i="${i}"><span class="shape">${shape}</span><span class="label">${esc(c)}</span></button>`;
        })
        .join("");
      answersEl.querySelectorAll(".answer").forEach((b) => {
        b.onclick = () => submitAnswer(Number(b.dataset.i));
      });
      startTimer(q.remainingMs, q.timeLimit * 1000);
    }
    updateAnswered(q.answeredCount, q.playerCount);
    if (state.yourAnswer != null) lockAnswer(state.yourAnswer);
  }

  async function submitAnswer(i) {
    if ($("answers").classList.contains("locked")) return;
    lockAnswer(i);
    const res = await emit("answer", { choice: i });
    if (!res.ok) $("answers").classList.remove("locked");
  }

  function lockAnswer(i) {
    const el = $("answers");
    el.classList.add("locked");
    el.querySelectorAll(".answer").forEach((b) => {
      b.disabled = true;
      b.classList.toggle("picked", Number(b.dataset.i) === i);
    });
    $("q-status").innerHTML = "Answer locked in! 🔒";
  }

  function updateAnswered(n, total) {
    $("q-answered").textContent = `${n} / ${total} answered`;
  }

  function startTimer(remainingMs, totalMs) {
    cancelAnimationFrame(timerRaf);
    const deadline = performance.now() + remainingMs;
    const bar = $("timer-bar");
    const num = $("timer-num");
    const tick = () => {
      const left = Math.max(0, deadline - performance.now());
      const frac = left / totalMs;
      bar.style.transform = `scaleX(${frac})`;
      bar.style.backgroundPosition = `${(1 - frac) * 100}% 0`;
      const secs = Math.ceil(left / 1000);
      num.textContent = secs;
      num.classList.toggle("urgent", secs <= 5 && left > 0);
      if (left > 0) timerRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function renderReveal() {
    const r = state.reveal;
    const key = `r:${r.questionIndex}`;
    if (renderedKey === key) return;
    // If we joined mid-reveal there's no question on screen; draw it first.
    if (renderedKey !== `q:${r.questionIndex}`) {
      state.question = {
        index: r.questionIndex, total: state.totalQuestions, topic: "", type: r.type,
        question: r.question, choices: r.choices, timeLimit: 1, remainingMs: 0, answeredCount: 0, playerCount: 0,
      };
      renderQuestion();
    }
    renderedKey = key;
    cancelAnimationFrame(timerRaf);
    $("timer-bar").style.transform = "scaleX(0)";
    $("timer-num").textContent = "⏰";
    $("timer-num").classList.remove("urgent");

    const el = $("answers");
    el.classList.remove("locked");
    el.classList.add("revealed");
    const mine = r.results[playerId];
    el.querySelectorAll(".answer").forEach((b) => {
      const i = Number(b.dataset.i);
      b.disabled = true;
      b.classList.toggle("correct", i === r.correctIndex);
      b.classList.toggle("picked", mine?.choice === i);
      b.insertAdjacentHTML("beforeend", `<span class="count">${r.counts[i]}</span>`);
    });
    const status = $("q-status");
    if (!mine || !mine.answered) status.innerHTML = `<span class="wrong">⏱ Too slow!</span>`;
    else if (mine.correct) status.innerHTML = `Correct! <span class="pts">+${mine.points}</span>`;
    else status.innerHTML = `<span class="wrong">✖ Not quite</span>`;
    if (mine?.correct) burstConfetti(60);
  }

  // ---------- leaderboard ----------
  function renderLeaderboard() {
    const lb = state.leaderboard;
    const key = `lb:${lb.questionIndex}`;
    $("next-btn").textContent = lb.isLast ? "See final results 🏆" : "Next question ➜";
    $("lb-sub").textContent = `After question ${lb.questionIndex + 1} of ${lb.total}`;
    if (renderedKey === key) return;
    renderedKey = key;

    const container = $("lb");
    const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h")) || 76;
    const visible = lb.entries.filter((e) => e.rank <= 5 || e.prevRank <= 5);
    const animate = animatedLeaderboardFor !== lb.questionIndex;
    animatedLeaderboardFor = lb.questionIndex;

    container.innerHTML = "";
    const rows = visible.map((e) => {
      const row = document.createElement("div");
      const moved = e.prevRank - e.rank;
      row.className = "lb-row";
      if (e.rank === 1) row.classList.add("first");
      if (e.id === playerId) row.classList.add("me");
      if (moved >= 2) row.classList.add("big-climb");
      if (moved <= -2) row.classList.add("big-drop");
      const moveBadge = animate && moved !== 0
        ? `<span class="move ${moved > 0 ? "up" : "down"}">${moved > 0 ? "▲" : "▼"} ${Math.abs(moved)}</span>`
        : "";
      row.innerHTML = `<span class="rank">${e.rank}</span><span class="avatar">${esc(e.emoji)}</span>
        <span class="name">${esc(e.name)}</span>${moveBadge}
        <span class="score" data-from="${e.score - e.points}" data-to="${e.score}">${e.score - e.points}</span>
        ${e.points ? `<span class="gain">+${e.points}</span>` : ""}`;
      const start = animate ? Math.min(e.prevRank, 6) : Math.min(e.rank, 6);
      row.style.transform = `translateY(${(start - 1) * rowH}px)`;
      row.style.opacity = start > 5 ? "0" : "1";
      row.style.zIndex = String(100 - e.rank);
      container.appendChild(row);
      return { row, e, moved };
    });

    // Next frames: slide each row to its new position and count the score up.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        rows.forEach(({ row, e, moved }) => {
          const end = Math.min(e.rank, 6);
          row.style.transform = `translateY(${(end - 1) * rowH}px)`;
          row.style.opacity = end > 5 ? "0" : "1";
          if (animate && moved >= 2 && e.rank <= 5) row.insertAdjacentHTML("beforeend", `<span class="rocket">🚀</span>`);
          setTimeout(() => row.classList.add("settled"), 1100);
        });
        countUp(container.querySelectorAll(".score"));
      }),
    );

    const mineEntry = lb.entries.find((e) => e.id === playerId);
    $("lb-you").innerHTML =
      mineEntry && mineEntry.rank > 5
        ? `You're <strong>#${mineEntry.rank}</strong> with <strong>${mineEntry.score}</strong> pts — keep going!`
        : "";
  }

  function countUp(els) {
    const t0 = performance.now();
    const dur = 1000;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const ease = 1 - Math.pow(1 - k, 3);
      els.forEach((el) => {
        const from = Number(el.dataset.from);
        const to = Number(el.dataset.to);
        el.textContent = Math.round(from + (to - from) * ease).toLocaleString();
      });
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- final ----------
  function renderFinal() {
    const f = state.final;
    const key = "final";
    if (renderedKey === key) return;
    renderedKey = key;
    const s = f.standings;
    const w = s[0];
    $("winner").innerHTML = w
      ? `<div class="avatar">${esc(w.emoji)}</div><h1>${esc(w.name)}</h1>
         <p>${w.score.toLocaleString()} points · ${w.correct} / ${f.total} correct</p>`
      : "";
    const order = [s[1], s[0], s[2]];
    $("podium").innerHTML = order
      .map((p, i) => {
        if (!p) return "";
        const place = [2, 1, 3][i];
        return `<div class="step p${place}"><div class="avatar" style="margin:0 auto">${esc(p.emoji)}</div>
          <div class="nm">${esc(p.name)}</div><div class="block">${place}</div></div>`;
      })
      .join("");
    $("final-list").innerHTML = s
      .map((p) => `<li><strong>#${p.rank}</strong><span class="avatar">${esc(p.emoji)}</span><span>${esc(p.name)}${p.id === playerId ? " (you)" : ""}</span>
        <span class="score">${p.score.toLocaleString()}</span></li>`)
      .join("");
    const gameId = `${state.pin}:${s.map((p) => p.score).join(",")}`;
    if (confettiFiredFor !== gameId) {
      confettiFiredFor = gameId;
      burstConfetti(260, true);
    }
  }

  // ---------- main render ----------
  function render() {
    if (!state) {
      show("home");
      return;
    }
    document.body.classList.toggle("is-host", isHost());
    if (state.phase !== "question" && state.phase !== "reveal") cancelAnimationFrame(timerRaf);
    switch (state.phase) {
      case "setup":
        renderedKey = "setup";
        $("answers").className = "answers";
        renderLobby();
        show("lobby");
        break;
      case "ready":
        renderedKey = "ready";
        $("ready-sub").textContent = `${state.totalQuestions} questions · ${state.settings.timeLimit}s each · ${state.players.filter((p) => p.connected).length} players`;
        show("ready");
        break;
      case "question":
        renderQuestion();
        show("question");
        break;
      case "reveal":
        renderReveal();
        show("question");
        break;
      case "leaderboard":
        renderLeaderboard();
        show("leaderboard");
        break;
      case "final":
        renderFinal();
        show("final");
        break;
    }
  }

  // ---------- socket ----------
  socket.on("state", (s) => {
    state = s;
    render();
  });
  socket.on("answerCount", ({ answeredCount, playerCount }) => updateAnswered(answeredCount, playerCount));
  socket.on("roomClosed", ({ reason }) => {
    toast(reason || "The game has ended", true);
    store.del("trivia.pin");
    state = null;
    renderedKey = "";
    document.body.classList.remove("is-host");
    show("home");
  });
  socket.on("connect", async () => {
    const pin = store.get("trivia.pin");
    if (!pin) return;
    socket.emit("resume", { pin, playerId }, (res) => {
      if (!res?.ok) {
        store.del("trivia.pin");
        if (state) toast("Your previous game has ended", true);
        state = null;
        render();
      }
    });
  });
  socket.on("disconnect", () => toast("Connection lost — reconnecting…", true));

  // ---------- confetti ----------
  const canvas = $("confetti");
  const ctx = canvas.getContext("2d");
  let particles = [];
  let confettiRaf = 0;
  function burstConfetti(n, rain = false) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    const colors = ["#ff4fa3", "#ffd54a", "#3dd9ff", "#3ee68a", "#ff8a3d", "#b57bff"];
    for (let i = 0; i < n; i++) {
      particles.push({
        x: rain ? Math.random() * canvas.width : canvas.width / 2,
        y: rain ? -Math.random() * canvas.height * 0.5 : canvas.height * 0.6,
        vx: rain ? (Math.random() - 0.5) * 3 : (Math.random() - 0.5) * 22,
        vy: rain ? Math.random() * 3 + 2 : -Math.random() * 24 - 8,
        r: (Math.random() * 6 + 4) * devicePixelRatio,
        rot: Math.random() * 6,
        vr: (Math.random() - 0.5) * 0.3,
        c: colors[i % colors.length],
        life: 0,
      });
    }
    if (!confettiRaf) confettiRaf = requestAnimationFrame(drawConfetti);
  }
  function drawConfetti() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles = particles.filter((p) => p.y < canvas.height + 40 && p.life < 600);
    for (const p of particles) {
      p.life++;
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy * 0.6;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
      ctx.restore();
    }
    confettiRaf = particles.length ? requestAnimationFrame(drawConfetti) : 0;
    if (!particles.length) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  initHome();
  initLobby();
  render();
})();
