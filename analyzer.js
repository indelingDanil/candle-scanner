// Ядро анализа: распознавание свечей на картинке и поиск паттернов/уровней/трендов.
// Работает с объектом вида ImageData { data, width, height } — и в браузере, и в Node (для тестов).
// Все "цены" здесь в пикселях: value = height - y (чем выше на экране, тем больше значение).
(function (root) {
  'use strict';

  // ---------- Цвета ----------

  function dist(r, g, b, c) {
    const dr = r - c[0], dg = g - c[1], db = b - c[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  // Ищет два самых частых насыщенных цвета: "зелёный" (рост) и "красный" (падение).
  function autoDetectColors(img) {
    const { data, width, height } = img;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 250000)));
    const buckets = new Map();
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const p = (y * width + x) * 4;
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx < 60 || (mx - mn) / mx < 0.35) continue; // фон, сетка, текст
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        let bk = buckets.get(key);
        if (!bk) { bk = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, bk); }
        bk.n++; bk.r += r; bk.g += g; bk.b += b;
      }
    }
    const list = [...buckets.values()]
      .map((k) => ({ n: k.n, c: [Math.round(k.r / k.n), Math.round(k.g / k.n), Math.round(k.b / k.n)] }))
      .sort((a, b) => b.n - a.n);
    const bull = list.find((k) => k.c[1] > k.c[0] + 30);
    const bear = list.find((k) => k.c[0] > k.c[1] + 30 && k.c[0] > k.c[2]);
    return { bull: bull ? bull.c : null, bear: bear ? bear.c : null };
  }

  // ---------- Распознавание свечей ----------

  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  /**
   * @param img ImageData-подобный объект (область графика)
   * @param bull [r,g,b] цвет растущей свечи
   * @param bear [r,g,b] цвет падающей свечи
   * @param opts { tol: допуск по цвету (евклидово RGB) }
   */
  function detectCandles(img, bull, bear, opts) {
    const tol = (opts && opts.tol) || 60;
    const mask = opts && opts.mask; // Uint8Array W*H: 1 — пиксель закрыт нашей разметкой
    const { data, width: W, height: H } = img;
    const cls = new Uint8Array(W * H); // 0 — ничего, 1 — рост, 2 — падение, 3 — неизвестно (под разметкой)
    const colBull = new Uint32Array(W), colBear = new Uint32Array(W);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, p = i * 4;
        if (mask && mask[i]) { cls[i] = 3; continue; }
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const d1 = bull ? dist(r, g, b, bull) : 1e9;
        const d2 = bear ? dist(r, g, b, bear) : 1e9;
        if (d1 < tol || d2 < tol) cls[i] = d1 <= d2 ? 1 : 2;
      }
    }

    // Плашки сделок, линии ордеров и т.п. того же цвета, что свечи: свеча узкая, а они тянутся по горизонтали.
    // Находим горизонтальные отрезки шире 3 свечей, объединяем в прямоугольники и помечаем как «неизвестно».
    {
      const lens = [];
      for (let y = 0; y < H; y += 2) {
        let x = 0;
        while (x < W) {
          const c = cls[y * W + x];
          if (c !== 1 && c !== 2) { x++; continue; }
          const x0 = x;
          while (x < W && cls[y * W + x] === c) x++;
          if (x - x0 >= 3) lens.push(x - x0);
        }
      }
      const estW = median(lens) || 5;
      const thr = Math.max(24, Math.round(estW * 3));
      const boxes = [];
      for (let y = 0; y < H; y++) {
        let x = 0;
        while (x < W) {
          const c = cls[y * W + x];
          if (c !== 1 && c !== 2) { x++; continue; }
          const x0 = x;
          while (x < W && cls[y * W + x] === c) x++;
          if (x - x0 <= thr) continue;
          const x1 = x - 1;
          // строки с текстом внутри плашки разрывают отрезки — поэтому допускаем разрыв по вертикали
          const b = boxes.find((B) => y - B.y1 <= 16 && Math.min(x1, B.x1) - Math.max(x0, B.x0) >= 0.5 * Math.min(x1 - x0, B.x1 - B.x0));
          if (b) { b.y1 = y; b.x0 = Math.min(b.x0, x0); b.x1 = Math.max(b.x1, x1); }
          else boxes.push({ x0, x1, y0: y, y1: y });
        }
      }
      for (const b of boxes)
        for (let y = b.y0; y <= b.y1; y++)
          for (let x = b.x0; x <= b.x1; x++) cls[y * W + x] = 3;
    }

    // Восстанавливаем «неизвестные» пиксели: если сверху и снизу одна и та же свеча — продолжаем её
    {
      for (let x = 0; x < W; x++) {
        let y = 0;
        while (y < H) {
          if (cls[y * W + x] !== 3) { y++; continue; }
          const y0 = y;
          while (y < H && cls[y * W + x] === 3) y++;
          const above = y0 > 0 ? cls[(y0 - 1) * W + x] : 0;
          const below = y < H ? cls[y * W + x] : 0;
          const fill = above === below && above !== 3 ? above : 0;
          for (let k = y0; k < y; k++) cls[k * W + x] = fill;
        }
      }
    }

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = cls[y * W + x];
        if (c === 1) colBull[x]++; else if (c === 2) colBear[x]++;
      }
    }

    // Тип столбца по большинству пикселей
    const colType = new Uint8Array(W);
    for (let x = 0; x < W; x++) {
      const n = colBull[x] + colBear[x];
      if (n >= 1) colType[x] = colBull[x] >= colBear[x] ? 1 : 2;
    }

    // Группируем соседние столбцы одного типа в сегменты (кандидаты в свечи)
    const segs = [];
    for (let x = 0; x < W; x++) {
      const t = colType[x];
      if (!t) continue;
      const last = segs[segs.length - 1];
      if (last && last.t === t && last.x1 === x - 1) last.x1 = x;
      else segs.push({ t, x0: x, x1: x });
    }

    const rowW = new Uint16Array(H);
    let candles = [];
    for (const s of segs) {
      const w = s.x1 - s.x0 + 1;
      rowW.fill(0);
      let peakY = -1, peakW = 0;
      for (let y = 0; y < H; y++) {
        let c = 0;
        for (let x = s.x0; x <= s.x1; x++) if (cls[y * W + x] === s.t) c++;
        rowW[y] = c;
        if (c > peakW) { peakW = c; peakY = y; }
      }
      if (peakY < 0) continue;
      // Расширяемся от самой широкой строки вверх/вниз, допуская разрывы до 2px
      const GAP = 2;
      let top = peakY, bot = peakY, gap = 0;
      for (let y = peakY - 1; y >= 0; y--) {
        if (rowW[y] > 0) { top = y; gap = 0; } else if (++gap > GAP) break;
      }
      gap = 0;
      for (let y = peakY + 1; y < H; y++) {
        if (rowW[y] > 0) { bot = y; gap = 0; } else if (++gap > GAP) break;
      }
      // Тело — строки, где ширина близка к максимальной; тени — узкие строки
      let bodyTop = top, bodyBot = bot;
      if (w >= 3) {
        const th = Math.max(2, Math.ceil(peakW * 0.6));
        bodyTop = -1; bodyBot = -1;
        for (let y = top; y <= bot; y++) {
          if (rowW[y] >= th) { if (bodyTop < 0) bodyTop = y; bodyBot = y; }
        }
        if (bodyTop < 0) { bodyTop = peakY; bodyBot = peakY; }
      }
      candles.push({
        type: s.t === 1 ? 'bull' : 'bear',
        x0: s.x0, x1: s.x1, xc: (s.x0 + s.x1) / 2, w,
        top, bot, bodyTop, bodyBot,
      });
    }

    // Отсев мусора: слишком широкие (плашки цены, текст) и слишком узкие сегменты
    const warnings = [];
    let mw = median(candles.map((c) => c.w));
    const before = candles.length;
    candles = candles.filter((c) => c.w <= mw * 2.2 + 1 && c.w >= Math.max(1, mw * 0.45) && (c.bot - c.top) >= 1);
    if (before - candles.length > 0) warnings.push(`Отброшено ${before - candles.length} объектов, не похожих на свечи`);
    mw = median(candles.map((c) => c.w));
    if (candles.length && mw < 3) warnings.push('Свечи слишком узкие (<3px): тела и тени не различить, увеличьте масштаб графика');
    if (candles.length < 10) warnings.push('Найдено мало свечей — проверьте область и цвета');

    // Переводим в OHLC (в пикселях, вверх = больше)
    for (const c of candles) {
      c.h = H - c.top;
      c.l = H - c.bot;
      const bh = H - c.bodyTop, bl = H - c.bodyBot;
      if (c.type === 'bull') { c.o = bl; c.c = bh; } else { c.o = bh; c.c = bl; }
    }

    // Свечи идут с равным шагом. Дыра в ряду = свечи, полностью закрытые чем-то (плашкой сделки и т.п.).
    // Вставляем на их место «скрытые» свечи, чтобы не сбивался счёт свечей.
    if (candles.length >= 10) {
      const step = median(candles.slice(1).map((c, i) => c.xc - candles[i].xc));
      if (step > 0) {
        const out = [candles[0]];
        let hidden = 0;
        for (let i = 1; i < candles.length; i++) {
          const prev = candles[i - 1], gap = candles[i].xc - prev.xc;
          const miss = Math.round(gap / step) - 1;
          if (miss >= 1 && miss <= 6 && Math.abs(gap - (miss + 1) * step) <= step * 0.35) {
            for (let m = 1; m <= miss; m++) {
              const xc = prev.xc + m * step;
              out.push({ type: 'hidden', hidden: true, x0: Math.round(xc - mw / 2), x1: Math.round(xc + mw / 2), xc, w: mw,
                top: prev.top, bot: prev.top, bodyTop: prev.top, bodyBot: prev.top, h: prev.c, l: prev.c, o: prev.c, c: prev.c });
              hidden++;
            }
          }
          out.push(candles[i]);
        }
        if (hidden) warnings.push(`Свечей закрыто чем-то на графике: ${hidden} (плашка сделки?) — они не участвуют в паттернах`);
        candles = out;
      }
    }
    return { candles, medianWidth: mw, warnings };
  }

  // ---------- Анализ ----------

  // weight: базовая значимость по классике (1 — слабый/частый, 3 — сильный/редкий)
  const HINT_UP = 'Возможный разворот вверх. Классическое подтверждение — следующая свеча закрывается выше максимума паттерна.';
  const HINT_DN = 'Возможный разворот вниз. Классическое подтверждение — следующая свеча закрывается ниже минимума паттерна.';
  const P = {
    doji:            { name: 'Доджи', short: 'Доджи', dir: 0, weight: 1, hint: 'Нерешительность: силы покупателей и продавцов равны. Сам по себе направления не даёт.' },
    dragonfly:       { name: 'Доджи «стрекоза»', short: 'Стрекоза', dir: 1, weight: 1, hint: 'Цену продавили вниз, но вернули к открытию. ' + HINT_UP },
    gravestone:      { name: 'Доджи «надгробие»', short: 'Надгробие', dir: -1, weight: 1, hint: 'Цену подняли, но вернули к открытию. ' + HINT_DN },
    hammer:          { name: 'Молот', short: 'Молот', dir: 1, weight: 2, hint: 'Длинная нижняя тень после падения: продавцов выкупили. ' + HINT_UP },
    hangingMan:      { name: 'Повешенный', short: 'Повешен.', dir: -1, weight: 2, hint: 'Форма молота, но после роста: признак слабости покупателей. ' + HINT_DN },
    invHammer:       { name: 'Перевёрнутый молот', short: 'Перев.молот', dir: 1, weight: 2, hint: 'Длинная верхняя тень после падения: первая попытка покупателей. ' + HINT_UP },
    shootingStar:    { name: 'Падающая звезда', short: 'Пад.звезда', dir: -1, weight: 2, hint: 'Длинная верхняя тень после роста: рост отвергнут. ' + HINT_DN },
    marubozuBull:    { name: 'Бычье марубозу', short: 'Марубозу', dir: 1, weight: 1, hint: 'Сильная свеча без теней: импульс покупателей. Это продолжение, а не разворот.' },
    marubozuBear:    { name: 'Медвежье марубозу', short: 'Марубозу', dir: -1, weight: 1, hint: 'Сильная свеча без теней: импульс продавцов. Это продолжение, а не разворот.' },
    engulfBull:      { name: 'Бычье поглощение', short: 'Поглощ.', dir: 1, weight: 2, hint: 'Тело растущей свечи перекрыло тело предыдущей падающей. ' + HINT_UP },
    engulfBear:      { name: 'Медвежье поглощение', short: 'Поглощ.', dir: -1, weight: 2, hint: 'Тело падающей свечи перекрыло тело предыдущей растущей. ' + HINT_DN },
    haramiBull:      { name: 'Бычий харами', short: 'Харами', dir: 1, weight: 1, hint: 'Маленькая свеча внутри тела большой падающей: падение замедляется. ' + HINT_UP },
    haramiBear:      { name: 'Медвежий харами', short: 'Харами', dir: -1, weight: 1, hint: 'Маленькая свеча внутри тела большой растущей: рост замедляется. ' + HINT_DN },
    piercing:        { name: 'Просвет в облаках', short: 'Просвет', dir: 1, weight: 2, hint: 'Растущая свеча закрылась выше середины предыдущей падающей. ' + HINT_UP },
    darkCloud:       { name: 'Завеса из тёмных облаков', short: 'Т.облака', dir: -1, weight: 2, hint: 'Падающая свеча закрылась ниже середины предыдущей растущей. ' + HINT_DN },
    tweezerBottom:   { name: 'Пинцет (дно)', short: 'Пинцет', dir: 1, weight: 1, hint: 'Два одинаковых минимума подряд: уровень удержали. ' + HINT_UP },
    tweezerTop:      { name: 'Пинцет (вершина)', short: 'Пинцет', dir: -1, weight: 1, hint: 'Два одинаковых максимума подряд: уровень не пробили. ' + HINT_DN },
    morningStar:     { name: 'Утренняя звезда', short: 'Утр.звезда', dir: 1, weight: 3, hint: 'Большая падающая, маленькая свеча, большая растущая. ' + HINT_UP },
    eveningStar:     { name: 'Вечерняя звезда', short: 'Веч.звезда', dir: -1, weight: 3, hint: 'Большая растущая, маленькая свеча, большая падающая. ' + HINT_DN },
    threeSoldiers:   { name: 'Три белых солдата', short: '3 солдата', dir: 1, weight: 2, hint: 'Три уверенные растущие свечи подряд: сильное давление покупателей.' },
    threeCrows:      { name: 'Три чёрные вороны', short: '3 вороны', dir: -1, weight: 2, hint: 'Три уверенные падающие свечи подряд: сильное давление продавцов.' },
  };

  const rng = (k) => k.h - k.l;
  const body = (k) => Math.abs(k.c - k.o);
  const upper = (k) => k.h - Math.max(k.o, k.c);
  const lower = (k) => Math.min(k.o, k.c) - k.l;
  const isBull = (k) => k.c > k.o;
  const isBear = (k) => k.c < k.o;
  const mid = (k) => (k.h + k.l) / 2;

  function avgOver(cs, i, n, fn) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - n); j < i; j++) { if (cs[j].hidden) continue; s += fn(cs[j]); c++; }
    if (!c) { for (let j = 0; j < cs.length; j++) { if (cs[j].hidden) continue; s += fn(cs[j]); c++; } }
    return c ? s / c : 1;
  }

  // Тренд перед свечой i: смещение середины свечей за n баров, нормированное на средний диапазон
  function trendBefore(cs, i, n, avgR) {
    if (i - n < 0) return 0;
    const d = (mid(cs[i - 1]) - mid(cs[i - n])) / Math.max(1, avgR);
    return d > 1 ? 1 : d < -1 ? -1 : 0;
  }

  function findPatterns(cs, lastIdx) {
    const out = [];
    const add = (i, key, len) => out.push({ i, len, key, ...P[key] });
    for (let i = 0; i <= lastIdx; i++) {
      const k = cs[i];
      if (k.hidden) continue;
      const aR = avgOver(cs, i, 14, rng), aB = Math.max(1, avgOver(cs, i, 14, body));
      const eps = Math.max(1, 0.05 * aR);
      const tr = trendBefore(cs, i, 5, aR);
      const r = rng(k), b = body(k), up = upper(k), lo = lower(k);

      // --- Одиночные свечи ---
      if (r >= 0.3 * aR && r > 0) {
        if (b <= 0.1 * r) {
          if (lo >= 0.7 * r) add(i, 'dragonfly', 1);
          else if (up >= 0.7 * r) add(i, 'gravestone', 1);
          else add(i, 'doji', 1);
        } else if (r >= 0.5 * aR) {
          if (lo >= 2 * b && up <= 0.15 * r) {
            if (tr < 0) add(i, 'hammer', 1); else if (tr > 0) add(i, 'hangingMan', 1);
          } else if (up >= 2 * b && lo <= 0.15 * r) {
            if (tr < 0) add(i, 'invHammer', 1); else if (tr > 0) add(i, 'shootingStar', 1);
          } else if (b >= 0.9 * r && r >= 1.3 * aR) {
            add(i, isBull(k) ? 'marubozuBull' : 'marubozuBear', 1);
          }
        }
      }

      // --- Двухсвечные ---
      if (i >= 1 && !cs[i - 1].hidden) {
        const p = cs[i - 1];
        const bp = body(p);
        if (isBear(p) && isBull(k) && b > bp && bp >= 0.2 * aB && k.o <= p.c + eps && k.c >= p.o && tr <= 0) add(i, 'engulfBull', 2);
        if (isBull(p) && isBear(k) && b > bp && bp >= 0.2 * aB && k.o >= p.c - eps && k.c <= p.o && tr >= 0) add(i, 'engulfBear', 2);

        if (isBear(p) && bp >= aB && Math.max(k.o, k.c) <= p.o && Math.min(k.o, k.c) >= p.c && b <= 0.6 * bp && b > 0 && tr < 0) add(i, 'haramiBull', 2);
        if (isBull(p) && bp >= aB && Math.max(k.o, k.c) <= p.c && Math.min(k.o, k.c) >= p.o && b <= 0.6 * bp && b > 0 && tr > 0) add(i, 'haramiBear', 2);

        if (isBear(p) && bp >= aB && isBull(k) && k.o <= p.c + eps && k.c > (p.o + p.c) / 2 && k.c < p.o) add(i, 'piercing', 2);
        if (isBull(p) && bp >= aB && isBear(k) && k.o >= p.c - eps && k.c < (p.o + p.c) / 2 && k.c > p.o) add(i, 'darkCloud', 2);

        if (tr < 0 && isBear(p) && isBull(k) && Math.abs(p.l - k.l) <= eps && rng(p) >= 0.5 * aR) add(i, 'tweezerBottom', 2);
        if (tr > 0 && isBull(p) && isBear(k) && Math.abs(p.h - k.h) <= eps && rng(p) >= 0.5 * aR) add(i, 'tweezerTop', 2);
      }

      // --- Трёхсвечные ---
      if (i >= 2 && !cs[i - 1].hidden && !cs[i - 2].hidden) {
        const a = cs[i - 2], m = cs[i - 1];
        const ba = body(a), bm = body(m);
        if (isBear(a) && ba >= aB && bm <= 0.5 * ba && bm <= 0.6 * aB && isBull(k) && k.c > (a.o + a.c) / 2 && Math.max(m.o, m.c) <= a.c + 0.3 * ba) add(i, 'morningStar', 3);
        if (isBull(a) && ba >= aB && bm <= 0.5 * ba && bm <= 0.6 * aB && isBear(k) && k.c < (a.o + a.c) / 2 && Math.min(m.o, m.c) >= a.c - 0.3 * ba) add(i, 'eveningStar', 3);

        const three = [a, m, k];
        const soldiers = three.every((x) => isBull(x) && body(x) >= 0.6 * aB && upper(x) <= 0.35 * body(x))
          && m.c > a.c && k.c > m.c && m.o >= a.o - eps && m.o <= a.c + eps && k.o >= m.o - eps && k.o <= m.c + eps;
        if (soldiers) add(i, 'threeSoldiers', 3);
        const crows = three.every((x) => isBear(x) && body(x) >= 0.6 * aB && lower(x) <= 0.35 * body(x))
          && m.c < a.c && k.c < m.c && m.o <= a.o + eps && m.o >= a.c - eps && k.o <= m.o + eps && k.o >= m.c - eps;
        if (crows) add(i, 'threeCrows', 3);
      }
    }
    return out;
  }

  function findPivots(cs, lastIdx, k) {
    const highs = [], lows = [];
    for (let i = k; i <= lastIdx - k; i++) {
      if (cs[i].hidden) continue;
      let isH = true, isL = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (cs[j].hidden) continue;
        if (cs[j].h > cs[i].h || (j < i && cs[j].h === cs[i].h)) isH = false;
        if (cs[j].l < cs[i].l || (j < i && cs[j].l === cs[i].l)) isL = false;
      }
      if (isH) highs.push({ i, v: cs[i].h });
      if (isL) lows.push({ i, v: cs[i].l });
    }
    return { highs, lows };
  }

  function findLevels(cs, lastIdx, piv, tol) {
    const pts = [...piv.highs, ...piv.lows].sort((a, b) => a.v - b.v);
    const clusters = [];
    for (const p of pts) {
      const c = clusters[clusters.length - 1];
      if (c && p.v - c.v <= tol) {
        c.sum += p.v; c.n++; c.v = c.sum / c.n; c.last = Math.max(c.last, p.i); c.first = Math.min(c.first, p.i);
      } else clusters.push({ v: p.v, sum: p.v, n: 1, last: p.i, first: p.i });
    }
    const lastClose = cs[lastIdx].c;
    return clusters
      .filter((c) => c.n >= 2)
      .map((c) => ({ v: c.v, touches: c.n, first: c.first, last: c.last, kind: c.v >= lastClose ? 'resistance' : 'support', score: c.n + c.last / cs.length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  // Трендовая линия: рост — по минимумам (поддержка), падение — по максимумам (сопротивление)
  function findTrendline(cs, lastIdx, pts, tol, isSupport) {
    const val = isSupport ? (k) => k.l : (k) => k.h;
    let best = null;
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const A = pts[a], B = pts[b];
        if (B.i - A.i < 3) continue;
        if (isSupport ? B.v <= A.v : B.v >= A.v) continue;
        const slope = (B.v - A.v) / (B.i - A.i);
        const line = (x) => A.v + slope * (x - A.i);
        let touches = 0, viol = 0, broken = false;
        for (let j = A.i; j <= lastIdx; j++) {
          if (cs[j].hidden) continue;
          const d = isSupport ? val(cs[j]) - line(j) : line(j) - val(cs[j]);
          if (Math.abs(d) <= tol) touches++;
          if (d < -tol) {
            if (j >= lastIdx - 1) broken = true; else viol++;
          }
        }
        if (viol > 0 || touches < 2) continue;
        const score = touches * 2 + (B.i - A.i) / cs.length + B.i / cs.length;
        if (!best || score > best.score) best = { i1: A.i, v1: A.v, i2: lastIdx, v2: line(lastIdx), slope, touches, broken, score, kind: isSupport ? 'up' : 'down' };
      }
    }
    return best;
  }

  function overallTrend(cs, lastIdx, aR) {
    const n = Math.min(30, lastIdx + 1);
    if (n < 5) return { dir: 0, label: 'недостаточно данных' };
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let t = 0; t < n; t++) {
      const y = mid(cs[lastIdx - n + 1 + t]);
      sx += t; sy += y; sxy += t * y; sxx += t * t;
    }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const norm = slope / Math.max(1, aR);
    const dir = norm > 0.15 ? 1 : norm < -0.15 ? -1 : 0;
    return { dir, norm, label: dir > 0 ? 'восходящий' : dir < 0 ? 'нисходящий' : 'боковик', bars: n };
  }

  /**
   * @param candles результат detectCandles().candles
   * @param opts { lastForming: последняя свеча ещё не закрыта (исключить из анализа) }
   */
  function analyze(candles, opts) {
    const cs = candles;
    const lastIdx = cs.length - 1 - (opts && opts.lastForming ? 1 : 0);
    if (lastIdx < 5) return { patterns: [], levels: [], trendlines: [], trend: { dir: 0, label: 'недостаточно данных' }, lastIdx };
    const aR = avgOver(cs, cs.length, cs.length, rng);
    const tol = Math.max(2, 0.3 * aR);
    const k = cs.length >= 40 ? 3 : 2;
    const piv = findPivots(cs, lastIdx, k);
    const trendlines = [
      findTrendline(cs, lastIdx, piv.lows.slice(-8), tol, true),
      findTrendline(cs, lastIdx, piv.highs.slice(-8), tol, false),
    ].filter(Boolean);
    const levels = findLevels(cs, lastIdx, piv, tol);
    const patterns = findPatterns(cs, lastIdx);

    // Контекст и результат каждого паттерна
    for (const p of patterns) {
      const kN = cs[p.i];
      let hi = -Infinity, lo = Infinity;
      for (let j = p.i - p.len + 1; j <= p.i; j++) { hi = Math.max(hi, cs[j].h); lo = Math.min(lo, cs[j].l); }
      // Разворот вверх у поддержки / вниз у сопротивления — сильнее
      const lv = levels.find((L) => (p.dir > 0 ? Math.abs(lo - L.v) : p.dir < 0 ? Math.abs(hi - L.v) : Infinity) <= tol * 1.5);
      p.atLevel = lv ? (lv.kind === 'support' ? 'S' : 'R') + '×' + lv.touches : null;
      // Бонус за уровень только разворотным паттернам; марубозу — импульс, а не разворот
      const reversal = !/^marubozu|^three/.test(p.key);
      p.strength = Math.min(3, p.weight + (lv && reversal ? 1 : 0));
      p.hi = hi; p.lo = lo;
      // Результат: куда закрылась следующая свеча (если она уже есть)
      if (p.dir !== 0 && p.i + 1 <= lastIdx && !cs[p.i + 1].hidden) {
        const nx = cs[p.i + 1];
        p.outcome = (p.dir > 0 ? nx.c > kN.c : nx.c < kN.c) ? 'win' : 'loss';
      } else p.outcome = p.dir === 0 || (p.i + 1 <= lastIdx) ? 'n/a' : 'pending';
    }

    // Статистика по видимой истории: как часто следующая свеча шла в сторону паттерна
    const stats = {};
    for (const p of patterns) {
      if (p.outcome !== 'win' && p.outcome !== 'loss') continue;
      const s = stats[p.key] || (stats[p.key] = { key: p.key, name: p.name, dir: p.dir, n: 0, win: 0 });
      s.n++; if (p.outcome === 'win') s.win++;
    }

    return {
      patterns,
      stats: Object.values(stats).sort((a, b) => b.n - a.n),
      levels,
      trendlines,
      trend: overallTrend(cs, lastIdx, aR),
      pivots: piv,
      lastIdx,
    };
  }

  // ---------- Сессия: накопление закрытых свечей между сканами ----------

  // Признаки свечи, не зависящие от вертикального масштаба (график сам масштабируется)
  function candleSig(k) {
    const r = Math.max(1, rng(k));
    if (k.hidden) return { t: 0, br: 0 };
    return { t: body(k) <= 0.1 * r ? 0 : (k.c > k.o ? 1 : -1), br: body(k) / r };
  }

  // Сколько новых свечей закрылось с прошлого скана: ищем сдвиг s, при котором хвосты совпадают.
  // -1 — не совпало (сменили пару/таймфрейм/прокрутили график)
  // Сравниваем только цвета: пропорции тел "плавают" из-за автомасштаба и наших подписей поверх свечей.
  // Доджи (t=0) совпадает с любым цветом. 20 свечей и ≤2 расхождения — случайное совпадение <0.1%.
  function alignShift(prev, cur, K, maxShift) {
    K = K || 20; maxShift = maxShift || 5;
    if (!prev || !prev.length) return -1;
    for (let s = 0; s <= maxShift; s++) {
      const n = Math.min(K, prev.length, cur.length - s);
      if (n < 8) continue;
      let bad = 0;
      for (let j = 0; j < n; j++) {
        const a = prev[prev.length - 1 - j].t, b = cur[cur.length - 1 - s - j].t;
        if (a !== b && a !== 0 && b !== 0) bad++;
      }
      if (bad <= 2) return s;
    }
    return -1;
  }

  // 95% доверительный интервал Уилсона для доли k/n
  function wilson(k, n) {
    if (!n) return [0, 1];
    const z = 1.96, p = k / n, d = 1 + z * z / n;
    const c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
  }

  /**
   * seq: [{ t: 1|-1|0, keys: [{key, dir}] }] — закрытые свечи сессии по порядку.
   * Считает, что происходило со СЛЕДУЮЩЕЙ свечой в похожих ситуациях.
   */
  function sessionStats(seq, payoutPct) {
    const be = 100 / (100 + (payoutPct || 92)); // порог безубыточности
    const out = { n: seq.length, breakeven: be, base: null, run: null, patterns: [] };
    if (seq.length < 2) return out;

    // База: доля растущих свечей
    let up = 0, tot = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i].t !== 0) { tot++; if (seq[i].t > 0) up++; }
    out.base = { n: tot, up, p: tot ? up / tot : 0.5, ci: wilson(up, tot) };

    // Серии: длина серии одного цвета, заканчивающейся на свече i (доджи серию не рвут и не продлевают)
    const runLen = [], runCol = [];
    for (let i = 0; i < seq.length; i++) {
      const t = seq[i].t;
      if (t === 0) { runCol[i] = i ? runCol[i - 1] : 0; runLen[i] = i ? runLen[i - 1] : 0; continue; }
      if (i && runCol[i - 1] === t) { runCol[i] = t; runLen[i] = runLen[i - 1] + 1; } else { runCol[i] = t; runLen[i] = 1; }
    }
    const last = seq.length - 1, cap = (x) => Math.min(x, 4);
    const col = runCol[last], len = runLen[last];
    if (col) {
      let n = 0, same = 0;
      for (let i = 0; i < last; i++) {
        if (runCol[i] !== col || cap(runLen[i]) !== cap(len) || seq[i + 1].t === 0) continue;
        n++; if (seq[i + 1].t === col) same++;
      }
      // Переводим в "вероятность роста следующей свечи"
      const upK = col > 0 ? same : n - same;
      out.run = { col, len, lenLabel: len >= 4 ? '4+' : String(len), n, same, pUp: n ? upK / n : 0.5, ci: wilson(upK, n) };
    }

    // Паттерны на последней свече: как они отрабатывали раньше в этой сессии
    for (const pk of seq[last].keys) {
      let n = 0, win = 0;
      for (let i = 0; i < last; i++) {
        if (!seq[i].keys.some((k) => k.key === pk.key) || seq[i + 1].t === 0) continue;
        n++; if (seq[i + 1].t === pk.dir) win++;
      }
      out.patterns.push({ key: pk.key, dir: pk.dir, name: P[pk.key].name, n, win, p: n ? win / n : 0.5, ci: wilson(win, n) });
    }
    return out;
  }

  const api = { autoDetectColors, detectCandles, analyze, candleSig, alignShift, wilson, sessionStats, PATTERNS: P };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CandleAnalyzer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
