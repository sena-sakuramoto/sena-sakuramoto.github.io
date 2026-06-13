// UIバインド + SVG描画 + エクスポート

const SVG_COLORS = {
  WALL: "none", KITCHEN: "#f7d9d2", DISHUP: "#f3c08c", COUNTER: "#cfe3c2",
  TABLE: "#c8d8ea", BENCH: "#d9bf8f", CHAIR: "#e6e2da", AISLE: "#f1efe9",
  WC: "#e3cfe6", ENTRANCE: "#f5e9b8", COLUMN: "#8d8a83",
};
const SVG_STROKES = { WALL: "#2a2a28", TABLE: "#5b7da0", BENCH: "#a8915f", CHAIR: "#a5a097", COUNTER: "#6f9457", COLUMN: "#55534e" };

const $ = (id) => document.getElementById(id);

function parsePairs(text, n) {
  const out = [];
  for (const line of (text || "").split("\n")) {
    const v = line.split(/[,\s、]+/).map(Number).filter(x => !Number.isNaN(x));
    if (v.length >= n) out.push(v.slice(0, n));
  }
  return out;
}

function readParams() {
  return {
    shape: $("inShape").value,
    W: Number($("inW").value),
    D: Number($("inD").value),
    notchPos: $("inNotchPos").value,
    notchW: Number($("inNotchW").value),
    notchD: Number($("inNotchD").value),
    freePts: parsePairs($("inFree").value, 2),
    columns: parsePairs($("inCols").value, 4).map(v => ({ x: v[0], y: v[1], w: v[2], h: v[3] })),
    kitchenPos: $("inKitchenPos").value,
    entrancePos: $("inEntrance").value,
    wcPos: $("inWCPos").value,
    presetKey: $("inPreset").value,
    mainAisle: Number($("inMain").value),
    subAisle: Number($("inSub").value),
    mix4: Number($("inMix4").value) / 100,
    n6: Number($("inN6").value),
    bench: $("inBench").checked,
    kitchenRatio: Number($("inKitchen").value) / 100,
    tableGap: Number($("inGap").value),
    counterEnabled: $("inCounter").checked,
    counterPitch: Number($("inPitch").value),
    dishup: $("inDishup").checked,
    pattern: $("inPattern").value,
  };
}

function applyPreset(key) {
  const p = PRESETS[key];
  $("inMain").value = p.mainAisle;
  $("inSub").value = p.subAisle;
  $("inMix4").value = Math.round(p.mix4 * 100);
  $("inKitchen").value = Math.round(p.kitchenRatio * 100);
  $("inGap").value = p.tableGap;
  $("inCounter").checked = p.counter;
  $("inPitch").value = p.counterPitch;
  $("presetNote").textContent = p.note;
}

function syncShapeUI() {
  const s = $("inShape").value;
  $("grpWD").style.display = s === "free" ? "none" : "";
  $("grpNotch").style.display = s === "L" ? "" : "none";
  $("grpFree").style.display = s === "free" ? "" : "none";
}

function renderSVG(result) {
  const { W, D } = result.size;
  const svg = $("plan");
  svg.setAttribute("viewBox", `-300 -300 ${W + 600} ${D + 600}`);
  let s = "";
  const order = ["AISLE", "ENTRANCE", "WC", "KITCHEN", "DISHUP", "COUNTER", "BENCH", "TABLE", "CHAIR", "COLUMN", "WALL"];
  const sorted = [...result.elements].sort((a, b) => order.indexOf(a.layer) - order.indexOf(b.layer));
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  for (const e of sorted) {
    const fill = SVG_COLORS[e.layer] || "#ddd";
    const stroke = SVG_STROKES[e.layer] || "#b8b3aa";
    const sw = e.layer === "WALL" ? 80 : 15;
    let lx, ly;
    if (e.kind === "poly") {
      const pts = e.pts.map(q => `${q[0]},${D - q[1]}`).join(" ");
      s += `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
      const c = polyCentroid(e.pts);
      lx = c[0]; ly = D - c[1];
    } else {
      const y = D - e.y - e.h; // SVGはy下向き: 入口を下に
      s += `<rect x="${e.x}" y="${y}" width="${e.w}" height="${e.h}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
      lx = e.x + e.w / 2; ly = y + e.h / 2;
    }
    if (e.label) {
      s += `<text x="${lx}" y="${ly}" font-size="320" fill="#555" text-anchor="middle" dominant-baseline="middle">${esc(e.label)}</text>`;
    }
  }
  s += `<text x="${W / 2}" y="${D + 450}" font-size="350" fill="#888" text-anchor="middle">間口 ${W} ／ 入口側</text>`;
  svg.innerHTML = s;
}

