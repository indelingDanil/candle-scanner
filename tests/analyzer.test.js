// Запуск: node tests/analyzer.test.js
// Рисует в памяти синтетический график с известными свечами и проверяет распознавание.
const A = require('../analyzer.js');

const BULL = [38, 166, 154], BEAR = [239, 83, 80], BG = [21, 25, 34], GRID = [42, 46, 57];
const W = 900, H = 400, CW = 9, STEP = 14, SCALE = 4; // 1 единица цены = 4px

function makeImg() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = BG[0]; data[i * 4 + 1] = BG[1]; data[i * 4 + 2] = BG[2]; data[i * 4 + 3] = 255; }
  return { data, width: W, height: H };
}
function rect(img, x0, y0, x1, y1, c) {
  for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++)
    for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
      const p = (y * W + x) * 4; img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2];
    }
}

// OHLC в "единицах"; y = H - 20 - v*SCALE
const bars = [];
let price = 60;
const push = (o, h, l, c) => { bars.push({ o, h, l, c }); price = c; };
// нисходящий участок
for (let i = 0; i < 8; i++) { const o = price, c = price - 3; push(o, o + 1, c - 1, c); }
// молот (после падения)
{ const o = price, c = price + 1; push(o, c + 0.25, o - 6, c); }
// бычье поглощение: медвежья, затем большая бычья
{ const o = price, c = price - 3; push(o, o + 0.5, c - 0.5, c); }
{ const o = price, c = price + 6; push(o, c + 0.5, o - 0.5, c); }
// рост
for (let i = 0; i < 6; i++) { const o = price, c = price + 2.5; push(o, c + 1, o - 1, c); }
// падающая звезда (после роста)
{ const o = price, c = price - 1; push(o, o + 6, c - 0.25, c); }
// медвежье поглощение
{ const o = price, c = price + 2; push(o, c + 0.5, o - 0.5, c); }
{ const o = price, c = price - 5; push(o, o + 0.5, c - 0.5, c); }
// боковик с доджи
for (let i = 0; i < 6; i++) { const o = price, c = price + (i % 2 ? 1.5 : -1.5); push(o, Math.max(o, c) + 1, Math.min(o, c) - 1, c); }
{ const o = price; push(o, o + 2, o - 2, o); }
for (let i = 0; i < 8; i++) { const o = price, c = price + (i % 2 ? 2 : -2); push(o, Math.max(o, c) + 1, Math.min(o, c) - 1, c); }

const img = makeImg();
// сетка
for (let y = 0; y < H; y += 50) rect(img, 0, y, W - 1, y, GRID);
for (let x = 0; x < W; x += 80) rect(img, x, 0, x, H - 1, GRID);
const toY = (v) => Math.round(H - 20 - v * SCALE);
bars.forEach((b, i) => {
  const x0 = 10 + i * STEP, xc = x0 + Math.floor(CW / 2);
  const col = b.c >= b.o ? BULL : BEAR;
  rect(img, xc, toY(b.h), xc, toY(b.l), col); // тень
  const yt = toY(Math.max(b.o, b.c)), yb = toY(Math.min(b.o, b.c));
  rect(img, x0, yt, x0 + CW - 1, Math.max(yt, yb), col); // тело
});
// "плашка текущей цены" на оси — должна отсеяться
rect(img, W - 60, 100, W - 5, 115, BULL);

let fails = 0;
const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) fails++; };

const colors = A.autoDetectColors(img);
check(colors.bull && Math.abs(colors.bull[1] - BULL[1]) < 20, 'авто-цвет роста ' + JSON.stringify(colors.bull));
check(colors.bear && Math.abs(colors.bear[0] - BEAR[0]) < 20, 'авто-цвет падения ' + JSON.stringify(colors.bear));

const det = A.detectCandles(img, colors.bull, colors.bear, { tol: 60 });
det.candles.forEach((c,i)=>{ const ex=10+i*STEP; if(Math.abs(c.x0-ex)>0 && !globalThis.__r){globalThis.__r=1; console.log("первое расхождение на", i, c);} });
check(det.candles.length === bars.length, `свечей найдено ${det.candles.length} из ${bars.length}`);
let bad = 0;
det.candles.forEach((c, i) => {
  const b = bars[i]; if (!b) return;
  const e = (val, v) => Math.abs(val - (H - toY(v))) <= 1;
  if (!(e(c.h, b.h) && e(c.l, b.l) && e(c.o, b.o) && e(c.c, b.c))) bad++;
});
check(bad === 0, `OHLC совпадает в пределах 1px (расхождений: ${bad})`);

const res = A.analyze(det.candles, { lastForming: true });
const found = res.patterns.map((p) => `${p.i}:${p.key}`);
const has = (i, key) => res.patterns.some((p) => p.i === i && p.key === key);
check(has(8, 'hammer'), 'молот на 8');
check(has(10, 'engulfBull'), 'бычье поглощение на 10');
check(has(17, 'shootingStar'), 'падающая звезда на 17');
check(has(19, 'engulfBear'), 'медвежье поглощение на 19');
check(res.patterns.some((p) => p.i === 26 && p.key.startsWith('doji')), 'доджи на 26');
console.log('Все паттерны:', found.join(', '));
console.log('Тренд:', res.trend.label, '| уровней:', res.levels.length, '| трендовых линий:', res.trendlines.length);
console.log('Предупреждения:', det.warnings);

