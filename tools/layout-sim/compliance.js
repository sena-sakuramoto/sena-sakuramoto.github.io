// 法規チェック(目安) — レイアウト実測値 × REGS(presets.js)の照合
// status: "ok"=本ツール上は充足 / "ng"=本レイアウトが目安超過 / "warn"=設計に織り込むべき事項 / "info"=参考
// あくまで一次スクリーニング。最終判断は建築士・所轄消防・保健所・特定行政庁との協議による。

function evaluateCompliance(m, p) {
  const rows = [];
  const add = (item, status, basis, detail) => rows.push({ item, status, basis, detail });
  const staff = Math.max(0, Math.floor(p.staff || 0));
  const occupants = m.totalSeats + staff;
  const seatAreaM2 = Math.max(0, m.areaM2 - m.kitchenM2 - m.wcBooths * 2.0);

  add("収容人員", "info", "消防法施行規則 第1条の3",
    `客席 ${m.totalSeats}(いす席=席数で算定)+ 従業員 ${staff} = ${occupants} 人`);

  add("用途区分", "info", "消防法 別表第一(3)項ロ / 建基法 令115条の3",
    "飲食店。消防用設備・避難規定はこの区分で判定");

  if (m.areaM2 >= REGS.extinguisherM2) {
    add("消火器具", "warn", "消防法施行令 第10条",
      `延べ ${m.areaM2.toFixed(0)}㎡ ≥ ${REGS.extinguisherM2}㎡ → 設置必要`);
  } else {
    add("消火器具", "warn", "消防法施行令 第10条(H31改正)",
      `${REGS.extinguisherM2}㎡未満でも火を使用する設備があれば原則設置必要`);
  }

  add("自動火災報知設備",
    m.areaM2 >= REGS.fireAlarmM2 ? "warn" : "ok",
    "消防法施行令 第21条",
    m.areaM2 >= REGS.fireAlarmM2
      ? `延べ ${m.areaM2.toFixed(0)}㎡ ≥ ${REGS.fireAlarmM2}㎡ → 設置必要`
      : `延べ ${m.areaM2.toFixed(0)}㎡ < ${REGS.fireAlarmM2}㎡ → 原則不要(無窓階・ビル全体条件は別途)`);

  add("誘導灯", "warn", "消防法施行令 第26条",
    "(3)項は階によらず避難口誘導灯・通路誘導灯が原則必要。所轄消防と協議");

  const travel = m.maxEgressM;
  const okTravel = travel <= REGS.maxTravelM;
  add("避難歩行距離",
    okTravel ? "ok" : "ng",
    "建基法施行令 第120条・第125条",
    `最遠席→入口 経路実測 ${travel.toFixed(1)}m / 目安 ${REGS.maxTravelM}m` +
    (okTravel ? "" : " — 超過。出口追加か配置見直しを") +
    "(避難階は屋外出口まで2倍まで可。上階は直通階段位置で要検証)");

  const wide = seatAreaM2 >= REGS.seatAreaThresholdM2;
  const reqMain = m.areaM2 >= REGS.largeAreaM2 ? REGS.mainEscapeAisleLargeMM
    : wide ? REGS.mainEscapeAisleMM : REGS.subEscapeAisleMM;
  const bottleneckMM = m.bottleneckM * 1000;
  add("客席避難通路幅",
    p.mainAisle >= reqMain ? "ok" : "ng",
    "自治体火災予防条例(例: 東京都条例の客席規定)",
    `客席 約${seatAreaM2.toFixed(0)}㎡ → 主要避難通路 ${reqMain}mm 目安に対し設定 ${p.mainAisle}mm` +
    (p.mainAisle >= reqMain ? "" : " — 不足。メイン通路幅を上げる") +
    `。参考: 最遠席ルート最狭部(卓間含む実測)${bottleneckMM.toFixed(0)}mm`);

  add("二方向避難",
    (wide || occupants >= REGS.occupantsTwoWayEgress) ? "warn" : "ok",
    "建基法施行令 第121条系・消防指導",
    (wide || occupants >= REGS.occupantsTwoWayEgress)
      ? `客席${seatAreaM2.toFixed(0)}㎡ / 収容${occupants}人 — 本ツールは出口1箇所前提。第2避難口の確保を検討`
      : "小規模のため出口1箇所で成立する場合が多い(要個別確認)");

  add("内装制限", "warn", "建基法施行令 第128条の4・第129条",
    "厨房(火気使用室)は壁・天井 準不燃以上。客席も建物規模・階数により難燃〜準不燃");

  add("排煙設備", "info", "建基法施行令 第126条の2",
    `延べ${REGS.smokeM2}㎡超の特殊建築物等で必要。テナントの場合はビル全体の排煙方式に従う`);

  add("バリアフリー", m.bottleneckM * 1000 >= 1200 ? "ok" : "info",
    "バリアフリー法・自治体条例",
    `車椅子動線の目安 1200mm — 最遠席ルート最狭部 ${bottleneckMM.toFixed(0)}mm` +
    (bottleneckMM >= 1200 ? "" : "(主要動線のみ1200確保なら成立する場合あり)"));

  add("便所(器具数)", "info", "労安規則(従業員下限)・SHASE-S206事務所値の客数換算",
    `${m.wcLabel}。法定の席数→便器数は存在しない(SHASE-S206に飲食店区分なし)。` +
    "ブース900×1500・小便器ピッチ750・前室900で自動作図。手洗いは厨房用と別系統(目安36×28cm以上)");

  if (m.wcReachable !== null && m.wcReachable !== undefined) {
    add("便所(動線)", m.wcReachable ? "ok" : "ng", "食品衛生法 施設基準(自治体条例)",
      m.wcReachable
        ? "客席から厨房を経由しない動線を確保"
        : "客席からトイレへ厨房を経由せず到達できない — 営業許可が下りないリスク");
  }

  add("グリストラップ", "warn", "下水道法・自治体条例(容量はHASS 217系で算定)",
    "自治体条例で設置義務となる例が多い。厨房洗浄ゾーン直下・屋外埋設等、清掃動線と合わせ計画");

  add("更衣場所", "warn", "労働安全衛生規則 第625条・営業許可施設基準",
    "作業場の外に従業員更衣場所が必要(保健所検査項目)。バックヤード計画に織り込み");

  add("搬入・ゴミ動線", "info", "実務(保健所指導)",
    "搬入口→保管庫は最短に。ゴミ置場は客席・厨房から離し、客動線と交差させない");

  return rows;
}
