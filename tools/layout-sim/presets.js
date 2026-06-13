// 飲食店レイアウトシミュレーター — ルールテーブル(単位: mm)
// ここの数値を直せば全体の挙動が変わる。GHPython移植時もこのテーブルを共有する。

// 寸法は実務値ベース(出典: ADAL/大昌工芸/ピースワーク等の店舗家具・設計資料)
const FURNITURE = {
  table2: { w: 600,  d: 700, seats: 2, label: "2人卓" },
  // 4人卓は 600幅の2人卓×2連結で運用(1人客の死に席対策・実務の定石)
  table4: { w: 1200, d: 750, seats: 4, label: "4人卓", pair: true },
  table6: { w: 1800, d: 750, seats: 6, label: "6人卓", pair: true },
  chair:  { w: 420,  d: 420 },
  chairZone: 450,      // テーブル縁から椅子着席に必要な奥行(立ち座り余裕は行間サブ通路で確保)
  counterTopDepth: 450,
  stoolZone: 600,      // カウンター椅子の占有奥行
  dishupDepth: 600,    // デシャップ台の奥行
  // 壁ベンチ(バンケット): ベンチ500+テーブル700+椅子側450 = 奥行1650。4人席ソファ幅1500が実務値
  bench: { depth: 500, tableD: 700, zoneD: 1650, mod4W: 1500, mod2W: 750, gap: 300, minWall: 1800 },
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
  mainEscapeAisleLargeMM: 1600, // 300㎡超の目安(建基法施行令系解説)
  largeAreaM2: 300,
  subEscapeAisleMM: 800,   // 補助通路幅の目安
  seatAreaThresholdM2: 150,// 客席面積の閾値 [㎡](通路幅・二方向避難の検討ライン)
  extinguisherM2: 150,     // 消火器: 消防法施行令10条 (3)項ロ 150㎡以上。※H31改正で火気使用の飲食店は面積によらず原則必要
  fireAlarmM2: 300,        // 自動火災報知設備: 消防法施行令21条 (3)項 延べ300㎡以上
  smokeM2: 500,            // 排煙設備: 建基法施行令126条の2(延べ500㎡超の特殊建築物等)
  occupantsTwoWayEgress: 50, // 二方向避難の検討を促す収容人員
};

// 厨房内部ゾーニングの目安比率(面に沿った分割: 一方通行動線 仕込→加熱→盛付/提供→下膳→洗浄)
const KITCHEN_ZONES = [
  { f: 0.30, label: "洗浄・下膳" },
  { f: 0.40, label: "加熱・盛付" },
  { f: 0.30, label: "下処理・冷蔵" },
];

// seatsPerTsubo = 業態別の坪効率ターゲット(高級1〜1.5 / 一般1.5〜2 / 大衆2.5 が実務目安)
const PRESETS = {
  izakaya: {
    label: "居酒屋・ダイニング",
    kitchenRatio: 0.30, mix4: 0.60, seatsPerTsubo: 2.5,
    mainAisle: 900, subAisle: 700, tableGap: 600,
    counter: true, counterPitch: 650,
    note: "4人席多め・厨房比率30%・デシャップ重視・坪2.5席目標",
  },
  cafe: {
    label: "カフェ",
    kitchenRatio: 0.20, mix4: 0.30, seatsPerTsubo: 1.8,
    mainAisle: 900, subAisle: 600, tableGap: 500,
    counter: true, counterPitch: 600,
    note: "2人席中心・滞在快適性優先・厨房20%・坪1.8席目標",
  },
  restaurant: {
    label: "レストラン(フルサービス)",
    kitchenRatio: 0.35, mix4: 0.55, seatsPerTsubo: 1.5,
    mainAisle: 1200, subAisle: 800, tableGap: 700,
    counter: false, counterPitch: 650,
    note: "席間隔広め・厨房35%・サービス動線重視・坪1.5席目標",
  },
  ramen: {
    label: "ラーメン・カウンター業態",
    kitchenRatio: 0.20, mix4: 0.25, seatsPerTsubo: 2.5,
    mainAisle: 900, subAisle: 600, tableGap: 500,
    counter: true, counterPitch: 600,
    note: "カウンター席主体・回転率優先・厨房10〜20%が実務・坪2.5席目標",
  },
};

// 席あたり客席面積の実務レンジ [㎡/席](カウンター主体0.9〜1.2 / テーブル主体1.2〜1.6 / フルサービス1.6〜)
const AREA_PER_SEAT_RANGE = { min: 0.9, low: 1.2, high: 1.8 };

// サービスステーション: この床面積[㎡]以上でフロア中間に設置(31坪≈102㎡が実務目安)
const STATION_AREA_M2 = 102;

// 便器数算定。
// 法定の「席数→便器数」は存在しない(SHASE-S206に飲食店区分なし)。
// 下限=労安規則の従業員基準(男大60人/1・男小30人/1・女20人/1、同時10人以内は共用個室1可)、
// 客用は事務所レベル1の実測値(100人: 男大2・男小2・女大3)を席数換算した近似。
// 30席以下かつ100㎡未満は男女共用1(小規模店の実務)。所轄保健所との事前協議が前提。
function toiletPlan(seats, areaM2 = 0) {
  if (seats <= 30 && areaM2 < 100) {
    return { shared: 1, maleBooth: 0, urinal: 0, femaleBooth: 0, booths: 1, label: "男女共用1(独立個室型)" };
  }
  const maleBooth = Math.max(1, Math.ceil(seats / 80));
  const urinal = Math.max(1, Math.ceil(seats / 60));
  const femaleBooth = Math.max(1, Math.ceil(seats / 40));
  return {
    shared: 0, maleBooth, urinal, femaleBooth,
    booths: maleBooth + femaleBooth,
    label: `男 大${maleBooth}・小${urinal} / 女 ${femaleBooth}`,
  };
}

// トイレまわりの実務寸法(出典: 店舗デザイン.COM、国交省建築設計標準・計画資料ほか)
const WC = {
  boothW: 900, boothD: 1500,  // 洋式ブース標準(最小800×1200)
  urinalP: 750, urinalD: 400, // 小便器ピッチ(推奨750)・器具占有奥行
  lavW: 900, lavD: 550,       // 手洗いカウンター(幅650〜900・奥行550〜600が主流)
  corridor: 900,              // 前室・ブース前廊下(900〜1200推奨)
  bfW: 2000, bfD: 2000,       // 車椅子使用者用便房 標準内法(内接円φ1500)
};

const ENTRANCE_DEPTH = 1500; // 入口・レジまわりの確保ゾーン
const AREA_PER_SEAT_EST = 1.5e6; // 席数初期推定用 1.5㎡/席 (mm²)
