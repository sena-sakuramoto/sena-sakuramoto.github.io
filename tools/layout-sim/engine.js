// 配置エンジン — ルールベースのゾーニング + テーブル充填
// 座標系: 原点は店舗左前(入口側)。x=間口方向, y=奥行方向(入口 y=0, 厨房が最奥)。単位 mm。

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// params:
//   W, D            店舗内寸(間口×奥行)
//   presetKey       業態キー
//   mainAisle       メイン通路幅
//   subAisle        サブ通路(サービス動線)幅
//   mix4            テーブル席のうち4人卓に割く席数比率 0..1
//   kitchenRatio    厨房面積比率 0..1
//   counterEnabled  厨房前カウンター席
//   counterPitch    カウンター1席ピッチ
//   dishup          デシャップ台
//   pattern         "center" | "side" | "auto"
function generateLayout(params) {
  // 1パス目: 面積からの仮席数でトイレを仮置き → 実席数で確定して再生成
  const est = toiletPlan(Math.max(1, Math.floor(params.W * params.D / AREA_PER_SEAT_EST)));
  const first = layoutCore(params, est.booths);
  const fin = toiletPlan(first.metrics.totalSeats);
  return fin.booths === est.booths ? first : layoutCore(params, fin.booths);
}

function layoutCore(params, wcBooths) {
  const p = { ...params };
  const els = [];   // {layer, kind:"rect"|"text", x,y,w,h, label}
  const warn = [];

  const area = p.W * p.D;
  if (p.W < 4000 || p.D < 6000) warn.push("店舗寸法が小さすぎます(間口4m×奥行6m以上を推奨)");

  // --- トイレ ---
  const wc = { booths: wcBooths };
  const wcW = wc.booths * WC.boothW + WC.lavW;
  const wcD = WC.boothD;
  // 入口横(前面左)に配置
  els.push({ layer: "WC", kind: "rect", x: 0, y: 0, w: wcW, h: wcD, label: `WC ×${wc.booths}` });

  // --- 入口ゾーン(前面右側) ---
  els.push({ layer: "ENTRANCE", kind: "rect", x: p.W - 2000, y: 0, w: 2000, h: ENTRANCE_DEPTH, label: "入口" });

  // --- 厨房(最奥の全幅帯) ---
  const kitchenD = clamp(Math.round(p.kitchenRatio * p.D), 2500, Math.round(p.D * 0.5));
  const kitchenY = p.D - kitchenD;
  els.push({ layer: "KITCHEN", kind: "rect", x: 0, y: kitchenY, w: p.W, h: kitchenD, label: `厨房 ${(p.W * kitchenD / 1e6).toFixed(1)}㎡` });

  // --- デシャップ台 ---
  let frontY = kitchenY; // 客席側に積み上げていく境界
  let dishupLen = 0;
  if (p.dishup) {
    frontY -= FURNITURE.dishupDepth;
    dishupLen = p.W - 1000; // 厨房出入口分を確保
    els.push({ layer: "DISHUP", kind: "rect", x: 0, y: frontY, w: dishupLen, h: FURNITURE.dishupDepth, label: "デシャップ" });
  }

  // --- 厨房前カウンター席 ---
  let counterSeats = 0;
  if (p.counterEnabled) {
    const ctY = frontY - FURNITURE.counterTopDepth;
    const stY = ctY - FURNITURE.stoolZone;
    const usable = p.W - 1500; // 端部・厨房出入口の逃げ
    counterSeats = Math.max(0, Math.floor(usable / p.counterPitch));
    if (counterSeats > 0) {
      els.push({ layer: "COUNTER", kind: "rect", x: 0, y: ctY, w: usable, h: FURNITURE.counterTopDepth, label: `カウンター ${counterSeats}席` });
      for (let i = 0; i < counterSeats; i++) {
        const cx = i * p.counterPitch + (p.counterPitch - FURNITURE.chair.w) / 2;
        els.push({ layer: "CHAIR", kind: "rect", x: cx, y: stY + 100, w: FURNITURE.chair.w, h: FURNITURE.chair.d });
      }
      frontY = stY;
    }
  }

  // --- メイン横通路(カウンター/デシャップ前のサービス動線) ---
  frontY -= p.mainAisle;
  els.push({ layer: "AISLE", kind: "rect", x: 0, y: frontY, w: p.W, h: p.mainAisle, label: `通路 ${p.mainAisle}` });

  // --- 客席ゾーン ---
  const diningY0 = Math.max(wcD, ENTRANCE_DEPTH) + 200; // WC前・入口前の逃げ
  const diningY1 = frontY;
  const diningD = diningY1 - diningY0;
  if (diningD < 1700) warn.push("客席に使える奥行がほぼありません。厨房比率か通路幅を見直してください。");

  // --- パターン: center=中央通路 / side=片側通路 ---
  const blocks = [];
  if (p.pattern === "center") {
    const bw = (p.W - p.mainAisle) / 2;
    blocks.push({ x: 0, w: bw }, { x: bw + p.mainAisle, w: bw });
    els.push({ layer: "AISLE", kind: "rect", x: bw, y: diningY0, w: p.mainAisle, h: diningD, label: `通路 ${p.mainAisle}` });
  } else { // side: 右壁沿いに縦通路(入口から直通)
    blocks.push({ x: 0, w: p.W - p.mainAisle });
    els.push({ layer: "AISLE", kind: "rect", x: p.W - p.mainAisle, y: diningY0, w: p.mainAisle, h: diningD, label: `通路 ${p.mainAisle}` });
  }

  // --- テーブル充填(行=横方向の帯。行間はサブ通路) ---
  const t4 = FURNITURE.table4, t2 = FURNITURE.table2;
  const rowModule = t4.d + FURNITURE.chairZone * 2; // 1650 を共通モジュールとする
  let n4 = 0, n2 = 0;
  let seats4 = 0, seats2 = 0;

  for (const b of blocks) {
    let y = diningY0;
    while (y + rowModule <= diningY1) {
      const tableSeats = seats4 + seats2;
      const useFour = tableSeats === 0 ? p.mix4 >= 0.5 : (seats4 / tableSeats) < p.mix4;
      const t = useFour ? t4 : t2;
      const margin = 300;
      const usable = b.w - margin * 2;
      const count = Math.floor((usable + p.tableGap) / (t.w + p.tableGap));
      const rowW = count * t.w + (count - 1) * p.tableGap;
      const x0 = b.x + margin + (usable - rowW) / 2;
      const ty = y + FURNITURE.chairZone;
      for (let i = 0; i < count; i++) {
        const tx = x0 + i * (t.w + p.tableGap);
        els.push({ layer: "TABLE", kind: "rect", x: tx, y: ty, w: t.w, h: t.d, label: t.label });
        // 椅子(長辺の前後に配置)
        const perSide = t.seats / 2;
        for (let s = 0; s < perSide; s++) {
          const cx = tx + (t.w / perSide) * (s + 0.5) - FURNITURE.chair.w / 2;
          els.push({ layer: "CHAIR", kind: "rect", x: cx, y: ty - FURNITURE.chair.d - 20, w: FURNITURE.chair.w, h: FURNITURE.chair.d });
          els.push({ layer: "CHAIR", kind: "rect", x: cx, y: ty + t.d + 20, w: FURNITURE.chair.w, h: FURNITURE.chair.d });
        }
      }
      if (useFour) { n4 += count; seats4 += count * 4; } else { n2 += count; seats2 += count * 2; }
      y += rowModule + p.subAisle;
    }
  }

  // --- 外壁 ---
  els.push({ layer: "WALL", kind: "rect", x: 0, y: 0, w: p.W, h: p.D });

  const totalSeats = seats4 + seats2 + counterSeats;
  const wcFinal = toiletPlan(totalSeats);

  const tsubo = area / 1e6 / 3.30578;
  const metrics = {
    totalSeats, seats4, seats2, counterSeats, n4, n2,
    areaM2: area / 1e6, tsubo,
    seatsPerTsubo: totalSeats / tsubo,
    kitchenM2: p.W * kitchenD / 1e6,
    kitchenPct: (kitchenD * p.W) / area * 100,
    wcBooths: wcFinal.booths, wcLabel: wcFinal.label,
    dishupLen,
  };
  return { elements: els, metrics, warnings: warn, params: p };
}

// メイン通路幅 × パターンのスイープ比較
function sweep(params) {
  const out = [];
  for (const aisle of [900, 1000, 1100, 1200]) {
    for (const pattern of ["center", "side"]) {
      const r = generateLayout({ ...params, mainAisle: aisle, pattern });
      out.push({ aisle, pattern, m: r.metrics });
    }
  }
  return out;
}

function bestPattern(params) {
  const c = generateLayout({ ...params, pattern: "center" });
  const s = generateLayout({ ...params, pattern: "side" });
  return s.metrics.totalSeats > c.metrics.totalSeats ? "side" : "center";
}
