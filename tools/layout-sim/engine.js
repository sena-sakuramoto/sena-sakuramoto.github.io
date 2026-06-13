// 配置エンジン v2 — 多角形境界 + ゾーニング指定 + ルールベース充填 + 多目的評価
// 座標系: 原点は店舗左前(入口側)。x=間口方向, y=奥行方向(入口 y=0)。単位 mm。
//
// params:
//   shape          "rect" | "L" | "free"
//   W, D           矩形/L字の外形寸法
//   notchPos       L字の欠き位置 "fl"|"fr"|"bl"|"br"
//   notchW, notchD L字の欠き寸法
//   freePts        自由入力の頂点 [[x,y],...](3点以上)
//   columns        柱 [{x,y,w,h},...]
//   kitchenPos     "back" | "left" | "right"
//   entrancePos    "left" | "center" | "right"
//   wcPos          "fl" | "fr" | "bl" | "br"
//   mainAisle, subAisle, mix4, n6, kitchenRatio, tableGap,
//   counterEnabled, counterPitch, dishup, bench, pattern("center"|"side")

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function generateLayout(params) {
  const b = buildBoundary(params);
  const est = toiletPlan(Math.max(1, Math.floor(Math.abs(polyArea(b.poly)) / AREA_PER_SEAT_EST)));
  const first = layoutCore(params, est.booths);
  const fin = toiletPlan(first.metrics.totalSeats);
  return fin.booths === est.booths ? first : layoutCore(params, fin.booths);
}

// --- 境界多角形の構築(原点に正規化、CCW) ---
function buildBoundary(p) {
  const warn = [];
  let pts;
  if (p.shape === "free" && Array.isArray(p.freePts) && p.freePts.length >= 3) {
    pts = p.freePts.map(q => [Number(q[0]), Number(q[1])]);
  } else if (p.shape === "L") {
    const W = p.W, D = p.D;
    const nw = clamp(p.notchW || 3000, 500, W - 2000);
    const nd = clamp(p.notchD || 3000, 500, D - 2000);
    const m = {
      fl: [[nw, 0], [W, 0], [W, D], [0, D], [0, nd], [nw, nd]],
      fr: [[0, 0], [W - nw, 0], [W - nw, nd], [W, nd], [W, D], [0, D]],
      bl: [[0, 0], [W, 0], [W, D], [nw, D], [nw, D - nd], [0, D - nd]],
      br: [[0, 0], [W, 0], [W, D - nd], [W - nw, D - nd], [W - nw, D], [0, D]],
    };
    pts = m[p.notchPos] || m.br;
  } else {
    pts = [[0, 0], [p.W, 0], [p.W, p.D], [0, p.D]];
  }
  // 原点へシフト
  const bb0 = polyBBox(pts);
  pts = ensureCCW(pts.map(q => [q[0] - bb0.minX, q[1] - bb0.minY]));
  if (Math.abs(polyArea(pts)) < 4000 * 6000) warn.push("平面が小さすぎるか、頂点入力が不正です。");
  return { poly: pts, warn };
}

// --- 厨房スラブ: 指定辺からの帯を二分探索で目標面積に合わせる ---
function solveKitchen(poly, bb, orient, targetArea) {
  const span = orient === "back" ? bb.h : bb.w;
  const region = (d) => {
    if (orient === "back") return clipHalf(poly, "y", bb.maxY - d, false);
    if (orient === "left") return clipHalf(poly, "x", bb.minX + d, true);
    return clipHalf(poly, "x", bb.maxX - d, false);
  };
  let lo = 2500, hi = Math.max(2600, span * 0.6);
  if (Math.abs(polyArea(region(hi))) < targetArea) { lo = hi; }
  else {
    for (let i = 0; i < 36; i++) {
      const mid = (lo + hi) / 2;
      if (Math.abs(polyArea(region(mid))) < targetArea) lo = mid; else hi = mid;
    }
  }
  const d = Math.round(lo);
  const faceLimit = orient === "back" ? bb.maxY - d : orient === "left" ? bb.minX + d : bb.maxX - d;
  return { d, poly: region(d), faceLimit };
}

