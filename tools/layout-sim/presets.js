// 飲食店レイアウトシミュレーター — ルールテーブル(単位: mm)
// ここの数値を直せば全体の挙動が変わる。GHPython移植時もこのテーブルを共有する。

const FURNITURE = {
  table2: { w: 700,  d: 700, seats: 2, label: "2人卓" },
  table4: { w: 1500, d: 750, seats: 4, label: "4人卓" },
  chair:  { w: 420,  d: 420 },
  chairZone: 450,      // テーブル縁から椅子着席に必要な奥行
  counterTopDepth: 450,
  stoolZone: 600,      // カウンター椅子の占有奥行
  dishupDepth: 600,    // デシャップ台の奥行
};

const PRESETS = {
  izakaya: {
    label: "居酒屋・ダイニング",
    kitchenRatio: 0.30, mix4: 0.60,
    mainAisle: 900, subAisle: 700, tableGap: 600,
    counter: true, counterPitch: 650,
    note: "4人席多め・厨房比率高め・デシャップ重視",
  },
  cafe: {
    label: "カフェ",
    kitchenRatio: 0.20, mix4: 0.30,
    mainAisle: 900, subAisle: 600, tableGap: 500,
    counter: true, counterPitch: 600,
    note: "2人席中心・滞在快適性優先・厨房コンパクト",
  },
  restaurant: {
    label: "レストラン(フルサービス)",
    kitchenRatio: 0.30, mix4: 0.55,
    mainAisle: 1200, subAisle: 750, tableGap: 700,
    counter: false, counterPitch: 650,
    note: "席間隔広め・サービス動線重視",
  },
  ramen: {
    label: "ラーメン・カウンター業態",
    kitchenRatio: 0.35, mix4: 0.25,
    mainAisle: 900, subAisle: 600, tableGap: 500,
    counter: true, counterPitch: 600,
    note: "カウンター席主体・回転率優先",
  },
};

// トイレ便器数の目安(客席数ベース)。
// ※あくまで目安。実際は所轄保健所・自治体条例・ビル管理基準の確認が必要。
function toiletPlan(seats) {
  if (seats <= 20)  return { booths: 1, label: "男女共用 1" };
  if (seats <= 40)  return { booths: 2, label: "男1・女1" };
  if (seats <= 70)  return { booths: 3, label: "男1(+小1)・女2 目安" };
  if (seats <= 100) return { booths: 4, label: "男2・女2 目安" };
  const extra = Math.ceil((seats - 100) / 50);
  return { booths: 4 + extra, label: `男女計 ${4 + extra} 目安` };
}

const WC = {
  boothW: 950,   // ブース1基の幅
  boothD: 1600,  // ブース奥行
  lavW: 900,     // 洗面スペース幅
};

const ENTRANCE_DEPTH = 1500; // 入口・レジまわりの確保ゾーン
const AREA_PER_SEAT_EST = 1.5e6; // 席数初期推定用 1.5㎡/席 (mm²)
