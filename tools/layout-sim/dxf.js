// Rhino向け DXF(R12) エクスポート。単位 mm。
// レイヤー別に LINE / TEXT のみで構成(R12互換が最も確実にRhinoで開ける)。

const DXF_COLORS = {
  WALL: 7, KITCHEN: 1, KZONE: 13, DISHUP: 30, COUNTER: 3,
  TABLE: 5, BENCH: 33, CHAIR: 8, AISLE: 252, WC: 6, ENTRANCE: 2, COLUMN: 250, TEXT: 7,
};

function dxfPair(code, value) { return code + "\n" + value + "\n"; }

function dxfLine(layer, x1, y1, x2, y2) {
  return dxfPair(0, "LINE") + dxfPair(8, layer) +
    dxfPair(10, x1) + dxfPair(20, y1) + dxfPair(30, 0) +
    dxfPair(11, x2) + dxfPair(21, y2) + dxfPair(31, 0);
}

function dxfText(layer, x, y, h, text) {
  return dxfPair(0, "TEXT") + dxfPair(8, layer) +
    dxfPair(10, x) + dxfPair(20, y) + dxfPair(30, 0) +
    dxfPair(40, h) + dxfPair(1, text);
}

function buildDXF(elements) {
  let s = "";
  s += dxfPair(0, "SECTION") + dxfPair(2, "TABLES");
  s += dxfPair(0, "TABLE") + dxfPair(2, "LAYER") + dxfPair(70, Object.keys(DXF_COLORS).length);
  for (const [name, color] of Object.entries(DXF_COLORS)) {
    s += dxfPair(0, "LAYER") + dxfPair(2, name) + dxfPair(70, 0) +
      dxfPair(62, color) + dxfPair(6, "CONTINUOUS");
  }
  s += dxfPair(0, "ENDTAB") + dxfPair(0, "ENDSEC");

  s += dxfPair(0, "SECTION") + dxfPair(2, "ENTITIES");
  for (const e of elements) {
    if (e.kind === "rect") {
      const { x, y, w, h } = e;
      s += dxfLine(e.layer, x, y, x + w, y);
      s += dxfLine(e.layer, x + w, y, x + w, y + h);
      s += dxfLine(e.layer, x + w, y + h, x, y + h);
      s += dxfLine(e.layer, x, y + h, x, y);
      if (e.label) s += dxfText("TEXT", x + 100, y + h / 2, 200, e.label);
    } else if (e.kind === "poly") {
      for (let i = 0; i < e.pts.length; i++) {
        const a = e.pts[i], b = e.pts[(i + 1) % e.pts.length];
        s += dxfLine(e.layer, a[0], a[1], b[0], b[1]);
      }
      if (e.label) {
        const c = polyCentroid(e.pts);
        s += dxfText("TEXT", c[0], c[1], 200, e.label);
      }
    }
  }
  s += dxfPair(0, "ENDSEC") + dxfPair(0, "EOF");
  return s;
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime || "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
