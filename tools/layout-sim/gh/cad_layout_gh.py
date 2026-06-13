# -*- coding: utf-8 -*-
"""GHPython ラッパ — 既存CADベースを読み、engine_core でレイアウトを生成して Rhino にベイクする。

必要環境: Rhino 8(GHPython / CPython3)。engine_core.py を同じフォルダに置く。

GHPython コンポーネントの入力(右クリックで型と一致させる):
  libpath : str   engine_core.py のあるフォルダ(例 "C:/.../tools/layout-sim/gh")
  source  : str   "layer"(Rhinoのレイヤー名で読む) または "curve"(下のCurve入力を使う)
  boundary: Curve 内壁の閉曲線(source="curve"時)
  windows : Curve[] 窓(壁上の線)
  columns : Curve[] 柱の閉曲線
  ps      : Curve[] PS/MB/ダクトの閉曲線
  entrance: Curve  入口(壁上の短い線分)
  kitchen : Curve  確定済み厨房(任意)
  biz     : str   "izakaya"|"cafe"|"restaurant"|"ramen"
  bf      : bool   車椅子対応ブース
  staff   : int    従業員数
  n6      : int    6人卓の優先卓数
  bench   : bool   窓沿いベンチ
  unit    : float  図面単位→mm係数(mm図=1.0, m図=1000.0)
  bake    : bool   True で Rhino ドキュメントに描画(レイヤー自動生成)

出力:
  geo    : 生成ジオメトリ(GHプレビュー用)
  layer  : 各ジオメトリのレイヤー名
  info   : 指標サマリー
  warn   : 警告

レイヤー名規約(source="layer" 時に読む / ベイク時に作る):
  IN_WALL, IN_WINDOW, IN_PS, IN_COLUMN, IN_ENTRANCE, IN_KITCHEN
  → 出力は OUT_* レイヤー群(WALL/KITCHEN/KZONE/WC/COUNTER/DISHUP/BENCH/TABLE/CHAIR/
    AISLE_MAIN/AISLE_SERVICE/ENTRANCE/REGI/PS/COLUMN/WINDOW)
"""

import sys
import System.Drawing as sd
import Rhino
import Rhino.Geometry as rg
import scriptcontext as sc
import Grasshopper

IN_LAYERS = {"IN_WALL": "boundary", "IN_WINDOW": "windows", "IN_PS": "ps",
             "IN_COLUMN": "columns", "IN_ENTRANCE": "entrance", "IN_KITCHEN": "kitchen"}

OUT_RGB = {
    "WALL": (40, 40, 40), "WINDOW": (43, 127, 208), "PS": (106, 95, 160),
    "COLUMN": (85, 83, 78), "KITCHEN": (214, 138, 125), "KZONE": (207, 154, 142),
    "WC": (154, 106, 160), "COUNTER": (111, 148, 87), "DISHUP": (192, 138, 68),
    "BENCH": (168, 145, 95), "TABLE": (91, 125, 160), "CHAIR": (176, 170, 160),
    "AISLE_MAIN": (155, 182, 212), "AISLE_SERVICE": (200, 192, 172),
    "ENTRANCE": (201, 178, 74), "REGI": (95, 148, 114),
}


def _load_engine(libpath):
    if libpath and libpath not in sys.path:
        sys.path.append(libpath)
    import engine_core
    return engine_core


def _crv_pts(crv, unit):
    """曲線→[(x,y),...]。閉ポリラインは頂点列、それ以外は折線近似。"""
    ok, pl = crv.TryGetPolyline()
    if not ok or pl is None:
        pc = crv.ToPolyline(0, 0, 0.01, 0.1, 0, 0.5, 0, 0, True)
        ok, pl = pc.TryGetPolyline()
        if not ok:
            return []
    pts = [(round(pt.X * unit, 1), round(pt.Y * unit, 1)) for pt in pl]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    return pts


def _seg(crv, unit):
    a, b = crv.PointAtStart, crv.PointAtEnd
    return [(round(a.X * unit, 1), round(a.Y * unit, 1)),
            (round(b.X * unit, 1), round(b.Y * unit, 1))]


def _read_by_layer(unit):
    base = dict(boundary=None, windows=[], columns=[], ps=[], entrance=None, kitchen=None)
    for obj in sc.doc.Objects:
        if not obj.IsValid:
            continue
        crv = obj.Geometry
        if not isinstance(crv, rg.Curve):
            continue
        lname = sc.doc.Layers[obj.Attributes.LayerIndex].Name
        role = IN_LAYERS.get(lname)
        if not role:
            continue
        if role in ("windows", "entrance"):
            seg = _seg(crv, unit)
            if role == "windows":
                base["windows"].append(seg)
            else:
                base["entrance"] = seg
        elif role in ("columns", "ps"):
            base[role].append(_crv_pts(crv, unit))
        else:
            base[role] = _crv_pts(crv, unit)
    return base


