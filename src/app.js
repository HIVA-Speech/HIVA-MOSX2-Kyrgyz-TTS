(() => {
  const C = window.CONFIG, T = window.I18N;
  const app = document.getElementById("app");
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const KEY = "mosx2_state_v1", DONE = "mosx2_done_v1";
  const ITEMS = [["intelligibility", "q_int"], ["naturalness", "q_nat"], ["prosody", "q_pro"], ["social", "q_soc"]];

  // ---------- состояние (переживает перезагрузку страницы) ----------
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }));
  let S = ls.get(KEY) || {
    pid: uuid(), stage: ls.get(DONE) ? "already" : "welcome", lang: C.DEFAULT_LANG,
    external: new URLSearchParams(location.search).get("pid"),
    demo: null, attempts: 0, list: null, order: null, idx: 0, tIdx: 0, pending: []
  };
  const save = () => ls.set(KEY, S);
  const t = k => (T[S.lang] && T[S.lang][k]) || T.ru[k] || k;

  document.querySelectorAll(".lang button").forEach(b => {
    b.onclick = () => { S.lang = b.dataset.l; save(); render(); };
  });

  // ---------- запись в БД с офлайн-очередью ----------
  async function insert(table, row) {
    S.pending.push({ table, row }); save();
    await flush();
  }
  async function flush() {
    const left = [];
    for (const p of S.pending) {
      const { error } = await sb.from(p.table).insert(p.row);
      if (error && error.code !== "23505") left.push(p); // 23505 = дубликат, уже сохранено
    }
    S.pending = left; save();
    if (left.length) flash(t("saveErr"));
  }
  function flash(msg) { const n = app.querySelector(".note"); if (n) n.textContent = msg; }

  // ---------- утилиты ----------
  const h = (html) => { app.innerHTML = html; app.scrollIntoView({ block: "start" }); };
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  let stimuliCache = null;
  const stimuli = async () => stimuliCache || (stimuliCache = await (await fetch(C.STIMULI_URL, { cache: "no-store" })).json());
  function constrainedShuffle(arr) {
    // без двух подряд записей одной категории и без трёх подряд одного пола
    for (let k = 0; k < 500; k++) {
      const s = shuffle(arr);
      const ok = s.every((x, i) => i === 0 || (x.category !== s[i - 1].category &&
        !(i > 1 && x.gender === s[i - 1].gender && x.gender === s[i - 2].gender)));
      if (ok) return s;
    }
    return shuffle(arr);
  }

  // Аудиоплеер: без перемотки, оценка доступна только после прослушивания до конца.
  // Звучит не дольше MAX_PLAY_S секунд, последние FADE_S — затухание (Web Audio; если файл
  // нельзя декодировать, например без CORS, — запасной вариант через <audio> и громкость).
  const audioUrl = p => /^(https?:)?\/\//.test(p) ? p : (C.AUDIO_BASE || "") + p;
  const LIMIT = C.MAX_PLAY_S || Infinity, FADE = C.FADE_S || 0;
  let actx = null;
  const ctx = () => actx || (actx = new (window.AudioContext || window.webkitAudioContext)());
  async function decode(url) {
    const buf = await (await fetch(url)).arrayBuffer();
    return new Promise((ok, fail) => ctx().decodeAudioData(buf, ok, fail));
  }
  function playBuffer(buf, onEnd) {
    const c = ctx(), s = c.createBufferSource(), g = c.createGain(), t0 = c.currentTime;
    const dur = Math.min(buf.duration, LIMIT);
    s.buffer = buf; s.connect(g); g.connect(c.destination);
    if (buf.duration > LIMIT + 0.05 && FADE) {
      g.gain.setValueAtTime(1, t0 + dur - FADE);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    }
    s.onended = onEnd; s.start(t0, 0, dur);
  }
  function playElement(url, onEnd, onError) {
    const a = new Audio(url); let iv, over = false;
    const stop = () => { if (over) return; over = true; clearInterval(iv); a.pause(); onEnd(); };
    a.onended = stop; a.onerror = () => { clearInterval(iv); onError(); };
    a.play().catch(onError);
    if (isFinite(LIMIT)) iv = setInterval(() => {
      const left = LIMIT - a.currentTime;
      if (left <= 0) stop(); else if (left < FADE) a.volume = Math.max(0, left / FADE);
    }, 40);
  }
  function player(el, src, onEnded) {
    const url = audioUrl(src), st = { plays: 0, done: false };
    const ready = decode(url).catch(() => null);
    el.innerHTML = `<button class="btn ghost" type="button">${t("play")}</button><span class="mute">${t("listenFirst")}</span>`;
    const btn = el.querySelector("button"), hint = el.querySelector("span");
    const ended = () => {
      btn.disabled = false; btn.textContent = t("replay");
      if (!st.done) { st.done = true; hint.textContent = ""; onEnded && onEnded(); }
    };
    const failed = () => { btn.disabled = false; hint.textContent = "⚠ audio"; };
    btn.onclick = async () => {
      btn.disabled = true;
      ctx().resume();  // до await: браузер разрешает звук только в обработчике нажатия
      const buf = await ready;
      st.plays++;
      if (buf) playBuffer(buf, ended); else playElement(url, ended, failed);
    };
    return st;
  }

  // ---------- экраны ----------
  function render() {
    document.documentElement.lang = S.lang;
    document.getElementById("hdr").textContent = t("title");
    document.querySelectorAll(".lang button").forEach(b => b.classList.toggle("on", b.dataset.l === S.lang));
    ({ welcome, demo, check, calib, failed, training, trials, feedback, done, already })[S.stage]();
  }
  const go = s => { S.stage = s; save(); render(); };

  function welcome() {
    h(`<h1>${t("title")}</h1><p>${t("intro")}</p>
       <label style="display:flex;gap:10px;align-items:flex-start;margin:18px 0"><input type="checkbox" id="c" style="margin-top:5px"> <span>${t("consent")}</span></label>
       <button class="btn" id="go" disabled>${t("start")}</button>`);
    const c = app.querySelector("#c"), b = app.querySelector("#go");
    c.onchange = () => b.disabled = !c.checked;
    b.onclick = () => go("demo");
  }

  function demo() {
    const sel = (id, opts) => `<label class="row"><span>${t(id)}</span><select id="${id}"><option value=""></option>${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>`;
    const regions = ["Бишкек", "Ош ш.", "Чүй", "Ош обл.", "Жалал-Абад", "Баткен", "Талас", "Нарын", "Ысык-Көл"];
    h(`<h2>${t("demoTitle")}</h2>
      ${sel("native", [["ky", t("native_ky")], ["ky_ru", t("native_both")], ["other", t("native_other")]])}
      ${sel("age", ["18–24", "25–34", "35–44", "45–54", "55+"].map(x => [x, x]))}
      ${sel("sex", [["m", t("sex_m")], ["f", t("sex_f")], ["na", t("sex_na")]])}
      ${sel("region", regions.map(r => [r, r]).concat([["other", t("other")]]))}
      ${sel("device", [["wired", t("dev_wired")], ["wireless", t("dev_wireless")], ["speakers", t("dev_speakers")], ["phone", t("dev_phone")]])}
      ${sel("env", [["quiet", t("env_quiet")], ["some", t("env_some")], ["noisy", t("env_noisy")]])}
      <button class="btn" id="go" disabled>${t("next")}</button>`);
    const ids = ["native", "age", "sex", "region", "device", "env"], b = app.querySelector("#go");
    const val = () => Object.fromEntries(ids.map(i => [i, app.querySelector("#" + i).value]));
    app.querySelectorAll("select").forEach(s => s.onchange = () => b.disabled = Object.values(val()).some(v => !v));
    b.onclick = () => { S.demo = val(); go("check"); };
  }

  function check() {
    const answers = C.CHECK_ITEMS.map(() => null);
    h(`<h2>${t("checkTitle")}</h2><p>${t("checkIntro")}</p><div class="note">${S.attempts ? t("checkRetry") : ""}</div>
       ${C.CHECK_ITEMS.map((_, i) => `<div style="margin:18px 0"><b>${i + 1}.</b> <div class="player" id="p${i}"></div>
         <div class="mute" style="margin-bottom:6px">${t("checkQ")}</div>
         <div class="digits" id="d${i}">${[...Array(10).keys()].map(n => `<button type="button" disabled data-n="${n}">${n}</button>`).join("")}</div></div>`).join("")}
       <button class="btn" id="go" disabled>${t("next")}</button>`);
    const b = app.querySelector("#go");
    C.CHECK_ITEMS.forEach((it, i) => {
      const box = app.querySelector("#d" + i);
      player(app.querySelector("#p" + i), it.audio, () => box.querySelectorAll("button").forEach(x => x.disabled = false));
      box.querySelectorAll("button").forEach(x => x.onclick = () => {
        box.querySelectorAll("button").forEach(y => y.classList.remove("on")); x.classList.add("on");
        answers[i] = +x.dataset.n; b.disabled = answers.includes(null);
      });
    });
    b.onclick = async () => {
      b.disabled = true;
      S.attempts++;
      const correct = answers.filter((a, i) => a === C.CHECK_ITEMS[i].answer).length;
      const passed = correct >= C.CHECK_MIN_CORRECT;
      if (!passed && S.attempts < C.CHECK_MAX_ATTEMPTS) { save(); return render(); }
      S.check = { correct, answers };
      if (!passed) return screened(false);
      // список нужен уже здесь: записи для проверки понимания берутся из чужих списков
      const { data, error } = await sb.rpc("next_list", { n_lists: C.N_LISTS });
      S.list = (!error && Number.isInteger(data)) ? data : (Math.random() * C.N_LISTS | 0);
      if (C.CALIB_N) go("calib"); else screened(true);
    };
  }

  // Проверка понимания: прослушать запись и выбрать прозвучавшую фразу из 4 вариантов
  async function calib() {
    if (!S.calib) {
      h(`<p>${t("loading")}</p>`);
      const pool = shuffle((await stimuli()).filter(s => s.calib && (C.N_LISTS === 1 || (s.item - 1) % C.N_LISTS !== S.list)));
      const pick = [];
      for (const s of pool) {  // разные категории, голоса по очереди
        if (pick.length === C.CALIB_N) break;
        const prev = pick[pick.length - 1];
        if (!pick.some(p => p.category === s.category) && (!prev || prev.gender !== s.gender)) pick.push(s);
      }
      for (const s of pool) if (pick.length < C.CALIB_N && !pick.includes(s)) pick.push(s);
      S.calib = pick.map(s => ({ id: s.id, audio: s.audio, answer: s.calib.phrase, options: shuffle([s.calib.phrase, ...s.calib.foils]) }));
      save();
    }
    if (!S.calib.length) return screened(true);  // в stimuli.json нет фраз (нет транскриптов)
    const chosen = S.calib.map(() => null);
    h(`<h2>${t("calibTitle")}</h2><p>${t("calibIntro")}</p>
       ${S.calib.map((it, i) => `<div style="margin:18px 0"><b>${i + 1}.</b> <div class="player" id="p${i}"></div>
         <div class="mute" style="margin-bottom:6px">${t("calibQ")}</div>
         <div class="opts" id="o${i}">${it.options.map((o, j) => `<button type="button" disabled data-j="${j}">${o}</button>`).join("")}</div></div>`).join("")}
       <div class="note"></div><button class="btn" id="go" disabled>${t("next")}</button>`);
    const b = app.querySelector("#go");
    S.calib.forEach((it, i) => {
      const box = app.querySelector("#o" + i);
      player(app.querySelector("#p" + i), it.audio, () => box.querySelectorAll("button").forEach(x => x.disabled = false));
      box.querySelectorAll("button").forEach(x => x.onclick = () => {
        box.querySelectorAll("button").forEach(y => y.classList.remove("on")); x.classList.add("on");
        chosen[i] = it.options[+x.dataset.j]; b.disabled = chosen.includes(null);
      });
    });
    b.onclick = () => {
      b.disabled = true;
      const answers = S.calib.map((it, i) => ({ id: it.id, chosen: chosen[i], correct: chosen[i] === it.answer }));
      S.calibRes = { correct: answers.filter(a => a.correct).length, answers };
      screened(S.calibRes.correct >= C.CALIB_MIN_CORRECT);
    };
  }

  // Итог отбора: строка участника сохраняется в любом случае (для статистики отсева)
  async function screened(passed) {
    await insert("participants", {
      id: S.pid, external_id: S.external, lang: S.lang, list_id: passed ? S.list : null,
      native_lang: S.demo.native, age_group: S.demo.age, sex: S.demo.sex, region: S.demo.region,
      audio_device: S.demo.device, environment: S.demo.env,
      attention_correct: S.check.correct, attention_attempts: S.attempts, attention_answers: S.check.answers,
      calib_correct: S.calibRes ? S.calibRes.correct : null, calib_answers: S.calibRes ? S.calibRes.answers : null,
      passed, user_agent: navigator.userAgent
    });
    if (!passed) { ls.set(DONE, true); return go("failed"); }
    go(C.TRAINING && C.TRAINING.length ? "training" : "trials");
  }

  function failed() { h(`<h2>${t("failedTitle")}</h2><p>${t("failedText")}</p>`); }
  function already() { h(`<p>${t("already")}</p>`); }

  // Общий экран оценки одной записи по 4 шкалам MOS-X2 (0–10)
  function ratingScreen({ title, sub, progress, audio, onSubmit }) {
    const r = {}; const t0 = performance.now();
    h(`${progress != null ? `<div class="bar"><i style="width:${progress}%"></i></div>` : ""}
       <h2>${title}</h2>${sub ? `<p class="mute">${sub}</p>` : ""}
       <div class="player" id="pl"></div>
       ${ITEMS.map(([k, q]) => `<div class="q"><div class="t">${t(q)}</div>
          <div class="scale" data-k="${k}">${[...Array(11).keys()].map(n => `<button type="button" disabled data-n="${n}">${n}</button>`).join("")}</div>
          <div class="ends"><span>0 — ${t(q + "_lo")}</span><span>10 — ${t(q + "_hi")}</span></div></div>`).join("")}
       <div class="note"></div>
       <button class="btn" id="go" disabled>${t("next")}</button>`);
    const b = app.querySelector("#go");
    const pl = player(app.querySelector("#pl"), audio, () => app.querySelectorAll(".scale button").forEach(x => x.disabled = false));
    app.querySelectorAll(".scale").forEach(sc => sc.querySelectorAll("button").forEach(x => x.onclick = () => {
      sc.querySelectorAll("button").forEach(y => y.classList.remove("on")); x.classList.add("on");
      r[sc.dataset.k] = +x.dataset.n; b.disabled = Object.keys(r).length < 4;
    }));
    b.onclick = async () => {
      b.disabled = true;
      await onSubmit({ ...r, plays: pl.plays, rt_ms: Math.round(performance.now() - t0) });
    };
  }

  function training() {
    const it = C.TRAINING[S.tIdx];
    if (!it) return go("trials");
    ratingScreen({
      title: `${t("trainTitle")} ${S.tIdx + 1}/${C.TRAINING.length}`, sub: t("trainIntro"), audio: it.audio,
      onSubmit: async (res) => {
        await insert("responses", { participant_id: S.pid, stimulus_id: it.id, kind: "training", list_id: S.list, trial_index: S.tIdx, ...res });
        S.tIdx++; save(); training();
      }
    });
  }

  async function trials() {
    if (!S.order) {
      h(`<p>${t("loading")}</p>`);
      const all = await stimuli();
      const mine =C.N_LISTS === 1 ? all : all.filter(s => (s.item - 1) % C.N_LISTS === S.list);
      const order = constrainedShuffle(mine).map(s => ({ ...s, kind: "test" }));
      if (C.CATCH_AUDIO) order.splice(Math.floor(order.length / 2), 0, { id: "catch", audio: C.CATCH_AUDIO, kind: "catch" });
      S.order = order; S.idx = 0; save();
    }
    const st = S.order[S.idx];
    if (!st) return go("feedback");
    ratingScreen({
      title: `${t("testTitle")} ${S.idx + 1} / ${S.order.length}`,
      progress: Math.round(100 * S.idx / S.order.length), audio: st.audio,
      onSubmit: async (res) => {
        await insert("responses", {
          participant_id: S.pid, stimulus_id: st.id, kind: st.kind, gender: st.gender || null,
          category: st.category || null, item: st.item || null, list_id: S.list, trial_index: S.idx, ...res
        });
        S.idx++; save(); trials();
      }
    });
  }

  function feedback() {
    h(`<h2>${t("feedbackTitle")}</h2><label class="row"><span>${t("feedbackQ")}</span><textarea id="f" rows="4"></textarea></label>
       <div class="note"></div><button class="btn" id="go">${t("finish")}</button>`);
    app.querySelector("#go").onclick = async (e) => {
      e.target.disabled = true;
      const txt = app.querySelector("#f").value.trim();
      await insert("feedback", { participant_id: S.pid, comment: txt || null });
      ls.set(DONE, true); go("done");
    };
  }

  function done() {
    h(`<h2>${t("doneTitle")}</h2><p class="mute">${t("code")}:</p><p class="code">${S.pid.slice(0, 8).toUpperCase()}</p><div class="note"></div>`);
    if (S.pending.length) flush();
  }

  render();
})();