function renderKPIs(m) {
  $("kpis").innerHTML = `
    <div class="kpi"><div class="num">${m.totalSeats}<small> 席</small></div><div class="cap">総席数</div></div>
    <div class="kpi"><div class="num">${m.score.toFixed(0)}<small> 点</small></div><div class="cap">総合スコア</div></div>
    <div class="kpi"><div class="num">${m.seatsPerTsubo.toFixed(2)}<small> 席/坪</small></div><div class="cap">坪効率 (${m.tsubo.toFixed(1)}坪)</div></div>
    <div class="kpi"><div class="num">${m.n6 + m.n4}<small> 卓 / ${m.seats6 + m.seats4}席</small></div><div class="cap">6・4人卓</div></div>
    <div class="kpi"><div class="num">${m.n2}<small> 卓 / ${m.seats2}席</small></div><div class="cap">2人卓</div></div>
    <div class="kpi"><div class="num">${m.benchSeats}<small> 席</small></div><div class="cap">壁ベンチ席</div></div>
    <div class="kpi"><div class="num">${m.counterSeats}<small> 席</small></div><div class="cap">カウンター</div></div>
    <div class="kpi"><div class="num">${m.kitchenM2.toFixed(1)}<small> ㎡ (${m.kitchenPct.toFixed(0)}%)</small></div><div class="cap">厨房面積</div></div>
    <div class="kpi"><div class="num">${m.avgServiceM.toFixed(1)}<small> m</small></div><div class="cap">配膳動線(平均・直線)</div></div>
    <div class="kpi"><div class="num">${m.maxEgressM.toFixed(1)}<small> m</small></div><div class="cap">避難距離(最大・直線)</div></div>
    <div class="kpi"><div class="num">${(m.wallRate * 100).toFixed(0)}<small> %</small></div><div class="cap">壁際席率</div></div>
    <div class="kpi"><div class="num">${m.wcBooths}<small> ブース</small></div><div class="cap">トイレ目安 (${m.wcLabel})</div></div>`;
}

function renderSweep(params) {
  const rows = sweep(params);
  const pname = { center: "中央通路", side: "片側通路" };
  $("sweepBody").innerHTML = rows.map((r, i) => `
    <tr class="${i === 0 ? "best" : ""}">
      <td>${pname[r.pattern]} / 通路${r.aisle}</td>
      <td>${r.m.totalSeats}</td>
      <td>${r.m.seatsPerTsubo.toFixed(2)}</td>
      <td>${r.m.avgServiceM.toFixed(1)}m</td>
      <td>${r.m.maxEgressM.toFixed(1)}m</td>
      <td>${(r.m.wallRate * 100).toFixed(0)}%</td>
      <td>${r.m.score.toFixed(0)}</td>
    </tr>`).join("");
}

let lastResult = null;

function update() {
  const params = readParams();
  syncShapeUI();
  if (params.pattern === "auto") params.pattern = bestPattern(params);
  lastResult = generateLayout(params);
  renderSVG(lastResult);
  renderKPIs(lastResult.metrics);
  renderSweep(readParams());
  $("warns").innerHTML = lastResult.warnings.map(w => "⚠ " + w).join("<br>");
  $("valMix4").textContent = $("inMix4").value + "%";
  $("valKitchen").textContent = $("inKitchen").value + "%";
}

function init() {
  for (const [k, v] of Object.entries(PRESETS)) {
    const o = document.createElement("option");
    o.value = k; o.textContent = v.label;
    $("inPreset").appendChild(o);
  }
  $("inPreset").value = "izakaya";
  applyPreset("izakaya");
  $("inPreset").addEventListener("change", () => { applyPreset($("inPreset").value); update(); });
  document.querySelectorAll("input, select, textarea").forEach(el => el.addEventListener("input", update));

  $("btnDXF").addEventListener("click", () => {
    if (!lastResult) return;
    downloadFile("layout.dxf", buildDXF(lastResult.elements), "application/dxf");
  });
  $("btn3DM").addEventListener("click", async () => {
    if (!lastResult) return;
    const btn = $("btn3DM");
    btn.disabled = true;
    btn.textContent = "生成中…";
    try {
      await export3dm(lastResult.elements);
    } catch (e) {
      alert(e.message || "3DM書き出しに失敗しました。DXF書き出しをご利用ください。");
    } finally {
      btn.disabled = false;
      btn.textContent = "3DM書き出し (Rhino)";
    }
  });
  $("btnJSON").addEventListener("click", () => {
    if (!lastResult) return;
    downloadFile("layout.json", JSON.stringify(lastResult, null, 2), "application/json");
  });
  update();
}

document.addEventListener("DOMContentLoaded", init);
