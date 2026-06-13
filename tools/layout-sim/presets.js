// 飲食店レイアウトシミュレーター — ルールテーブル(単位: mm)
// ここの数値を直せば全体の挙動が変わる。GHPython移植時もこのテーブルを共有する。

const FURNITURE = {
  table2: { w: 700,  d: 700, seats: 2, label: "2人卓" },
  table4: { w: 1500, d: 750, seats: 4, label: "4人卓" },
  table6: { w: 1800, d: 750, seats: 6, label: "6人卓" },
  chair:  { w: 420,  d: 420 },
  chairZone: 450,      // テーブル縁から椅子着席に必要な奥行
  counterTopDepth: 450,
  stoolZone: 600,      // カウンター椅子の占有奥行
  dishupDepth: 600,    // デシャップ台の奥行
  // 壁ベンチ(バンケット)モジュール: 壁→ベンチ500+テーブル700+椅子側450 = 奥行1650
  bench: { depth: 500, tableD: 700, zoneD: 1650, mod4W: 1400, mod2W: 750, gap: 300, minWall: 1800 },
};

// 多目的スコア(0〜100)の重み。capacity=坪効率 / service=配膳動線 / egress=避難距離 / wall=壁際席率
const SCORE = {
  weights: { capacity: 0.5, service: 0.2, egress: 0.15, wall: 0.15 },
  targetSeatsPerTsubo: 2.2,  // これ以上で坪効率スコア満点
};

// 経路解析の設定
const CIRC = {
  cell: 100,        // グリッドセル寸法
  minClear: 250,    // 歩行可能とみなす最小クリアランス(=有効幅500mm相当)。通路幅の適否は別途チェック
  reach: 650,       // 席ユニットからアクセス点を探す距離
};

// 法規チェックの基準値(目安)。テナント条件・所轄庁により異なるため、案件ごとにここを調整する。
const REGS = {
  maxTravelM: 30,          // 歩行距離の目安 [m]。建基法施行令120条(直通階段まで)系の代表値。
                           // 避難階では屋外出口まで2倍まで可(令125条)。上階テナントは階段位置で別途検証
  mainEscapeAisleMM: 1200, // 客席150㎡以上で求められることが多い主要避難通路幅(自治体火災予防条例。例: 東京都条例)
  subEscapeAisleMM: 800,   // 補助通路幅の目安
  seatAreaThresholdM2: 150,// 客席面積の閾値 [㎡](通路幅・二方向避難の検討ライン)
  extinguisherM2: 150,     // 消火器: 消防法施行令10条 (3)項ロ 150㎡以上。※H31改正で火気使用の飲食店は面積によらず原則必要
  fireAlarmM2: 300,        // 自動火災報知設備: 消防法施行令21条 (3)項 延べ300㎡以上
  smokeM2: 500,            // 排煙設備: 建基法施行令126条の2(延べ500㎡超の特殊建築物等)
  occupantsTwoWayEgress: 50, // 二方向避難の検討を促す収容人員
};

// 厨房内部ゾーニングの目安比率(面に沿った分割: デシャップ寄り→奥)
const KITCHEN_ZONES = [
  { f: 0.30, label: "洗浄・下膳" },
  { f: 0.40, label: "加熱ライン" },
  { f: 0.30, label: "仕込み・冷蔵" },
];

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
