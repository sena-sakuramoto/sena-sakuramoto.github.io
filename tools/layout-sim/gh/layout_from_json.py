# -*- coding: utf-8 -*-
"""GHPython: シミュレーターのJSONを読み込み、Grasshopper上に平面を再構築する。

使い方:
  1. Webシミュレーターで「JSON書き出し」→ layout.json を保存
  2. Grasshopper に GHPython コンポーネントを置き、このコードを貼り付け
  3. 入力 path に File Path コンポーネント(layout.json)を接続
     - path: str (Item Access)
  4. 出力:
     - rects : 矩形ポリラインカーブ(全要素)
     - layers: 各矩形のレイヤー名(WALL/KITCHEN/DISHUP/COUNTER/TABLE/CHAIR/AISLE/WC/ENTRANCE)
     - labels: 各矩形のラベル(無い要素は空文字)
     - info  : 指標サマリー文字列

レイヤー名で Cull Pattern / Dispatch すれば色分け・選択表示ができる。
座標系: 原点=店舗左前(入口側)、x=間口、y=奥行、単位mm。
"""
import json
import io
import Rhino.Geometry as rg

rects = []
layers = []
labels = []
info = ""

if path:
    with io.open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    for e in data.get("elements", []):
        if e.get("kind") != "rect":
            continue
        x, y, w, h = e["x"], e["y"], e["w"], e["h"]
        pts = [
            rg.Point3d(x, y, 0),
            rg.Point3d(x + w, y, 0),
            rg.Point3d(x + w, y + h, 0),
            rg.Point3d(x, y + h, 0),
            rg.Point3d(x, y, 0),
        ]
        rects.append(rg.PolylineCurve(pts))
        layers.append(e["layer"])
        labels.append(e.get("label") or "")

    m = data.get("metrics", {})
    info = u"総席数 {0} (4人卓 {1}卓/{2}席, 2人卓 {3}卓/{4}席, カウンター {5}席) / 厨房 {6:.1f}㎡ ({7:.0f}%) / トイレ目安 {8}ブース / {9:.2f}席/坪".format(
        m.get("totalSeats", 0),
        m.get("n4", 0), m.get("seats4", 0),
        m.get("n2", 0), m.get("seats2", 0),
        m.get("counterSeats", 0),
        m.get("kitchenM2", 0.0), m.get("kitchenPct", 0.0),
        m.get("wcBooths", 0),
        m.get("seatsPerTsubo", 0.0),
    )