def _read_from_curves(unit, boundary, windows, columns, ps, entrance, kitchen):
    base = dict(boundary=_crv_pts(boundary, unit) if boundary else None,
                windows=[_seg(c, unit) for c in (windows or [])],
                columns=[_crv_pts(c, unit) for c in (columns or [])],
                ps=[_crv_pts(c, unit) for c in (ps or [])],
                entrance=_seg(entrance, unit) if entrance else None,
                kitchen=_crv_pts(kitchen, unit) if kitchen else None)
    return base


def _ensure_layer(name, rgb):
    full = "OUT_" + name
    idx = sc.doc.Layers.FindByFullPath(full, -1)
    if idx >= 0:
        return idx
    layer = Rhino.DocObjects.Layer()
    layer.Name = full
    layer.Color = sd.Color.FromArgb(*rgb)
    return sc.doc.Layers.Add(layer)


def _poly_curve(pts):
    p3 = [rg.Point3d(x, y, 0) for x, y in pts]
    p3.append(p3[0])
    return rg.PolylineCurve(p3)


def _rect_curve(e):
    x, y, w, h = e["x"], e["y"], e["w"], e["h"]
    return _poly_curve([(x, y), (x + w, y), (x + w, y + h), (x, y + h)])


def run(libpath, source, boundary, windows, columns, ps, entrance, kitchen,
        biz, bf, staff, n6, bench, unit, bake):
    ec = _load_engine(libpath)
    unit = unit or 1.0
    if source == "layer":
        base = _read_by_layer(unit)
    else:
        base = _read_from_curves(unit, boundary, windows, columns, ps, entrance, kitchen)
    if not base.get("boundary"):
        return [], [], "境界(IN_WALL / boundary)が見つかりません", ["境界曲線が必要です"]

    params = dict(biz=biz or "izakaya", bf=bool(bf), staff=int(staff or 4),
                  n6=int(n6 or 0), bench=(True if bench is None else bool(bench)), dishup=True)
    res = ec.generate(base, params)

    geo, lyr = [], []
    inv = 1.0 / unit  # mm→図面単位に戻す
    for e in res["elements"]:
        name = e["layer"]
        if e["kind"] == "poly":
            g = _poly_curve([(x * inv, y * inv) for x, y in e["pts"]])
        elif e["kind"] == "rect":
            g = _rect_curve({k: e[k] * inv for k in ("x", "y", "w", "h")})
        elif e["kind"] == "seg":
            g = rg.LineCurve(rg.Point3d(e["a"][0] * inv, e["a"][1] * inv, 0),
                             rg.Point3d(e["b"][0] * inv, e["b"][1] * inv, 0))
        else:
            continue
        geo.append(g); lyr.append("OUT_" + name)
        if e.get("label"):
            c = g.GetBoundingBox(True).Center
            geo.append(rg.TextDot(e["label"], c)); lyr.append("OUT_" + name)

    if bake:
        for g, ln in zip(geo, lyr):
            base_name = ln[4:]
            idx = _ensure_layer(base_name, OUT_RGB.get(base_name, (120, 120, 120)))
            att = Rhino.DocObjects.ObjectAttributes()
            att.LayerIndex = idx
            if isinstance(g, rg.TextDot):
                sc.doc.Objects.AddTextDot(g, att)
            elif isinstance(g, rg.Curve):
                sc.doc.Objects.AddCurve(g, att)
        sc.doc.Views.Redraw()

    m = res["metrics"]
    info = (u"総席 %d (6:%d 4:%d 2:%d / ベンチ%d / C%d)  厨房%.1f㎡  %.1f坪  %.2f席/坪(目標%.1f)  WC: %s  厨房面=%s"
            % (m["total"], m["n6"], m["n4"], m["n2"], m["bench"], m["counter"],
               m["kitchen_m2"], m["tsubo"], m["sptsubo"], m["target_sptsubo"], m["wc"], m["orient"]))
    return geo, lyr, info, res["warnings"]


# Grasshopper 実行(コンポーネント末尾でこれを呼ぶ)
try:
    geo, layer, info, warn = run(
        libpath, source, boundary, windows, columns, ps, entrance, kitchen,
        biz, bf, staff, n6, bench, unit, bake)
except NameError:
    # スタンドアロン構文チェック用
    pass