// --- Маска: поверх графика нарисована "наша" разметка (линия уровня и подпись) ---
const mask = new Uint8Array(W * H);
const paint = (x0, y0, x1, y1, c) => { rect(img, x0, y0, x1, y1, c); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * W + x] = 1; };
paint(0, 250, W - 1, 251, [255, 159, 67]);   // горизонтальная линия через свечи
paint(120, 150, 175, 162, [255, 255, 255]);  // "подпись"
const detM = A.detectCandles(img, colors.bull, colors.bear, { tol: 60, mask });
let badM = 0;
detM.candles.forEach((c, i) => {
  const b = bars[i]; if (!b) return;
  const e = (val, v) => Math.abs(val - (H - toY(v))) <= 2;
  if (!(e(c.h, b.h) && e(c.l, b.l) && e(c.o, b.o) && e(c.c, b.c))) badM++;
});
check(detM.candles.length === bars.length && badM === 0, `с маской: свечей ${detM.candles.length}, расхождений OHLC >2px: ${badM}`);
const detNo = A.detectCandles(img, colors.bull, colors.bear, { tol: 60 });
console.log('     (без маски на той же картинке: свечей', detNo.candles.length + ')');

// --- Плашка сделки того же цвета, что медвежьи свечи, поверх последних свечей + линия вправо ---
{
  const img2 = makeImg();
  for (let y = 0; y < H; y += 50) rect(img2, 0, y, W - 1, y, GRID);
  bars.forEach((b, i) => {
    const x0 = 10 + i * STEP, xc = x0 + Math.floor(CW / 2);
    const col = b.c >= b.o ? BULL : BEAR;
    rect(img2, xc, toY(b.h), xc, toY(b.l), col);
    const yt = toY(Math.max(b.o, b.c)), yb = toY(Math.min(b.o, b.c));
    rect(img2, x0, yt, x0 + CW - 1, Math.max(yt, yb), col);
  });
  const lastX = 10 + 28 * STEP; // плашка на месте входа, новые свечи правее
  const lastC = bars[29];
  const by = toY((lastC.o + lastC.c) / 2) - 12;
  rect(img2, lastX - 6, by, lastX + 54, by + 26, BEAR);                 // плашка "▼$10"
  rect(img2, lastX + 8, by + 8, lastX + 30, by + 17, [255, 255, 255]);  // текст
  rect(img2, lastX + 55, by + 12, W - 80, by + 13, BEAR);               // линия сделки
  const d2 = A.detectCandles(img2, colors.bull, colors.bear, { tol: 60 });
  check(d2.candles.length === bars.length, `с плашкой сделки: свечей ${d2.candles.length} из ${bars.length}`);
  const sameColors = d2.candles.every((c, i) => bars[i] && (c.hidden || (c.type === 'bull') === (bars[i].c >= bars[i].o)));
  console.log('     скрытых свечей:', d2.candles.filter((c) => c.hidden).length, '|', d2.warnings.join('; '));
  const r2 = A.analyze(d2.candles, { lastForming: true });
  check(r2.patterns.every((p) => !d2.candles[p.i].hidden), 'скрытые свечи не дают паттернов');
  check(sameColors, 'с плашкой сделки: цвета всех свечей верные');
  const wide = d2.candles.some((c) => c.w > CW + 2);
  check(!wide, 'плашка не склеилась со свечами');
}

const s = res.stats.map((x) => `${x.name} ${x.win}/${x.n}`).join(', ');
console.log('Статистика:', s);
check(res.patterns.every((p) => p.strength >= 1 && p.outcome), 'у всех паттернов есть сила и результат');

// --- Сессия ---
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const randSeq = (n) => Array.from({ length: n }, () => ({ t: rnd() < 0.5 ? 1 : -1, br: rnd() }));
const full = randSeq(120);
const noisy = (arr) => arr.map((x, i) => (i % 9 === 4 ? { t: 0, br: 0 } : x)); // часть свечей распознана как доджи
let okShift = 0, falseHit = 0;
for (let st = 0; st < 30; st++) {
  const prev = full.slice(st, st + 85);
  for (let s = 0; s <= 3; s++) if (A.alignShift(prev, noisy(full.slice(st + s, st + 85 + s))) === s) okShift++;
  const other = randSeq(85);
  if (A.alignShift(prev, other) !== -1) falseHit++;
}
check(okShift === 120, `сдвиг определён верно в ${okShift}/120 случаях (с шумом доджи)`);
check(falseHit <= 1, `ложных совпадений с чужим графиком: ${falseHit}/30`);
const w = A.wilson(18, 31);
check(Math.abs(w[0] - 0.41) < 0.02 && Math.abs(w[1] - 0.74) < 0.02, `Уилсон 18/31 = ${w.map((x) => x.toFixed(2))}`);
// синтетическая сессия: после 2 зелёных всегда зелёная
const seq = [];
for (let i = 0; i < 60; i++) seq.push({ t: i % 4 === 3 ? -1 : 1, keys: [] });
seq.push({ t: -1, keys: [] }, { t: 1, keys: [] }, { t: 1, keys: [{ key: 'engulfBull', dir: 1 }] });
const ss = A.sessionStats(seq, 92);
console.log('Сессия:', JSON.stringify({ base: ss.base, run: ss.run, be: ss.breakeven.toFixed(3) }));
check(ss.run && ss.run.len === 2 && ss.run.pUp === 1, 'серия из 2 зелёных → следующая зелёная в 100%');
check(Math.abs(ss.breakeven - 0.521) < 0.001, 'порог безубыточности при 92% = 52.1%');
process.exit(fails ? 1 : 0);