// 厨房面から客席側へ off だけ寄った位置の帯矩形(a0..a1 は面に沿った区間)
function stripRect(orient, faceLimit, off, depth, a0, a1) {
  if (orient === "back") return { x: a0, y: faceLimit - off - depth, w: a1 - a0, h: depth };
  if (orient === "left") return { x: faceLimit + off, y: a0, w: depth, h: a1 - a0 };
  return { x: faceLimit - off - depth, y: a0, w: depth, h: a1 - a0 }; // right
}

// 帯の中で配置可能な最長連続区間を探す
function findRun(poly, bb, orient, faceLimit, off, depth, blocks) {
  const step = 100;
  const end = orient === "back" ? bb.maxX : bb.maxY;
  let best = null, s = null;
  for (let a = 0; a <= end - step; a += step) {
    const r = stripRect(orient, faceLimit, off, depth, a, a + step);
    const ok = rectInPoly(r, poly) && !blocks.some(bl => rectsOverlap(r, bl, bl.pad || 0));
    if (ok) { if (s === null) s = a; }
    else if (s !== null) {
      if (!best || a - s > best.a1 - best.a0) best = { a0: s, a1: a };
      s = null;
    }
  }
  if (s !== null && (!best || end - s > best.a1 - best.a0)) best = { a0: s, a1: end };
  return best;
}

function rectCx(r) { return r.x + r.w / 2; }
function rectCy(r) { return r.y + r.h / 2; }

