# D-log（ディーログ）

飛行記録・日常点検・機体管理を1画面で行う、静的ホスティング向けの Web アプリ（PWA）です。
Google Apps Script（GAS）と Google スプレッドシートは使用しません。

- フロントエンド: `index.html`（Tailwind CSS CDN + Vanilla JS。ビルド不要）
- データ保存: ブラウザの `localStorage`（端末ごと）
- 重い処理: `drone-log-bff`（FastAPI）に委譲
  - DJI ログ（`.txt`）の解析
  - 飛行日誌 Excel（様式1）の生成
  - 周辺インフラ（送電線・鉄塔）の判定
- 公開 URL: `https://aromabird.github.io/drone-log/`
- リポジトリ: [`aromabird/drone-log`](https://github.com/aromabird/drone-log)
- 記録様式: 国交省「無人航空機の飛行日誌の取扱要領」様式1〜3 に準拠した列構成

---

## 1. 主な機能

| タブ | できること |
|---|---|
| 飛行を記録 | 飛行情報（様式1）と日常点検（様式2・13項目）を1回の保存で同時記録。離着陸時刻から飛行時間を自動計算（日跨ぎ対応）。現在時刻（JST）のワンタップ入力、住所からの座標検索、GPS による現在地＋住所の取得。離着陸座標から天候・風速・海抜標高・DID を取得して飛行適性を判定。周辺インフラ（送電線・鉄塔）のリスクチェック。特定飛行10項目と立入管理措置からカテゴリーⅠ/ⅡA/ⅡB/Ⅲを自動判定。DJI ログ（.txt）の取り込み。入力クリア。 |
| 日誌 | 期間・機体・キーワードで検索、飛行ごとの点検結果の確認、様式1 CSV / 様式2・3 CSV / 飛行日誌 Excel（BFF）の出力 |
| 機体管理 | 機体・操縦者の登録/編集、技能証明（資格区分・有効期限・限定解除）、20時間（1200分）基準の点検アラート、20時間定期点検・修理の記録 |
| ヘルプ | 主な機能、Overpass API による周辺インフラ確認、法定帳票（Excel）出力、データプライバシー、基本的な使い方 |
| 設定 | BFF の接続先（localStorage に保存）、操縦者マスタの技能証明（一等/二等/なし、有効期限、目視外/夜間/25kg以上の限定解除） |

屋外での視認性を優先し、アプリ全体の文字サイズを **130% に固定**しています。

### AI 安全フライト診断について

現在の AI 安全フライト診断は **デモ表示** です。実際の画像解析は行わず、特定飛行区分への反映も行いません。
本物の Gemini 連携が必要な場合は、BFF に画像解析エンドポイントを追加し、API キーを BFF 側の環境変数で管理してください（ブラウザへキーを埋め込まないでください）。

---

## 2. アーキテクチャ

```text
ブラウザ
├── index.html（GitHub Pages）
│   ├── 機体・操縦者・飛行・点検 ── localStorage
│   ├── 住所検索 ── 国土地理院 住所検索 API
│   ├── 逆ジオコーディング ── Nominatim → 国土地理院（フォールバック）
│   ├── 天候 ── Open-Meteo
│   ├── 標高 ── 国土地理院 標高API
│   └── DID ── 国土地理院 地理院タイル（did2020）
└── FastAPI BFF
    ├── POST /api/parse-log（DJI ログ解析）
    ├── POST /api/export-log（Excel 生成）
    └── GET  /api/check-infrastructure（送電線・鉄塔）
```

- 一覧・保存・CSV はブラウザ内で完結します。
- BFF が停止していても、記録・検索・CSV 出力は動作します（DJI 解析・Excel・インフラ判定のみ失敗）。
- BFF の接続先は **設定タブ** で変更できます（`localStorage` の `drone-log:bff-base-url:v1` に保存）。
  既定値は Tailscale の MagicDNS `https://mac-mini-m4.tail95f7a2.ts.net` です。

---

## 3. ファイル構成

```text
drone-log/
├── index.html              # フロントエンド（5タブ / localStorage / 公開API連携）
├── manifest.json           # PWA マニフェスト
├── icons/
│   ├── icon-192x192.png
│   ├── icon-512x512.png
│   └── apple-touch-icon.png
└── README.md
```

---

## 4. ローカルで確認する

```bash
cd drone-log
python3 -m http.server 8811
# ブラウザで http://localhost:8811/index.html を開く
```

- 初回は **空のストア** で起動します。機体・操縦者を「機体管理」から登録してください。
- 画面確認用のサンプルデータを入れたい場合は `http://localhost:8811/index.html?demo=1` を開きます。
  - `file://` で直接開いた場合もサンプルデータを投入しますが、BFF は CORS の許可外（`Origin: null`）になるため、DJI 解析・Excel・インフラ判定は失敗します。BFF を使う確認は `python3 -m http.server` で配信してください。
- データを初期化する場合は DevTools の Console で次を実行し、再読み込みします。

```js
localStorage.clear();
```

- タブは URL ハッシュで直接開けます（`#entry` / `#log` / `#fleet` / `#help` / `#settings`）。
- `manifest.json` と `icons/` は PWA 用です。PWA のインストールは GitHub Pages 側で行ってください。

---

## 5. データ保存とバックアップ

- 保存先はブラウザの `localStorage`（キー: `drone-log:mock:v1`）です。
- BFF の接続先は別キー `drone-log:bff-base-url:v1` に保存します（未設定時は既定の MagicDNS）。
- 操縦者の技能証明（資格区分・有効期限・限定解除）は `pilots[]` の各要素に保存します。既存データに項目が無い場合は「未設定」として扱います。
- 端末・ブラウザごとにデータが分かれます。共有端末やブラウザのデータ消去で失われるため、定期的に CSV / Excel を出力して保管してください。
- CSV は国交省様式1〜3の記載事項に準拠した**記録・保管用**データです。DIPS 2.0 への直接インポートはできません。
- Excel 出力は BFF の `/api/export-log` を使用します。
- 旧 GAS 版のスプレッドシートデータは、このアプリへ自動移行されません。必要な場合は旧環境から CSV 等で退避してください。

---

## 6. 外部 API とプライバシー

| 用途 | サービス | 送信する情報 | 備考 |
|---|---|---|---|
| 住所 → 座標 | 国土地理院 住所検索 API | 入力した住所文字列 | API キー不要 |
| 座標 → 住所 | Nominatim（OpenStreetMap） | 緯度・経度 | 失敗時は国土地理院の逆ジオコーダーへフォールバック |
| 天候・風速 | Open-Meteo | 緯度・経度 | API キー不要 |
| 標高 | 国土地理院 標高API | 緯度・経度 | API キー不要 |
| DID | 国土地理院 地理院タイル（did2020） | タイル座標 | API キー不要 |

- 氏名・連絡先・飛行記録そのものは外部 API へ送信しません。
- Nominatim は公共サービスです。連続呼び出しを 1.1 秒以上あける実装にしています。
- 社内ネットワーク等で外部 API が許可されていない場合は、画面に日本語のエラーが表示されます。その場合は緯度・経度・住所を手入力してください。


---

## 7. BFF（FastAPI）の起動

`drone-log-bff` の README を参照してください。

```bash
cd drone-log-bff
.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
```

- ヘルスチェック: `http://127.0.0.1:8000/api/health`
- PWA からの接続先は **設定タブ** で変更します（既定: `https://mac-mini-m4.tail95f7a2.ts.net`）。
- HTTPS の PWA から `http://100.x.x.x:8000` は混在コンテンツで遮断されるため、本番は HTTPS の MagicDNS を指定してください。
- BFF はステートレスです。DJI ログや画像をディスクへ保存しません。

---

## 8. 検証

```bash
# インライン JS の構文チェック
python3 - <<'PY'
from pathlib import Path
html = Path('index.html').read_text()
start = html.index("<script>\n'use strict';") + len('<script>')
end = html.index('</script>', start)
Path('/tmp/drone-log-inline.js').write_text(html[start:end])
PY
node --check /tmp/drone-log-inline.js

# BFF のテスト（drone-log-bff 側。サーバー起動後に実行）
cd ../drone-log-bff && ./tests/smoke_test.sh
```

ブラウザ確認では、以下を確認してください。

- 機体・操縦者の登録、飛行記録の保存、日誌検索、CSV 出力
- 設定タブ: BFF 接続先の保存・リロード後の復元・接続テスト（`/api/health`）
- 設定タブ / 操縦者モーダル: 資格区分・有効期限・限定解除の保存と復元、機体管理の一覧表示
- ヘルプタブ: Overpass API・法定帳票 Excel・データプライバシーの記載
- 住所検索 / GPS / 現場環境（天候・標高・DID）
- DJI ログ取り込み、Excel 出力、周辺インフラ判定（BFF 起動時）
- ブラウザの Console に GAS（`google.script`）や旧 API のエラーが出ないこと
- `https://aromabird.github.io` からの BFF 呼び出しが CORS エラーにならないこと

---

## 9. 旧 GAS 版からの移行メモ

- `Code.gs` / `appsscript.json` / `.clasp.json` / clasp 用テストは削除済みです。
- 旧 GAS 版の `?api=` パラメータ、`API_CONFIG`、共有トークン、`#sync-status` / `#sheet-link` は廃止しました。
- 旧版でスプレッドシートに保存したデータは、このアプリの `localStorage` へ自動移行されません。
- 旧版のブックマークや GAS のデプロイは不要です。GitHub Pages の URL を使用してください。

---

## 10. 注意事項

- 本アプリは記録・保管を支援するものであり、法令上の点検要否を保証するものではありません。必ず原典を確認してください。
- `localStorage` はブラウザのプライベートモードや容量制限の影響を受けます。重要な記録は CSV / Excel でバックアップしてください。
- 外部 API の仕様変更・レート制限・ネットワーク遮断により、座標・天候・標高・DID が取得できない場合があります。
