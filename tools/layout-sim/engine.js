// 配置エンジン v3 — 多角形境界 + ゾーニング指定 + ルールベース充填
//                  + 経路解析(到達不能席の自動撤去・経路距離評価) + 多スタート最適化
// 座標系: 原点は店舗左前(入口側)。x=間口方向, y=奥行方向(入口 y=0)。単位 mm。
//
// params:
//   shape("rect"|"L"|"free"), W, D, notchPos, notchW, notchD, freePts, columns
//   kitchenPos("back"|"left"|"right"), entrancePos("left"|"center"|"right"), wcPos("fl"|"fr"|"bl"|"br")
//   mainAisle, subAisle, mix4, n6, kitchenRatio, tableGap,
//   counterEnabled, counterPitch, dishup, bench, staff,
//   pattern("auto"|"center"|"side"|"sideL")

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 自動最適化: パターン × 行位相 の候補を全生成し、総合スコア最大の案を返す
function generateLayout(params) {
  const b = buildBoundary(params);
  const areaM2 = Math.abs(polyArea(b.poly)) / 1e6;
  const est = toiletPlan(Math.max(1, Math.floor(areaM2 * 1e6 / AREA_PER_SEAT_EST)), areaM2);
  const patterns = params.pattern === "auto" ? ["center", "side", "sideL"] : [params.pattern];
  const phases = [0, 0.5];
  let best = null;
  for (const pattern of patterns) {
    for (const phase of phases) {
      const r = layoutCore({ ...params, pattern }, est, { phase });
      if (!best || r.metrics.score > best.metrics.score) best = r;
    }
  }
  const fin = toiletPlan(best.metrics.totalSeats, areaM2);
  if (fin.label !== est.label) {
    return layoutCore(best.params, fin, best.opt);
  }
  return best;
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

function layoutCore(params, wcPlan, opt) {
  const p = { ...params };
  const { poly, warn } = buildBoundary(p);
  const bb = polyBBox(poly);
  const area = Math.abs(polyArea(poly));
  const zoneEls = [];          // 撤去対象にならない固定要素
  let units = [];              // 席ユニット {rect, seats, kind, wall, removable, els:[]}

  zoneEls.push({ layer: "WALL", kind: "poly", pts: poly });

  // --- 柱 ---
  const columns = (p.columns || []).filter(c => c.w > 0 && c.h > 0);
  const colBlocks = columns.map(c => ({ ...c, pad: 150 }));
  for (const c of columns) zoneEls.push({ layer: "COLUMN", kind: "rect", ...c });

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
  zoneEls.push({ layer: "ENTRANCE", kind: "rect", ...entrance, label: "入口・待合" });
  const entranceBlocks = [
    { ...entrance, pad: 300 },
    { x: entrance.x, y: entrance.y, w: entrance.w, h: entrance.h + 800, pad: 0 }, // 入口前の引き
  ];

  // --- レジ(入口脇が実務定石: 会計混雑の防止・防犯) ---
  let regiEl = null;
  {
    const rw = 900, rd = 600;
    const cands = [
      { x: entrance.x + entrance.w + 150, y: 100, w: rw, h: rd },
      { x: entrance.x - 150 - rw, y: 100, w: rw, h: rd },
      { x: entrance.x + entrance.w + 150, y: 100, w: rd, h: rw },
      { x: entrance.x - 150 - rd, y: 100, w: rd, h: rw },
    ];
    for (const r of cands) {
      if (rectInPoly(r, poly) && !colBlocks.some(c => rectsOverlap(r, c, c.pad))) {
        regiEl = { layer: "COUNTER", kind: "rect", ...r, label: "レジ" };
        zoneEls.push(regiEl);
        entranceBlocks.push({ x: r.x, y: r.y, w: r.w, h: r.h, pad: 400 }); // 会計待ちの逃げ
        break;
      }
    }
  }

  // --- 厨房 ---
  const orient = p.kitchenPos || "back";
  const kTarget = clamp(p.kitchenRatio, 0.15, 0.45) * area;
  const K = solveKitchen(poly, bb, orient, kTarget);
  let kitchenArea = Math.abs(polyArea(K.poly));
  const kitchenEl = { layer: "KITCHEN", kind: "poly", pts: K.poly, label: "" };
  zoneEls.push(kitchenEl);

  // 厨房内部ゾーニング目安(面に沿った分割)
  {
    const S = orient === "back" ? bb.maxX : bb.maxY;
    let f0 = 0;
    for (const z of KITCHEN_ZONES) {
      const a0 = f0 * S, a1 = (f0 + z.f) * S;
      f0 += z.f;
      const r = orient === "back"
        ? { x: a0, y: K.faceLimit, w: a1 - a0, h: bb.maxY - K.faceLimit }
        : orient === "left"
          ? { x: 0, y: a0, w: K.faceLimit, h: a1 - a0 }
          : { x: K.faceLimit, y: a0, w: bb.maxX - K.faceLimit, h: a1 - a0 };
      const cp = clipRectPoly(K.poly, r);
      if (cp.length >= 3 && Math.abs(polyArea(cp)) > 2e6) {
        zoneEls.push({ layer: "KZONE", kind: "poly", pts: cp, label: z.label });
      }
    }
  }

  // 厨房本体(歩行障害)
  const kitchenSolid = orient === "back"
    ? { x: 0, y: K.faceLimit, w: bb.maxX, h: bb.maxY - K.faceLimit }
    : orient === "left"
      ? { x: 0, y: 0, w: K.faceLimit, h: bb.maxY }
      : { x: K.faceLimit, y: 0, w: bb.maxX - K.faceLimit, h: bb.maxY };

  // --- WC寸法(男女別ブース+小便器+手洗い+前室) ---
  const bf = !!p.bfBooth;
  const boothBandD = Math.max(WC.boothD, bf ? WC.bfD : 0);
  const wcW = Math.max(1800,
    (wcPlan.shared + wcPlan.femaleBooth + wcPlan.maleBooth) * WC.boothW +
    wcPlan.urinal * WC.urinalP + (bf ? WC.bfW : 0) + WC.lavW);
  const wcD = boothBandD + WC.corridor;

  // --- 厨房面から客席側へ: デシャップ → カウンター → サービス通路 ---
  const stripAvoid = [...entranceBlocks, ...colBlocks];
  const stripSolids = [];  // 歩行障害になる什器(デシャップ・カウンター)
  const stripAll = [];     // WC配置が避ける範囲(サービス通路含む)

  // WCが奥指定×厨房奥の場合: 厨房帯の角へ先行確保し、客席側に前室廊下を残して
  // デシャップ・カウンターをその区間から退避させる(小規模店の実務手法)
  let wcRect = null;
  if ((p.wcPos === "bl" || p.wcPos === "br") && orient === "back") {
    const ax = p.wcPos === "bl" ? 0 : bb.maxX - wcW;
    const wy = Math.min(K.faceLimit, bb.maxY - wcD);
    for (let o = 0; o <= bb.maxX && !wcRect; o += 250) {
      for (const sgn of o === 0 ? [1] : [1, -1]) {
        const x = clamp(ax + sgn * o, 0, bb.maxX - wcW);
        const r = { x, y: wy, w: wcW, h: wcD };
        const corridor = { x, y: wy - WC.corridor, w: wcW, h: WC.corridor };
        if (rectInPoly(r, poly) && rectInPoly(corridor, poly) &&
            !colBlocks.some(c => rectsOverlap(r, c, c.pad)) &&
            !entranceBlocks.some(b2 => rectsOverlap(r, b2, 0))) {
          wcRect = r;
          stripAvoid.push({ ...r, pad: 0 }, { ...corridor, pad: 0 });
          break;
        }
      }
    }
  }
  let off = 0;
  let dishupEl = null;
  if (p.dishup) {
    const run = findRun(poly, bb, orient, K.faceLimit, off, FURNITURE.dishupDepth, stripAvoid);
    if (run && run.a1 - run.a0 > 2200) {
      const a1 = run.a1 - 1000; // 厨房出入口の逃げ
      dishupEl = { layer: "DISHUP", kind: "rect", ...stripRect(orient, K.faceLimit, off, FURNITURE.dishupDepth, run.a0, a1), label: "デシャップ" };
      zoneEls.push(dishupEl);
      stripSolids.push({ x: dishupEl.x, y: dishupEl.y, w: dishupEl.w, h: dishupEl.h });
      off += FURNITURE.dishupDepth;
    }
  }
  let counterSeats = 0, counterEl = null, counterUnit = null;
  if (p.counterEnabled) {
    const total = FURNITURE.counterTopDepth + FURNITURE.stoolZone;
    const run = findRun(poly, bb, orient, K.faceLimit, off, total, stripAvoid);
    if (run && run.a1 - run.a0 > 2000) {
      const a0 = run.a0 + 500, a1 = run.a1 - 1000;
      counterSeats = Math.max(0, Math.floor((a1 - a0) / p.counterPitch));
      if (counterSeats > 0) {
        counterEl = { layer: "COUNTER", kind: "rect", ...stripRect(orient, K.faceLimit, off, FURNITURE.counterTopDepth, a0, a1), label: `カウンター ${counterSeats}席` };
        const cEls = [counterEl];
        for (let i = 0; i < counterSeats; i++) {
          const ca = a0 + i * p.counterPitch + (p.counterPitch - FURNITURE.chair.w) / 2;
          cEls.push({ layer: "CHAIR", kind: "rect", ...stripRect(orient, K.faceLimit, off + FURNITURE.counterTopDepth + 90, FURNITURE.chair.d, ca, ca + FURNITURE.chair.w) });
        }
        const cRect = stripRect(orient, K.faceLimit, off, total, a0, a1);
        stripSolids.push(cRect);
        counterUnit = { rect: cRect, seats: counterSeats, kind: "counter", wall: false, removable: false, els: cEls };
        units.push(counterUnit);
        off += total;
      }
    }
  }
  stripAll.push(...stripSolids);
  // サービス通路(厨房・カウンター前の横断動線)
  const aisleStrip = stripRect(orient, K.faceLimit, off, p.mainAisle, 0, orient === "back" ? bb.maxX : bb.maxY);
  const aisleClip = clipRectPoly(poly, aisleStrip);
  if (aisleClip.length >= 3) zoneEls.push({ layer: "AISLE", kind: "poly", pts: aisleClip, label: `通路 ${p.mainAisle}` });
  stripAll.push({ ...aisleStrip });
  off += p.mainAisle;

  // 客席が使えない帯(厨房〜サービス通路)
  const bandBlock = orient === "back"
    ? { x: 0, y: K.faceLimit - off, w: bb.maxX, h: bb.maxY - (K.faceLimit - off), pad: 0 }
    : orient === "left"
      ? { x: 0, y: 0, w: K.faceLimit + off, h: bb.maxY, pad: 0 }
      : { x: K.faceLimit - off, y: 0, w: bb.maxX - (K.faceLimit - off), h: bb.maxY, pad: 0 };

  // --- WC配置(先行確保されていない場合: 指定コーナーに最近接でスキャン) ---
  // 候補は「四周いずれかに幅900の自由床が接する」=前室・アプローチが成立する位置のみ
  if (!wcRect) {
    const anchors = {
      fl: [0, 0], fr: [bb.maxX - wcW, 0],
      bl: [0, bb.maxY - wcD], br: [bb.maxX - wcW, bb.maxY - wcD],
    };
    const anchor = anchors[p.wcPos] || anchors.bl;
    const wcAvoid = [...stripAll.map(r => ({ ...r, pad: 0 })), ...entranceBlocks, ...colBlocks];
    const sideFree = (r) => [
      { x: r.x, y: r.y - 900, w: r.w, h: 900 },
      { x: r.x, y: r.y + r.h, w: r.w, h: 900 },
      { x: r.x - 900, y: r.y, w: 900, h: r.h },
      { x: r.x + r.w, y: r.y, w: 900, h: r.h },
    ].some(s => rectInPoly(s, poly) && !rectsOverlap(s, kitchenSolid, 0) &&
      !stripSolids.some(q => rectsOverlap(s, q, 0)) && !colBlocks.some(c => rectsOverlap(s, c, 0)));
    let bestD = Infinity;
    for (let gy = 0; gy <= bb.maxY - wcD; gy += 250) {
      for (let gx = 0; gx <= bb.maxX - wcW; gx += 250) {
        const d2 = (gx - anchor[0]) ** 2 + (gy - anchor[1]) ** 2;
        if (d2 >= bestD) continue;
        const r = { x: gx, y: gy, w: wcW, h: wcD };
        if (rectInPoly(r, poly) && !wcAvoid.some(b => rectsOverlap(r, b, b.pad || 0)) && sideFree(r)) {
          wcRect = r; bestD = d2;
        }
      }
    }
    if (!wcRect) { wcRect = { x: anchor[0], y: anchor[1], w: wcW, h: wcD }; warn.push("WCが指定位置周辺に収まりません。"); }
  }
  zoneEls.push({ layer: "WC", kind: "rect", ...wcRect, label: "WC" });
  // 器具帯は店内中心から遠い壁側、前室・廊下は客席側
  {
    const flip = rectCy(wcRect) > bb.maxY / 2; // 奥配置 → 器具は奥壁、前室は手前
    const fx = (off, w, d, label) => flip
      ? { x: wcRect.x + off, y: wcRect.y + wcRect.h - d, w, h: d, label }
      : { x: wcRect.x + off, y: wcRect.y, w, h: d, label };
    let ox = 0;
    const put = (w, d, label) => { zoneEls.push({ layer: "WC", kind: "rect", ...fx(ox, w, d, label) }); ox += w; };
    for (let i = 0; i < wcPlan.shared; i++) put(WC.boothW, WC.boothD, "共用");
    for (let i = 0; i < wcPlan.femaleBooth; i++) put(WC.boothW, WC.boothD, "女");
    if (bf) put(WC.bfW, WC.bfD, "多目的");
    put(WC.lavW, WC.lavD, "手洗");
    for (let i = 0; i < wcPlan.maleBooth; i++) put(WC.boothW, WC.boothD, "男");
    for (let i = 0; i < wcPlan.urinal; i++) put(WC.urinalP, WC.urinalD, "小");
  }
  const wcInKitchen = clipRectPoly(K.poly, wcRect);
  if (wcInKitchen.length >= 3) {
    kitchenArea -= Math.abs(polyArea(wcInKitchen));
    warn.push("WCが厨房帯端部に配置されています(厨房面積から控除済み)。");
  }
  kitchenEl.label = `厨房 ${(kitchenArea / 1e6).toFixed(1)}㎡`;

  // --- メイン客動線(入口からの縦通路帯) ---
  const bandTop = orient === "back" ? K.faceLimit - off : bb.maxY;
  const desiredBandX = p.pattern === "side" ? bb.maxX - p.mainAisle
    : p.pattern === "sideL" ? 0
    : clamp(rectCx(entrance) - p.mainAisle / 2, 0, bb.maxX - p.mainAisle);
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
  if (bandClip.length >= 3) zoneEls.push({ layer: "AISLE", kind: "poly", pts: bandClip, label: `通路 ${p.mainAisle}` });

  // --- サービスステーション(31坪≈102㎡以上でフロア中間・メイン動線沿いに設置が実務目安) ---
  let stationEl = null;
  if (area / 1e6 >= STATION_AREA_M2) {
    const sw = 600, sh = 900;
    const sAvoid = [...entranceBlocks, ...colBlocks, { ...wcRect, pad: 300 }, bandBlock];
    outer2:
    for (let dy = 0; dy <= bandTop * 0.4; dy += 300) {
      for (const yy of [bandTop * 0.55 - dy, bandTop * 0.55 + dy]) {
        for (const xx of [mainBand.x + mainBand.w + 100, mainBand.x - 100 - sw]) {
          const r = { x: xx, y: yy, w: sw, h: sh };
          if (rectInPoly(r, poly) && !sAvoid.some(b => rectsOverlap(r, b, b.pad || 0))) {
            stationEl = { layer: "DISHUP", kind: "rect", ...r, label: "ST" };
            zoneEls.push(stationEl);
            break outer2;
          }
        }
      }
    }
  }

  // --- テーブル類が避けるブロック一式 ---
  const tableBlocks = [
    bandBlock,
    { ...mainBand, pad: 0 },
    { ...wcRect, pad: 600 },
    ...entranceBlocks,
    ...colBlocks,
  ];
  if (stationEl) tableBlocks.push({ x: stationEl.x, y: stationEl.y, w: stationEl.w, h: stationEl.h, pad: 300 });

  // --- 壁ベンチ(バンケット)席 ---
  if (p.bench) {
    const BZ = FURNITURE.bench;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b2 = poly[(i + 1) % poly.length];
      const horiz = Math.abs(a[1] - b2[1]) < 1, vert = Math.abs(a[0] - b2[0]) < 1;
      if (!horiz && !vert) continue;
      const L = Math.hypot(b2[0] - a[0], b2[1] - a[1]);
      if (L < BZ.minWall) continue;
      const u = [(b2[0] - a[0]) / L, (b2[1] - a[1]) / L];
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
          if (units.some(q => rectsOverlap(r, q.rect, 0))) continue;
          const piece = (o0, dep, t0, t1) => {
            const px0 = a[0] + u[0] * t0 + n[0] * o0, py0 = a[1] + u[1] * t0 + n[1] * o0;
            const px1 = a[0] + u[0] * t1 + n[0] * (o0 + dep), py1 = a[1] + u[1] * t1 + n[1] * (o0 + dep);
            return { x: Math.min(px0, px1), y: Math.min(py0, py1), w: Math.abs(px1 - px0), h: Math.abs(py1 - py0) };
          };
          const uEls = [
            { layer: "BENCH", kind: "rect", ...piece(0, BZ.depth, t, t + wMod) },
            { layer: "TABLE", kind: "rect", ...piece(BZ.depth, BZ.tableD, t + 30, t + wMod - 30), label: seats === 4 ? "B4" : "B2" },
          ];
          const nCh = seats / 2;
          for (let c = 0; c < nCh; c++) {
            const cc = t + (wMod / nCh) * (c + 0.5) - FURNITURE.chair.w / 2;
            uEls.push({ layer: "CHAIR", kind: "rect", ...piece(BZ.depth + BZ.tableD + 20, FURNITURE.chair.d, cc, cc + FURNITURE.chair.w) });
          }
          units.push({ rect: r, seats, kind: seats === 4 ? "bench4" : "bench2", wall: true, removable: true, els: uEls });
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
  let n6left = Math.max(0, Math.floor(p.n6 || 0));
  let s4run = 0, s2run = 0, s6run = 0;

  const unitFits = (r) =>
    rectInPoly(r, poly) &&
    !tableBlocks.some(bl => rectsOverlap(r, bl, bl.pad || 0)) &&
    !units.some(q => rectsOverlap(r, q.rect, q.kind.startsWith("bench") ? p.subAisle : 0));

  const phase = (opt && opt.phase) || 0;
  const y0 = 300 + Math.round(phase * (rowModule + p.subAisle));
  for (let y = y0; y + rowModule <= bb.maxY; y += rowModule + p.subAisle) {
    let x = 200;
    while (x < bb.maxX - t2.w) {
      let chosen;
      if (n6left > 0) chosen = t6;
      else {
        const ts = s4run + s2run + s6run;
        chosen = (ts === 0 ? p.mix4 >= 0.5 : (s4run + s6run) / ts < p.mix4) ? t4 : t2;
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
        const uEls = [{ layer: "TABLE", kind: "rect", x, y: ty, w: t.w, h: t.d, label: t.label }];
        if (t.pair) { // 連結卓: 600mmモジュールの分割線(2人卓×nとして運用)
          for (let sx = 600; sx < t.w - 10; sx += 600) {
            uEls.push({ layer: "TABLE", kind: "rect", x: x + sx - 5, y: ty, w: 10, h: t.d });
          }
        }
        const perSide = t.seats / 2;
        for (let s = 0; s < perSide; s++) {
          const cx = x + (t.w / perSide) * (s + 0.5) - FURNITURE.chair.w / 2;
          uEls.push({ layer: "CHAIR", kind: "rect", x: cx, y: ty - FURNITURE.chair.d - 20, w: FURNITURE.chair.w, h: FURNITURE.chair.d });
          uEls.push({ layer: "CHAIR", kind: "rect", x: cx, y: ty + t.d + 20, w: FURNITURE.chair.w, h: FURNITURE.chair.d });
        }
        const rect = { x, y, w: t.w, h: rowModule };
        const wall = distPtPolyEdge(x + t.w / 2, y + rowModule / 2, poly) < 1400;
        units.push({ rect, seats: t.seats, kind: String(t.seats), wall, removable: true, els: uEls });
        if (t === t6) { s6run += 6; n6left--; } else if (t === t4) { s4run += 4; } else { s2run += 2; }
        x += t.w + p.tableGap;
      } else {
        x += 250;
      }
    }
  }
  if (n6left > 0) warn.push(`6人卓が ${n6left} 卓置けませんでした。`);

  // --- 経路解析: 到達不能ユニットの撤去 + 経路距離 ---
  const walkObstaclesFor = (us) => [
    kitchenSolid, ...stripSolids, wcRect, ...columns,
    ...(regiEl ? [{ x: regiEl.x, y: regiEl.y, w: regiEl.w, h: regiEl.h }] : []),
    ...(stationEl ? [{ x: stationEl.x, y: stationEl.y, w: stationEl.w, h: stationEl.h }] : []),
    ...us.map(u => u.rect),
  ];
  const svcSrcRect = dishupEl || counterEl ||
    stripRect(orient, K.faceLimit, 0, 600,
      (orient === "back" ? bb.maxX : bb.maxY) / 2 - 600, (orient === "back" ? bb.maxX : bb.maxY) / 2 + 600);

  let removed = 0, circOk = false, bottleneck = p.mainAisle;
  let maxEgress = 0, avgService = 0, wcReachable = null;
  for (let iter = 0; iter < 4; iter++) {
    const grid = buildWalkGrid(poly, bb, walkObstaclesFor(units), CIRC.cell, CIRC.minClear);
    const entCells = cellsInRect(grid, entrance, 200);
    if (entCells.length === 0) break; // 入口前が塞がっている → 直線距離フォールバック
    const eg = shortestField(grid, entCells);
    const svcCells = cellsInRect(grid, svcSrcRect, 500);
    const sv = svcCells.length ? shortestField(grid, svcCells) : null;
    wcReachable = !!accessPoint(grid, eg.dist, wcRect, CIRC.reach); // 客席側からの到達(厨房は障害扱い)

    const bad = [];
    let egMax = 0, egMaxCell = -1, svSum = 0, svSeats = 0;
    for (const u of units) {
      const ap = accessPoint(grid, eg.dist, u.rect, CIRC.reach);
      if (!ap) { if (u.removable) bad.push(u); else warn.push("カウンター席への動線が確保できていません。"); continue; }
      u.egressD = ap.d + CIRC.reach; // セル→席までの取り付き分を加算
      if (u.egressD > egMax) { egMax = u.egressD; egMaxCell = ap.k; }
      if (sv) {
        const sp = accessPoint(grid, sv.dist, u.rect, CIRC.reach);
        if (sp) { svSum += (sp.d + CIRC.reach) * u.seats; svSeats += u.seats; }
      }
    }
    if (bad.length === 0) {
      circOk = true;
      maxEgress = egMax;
      avgService = svSeats > 0 ? svSum / svSeats : 0;
      if (egMaxCell >= 0) bottleneck = 2 * pathMinClearance(grid, eg.parent, egMaxCell);
      break;
    }
    units = units.filter(u => !bad.includes(u));
    removed += bad.length;
  }
  if (removed > 0) warn.push(`動線が確保できない席ユニット ${removed} 件を自動撤去しました。`);
  if (wcReachable === false) warn.push("客席からトイレへ厨房を経由せず到達できません。営業許可上のリスクがあるため配置を見直してください。");

  // --- 集計 ---
  let n6c = 0, n4c = 0, n2c = 0, nBenchMod = 0;
  let seats6 = 0, seats4 = 0, seats2 = 0, benchSeats = 0;
  const seatGroups = [];
  for (const u of units) {
    seatGroups.push({ cx: rectCx(u.rect), cy: rectCy(u.rect), seats: u.seats, wall: u.wall });
    if (u.kind === "6") { n6c++; seats6 += 6; }
    else if (u.kind === "4") { n4c++; seats4 += 4; }
    else if (u.kind === "2") { n2c++; seats2 += 2; }
    else if (u.kind.startsWith("bench")) { nBenchMod++; benchSeats += u.seats; }
  }
  const totalSeats = seats6 + seats4 + seats2 + benchSeats + counterSeats;
  const wcFinal = toiletPlan(totalSeats, area / 1e6);
  const tsubo = area / 1e6 / 3.30578;
  // 席あたり客席面積(実務レンジ: カウンター主体0.9〜1.2 / テーブル1.2〜1.6 / フルサービス1.6〜)
  const seatZoneM2 = Math.max(0, (area - kitchenArea - wcRect.w * wcRect.h) / 1e6);
  const areaPerSeat = totalSeats > 0 ? seatZoneM2 / totalSeats : 0;
  if (totalSeats > 0 && areaPerSeat < AREA_PER_SEAT_RANGE.min) {
    warn.push(`席あたり客席面積 ${areaPerSeat.toFixed(2)}㎡/席 — 実務最小0.9㎡を下回っています(詰めすぎ)。`);
  } else if (totalSeats > 0 && areaPerSeat > AREA_PER_SEAT_RANGE.high * 1.5) {
    warn.push(`席あたり客席面積 ${areaPerSeat.toFixed(2)}㎡/席 — 余裕が大きく、席数を増やす余地があります。`);
  }
  const entRef = [rectCx(entrance), entrance.y + entrance.h];
  const svcRef = [rectCx(svcSrcRect), rectCy(svcSrcRect)];

  if (!circOk) {
    // フォールバック: 直線距離
    let svcSum = 0, svcSeats2 = 0;
    for (const g of seatGroups) {
      svcSum += Math.hypot(g.cx - svcRef[0], g.cy - svcRef[1]) * g.seats;
      svcSeats2 += g.seats;
      maxEgress = Math.max(maxEgress, Math.hypot(g.cx - entRef[0], g.cy - entRef[1]));
    }
    avgService = svcSeats2 > 0 ? svcSum / svcSeats2 : 0;
    warn.push("経路解析が成立せず直線距離で評価しています(入口前の塞がり等)。");
  }

  let wallSeats = 0;
  for (const g of seatGroups) if (g.wall) wallSeats += g.seats;
  const wallRate = totalSeats > 0 ? wallSeats / totalSeats : 0;

  const diag = Math.hypot(bb.maxX, bb.maxY);
  const seatsPerTsubo = totalSeats / tsubo;
  const sc = SCORE.weights;
  const score = 100 * (
    sc.capacity * Math.min(seatsPerTsubo / SCORE.targetSeatsPerTsubo, 1) +
    sc.service * clamp(1 - avgService / (diag * 0.9), 0, 1) +
    sc.egress * clamp(1 - maxEgress / (diag * 1.4), 0, 1) +
    sc.wall * wallRate
  );

  if (totalSeats === 0) warn.push("席が1つも置けません。条件を見直してください。");
  warn.push("配膳・避難距離は通路経路上の実測値(グリッド近似)。法規の最終判断は所轄庁と要協議。");

  const metrics = {
    totalSeats, seats6, seats4, seats2, counterSeats, benchSeats,
    n6: n6c, n4: n4c, n2: n2c, nBenchMod,
    areaM2: area / 1e6, tsubo, seatsPerTsubo,
    kitchenM2: kitchenArea / 1e6, kitchenPct: kitchenArea / area * 100,
    wcBooths: wcFinal.booths, wcLabel: wcFinal.label,
    avgServiceM: avgService / 1000, maxEgressM: maxEgress / 1000,
    bottleneckM: bottleneck / 1000,
    wallRate, score, removedUnits: removed,
    occupants: totalSeats + Math.max(0, Math.floor(p.staff || 0)),
    areaPerSeat, wcReachable,
    staffGuide: Math.ceil(totalSeats / 10), // スタッフ1人/10席の実務目安
  };
  const elements = [...zoneEls, ...units.flatMap(u => u.els)];
  return { elements, metrics, warnings: warn, params: p, opt, size: { W: bb.maxX, D: bb.maxY } };
}

// メイン通路幅 × パターンのスイープ比較(各セルとも位相最適化済み・総合スコア順)
function sweep(params) {
  const out = [];
  for (const aisle of [900, 1000, 1100, 1200]) {
    for (const pattern of ["center", "side", "sideL"]) {
      const r = generateLayout({ ...params, mainAisle: aisle, pattern });
      out.push({ aisle, pattern, m: r.metrics });
    }
  }
  out.sort((a, b) => b.m.score - a.m.score);
  return out;
}
