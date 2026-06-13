// Rhino .3dm 書き出し(rhino3dm.js / WASM)
// ライブラリはボタン押下時にCDNから遅延ロード。読めない環境ではDXFを案内する。

const RHINO3DM_CDN = "https://cdn.jsdelivr.net/npm/rhino3dm@8.4.0/rhino3dm.min.js";

const LAYER_RGB = {
  WALL: [40, 40, 40], KITCHEN: [214, 84, 58], KZONE: [222, 150, 135], DISHUP: [224, 138, 44],
  COUNTER: [90, 140, 60], TABLE: [62, 106, 150], BENCH: [168, 145, 95],
  CHAIR: [150, 144, 134], AISLE: [200, 196, 186], WC: [150, 80, 160],
  ENTRANCE: [190, 160, 40], COLUMN: [85, 83, 78],
};

let _rhinoPromise = null;
function loadRhino3dm() {
  if (_rhinoPromise) return _rhinoPromise;
  _rhinoPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = RHINO3DM_CDN;
    s.onload = () => rhino3dm().then(resolve, reject);
    s.onerror = () => {
      _rhinoPromise = null;
      reject(new Error("rhino3dm の読み込みに失敗しました(オフライン環境ではDXF書き出しをご利用ください)"));
    };
    document.head.appendChild(s);
  });
  return _rhinoPromise;
}

async function build3dm(elements) {
  const rhino = await loadRhino3dm();
  const doc = new rhino.File3dm();
  doc.settings().modelUnitSystem = rhino.UnitSystem.Millimeters;

  const layerIndex = {};
  for (const [name, [r, g, b]] of Object.entries(LAYER_RGB)) {
    const layer = new rhino.Layer();
    layer.name = name;
    layer.color = { r, g, b, a: 255 };
    layerIndex[name] = doc.layers().add(layer);
    layer.delete();
  }

  for (const e of elements) {
    if (e.kind !== "rect" && e.kind !== "poly") continue;
    const attrs = new rhino.ObjectAttributes();
    attrs.layerIndex = layerIndex[e.layer] ?? 0;
    const pl = new rhino.Polyline();
    let labelAt;
    if (e.kind === "rect") {
      pl.add(e.x, e.y, 0);
      pl.add(e.x + e.w, e.y, 0);
      pl.add(e.x + e.w, e.y + e.h, 0);
      pl.add(e.x, e.y + e.h, 0);
      pl.add(e.x, e.y, 0);
      labelAt = [e.x + e.w / 2, e.y + e.h / 2, 0];
    } else {
      for (const q of e.pts) pl.add(q[0], q[1], 0);
      pl.add(e.pts[0][0], e.pts[0][1], 0);
      const c = polyCentroid(e.pts);
      labelAt = [c[0], c[1], 0];
    }
    doc.objects().addPolyline(pl, attrs);
    if (e.label) {
      doc.objects().addTextDot(e.label, labelAt, attrs);
    }
    pl.delete();
    attrs.delete();
  }
  return doc.toByteArray();
}

async function export3dm(elements) {
  const buf = await build3dm(elements);
  downloadFile("layout.3dm", buf, "application/octet-stream");
}
