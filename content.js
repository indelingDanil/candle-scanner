// Панель Candle Scanner: выбор области графика, захват экрана, анализ и отрисовка разметки поверх страницы.
(function () {
  'use strict';
  if (window.__candleScanner) { window.__candleScanner.toggle(); return; }

  const A = window.CandleAnalyzer;
  const STORE_KEY = 'cs:' + location.host;
  const AUTO_MS = 1000;
  const RECENT = 20; // сколько последних свечей подписывать на графике

  const state = {
    region: null,          // { x, y, w, h } в CSS-пикселях относительно окна
    bull: null, bear: null, // [r,g,b]
    tol: 60,
    show: { patterns: true, levels: true, trend: true, debug: false, weak: false, history: false },
    lastForming: true,
    payout: 92,
    auto: false,
    busy: false,
    result: null,          // { det, res, scale }
  };

  // Сессия: закрытые свечи с момента запуска (стартовые данные — видимая история)
  const WARMUP = 30;
  const MIN_N = 8; // меньше случаев — статистику паттерна не используем
  let session = newSession();
  function newSession() { return { seq: [], prevSig: null, seeded: 0, live: 0, misses: 0, stats: null }; }

  function updateSession(det, res) {
    const closed = det.candles.slice(0, res.lastIdx + 1);
    if (closed.length < 8) return;
    const sig = closed.map(A.candleSig);
    const patAt = (i) => res.patterns.filter((p) => p.i === i && p.dir !== 0).map((p) => ({ key: p.key, dir: p.dir }));
    const seed = () => {
      session = newSession();
      session.seq = closed.map((k, i) => ({ t: sig[i].t, keys: patAt(i) }));
      session.seeded = closed.length;
    };
    if (!session.seq.length) seed();
    else {
      const s = A.alignShift(session.prevSig, sig);
      if (s > 0) {
        for (let j = s; j >= 1; j--) { const i = closed.length - j; session.seq.push({ t: sig[i].t, keys: patAt(i) }); }
        session.live += s; session.misses = 0;
      } else if (s < 0) {
        // 3 несовпадения подряд — график сменился (пара, таймфрейм, прокрутка): начинаем заново
        if (++session.misses >= 3) seed();
        else return; // этот кадр пропускаем, prevSig не трогаем
      } else session.misses = 0;
    }
    session.prevSig = sig;
    session.stats = A.sessionStats(session.seq, state.payout);
  }

  // Оценка следующей свечи: паттерн (если по нему хватает истории), иначе серия
  function verdict(ss) {
    if (!ss || ss.n < WARMUP) return null;
    const pat = ss.patterns.filter((p) => p.n >= MIN_N).sort((a, b) => b.n - a.n)[0];
    let pUp, ci, src, n;
    if (pat) {
      pUp = pat.dir > 0 ? pat.p : 1 - pat.p;
      ci = pat.dir > 0 ? pat.ci : [1 - pat.ci[1], 1 - pat.ci[0]];
      src = pat.name; n = pat.n;
    } else if (ss.run && ss.run.n >= MIN_N) {
      pUp = ss.run.pUp; ci = ss.run.ci; n = ss.run.n;
      src = `после ${ss.run.lenLabel} ${ss.run.col > 0 ? 'зелёных' : 'красных'} подряд`;
    } else return { dir: 0, pUp: 0.5, ci: [0, 1], src: null, n: 0, edge: false };
    const be = ss.breakeven;
    const dir = ci[0] > be ? 1 : ci[1] < 1 - be ? -1 : 0;
    return { dir, pUp, ci, src, n, edge: dir !== 0 };
  }

  // ---------- DOM ----------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
  <style>
    :host { all: initial; }
    canvas.ov { position: fixed; inset: 0; pointer-events: none; }
    .layer { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: rgba(0,0,0,.25); display: none; }
    .layer .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: #15181e; color: #fff;
      font: 13px system-ui, sans-serif; padding: 8px 14px; border-radius: 6px; }
    .sel { position: fixed; border: 2px dashed #ffd400; background: rgba(255,212,0,.08); display: none; }
    .panel { position: fixed; right: 16px; bottom: 16px; width: 290px; pointer-events: auto; background: #15181e; color: #e6e8eb;
      font: 12px system-ui, sans-serif; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.5); border: 1px solid #2a2f38; }
    .hd { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; cursor: move; border-bottom: 1px solid #2a2f38; font-weight: 600; }
    .hd button { background: none; border: 0; color: #9aa3ad; font-size: 16px; cursor: pointer; padding: 0 4px; }
    .bd { padding: 10px; display: grid; gap: 8px; max-height: calc(100vh - 90px); overflow: auto; }
    .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .btn { flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid #333a45; background: #1f242c; color: #e6e8eb; cursor: pointer; font: inherit; }
    .btn:hover { background: #262c36; }
    .btn.primary { background: #2f80ed; border-color: #2f80ed; color: #fff; }
    .btn.on { background: #27ae60; border-color: #27ae60; color: #fff; }
    .sw { width: 18px; height: 18px; border-radius: 4px; border: 1px solid #444; display: inline-block; }
    label { display: flex; gap: 4px; align-items: center; cursor: pointer; }
    .st { color: #9aa3ad; line-height: 1.45; }
    .warn { color: #f2c94c; }
    .list { max-height: 130px; overflow: auto; border-top: 1px solid #2a2f38; padding-top: 6px; }
    .list div { padding: 2px 0; }
    .now { background: #1c2129; border-radius: 6px; padding: 8px; line-height: 1.4; }
    .now b { font-size: 13px; }
    .now .h { color: #9aa3ad; font-size: 11px; margin-top: 3px; }
    .sec { color: #6b7480; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 2px; }
    .stats div { display: flex; justify-content: space-between; padding: 1px 0; }
    .ok { color: #4cd38a; } .bad { color: #ff6b6b; } .wait { color: #f2c94c; }
    .up { color: #4cd38a; } .dn { color: #ff6b6b; } .nt { color: #c9d1d9; }
    .disc { color: #6b7480; font-size: 10px; line-height: 1.35; }
    input[type=range] { flex: 1; }
  </style>
  <canvas class="ov"></canvas>
  <div class="layer"><div class="hint"></div></div>
  <div class="sel"></div>
  <div class="panel">
    <div class="hd"><span>Candle Scanner</span><button data-a="close" title="Закрыть">×</button></div>
    <div class="bd">
      <div class="row">
        <button class="btn" data-a="region">Область</button>
        <button class="btn primary" data-a="scan">Сканировать</button>
        <button class="btn" data-a="auto">Авто</button>
      </div>
      <div class="row">
        <span class="sw" data-sw="bull"></span><button class="btn" data-a="pick-bull">Пипетка ▲</button>
        <span class="sw" data-sw="bear"></span><button class="btn" data-a="pick-bear">Пипетка ▼</button>
      </div>
      <div class="row">
        <button class="btn" data-a="autocolor">Авто-цвета</button>
        <span>Допуск</span><input type="range" min="15" max="140" data-k="tol"><span data-v="tol"></span>
      </div>
      <div class="row">
        <label><input type="checkbox" data-c="patterns">Паттерны</label>
        <label><input type="checkbox" data-c="levels">Уровни</label>
        <label><input type="checkbox" data-c="trend">Тренд</label>
        <label><input type="checkbox" data-c="debug">Отладка</label>
      </div>
      <div class="row">
        <label title="Доджи, марубозу, харами, пинцет вне уровней"><input type="checkbox" data-c="weak">Слабые</label>
        <label title="Подписывать паттерны по всему графику, а не только на последних свечах"><input type="checkbox" data-c="history">Вся история</label>
      </div>
      <label><input type="checkbox" data-c="lastForming">Последняя свеча ещё формируется</label>
      <div class="row">
        <span>Выплата</span><input type="number" min="1" max="200" data-k="payout" style="width:52px;background:#1f242c;color:#e6e8eb;border:1px solid #333a45;border-radius:4px;padding:3px"><span>%</span>
        <button class="btn" data-a="reset">Новая сессия</button>
      </div>
      <div><div class="sec">Следующая свеча — по истории этой сессии</div><div class="now" data-out="session">—</div></div>
      <div class="st" data-out="status">Выберите область графика (без шкал цены и времени).</div>
      <div><div class="sec">Сейчас (последняя закрытая свеча)</div><div class="now" data-out="now">—</div></div>
      <div><div class="sec">Недавние паттерны · ✓ следующая свеча пошла в сторону паттерна</div><div class="list" data-out="list"></div></div>
      <div><div class="sec">Статистика на видимой истории</div><div class="list stats" data-out="stats"></div></div>
      <div class="disc">Инструмент визуальной разметки графика. Не является торговыми сигналами или инвестиционной рекомендацией.</div>
    </div>
  </div>`;
  document.documentElement.appendChild(host);

  const $ = (s) => shadow.querySelector(s);
  const ov = $('canvas.ov'), ctx = ov.getContext('2d');
  const layer = $('.layer'), hint = $('.layer .hint'), sel = $('.sel'), panel = $('.panel');

  // ---------- Хранилище ----------
  function save() {
    chrome.storage.local.set({ [STORE_KEY]: {
      region: state.region, bull: state.bull, bear: state.bear, tol: state.tol,
      show: state.show, lastForming: state.lastForming, payout: state.payout,
    } });
  }
  function load() {
    return chrome.storage.local.get(STORE_KEY).then((o) => {
      const s = o[STORE_KEY];
      if (s) Object.assign(state, s, { show: Object.assign({}, state.show, s.show) });
    }).catch(() => {});
  }

  // ---------- Захват ----------
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // hide=true — спрятать свою разметку на время снимка (нужно только для пипетки).
  // При сканировании разметку не прячем (нет мигания), а вырезаем её маской — см. cropRegion.
  async function captureScreen(hide) {
    if (hide) { host.style.visibility = 'hidden'; await raf(); await raf(); await sleep(20); }
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'cs-capture' });
    } finally {
      if (hide) host.style.visibility = 'visible';
    }
    if (!resp || !resp.ok) throw new Error(resp ? resp.error : 'нет ответа от расширения');
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = resp.dataUrl; });
    const scale = img.naturalWidth / window.innerWidth;
    return { img, scale };
  }

  function cropRegion(img, scale, r) {
    const w = Math.max(1, Math.round(r.w * scale)), h = Math.max(1, Math.round(r.h * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    const sx = Math.round(r.x * scale), sy = Math.round(r.y * scale);
    cx.drawImage(img, sx, sy, w, h, 0, 0, w, h);
    const data = cx.getImageData(0, 0, w, h);

    // Маска: всё, что на снимке нарисовано нами (разметка и панель)
    const mask = new Uint8Array(w * h);
    const m = document.createElement('canvas');
    m.width = w; m.height = h;
    const mx = m.getContext('2d', { willReadFrequently: true });
    const k = ov.width / window.innerWidth;
    if (ov.width && ov.height) mx.drawImage(ov, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, w, h);
    mx.fillStyle = '#000';
    for (const el of [panel, layer, sel]) { // у скрытых элементов размер 0 — они пропускаются
      const b = el.getBoundingClientRect();
      if (b.width && b.height) mx.fillRect((b.left - r.x) * scale - 2, (b.top - r.y) * scale - 2, b.width * scale + 4, b.height * scale + 4);
    }
    const a = mx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < w * h; i++) if (a[i * 4 + 3] > 0) mask[i] = 1;
    // Расширяем на 1px — сглаженные края линий и текста
    const out = mask.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x > 0) out[y * w + x - 1] = 1; if (x < w - 1) out[y * w + x + 1] = 1;
      if (y > 0) out[(y - 1) * w + x] = 1; if (y < h - 1) out[(y + 1) * w + x] = 1;
    }
    return { data, mask: out };
  }

  // ---------- Сканирование ----------
  async function scan() {
    if (state.busy) return;
    if (!state.region) { setStatus('Сначала выберите область графика.'); return; }
    state.busy = true;
    try {
      const { img, scale } = await captureScreen(false);
      const { data, mask } = cropRegion(img, scale, state.region);
      if (!state.bull || !state.bear) {
        const c = A.autoDetectColors(data);
        state.bull = state.bull || c.bull;
        state.bear = state.bear || c.bear;
        save(); syncUI();
        if (!state.bull || !state.bear) { setStatus('Не удалось определить цвета свечей — укажите их пипеткой.'); return; }
      }
      const t0 = performance.now();
      const det = A.detectCandles(data, state.bull, state.bear, { tol: state.tol, mask });
      const res = A.analyze(det.candles, { lastForming: state.lastForming });
      updateSession(det, res);
      state.result = { det, res, scale, ms: Math.round(performance.now() - t0) };
      render();
      report();
    } catch (e) {
      setStatus('Ошибка: ' + (e.message || e));
      if (state.auto) toggleAuto(false);
    } finally {
      state.busy = false;
    }
  }

  let autoTimer = null;
  function toggleAuto(on) {
    state.auto = on === undefined ? !state.auto : on;
    clearInterval(autoTimer);
    if (state.auto) { scan(); autoTimer = setInterval(scan, AUTO_MS); }
    syncUI();
  }

  // ---------- Отрисовка ----------
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    ov.width = Math.round(window.innerWidth * dpr);
    ov.height = Math.round(window.innerHeight * dpr);
    ov.style.width = window.innerWidth + 'px';
    ov.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function render() {
    sizeCanvas();
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const r = state.region;
    if (!r) return;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(160,170,180,.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + .5, r.y + .5, r.w, r.h);
    ctx.restore();
    if (!state.result) return;

    const { det, res, scale } = state.result;
    const cs = det.candles;
    const H = Math.round(r.h * scale);
    const X = (px) => r.x + px / scale;            // пиксель скриншота → CSS
    const Yv = (v) => r.y + (H - v) / scale;       // значение (вверх = больше) → CSS
    const xAt = (i) => X(cs[i].xc);

    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();

    if (state.show.debug) {
      ctx.lineWidth = 1;
      cs.forEach((c, i) => {
        ctx.strokeStyle = i > res.lastIdx ? 'rgba(255,255,255,.6)' : 'rgba(0,200,255,.8)';
        ctx.strokeRect(X(c.x0) - 1, Yv(c.h) - 1, (c.x1 - c.x0 + 1) / scale + 2, (c.h - c.l) / scale + 2);
      });
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      (res.pivots ? res.pivots.highs : []).forEach((p) => ctx.fillRect(xAt(p.i) - 2, Yv(p.v) - 6, 4, 4));
      (res.pivots ? res.pivots.lows : []).forEach((p) => ctx.fillRect(xAt(p.i) - 2, Yv(p.v) + 2, 4, 4));
    }

    if (state.show.levels) {
      res.levels.forEach((lv) => {
        const y = Math.round(Yv(lv.v)) + .5;
        const col = lv.kind === 'support' ? '77,163,255' : '255,159,67';
        ctx.strokeStyle = `rgba(${col},${Math.min(.95, .45 + lv.touches * .12)})`;
        ctx.lineWidth = Math.min(3, 1 + (lv.touches - 2) * .5);
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(xAt(lv.first) - 10, y); ctx.lineTo(r.x + r.w, y); ctx.stroke();
        ctx.setLineDash([]);
        label(`${lv.kind === 'support' ? 'S' : 'R'} ×${lv.touches}`, r.x + r.w - 4, y - 3, `rgb(${col})`, 'right');
      });
    }

    if (state.show.trend) {
      res.trendlines.forEach((t) => {
        const col = t.kind === 'up' ? '#ffd400' : '#e056fd';
        const x1 = xAt(t.i1), x2 = xAt(t.i2);
        const y1 = Yv(t.v1), y2 = Yv(t.v2);
        const ext = 40; // немного продлеваем вправо
        const k = (y2 - y1) / Math.max(1, x2 - x1);
        ctx.strokeStyle = col; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2 + ext, y2 + k * ext); ctx.stroke();
        label((t.kind === 'up' ? 'Тренд ↑' : 'Тренд ↓') + (t.broken ? ' (пробой?)' : ''), x2 + ext, y2 + k * ext + (t.kind === 'up' ? 14 : -6), col, 'right');
      });
    }

    if (state.show.patterns) {
      const stack = new Map();
      const minI = state.show.history ? 0 : res.lastIdx - RECENT + 1;
      visiblePatterns(res).filter((p) => p.i >= minI).forEach((p) => {
        const c = cs[p.i];
        const n = stack.get(p.i) || 0; stack.set(p.i, n + 1);
        const col = p.dir > 0 ? '#4cd38a' : p.dir < 0 ? '#ff6b6b' : '#c9d1d9';
        const mark = p.outcome === 'win' ? ' ✓' : p.outcome === 'loss' ? ' ✗' : p.outcome === 'pending' ? ' ?' : '';
        const text = (p.strength >= 3 ? '★ ' : '') + p.short + mark;
        const x = X(c.xc);
        // подсветка свечей паттерна
        const i0 = p.i - p.len + 1;
        const left = X(cs[i0].x0) - 2, right = X(c.x1) + 2;
        let hi = -Infinity, lo = Infinity;
        for (let j = i0; j <= p.i; j++) { hi = Math.max(hi, cs[j].h); lo = Math.min(lo, cs[j].l); }
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
        ctx.strokeRect(left, Yv(hi) - 2, right - left, (hi - lo) / scale + 4);
        ctx.setLineDash([]);
        if (p.dir > 0) label(text, x, Yv(lo) + 14 + n * 13, col, 'center');
        else label(text, x, Yv(hi) - 6 - n * 13, col, 'center');
      });
    }

    // Плашка в правом верхнем углу области: оценка следующей свечи
    const v = verdict(session.stats);
    if (v || (session.stats && session.stats.n < WARMUP)) {
      ctx.font = '700 13px system-ui, sans-serif';
      let text, bg;
      if (!v) { text = `Прогрев ${session.stats.n}/${WARMUP}`; bg = 'rgba(120,100,20,.9)'; }
      else if (v.edge) { text = `${v.dir > 0 ? '▲ Чаще росла' : '▼ Чаще падала'}: ${Math.round((v.dir > 0 ? v.pUp : 1 - v.pUp) * 100)}% из ${v.n} · ${v.src}`; bg = v.dir > 0 ? 'rgba(30,140,80,.92)' : 'rgba(190,50,50,.92)'; }
      else if (!v.src) { text = 'Мало похожих случаев · пропуск'; bg = 'rgba(60,66,78,.92)'; }
      else { text = `Как монетка: рост ${Math.round(v.pUp * 100)}% из ${v.n} · пропуск`; bg = 'rgba(60,66,78,.92)'; }
      const tw = ctx.measureText(text).width + 16;
      const bx = r.x + r.w - tw - 8, by = r.y + 8;
      ctx.fillStyle = bg; ctx.fillRect(bx, by, tw, 24);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(text, bx + 8, by + 17);
    }
    ctx.restore();
  }

  function label(text, x, y, color, align) {
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = align || 'left';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,12,16,.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  }

  function setStatus(html) { $('[data-out=status]').innerHTML = html; }

  function report() {
    const { det, res, ms } = state.result;
    const n = det.candles.length;
    const tcls = res.trend.dir > 0 ? 'up' : res.trend.dir < 0 ? 'dn' : 'nt';
    let s = `Свечей: <b>${n}</b> · ширина ~${det.medianWidth}px · ${ms} мс<br>` +
      `Тренд (${res.trend.bars || 0} св.): <span class="${tcls}">${res.trend.label}</span> · уровней: ${res.levels.length} · линий: ${res.trendlines.length}`;
    det.warnings.forEach((w) => { s += `<br><span class="warn">⚠ ${w}</span>`; });
    setStatus(s);

    $('[data-out=session]').innerHTML = sessionHTML();

    const vis = visiblePatterns(res);
    const arrow =(p) => p.dir > 0 ? '▲' : p.dir < 0 ? '▼' : '●';
    const dcls = (p) => p.dir > 0 ? 'up' : p.dir < 0 ? 'dn' : 'nt';
    const stars = (p) => '★'.repeat(p.strength) + '☆'.repeat(3 - p.strength);
    const res3 = (p) => p.outcome === 'win' ? '<span class="ok">✓</span>' : p.outcome === 'loss' ? '<span class="bad">✗</span>' : p.outcome === 'pending' ? '<span class="wait">ждёт</span>' : '';

    // Сейчас: паттерны, завершившиеся на последней закрытой свече
    const now = vis.filter((p) => p.i === res.lastIdx);
    $('[data-out=now]').innerHTML = now.length
      ? now.map((p) => `<div><b class="${dcls(p)}">${arrow(p)} ${p.name}</b> <span title="Сила: базовая значимость + бонус у уровня">${stars(p)}</span>` +
          `${p.atLevel ? ` · у уровня ${p.atLevel}` : ''}<div class="h">${p.hint}</div></div>`).join('<div style="height:6px"></div>')
      : '<span class="st">Значимых паттернов нет. Ждём.</span>';

    const items = [...vis].sort((a, b) => b.i - a.i).slice(0, 15).map((p) => {
      const ago = res.lastIdx - p.i;
      return `<div title="${p.hint}"><span class="${dcls(p)}">${arrow(p)} ${p.name}</span> ${stars(p)} — ${ago === 0 ? 'сейчас' : ago + ' св. назад'} ${res3(p)}</div>`;
    });
    $('[data-out=list]').innerHTML = items.length ? items.join('') : '<div class="st">Паттерны не найдены</div>';

    const keys = new Set(vis.map((p) => p.key));
    const st = res.stats.filter((s) => keys.has(s.key)).map((s) => {
      const pct = Math.round((s.win / s.n) * 100);
      const c = s.n < 5 ? 'st' : pct >= 60 ? 'ok' : pct <= 40 ? 'bad' : 'nt';
      return `<div><span class="${s.dir > 0 ? 'up' : 'dn'}">${s.dir > 0 ? '▲' : '▼'} ${s.name}</span><span class="${c}">${s.win}/${s.n} · ${pct}%</span></div>`;
    });
    $('[data-out=stats]').innerHTML = st.length
      ? st.join('') + '<div class="disc" style="display:block">Как часто следующая свеча закрывалась в сторону паттерна. Меньше 5 случаев (серым) — выборка слишком мала. Прошлое на этом графике не гарантирует будущего.</div>'
      : '<div class="st">Недостаточно данных</div>';
  }

  function sessionHTML() {
    const ss = session.stats;
    if (!ss) return '<span class="st">Нет данных</span>';
    const pct = (x) => Math.round(x * 100) + '%';
    const rng = (ci) => `(${pct(ci[0])}–${pct(ci[1])})`;
    const lines = [];
    const v = verdict(ss);
    if (!v) lines.push(`<b class="wait">Прогрев: ${ss.n}/${WARMUP} свечей</b>`);
    else if (v.edge) lines.push(`<b class="${v.dir > 0 ? 'up' : 'dn'}">${v.dir > 0 ? '▲ Следующая чаще росла' : '▼ Следующая чаще падала'}</b> — ${v.src}<div class="h">Даже с поправкой на маленькую выборку это выше порога безубыточности ${(ss.breakeven * 100).toFixed(1)}%.</div>`);
    else if (!v.src) lines.push(`<b class="nt">Мало похожих случаев — пропуск</b><div class="h">В сессии пока меньше ${MIN_N} таких же ситуаций, оценивать не по чему.</div>`);
    else lines.push(`<b class="nt">Как монетка — пропуск</b><div class="h">${v.src}: следующая росла в ${Math.round(v.pUp * 100)}% из ${v.n} случаев. Реальная доля может быть от ${Math.round(v.ci[0] * 100)}% до ${Math.round(v.ci[1] * 100)}% — это не даёт уверенно пройти порог ${(ss.breakeven * 100).toFixed(1)}%.</div>`);

    if (ss.run) {
      const c = ss.run.col > 0 ? '<span class="up">▲</span>' : '<span class="dn">▼</span>';
      const sameP = ss.run.n ? ss.run.same / ss.run.n : 0;
      lines.push(`После серии ${ss.run.lenLabel}${c} следующая была того же цвета: ${ss.run.same} из ${ss.run.n}` +
        (ss.run.n ? ` · ${pct(sameP)}` : '') + (ss.run.n < MIN_N ? ' <span class="st">(мало)</span>' : ''));
    }
    ss.patterns.forEach((p) => {
      lines.push(`<span class="${p.dir > 0 ? 'up' : 'dn'}">${p.name}</span>: срабатывал ${p.win} из ${p.n}` +
        (p.n ? ` · ${pct(p.p)} ${rng(p.ci)}` : '') + (p.n < MIN_N ? ' <span class="st">(мало)</span>' : ''));
    });
    if (ss.base) lines.push(`<span class="st">Всего в сессии: растущих ${pct(ss.base.p)} из ${ss.base.n} · порог при выплате ${state.payout}%: ${(ss.breakeven * 100).toFixed(1)}%</span>`);
    const sync = session.misses ? `<span class="warn">синхронизация потеряна (${session.misses}/3)</span>` : '<span class="ok">● запись идёт</span>';
    lines.push(`<span class="st">В памяти: ${ss.n} свечей (с экрана ${session.seeded} + новых ${session.live}) · ${sync}</span>`);
    return lines.join('<div style="height:4px"></div>');
  }

  // Слабые паттерны (сила 1) показываем, только если включено «Слабые»
  function visiblePatterns(res) {
    return res.patterns.filter((p) => state.show.weak || p.strength >= 2);
  }

  // ---------- Выбор области и пипетка ----------
  function selectRegion() {
    if (state.auto) toggleAuto(false);
    hint.textContent = 'Обведите область свечей (без шкал цены/времени). Esc — отмена';
    layer.style.display = 'block';
    panel.style.display = 'none';
    let start = null;
    const done = () => {
      layer.style.display = 'none'; sel.style.display = 'none'; panel.style.display = '';
      layer.onmousedown = layer.onmousemove = layer.onmouseup = null;
      window.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
    window.addEventListener('keydown', onKey, true);
    layer.onmousedown = (e) => { start = { x: e.clientX, y: e.clientY }; e.preventDefault(); };
    layer.onmousemove = (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
      Object.assign(sel.style, { display: 'block', left: x + 'px', top: y + 'px', width: Math.abs(e.clientX - start.x) + 'px', height: Math.abs(e.clientY - start.y) + 'px' });
    };
    layer.onmouseup = (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
      const w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
      done();
      if (w < 40 || h < 40) { setStatus('Область слишком маленькая.'); return; }
      state.region = { x, y, w, h };
      state.result = null;
      session = newSession();
      save(); render();
      scan();
    };
  }

  async function pickColor(which) {
    if (state.auto) toggleAuto(false);
    let shot;
    try { shot = await captureScreen(true); } catch (e) { setStatus('Ошибка захвата: ' + e.message); return; }
    const c = document.createElement('canvas');
    c.width = shot.img.naturalWidth; c.height = shot.img.naturalHeight;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(shot.img, 0, 0);
    hint.textContent = `Кликните по телу ${which === 'bull' ? 'растущей' : 'падающей'} свечи. Esc — отмена`;
    layer.style.display = 'block'; layer.style.background = 'transparent';
    const done = () => {
      layer.style.display = 'none'; layer.style.background = '';
      layer.onclick = null; window.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
    window.addEventListener('keydown', onKey, true);
    layer.onclick = (e) => {
      const px = Math.round(e.clientX * shot.scale), py = Math.round(e.clientY * shot.scale);
      const d = cx.getImageData(Math.max(0, px - 1), Math.max(0, py - 1), 3, 3).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < 9; i++) { r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; }
      state[which] = [Math.round(r / 9), Math.round(g / 9), Math.round(b / 9)];
      done(); save(); syncUI();
      if (state.region) scan();
    };
  }

  // ---------- UI ----------
  function syncUI() {
    const rgb = (c) => c ? `rgb(${c[0]},${c[1]},${c[2]})` : 'transparent';
    $('[data-sw=bull]').style.background = rgb(state.bull);
    $('[data-sw=bear]').style.background = rgb(state.bear);
    $('[data-k=tol]').value = state.tol;
    $('[data-k=payout]').value = state.payout;
    $('[data-v=tol]').textContent = state.tol;
    ['patterns', 'levels', 'trend', 'debug', 'weak', 'history'].forEach((k) => { $(`[data-c=${k}]`).checked = state.show[k]; });
    $('[data-c=lastForming]').checked = state.lastForming;
    const ab = $('[data-a=auto]');
    ab.classList.toggle('on', state.auto);
    ab.textContent = state.auto ? 'Авто ■' : 'Авто ▶';
  }

  panel.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]');
    if (!a) return;
    switch (a.dataset.a) {
      case 'close': api.toggle(); break;
      case 'region': selectRegion(); break;
      case 'scan': scan(); break;
      case 'auto': toggleAuto(); break;
      case 'pick-bull': pickColor('bull'); break;
      case 'pick-bear': pickColor('bear'); break;
      case 'autocolor': state.bull = state.bear = null; save(); syncUI(); scan(); break;
      case 'reset': session = newSession(); scan(); break;
    }
  });
  panel.addEventListener('change', (e) => {
    const c = e.target.dataset.c;
    if (c === 'lastForming') { state.lastForming = e.target.checked; save(); scan(); return; }
    if (c) { state.show[c] = e.target.checked; save(); render(); if (state.result) report(); }
  });
  $('[data-k=tol]').addEventListener('input', (e) => { state.tol = +e.target.value; $('[data-v=tol]').textContent = state.tol; });
  $('[data-k=tol]').addEventListener('change', () => { save(); scan(); });
  $('[data-k=payout]').addEventListener('change', (e) => {
    state.payout = Math.max(1, Math.min(200, +e.target.value || 92));
    save();
    if (session.seq.length) session.stats = A.sessionStats(session.seq, state.payout);
    if (state.result) { render(); report(); }
  });

  // Перетаскивание панели
  (function drag() {
    const hd = $('.hd');
    let d = null;
    hd.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      d = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!d) return;
      Object.assign(panel.style, { left: (e.clientX - d.dx) + 'px', top: (e.clientY - d.dy) + 'px', right: 'auto', bottom: 'auto' });
    });
    window.addEventListener('mouseup', () => { d = null; });
  })();

  window.addEventListener('resize', () => render());

  const api = {
    toggle() {
      const hidden = host.style.display === 'none';
      host.style.display = hidden ? '' : 'none';
      if (!hidden && state.auto) toggleAuto(false);
    },
  };
  window.__candleScanner = api;

  load().then(() => { syncUI(); render(); if (state.region) scan(); });
})();
