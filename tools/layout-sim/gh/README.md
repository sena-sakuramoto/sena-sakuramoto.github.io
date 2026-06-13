# CADベース・レイアウトエンジン(Rhino / Grasshopper)

既存CAD(内壁・窓・PS・柱・入口)を**読んで理解した上で**席・厨房・通路を起こす、Rhinoネイティブの生成エンジン。
Web版(`../`)の「箱に矩形を詰める」方式とは別物で、こちらが実務用の本体。

## ファイル

| ファイル | 役割 |
|---|---|
| `engine_core.py` | レイアウト生成の幾何コア(純Python・Rhino非依存)。境界+穴(PS/柱)+窓+入口を入力に、席・什器・**階層化された通路**を出力。ヘッドレスで単体テスト可能 |
| `cad_layout_gh.py` | GHPythonラッパ。Rhinoのレイヤー or GHのCurve入力からCADを読み、`engine_core`を呼び、Rhinoに実ジオメトリをベイク(レイヤー自動生成) |

## 使い方(Rhino 8 / GHPython, Python3)

1. テナントのCAD(DXF/DWG)をRhinoにインポート
2. 既存要素を次のレイヤーに分類(`source="layer"`の場合):
   - `IN_WALL` 内壁の閉曲線 / `IN_WINDOW` 窓(壁上の線) / `IN_PS` PS・MB・ダクト /
     `IN_COLUMN` 柱 / `IN_ENTRANCE` 入口(壁上の線分) / `IN_KITCHEN` 確定済み厨房(任意)
3. Grasshopperに GHPython(Python3)コンポーネントを置き `cad_layout_gh.py` を貼る
4. 入力 `libpath` に `engine_core.py` のフォルダ、`source="layer"`、`biz`・`bf`・`staff`・`n6`・`bench`・`unit`(mm図=1.0)、`bake=True`
5. `OUT_*` レイヤーに席・厨房・通路・WCが生成される

GHでCurveを直接配線したい場合は `source="curve"` にして `boundary/windows/columns/ps/entrance/kitchen` をワイヤ。

## 設計思想(Web版との違い)

- **CADが出発点**: 窓位置→窓辺は優先席(バンケット)、PS位置→厨房・WCを近接(給排水)、柱→実障害として回避。機械的グリッドではなく既存条件から起こす
- **通路は階層**: 主通路(避難・客主導線)/ 配膳動線 / 席間通り抜け / 椅子引き代 を別々の基準(`engine_core.CLEAR`)で管理
- **厨房面ベース**: 厨房の客席面に沿ってデシャップ→カウンター→配膳通路を順に積み、その有効区間を実測して配置
- **実寸什器**: 2人600×700・4人1200×750(連結)・6人1800×750・ベンチ帯1650・WC前室付き男女別

## チューニング

数値は `engine_core.py` 冒頭の `FURN / CLEAR / WC / BIZ` に集約。業態別の厨房比率・席ミックス・坪効率目標・通路幅もここ。
