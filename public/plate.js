// Разбор казахстанского госномера из «сырого» текста, который выдал OCR.
//
// OCR на фото часто путает похожие символы (0/O, 1/I, 8/B, 5/S…) и захватывает
// лишнее — надпись «KZ», флаг, рамку. Поэтому мы не доверяем тексту как есть, а
// ищем в нём фрагмент по шаблону номера и поправляем символы по их месту:
//   новый формат:  123 ABC 02  — 3 цифры, 3 буквы, 2 цифры региона
//   старый формат: 123 AB 02   — 3 цифры, 2 буквы, 2 цифры региона
// На месте цифры «O» превращается в «0», на месте буквы «0» — в «O» и т.д.
//
// Файл работает и в браузере (window.PlateParser), и в Node (для тестов).
(function (root) {
  // что OCR принимает за цифру → какая это цифра на самом деле
  const TO_DIGIT = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", G: "6", B: "8" };
  // что OCR принимает за букву → какая это буква на самом деле
  const TO_LETTER = { "0": "O", "1": "I", "2": "Z", "5": "S", "6": "G", "8": "B", "4": "A" };

  // Шаблоны: D — цифра, L — буква. Главные — два формата казахстанских номеров.
  const TEMPLATES = ["DDDLLLDD", "DDDLLDD"];

  // Коды регионов Казахстана — 01…20 (Астана, Алматы, области…). Нужны не для
  // отбраковки, а чтобы из нескольких похожих вариантов выбрать правдоподобный.
  function regionLooksValid(region) {
    const n = Number(region);
    return n >= 1 && n <= 20;
  }

  // Подгоняет один символ под тип слота. Возвращает {ch, fixed} или null,
  // если символ вообще не может стоять на этом месте.
  function fit(ch, slot) {
    if (slot === "D") {
      if (ch >= "0" && ch <= "9") return { ch, fixed: 0 };
      if (TO_DIGIT[ch]) return { ch: TO_DIGIT[ch], fixed: 1 };
      return null;
    }
    if (ch >= "A" && ch <= "Z") return { ch, fixed: 0 };
    if (TO_LETTER[ch]) return { ch: TO_LETTER[ch], fixed: 1 };
    return null;
  }

  // Лучший номер внутри одной «чистой» строки (только A-Z и 0-9)
  function bestInRun(run) {
    let best = null;
    for (const tpl of TEMPLATES) {
      for (let start = 0; start + tpl.length <= run.length; start++) {
        let fixes = 0;
        let out = "";
        let ok = true;
        for (let i = 0; i < tpl.length; i++) {
          const f = fit(run[start + i], tpl[i]);
          if (!f) { ok = false; break; }
          out += f.ch;
          fixes += f.fixed;
        }
        if (!ok) continue;
        const region = out.slice(-2);
        // чем меньше правок — тем надёжнее; неправдоподобный регион — штраф
        const cost = fixes + (regionLooksValid(region) ? 0 : 1.5);
        const plate = `${out.slice(0, 3)} ${out.slice(3, out.length - 2)} ${region}`;
        if (!best || cost < best.cost) best = { plate, cost };
      }
    }
    return best;
  }

  // Достаёт лучший номер из всего текста OCR (по строкам и целиком).
  // Возвращает {plate, cost} или null.
  function parse(text) {
    if (!text) return null;
    const upper = String(text).toUpperCase();
    const runs = upper.split(/[\r\n]+/).map(l => l.replace(/[^A-Z0-9]/g, "")).filter(Boolean);
    // иногда номер OCR разрывает на «слова» с пробелами — склеенная версия ловит и это
    runs.push(upper.replace(/[^A-Z0-9]/g, ""));
    let best = null;
    for (const run of runs) {
      const cand = bestInRun(run);
      if (cand && (!best || cand.cost < best.cost)) best = cand;
    }
    // слишком «натянутый» вариант (много правок) лучше не подставлять — пусть
    // сотрудник введёт номер сам, чем получит неверный
    if (!best || best.cost > 3) return null;
    return best;
  }

  // Из результатов нескольких проходов OCR выбирает номер, который встретился
  // чаще всего (при равенстве — с меньшим числом правок).
  function pickBest(texts) {
    const votes = new Map();
    for (const t of texts) {
      const r = parse(t);
      if (!r) continue;
      const v = votes.get(r.plate) || { plate: r.plate, count: 0, cost: r.cost };
      v.count += 1;
      v.cost = Math.min(v.cost, r.cost);
      votes.set(r.plate, v);
    }
    let best = null;
    for (const v of votes.values()) {
      if (!best || v.count > best.count || (v.count === best.count && v.cost < best.cost)) best = v;
    }
    return best;
  }

  // --- Поиск таблички с номером в кадре -------------------------------------
  // OCR плохо находит маленький номер среди кузова, фар и фона, зато отлично читает
  // уже вырезанную табличку. Поэтому сначала ищем «похожие на номер» места: у
  // таблички много частых вертикальных границ (штрихи символов) в узкой
  // горизонтальной полосе с пропорциями около 4,6 : 1 (казахстанский номер 520×112).
  // Работает на сером изображении (массив яркостей 0..255), без привязки к DOM.
  // Возвращает до `limit` рамок {x, y, w, h, score} в координатах этого изображения.
  function findPlateBoxes(gray, w, h, limit) {
    limit = limit || 3;
    const N = w * h;
    const E = new Uint8Array(N); // вертикальные границы
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        if (Math.abs(gray[row + x + 1] - gray[row + x - 1]) >= 48) E[row + x] = 1;
      }
    }
    // интегральное изображение границ — чтобы быстро считать плотность в рамке
    const W1 = w + 1;
    const I = new Int32Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += E[y * w + x];
        I[(y + 1) * W1 + (x + 1)] = I[y * W1 + (x + 1)] + rowSum;
      }
    }
    const edgesIn = (x0, y0, x1, y1) => I[(y1 + 1) * W1 + (x1 + 1)] - I[y0 * W1 + (x1 + 1)] - I[(y1 + 1) * W1 + x0] + I[y0 * W1 + x0];

    const found = [];
    for (const kx of [7, 13]) {
      // растягиваем границы по горизонтали (буквы сливаются в одно пятно) и чуть по вертикали
      const H = new Uint8Array(N);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let cnt = 0;
        for (let x = 0; x < w + kx; x++) {
          if (x < w) cnt += E[row + x];
          const out = x - 2 * kx - 1;
          if (out >= 0) cnt -= E[row + out];
          const cx = x - kx;
          if (cx >= 0 && cx < w) H[row + cx] = cnt > 0 ? 1 : 0;
        }
      }
      const V = new Uint8Array(N);
      for (let x = 0; x < w; x++) {
        let cnt = 0;
        for (let y = 0; y < h + 2; y++) {
          if (y < h) cnt += H[y * w + x];
          const out = y - 5;
          if (out >= 0) cnt -= H[out * w + x];
          const cy = y - 2;
          if (cy >= 0 && cy < h) V[cy * w + x] = cnt > 0 ? 1 : 0;
        }
      }
      // связные области
      const seen = new Uint8Array(N);
      const stack = [];
      for (let s = 0; s < N; s++) {
        if (!V[s] || seen[s]) continue;
        let minx = w, maxx = 0, miny = h, maxy = 0;
        stack.push(s); seen[s] = 1;
        while (stack.length) {
          const p = stack.pop();
          const px = p % w, py = (p / w) | 0;
          if (px < minx) minx = px; if (px > maxx) maxx = px;
          if (py < miny) miny = py; if (py > maxy) maxy = py;
          if (px > 0 && V[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
          if (px < w - 1 && V[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
          if (py > 0 && V[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
          if (py < h - 1 && V[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
        }
        // пятно шире реальных границ на величину растяжения (kx по горизонтали, 2 по
        // вертикали) — возвращаем рамку к настоящим границам, иначе вырезка получится
        // с лишним фоном, а на фоне OCR читает хуже
        minx += kx; maxx -= kx; miny += 2; maxy -= 2;
        if (maxx <= minx || maxy <= miny) continue;
        const bw = maxx - minx + 1, bh = maxy - miny + 1;
        const aspect = bw / bh;
        if (bw < w * 0.06 || bw > w * 0.85 || bh < h * 0.015 || bh > h * 0.35) continue;
        if (aspect < 2.2 || aspect > 8.5) continue;
        const density = edgesIn(minx, miny, maxx, maxy) / (bw * bh);
        if (density < 0.05 || density > 0.75) continue;
        const shape = 1 - Math.min(1, Math.abs(Math.log(aspect / 4.6)) / 1.4);
        found.push({ x: minx, y: miny, w: bw, h: bh, score: density * (0.3 + shape) });
      }
    }
    // убираем дубли (один и тот же номер найден двумя размерами растяжения)
    found.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const f of found) {
      const dup = kept.some(k => {
        const ix = Math.max(0, Math.min(k.x + k.w, f.x + f.w) - Math.max(k.x, f.x));
        const iy = Math.max(0, Math.min(k.y + k.h, f.y + f.h) - Math.max(k.y, f.y));
        const inter = ix * iy;
        return inter / (k.w * k.h + f.w * f.h - inter) > 0.3;
      });
      if (!dup) kept.push(f);
      if (kept.length >= limit) break;
    }
    return kept;
  }

  const api = { parse, pickBest, findPlateBoxes };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PlateParser = api;
})(typeof window !== "undefined" ? window : this);