function layoutCore(params, wcBooths) {
  const p = { ...params };
  const { poly, warn } = buildBoundary(p);
  const bb = polyBBox(poly);
  const area = Math.abs(polyArea(poly));
  const els = [];
  const seatGroups = []; // {cx, cy, seats, wall}

  // 外壁
  els.push({ layer: "WALL", kind: "poly", pts: poly });

  // --- 柱 ---
  const columns = (p.columns || []).filter(c => c.w > 0 && c.h > 0);
  const colBlocks = columns.map(c => ({ ...c, pad: 150 }));
  for (const c of columns) els.push({ layer: "COLUMN", kind: "rect", ...c });

  // --- 入口(前面 y=0 沿い、指定位置から滑らせて収まる場所へ) ---
  const entW = 2000, entD = ENTRANCE_DEPTH;
  const desired = p.entrancePos === "left" ? 300 : p.entrancePos === "center" ? (bb.maxX - entW) / 2 : bb.maxX - entW - 300;
  let entrance = null;
  outer:
  for (let dy = 0; dy <= 2500 && !entrance; dy += 250) {
    for (let off = 0; off <= bb.maxX; off += 250) {
      for (const sgn of off === 0 ? [1] : [1, -1]) {
        const x = clamp(desired + sgn * off, 0, bb.maxX - entW);
        const r = { x, y: dy, w: entW, h: entD };
        if (rectInPoly(r, poly) && !colBlocks.some(c => rectsOverlap(r, c, c.pad))) { entrance = r; break outer; }
      }
    }
  }
  if (!entrance) { entrance = { x: clamp(desired, 0, bb.maxX - entW), y: 0, w: entW, h: entD }; warn.push("入口が前面に収まりません。境界形状を確認してください。"); }
  els.push({ layer: "ENTRANCE", kind: "rect", ...entrance, label: "入口" });
  const entranceBlocks = [
    { ...entrance, pad: 300 },
    { x: entrance.x, y: entrance.y, w: entrance.w, h: entrance.h + 800, pad: 0 }, // 入口前の引き
  ];

  // --- 厨房 ---
  const orient = p.kitchenPos || "back";
  const kTarget = clamp(p.kitchenRatio, 0.15, 0.45) * area;
  const K = solveKitchen(poly, bb, orient, kTarget);
  let kitchenArea = Math.abs(polyArea(K.poly));
  const kitchenEl = { layer: "KITCHEN", kind: "poly", pts: K.poly, label: "" };
  els.push(kitchenEl);

  // --- 厨房面から客席側へ: デシャップ → カウンター → サービス通路 ---
  const stripAvoid = [...entranceBlocks, ...colBlocks];
  const stripRects = [];
  let off = 0;
  let dishupEl = null;
  if (p.dishup) {
    const run = findRun(poly, bb, orient, K.faceLimit, off, FURNITURE.dishupDepth, stripAvoid);
    if (run && run.a1 - run.a0 > 2200) {
      const a1 = run.a1 - 1000; // 厨房出入口の逃げ
      dishupEl = { layer: "DISHUP", kind: "rect", ...stripRect(orient, K.faceLimit, off, FURNITURE.dishupDepth, run.a0, a1), label: "デシャップ" };
      els.push(dishupEl);
      stripRects.push({ ...dishupEl, pad: 0 });
      off += FURNITURE.dishupDepth;
    }
  }
  let counterSeats = 0, counterEl = null;
  if (p.counterEnabled) {
    const total = FURNITURE.counterTopDepth + FURNITURE.stoolZone;
    const run = findRun(poly, bb, orient, K.faceLimit, off, total, stripAvoid);
    if (run && run.a1 - run.a0 > 2000) {
      const a0 = run.a0 + 500, a1 = run.a1 - 1000;
      counterSeats = Math.max(0, Math.floor((a1 - a0) / p.counterPitch));
      if (counterSeats > 0) {
        counterEl = { layer: "COUNTER", kind: "rect", ...stripRect(orient, K.faceLimit, off, FURNITURE.counterTopDepth, a0, a1), label: `カウンター ${counterSeats}席` };
        els.push(counterEl);
        for (let i = 0; i < counterSeats; i++) {
          const ca = a0 + i * p.counterPitch + (p.counterPitch - FURNITURE.chair.w) / 2;
          els.push({ layer: "CHAIR", kind: "rect", ...stripRect(orient, K.faceLimit, off + FURNITURE.counterTopDepth + 90, FURNITURE.chair.d, ca, ca + FURNITURE.chair.w) });
        }
        stripRects.push({ ...stripRect(orient, K.faceLimit, off, total, a0, a1), pad: 0 });
        seatGroups.push({ cx: rectCx(counterEl), cy: rectCy(counterEl), seats: counterSeats, wall: false });
        off += total;
      }
    }
  }
  // サービス通路(厨房・カウンター前の横断動線)
  const aisleStrip = stripRect(orient, K.faceLimit, off, p.mainAisle, 0, orient === "back" ? bb.maxX : bb.maxY);
  const aisleClip = clipRectPoly(poly, aisleStrip);
  if (aisleClip.length >= 3) els.push({ layer: "AISLE", kind: "poly", pts: aisleClip, label: `通路 ${p.mainAisle}` });
  stripRects.push({ ...aisleStrip, pad: 0 });
  off += p.mainAisle;

  // 客席が使えない帯(厨房〜サービス通路)を1つのブロックに
  const bandBlock = orient === "back"
    ? { x: 0, y: K.faceLimit - off, w: bb.maxX, h: bb.maxY - (K.faceLimit - off), pad: 0 }
    : orient === "left"
      ? { x: 0, y: 0, w: K.faceLimit + off, h: bb.maxY, pad: 0 }
      : { x: K.faceLimit - off, y: 0, w: bb.maxX - (K.faceLimit - off), h: bb.maxY, pad: 0 };

  // --- WC(指定コーナーに最近接で配置。厨房帯への食い込みは許す=厨房面積から控除) ---
  const wcW = wcBooths * WC.boothW + WC.lavW, wcD = WC.boothD;
  const anchors = {
    fl: [0, 0], fr: [bb.maxX - wcW, 0],
    bl: [0, bb.maxY - wcD], br: [bb.maxX - wcW, bb.maxY - wcD],
  };
  const anchor = anchors[p.wcPos] || anchors.fl;
  const wcAvoid = [...stripRects, ...entranceBlocks, ...colBlocks];
  let wcRect = null, bestD = Infinity;
  for (let gy = 0; gy <= bb.maxY - wcD; gy += 250) {
    for (let gx = 0; gx <= bb.maxX - wcW; gx += 250) {
      const d2 = (gx - anchor[0]) ** 2 + (gy - anchor[1]) ** 2;
      if (d2 >= bestD) continue;
      const r = { x: gx, y: gy, w: wcW, h: wcD };
      if (rectInPoly(r, poly) && !wcAvoid.some(b => rectsOverlap(r, b, b.pad || 0))) { wcRect = r; bestD = d2; }
    }
  }
  if (!wcRect) { wcRect = { x: anchor[0], y: anchor[1], w: wcW, h: wcD }; warn.push("WCが指定位置周辺に収まりません。"); }
  els.push({ layer: "WC", kind: "rect", ...wcRect, label: `WC ×${wcBooths}` });
  // 厨房帯と重なる分を厨房面積から控除
  const wcInKitchen = clipRectPoly(K.poly, wcRect);
  if (wcInKitchen.length >= 3) {
    kitchenArea -= Math.abs(polyArea(wcInKitchen));
    warn.push("WCが厨房ゾーンに食い込んでいます(厨房面積を控除済み)。");
  }
  kitchenEl.label = `厨房 ${(kitchenArea / 1e6).toFixed(1)}㎡`;

  // --- メイン客動線(入口からの縦通路帯) ---
  const bandTop = orient === "back" ? K.faceLimit - off : bb.maxY;
  const desiredBandX = p.pattern === "side" ? bb.maxX - p.mainAisle : clamp(rectCx(entrance) - p.mainAisle / 2, 0, bb.maxX - p.mainAisle);
  let mainBand = null;
  for (let o = 0; o <= bb.maxX && !mainBand; o += 250) {
    for (const sgn of o === 0 ? [1] : [1, -1]) {
      const x = clamp(desiredBandX + sgn * o, 0, bb.maxX - p.mainAisle);
      const r = { x, y: 0, w: p.mainAisle, h: bandTop };
      if (!rectsOverlap(r, wcRect, 200) && !colBlocks.some(c => rectsOverlap(r, c, 0))) { mainBand = r; break; }
    }
  }
  if (!mainBand) mainBand = { x: desiredBandX, y: 0, w: p.mainAisle, h: bandTop };
  const bandClip = clipRectPoly(poly, mainBand);
  if (bandClip.length >= 3) els.push({ layer: "AISLE", kind: "poly", pts: bandClip, label: `通路 ${p.mainAisle}` });

  // --- テーブル類が避けるブロック一式 ---
  const tableBlocks = [
    bandBlock,
    { ...mainBand, pad: 0 },
    { ...wcRect, pad: 600 },
    ...entranceBlocks,
    ...colBlocks,
  ];

  const placed = []; // {rect, bench:bool}

  // --- 壁ベンチ(バンケット)席 ---
  let benchSeats = 0, nBenchMod = 0;
  if (p.bench) {
    const BZ = FURNITURE.bench;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const horiz = Math.abs(a[1] - b[1]) < 1, vert = Math.abs(a[0] - b[0]) < 1;
      if (!horiz && !vert) continue; // 斜め壁はv2では対象外
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < BZ.minWall) continue;
      const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      const n = [-u[1], u[0]]; // CCWなので左法線=内側
      let t = 100;
      while (t < L - BZ.mod2W) {
        let placedHere = false;
        for (const [wMod, seats] of [[BZ.mod4W, 4], [BZ.mod2W, 2]]) {
          if (t + wMod > L - 100) continue;
          const x0 = a[0] + u[0] * t, y0 = a[1] + u[1] * t;
          const x1 = a[0] + u[0] * (t + wMod) + n[0] * BZ.zoneD, y1 = a[1] + u[1] * (t + wMod) + n[1] * BZ.zoneD;
          const r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
          if (!rectInPoly(r, poly)) continue;
          if (tableBlocks.some(bl => rectsOverlap(r, bl, bl.pad || 0))) continue;
          if (placed.some(q => rectsOverlap(r, q.rect, 0))) continue;
          // ベンチ・テーブル・椅子を描く
          const piece = (o0, dep, t0, t1) => {
            const px0 = a[0] + u[0] * t0 + n[0] * o0, py0 = a[1] + u[1] * t0 + n[1] * o0;
            const px1 = a[0] + u[0] * t1 + n[0] * (o0 + dep), py1 = a[1] + u[1] * t1 + n[1] * (o0 + dep);
            return { x: Math.min(px0, px1), y: Math.min(py0, py1), w: Math.abs(px1 - px0), h: Math.abs(py1 - py0) };
          };
          els.push({ layer: "BENCH", kind: "rect", ...piece(0, BZ.depth, t, t + wMod) });
          els.push({ layer: "TABLE", kind: "rect", ...piece(BZ.depth, BZ.tableD, t + 30, t + wMod - 30), label: seats === 4 ? "B4" : "B2" });
          const nCh = seats / 2;
          for (let c = 0; c < nCh; c++) {
            const cc = t + (wMod / nCh) * (c + 0.5) - FURNITURE.chair.w / 2;
            els.push({ layer: "CHAIR", kind: "rect", ...piece(BZ.depth + BZ.tableD + 20, FURNITURE.chair.d, cc, cc + FURNITURE.chair.w) });
          }
          placed.push({ rect: r, bench: true });
          seatGroups.push({ cx: rectCx(r), cy: rectCy(r), seats, wall: true });
          benchSeats += seats; nBenchMod++;
          t += wMod + BZ.gap;
          placedHere = true;
          break;
        }
        if (!placedHere) t += 250;
      }
    }
  }

  // --- フリーテーブル(行充填: 行ピッチ=卓奥行+椅子帯×2+サブ通路) ---
  const t6 = FURNITURE.table6, t4 = FURNITURE.table4, t2 = FURNITURE.table2;
  const rowModule = t4.d + FURNITURE.chairZone * 2;
  let n6 = 0, n4 = 0, n2 = 0, seats6 = 0, seats4 = 0, seats2 = 0;
  let n6left = Math.max(0, Math.floor(p.n6 || 0));

  const unitFits = (r) =>
    rectInPoly(r, poly) &&
    !tableBlocks.some(bl => rectsOverlap(r, bl, bl.pad || 0)) &&
    !placed.some(q => rectsOverlap(r, q.rect, q.bench ? p.subAisle : 0));

  for (let y = 300; y + rowModule <= bb.maxY; y += rowModule + p.subAisle) {
    let x = 200;
    while (x < bb.maxX - t2.w) {
      let chosen = null;
      if (n6left > 0) chosen = t6;
      else {
        const ts = seats4 + seats2 + seats6;
        chosen = (ts === 0 ? p.mix4 >= 0.5 : (seats4 + seats6) / ts < p.mix4) ? t4 : t2;
      }
      const tryList = chosen === t2 ? [t2] : chosen === t4 ? [t4, t2] : [t6, t4, t2];
      let placedT = null;
      for (const t of tryList) {
        const r = { x, y, w: t.w, h: rowModule };
        if (x + t.w <= bb.maxX && unitFits(r)) { placedT = t; break; }
      }
      if (placedT) {
        const t = placedT;
        const ty = y + FURNITURE.chairZone + (t4.d - t.d) / 2;
        els.push({ layer: "TABLE", kind: "rect", x, y: ty, w: t.w, h: t.d, label: t.label });
        const perSide = t.seats / 2;
        for (let s = 0; s < perSide; s++) {
          const cx = x + (t.w / perSide) * (s + 0.5) - FURNITURE.chair.w / 2;
          els.push({ layer: "CHAIR", kind: "rect", x: cx, y: ty - FURNITURE.chair.d - 20, w: FURNITURE.chair.w, h: FURNITURE.chair.d });
          els.push({ layer: "CHAIR", kind: "rect", x: cx, y: ty + t.d + 20, w: FURNITURE.chair.w, h: FURNITURE.chair.d });
        }
        placed.push({ rect: { x, y, w: t.w, h: rowModule }, bench: false });
        const wall = distPtPolyEdge(x + t.w / 2, y + rowModule / 2, poly) < 1400;
        seatGroups.push({ cx: x + t.w / 2, cy: y + rowModule / 2, seats: t.seats, wall });
        if (t === t6) { n6++; seats6 += 6; n6left--; }
        else if (t === t4) { n4++; seats4 += 4; }
        else { n2++; seats2 += 2; }
        x += t.w + p.tableGap;
      } else {
        x += 250;
      }
    }
  }
  if (n6left > 0) warn.push(`6人卓が ${n6left} 卓置けませんでした。`);

  // --- 指標 ---
  const totalSeats = seats6 + seats4 + seats2 + counterSeats + benchSeats;
  const wcFinal = toiletPlan(totalSeats);
  const tsubo = area / 1e6 / 3.30578;
  const svcRef = dishupEl ? [rectCx(dishupEl), rectCy(dishupEl)]
    : counterEl ? [rectCx(counterEl), rectCy(counterEl)]
    : polyCentroid(K.poly);
  const entRef = [rectCx(entrance), entrance.y + entrance.h];

  let svcSum = 0, svcSeats = 0, maxEgress = 0, wallSeats = 0;
  for (const g of seatGroups) {
    svcSum += Math.hypot(g.cx - svcRef[0], g.cy - svcRef[1]) * g.seats;
    svcSeats += g.seats;
    maxEgress = Math.max(maxEgress, Math.hypot(g.cx - entRef[0], g.cy - entRef[1]));
    if (g.wall) wallSeats += g.seats;
  }
  const avgService = svcSeats > 0 ? svcSum / svcSeats : 0;
  const wallRate = totalSeats > 0 ? wallSeats / totalSeats : 0;

  const diag = Math.hypot(bb.maxX, bb.maxY);
  const seatsPerTsubo = totalSeats / tsubo;
  const sc = SCORE.weights;
  const score = 100 * (
    sc.capacity * Math.min(seatsPerTsubo / SCORE.targetSeatsPerTsubo, 1) +
    sc.service * clamp(1 - avgService / (diag * 0.6), 0, 1) +
    sc.egress * clamp(1 - maxEgress / diag, 0, 1) +
    sc.wall * wallRate
  );

  if (totalSeats === 0) warn.push("席が1つも置けません。条件を見直してください。");
  warn.push("配膳・避難距離は直線距離の目安です(経路探索なし)。法規・避難計画は別途検証してください。");

  const metrics = {
    totalSeats, seats6, seats4, seats2, counterSeats, benchSeats,
    n6, n4, n2, nBenchMod,
    areaM2: area / 1e6, tsubo, seatsPerTsubo,
    kitchenM2: kitchenArea / 1e6, kitchenPct: kitchenArea / area * 100,
    wcBooths: wcFinal.booths, wcLabel: wcFinal.label,
    avgServiceM: avgService / 1000, maxEgressM: maxEgress / 1000,
    wallRate, score,
  };
  return { elements: els, metrics, warnings: warn, params: p, size: { W: bb.maxX, D: bb.maxY } };
}

// メイン通路幅 × パターンのスイープ比較(総合スコア順)
function sweep(params) {
  const out = [];
  for (const aisle of [900, 1000, 1100, 1200]) {
    for (const pattern of ["center", "side"]) {
      const r = generateLayout({ ...params, mainAisle: aisle, pattern });
      out.push({ aisle, pattern, m: r.metrics });
    }
  }
  out.sort((a, b) => b.m.score - a.m.score);
  return out;
}

function bestPattern(params) {
  const c = generateLayout({ ...params, pattern: "center" });
  const s = generateLayout({ ...params, pattern: "side" });
  return s.metrics.score > c.metrics.score ? "side" : "center";
}
