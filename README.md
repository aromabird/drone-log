# ドローン飛行日誌 & 機体管理（GAS + Google スプレッドシート）

飛行記録・日常点検・機体管理を1画面で行う Web アプリのプロトタイプです。
Google Apps Script（GAS）をバックエンド、Google スプレッドシートをデータベースとして動作し、
スマートフォン（Pixel 10 等）と PC の両方で使えるレスポンシブ UI を持ちます。

- フロントエンド: `index.html`（Tailwind CSS CDN + Vanilla JS。ビルド不要）
- バックエンド: `Code.gs`（V8 ランタイム）
- 公開方法は2通り（同じ `index.html` を使い回せます）
  - **GAS の Web アプリ**: `doGet` が `index.html` を配信し、`google.script.run` で関数を呼ぶ（従来方式）
  - **GitHub Pages でフロントのみ公開**: `doPost` を JSON API として `fetch` で呼ぶ（[3.6](#36-github-pages-でフロントだけを公開するgas-を-json-api-として使う)）

- 記録様式: 国交省「無人航空機の飛行日誌の取扱要領」様式1〜3 に準拠した列構成
- 拡張前提: DJI ログ解析 / DIPS 連携（地名・座標の変換は GAS 標準の Maps サービス、
  画像リスク判定は Gemini API で実装済み）

---

## 1. 主な機能

| タブ | できること |
|---|---|
| 飛行を記録 | 飛行情報（様式1）と日常点検（様式2・13項目）を**1回の保存で同時記録**。離着陸時刻から飛行時間を自動計算（日跨ぎ対応）。**ワンタップで現在時刻（JST）を離陸/着陸時刻へ入力**、**住所から緯度経度を検索**、**GPS で現在地の座標＋住所を取得**。**離着陸座標から天候・風速（突風）・海抜標高・DID 規制を自動取得して飛行適性を判定**（Open-Meteo / 国土地理院。API キー不要）。**特定飛行10項目（飛行空域4・飛行方法6）のチェックと立入管理措置からカテゴリーⅠ/ⅡA/ⅡB/Ⅲを自動判定**し、必要な手続きを表示。**Gemini による衛星写真／現場写真のリスク診断**（検出項目を特定飛行区分へ自動反映）。安全影響事象、飛行目的、DJI ログのドロップ領域（準備中）。**「🗑️ 入力をクリア」でフォーム全体（飛行情報・点検・環境/AI の結果・エラー表示）を初期状態へ一括リセット**（確認ダイアログ付き。操縦者・機体は維持） |
| 日誌 | 期間・機体・キーワードで検索、飛行ごとの点検結果の確認、様式1 CSV と様式2・3 CSV の出力 |
| 機体管理 | 機体・操縦者の登録/編集、20時間（1200分）を基準にした点検アラート、20時間定期点検・修理の記録 |

保存時にサーバー側で以下を自動処理します。

- 飛行ID（`FLT-0001`）・点検ID（`INS-0001`）のゼロ埋め採番
- 機体の累計飛行時間の再計算と `m_drones` への書き戻し
- 点検項目に1つでも NG があれば「異常あり」に確定
- 飛行記録と点検記録を同一ロック内で追記（中途半端な保存を防ぐ）

---

## 2. ファイル構成

```text
drone-log/
├── Code.gs                 # バックエンド（CRUD / CSV / 初期化 / doPost API / 将来拡張スタブ）
├── index.html              # フロントエンド（3タブ / localStorage モック内蔵 / API 接続対応）
├── appsscript.json         # GAS プロジェクト設定（Asia/Tokyo, V8, 匿名アクセス）
├── .clasp.json.example     # clasp 連携用のひな型（scriptId を書き換えて .clasp.json に）
├── tests/
│   ├── backend.test.js     # GAS をスタブ化して Code.gs を検証するハーネス
│   └── mock-api-server.js  # API モードのローカル検証用モックサーバー（静的配信 + doPost 相当）
└── README.md
```

---

## 3. セットアップ

### 3.1 スプレッドシートにバインドする（本番）

1. Google スプレッドシートを新規作成する
2. 「拡張機能 > Apps Script」を開く
3. `Code.gs` の内容を `コード.gs` に貼り付ける
4. ファイルを追加して `index.html` を作成し、内容を貼り付ける
   （ファイル名は必ず `index`。GAS 側は `HtmlService.createTemplateFromFile('index')` を参照）
5. プロジェクト設定 >「`appsscript.json` マニフェストを表示する」を有効化し、`appsscript.json` の内容を反映する
6. エディタで `initSpreadsheet` を1回実行し、権限を許可する
   - `m_drones` / `m_pilots` / `t_flights` / `t_inspections` の4シートが自動作成されます
   - 何度実行しても既存データは消えません（不足ヘッダーは末尾に追加）
7. 「デプロイ > 新しいデプロイ > ウェブアプリ」で公開する
   - 実行ユーザー: 自分
   - アクセスできるユーザー: 自分のみ（必要に応じて変更）

補足: スプレッドシートのメニューに「ドローン日誌」が追加され、
「シートを初期セットアップ」「累計時間の再計算」「セルフチェック」を実行できます。

### 3.2 clasp で管理する場合

```bash
cd drone-log
cp .clasp.json.example .clasp.json   # scriptId を自分のものに書き換える
npx @google/clasp push
npx @google/clasp open
```

> `.clasp.json` は認証情報（scriptId）を含むため `.gitignore` の `*.json` で除外されます。
> `appsscript.json` だけは管理対象にするため、リポジトリ直下の `.gitignore` に例外を追加しています。

### 3.3 ローカルで UI を確認する（モックモード）

```bash
cd drone-log
python3 -m http.server 8811
# ブラウザで http://localhost:8811/index.html を開く
```

`google.script.run` が存在しない環境では、自動的に **localStorage ベースのモック**へ切り替わります。
ヘッダーのバッジが「ローカル(デモ)」になっていればモックモードです。

- 初回アクセス時にサンプルデータ（機体2台・操縦者1名・飛行3件）を投入します
- リセットする場合は DevTools で `localStorage.clear()` を実行して再読み込みしてください
- モックのロジックは画面確認用の簡易実装です。本番の正は `Code.gs` です
- タブは URL ハッシュで直接開けます（`#entry` / `#log` / `#fleet`）
- AI 安全フライト診断は、モックでは固定の解析結果（`mock-gemini`）を返します。
- `?api=https://…/exec` を付けて開くと、モックではなく**実際の GAS API**（`doPost`）へ接続します。
  API URL が未設定のまま `http(s)` で開いた場合は、保存されない旨のトーストが表示されます。

### 3.4 Gemini（AI 安全フライト診断）の準備

1. [Google AI Studio](https://aistudio.google.com/apikey) で API キーを発行します。
2. Apps Script の **プロジェクトの設定 → スクリプト プロパティ** に次を登録します。

| プロパティ | 必須 | 用途 |
|---|---|---|
| `GEMINI_API_KEY` | **必須** | Gemini API（`gemini-2.5-flash`）の呼び出し |
| `GOOGLE_MAPS_API_KEY` | 任意 | 衛星写真（`Maps.newStaticMap`）の本番割当・署名付きリクエスト |

- 未設定のまま診断ボタンを押すと「Gemini の API キーが未設定です…」と表示されます（キーは画面・ログに出しません）。
- `GOOGLE_MAPS_API_KEY` が無い場合、StaticMap は Apps Script の既定割当（テスト用の少数リクエスト）で動作します。
  本番運用では Maps Static API を有効化したキーの登録を推奨します。
- 送信するのは「衛星写真（600×600, zoom 19）」または「長辺1200pxへ圧縮した現場写真（JPEG）」だけです。
  このアプリは撮影画像をスプレッドシートへは保存しません。

### 3.5 現場環境チェック（天候・標高・DID）の準備

**準備は不要です。** Open-Meteo・国土地理院 標高API・地理院タイル（人口集中地区）はいずれも
API キー不要のオープンデータで、スクリプト プロパティの登録なしで動作します。

- 現場環境チェックは外部へ送るのは「緯度・経度」だけです（写真や氏名は送信しません）。
- 社内ネットワーク等で外部 API が許可されていない場合は、日本語のエラーが画面に表示されます。

### 3.6 GitHub Pages でフロントだけを公開する（GAS を JSON API として使う）

フロントを静的ホスティングへ移すと、GAS の iframe サンドボックス制約（GPS・ダウンロード・
`X-Frame-Options`）を受けにくくなります。バックエンドは GAS のまま、`doPost` を JSON API として使います。

```text
ブラウザ ── GET ──▶ GitHub Pages（index.html）
   │
   └─ POST(JSON, text/plain) ──▶ GAS doPost ──▶ SpreadsheetApp / Maps / UrlFetchApp
```

1. **GAS 側**: 「デプロイ → 新しいデプロイ → ウェブアプリ」で次を設定し、`/exec` の URL を控えます。
   - 実行ユーザー: **自分**
   - アクセス: **全員（匿名）** … Pages からの `fetch` は Google のログイン cookie を送れないため必須
2. **フロント側**: `index.html` の `API_CONFIG.url` に控えた URL を設定します（空欄なら従来どおり
   `google.script.run` → モックの順にフォールバック）。

   ```js
   var API_CONFIG = {
     url: 'https://script.google.com/macros/s/XXXXXXXXXXXX/exec',
     timeoutMs: 30000,
     aiTimeoutMs: 90000
   };
   ```

   デプロイ前に試すときは URL を書き換えず、`index.html?api=https://…/exec` で上書きできます。
3. **GitHub 側**: リポジトリの **Settings → Pages** で Source を `Deploy from a branch` /
   `main` / `/ (root)` に設定します。このリポジトリ（`aromabird/works`）の場合の公開 URL は
   `https://aromabird.github.io/works/drone-log/` です（反映まで最大10分ほどかかります）。

4. **疎通確認（ターミナル）**: 反映後、`/exec` に `text/plain` で POST して JSON が返るか確認します。

   ```bash
   curl -sS -L --data '{"action":"getCatalog","args":[]}' \
     -H 'Content-Type: text/plain;charset=utf-8' \
     'https://script.google.com/macros/s/XXXXXXXXXXXX/exec'
   # → {"success":true,"data":{...}}
   ```

   - `-L` は必須です（GAS は 302 で `script.googleusercontent.com` へ転送します）。
   - **`-X POST` を付けないでください**。付けるとリダイレクト後も POST になり、HTML の案内ページが返ります
     （`--data` だけで自動的に POST → 302 で GET に切り替わります）。
   - 本文が「スクリプト関数が見つかりません: doPost」なら、デプロイが古いバージョンを指しています（下記参照）。

制約と注意:

- **CORS**: GAS は `OPTIONS`（プリフライト）に応答できません。`Content-Type: application/json` を付けると
  失敗するため、`index.html` は `Content-Type: text/plain;charset=utf-8` で POST しています。変更しないでください。
  本番 `/exec` は `Access-Control-Allow-Origin: *` を返すため、別オリジンからでも本文を読めます（2026-11-06 実測）。
- **デプロイはバージョン固定**: `/exec` はデプロイ作成時点のバージョンを実行します。`clasp push` だけでは
  `/exec` の挙動は変わりません。反映には `npx @google/clasp create-version "説明"` →
  `npx @google/clasp update-deployment <deploymentId> -V <番号>` が必要です（既存デプロイの更新なので **URL は不変**）。
  2026-11-06 に「`doPost` が見つからない」が続いた実際の原因も、デプロイが push 前のバージョンを指していたことでした。
- GAS は HTTP ステータスを制御できないため、**失敗も HTTP 200** で返します。成否は本文の
  `success` で判定します（「5.3 外部 API（`doPost`）」参照）。
- **アクセスを「全員（匿名）」にする＝ URL を知る第三者が書き込める**状態です。個人利用の前提で、
  管理系（`initSpreadsheet` / `recalcDroneTotals` / `selfCheck`）は API に公開していません。
  第三者への共有や本番運用を行う場合は、トークン検証や Google アカウント認証の追加を検討してください。
- `index.html` はソースがそのまま公開されます（API URL も公開情報になります）。秘密情報は置かないでください。

---

## 4. シート構成

列は**ヘッダー文字列で解決**するため、末尾に列を追加しても既存データの位置は壊れません。
日付・時刻はタイムゾーンずれを避けるため、すべて文字列（`YYYY-MM-DD` / `HH:mm`）で保存し、
該当列の表示形式はテキスト（`@`）に設定します。

### m_drones（機体マスタ）

`機体ID` / `機種名` / `メーカー` / `重量(g)` / `機体登録記号` / `製造番号` / `総飛行時間(累計分)` / `備考`

### m_pilots（操縦者マスタ）

`操縦者ID` / `氏名` / `技能証明書番号` / `連絡先`

### t_flights（飛行記録 = 様式1）

`飛行ID` / `飛行年月日` / `操縦者ID` / `機体ID` / `離陸場所` / `着陸場所` / `緯度` / `経度` /
`離陸時刻` / `着陸時刻` / `飛行時間(分)` / `特定飛行区分` / `立入管理措置` / `飛行カテゴリー` /
`安全影響事象` / `飛行目的` / `登録日時`

- `特定飛行区分` は10項目を `、` 区切りで保存します（例: `目視外、夜間`）。未選択は `非特定飛行`。
- `立入管理措置` は `あり` / `なし`。`飛行カテゴリー` は `カテゴリーⅠ` / `ⅡA` / `ⅡB` / `Ⅲ`。
- 既存シートには `initSpreadsheet()` 実行時に2列が**末尾へ追加**されます（ヘッダー名で解決するため既存データは壊れません）。

### t_inspections（点検記録 = 様式2・3）

`点検ID` / `飛行ID` / `機体ID` / `点検種別` / `点検実施日` / `実施者` / `点検結果` /
`点検詳細メモ` / `点検項目詳細(JSON)` / `登録日時`

`点検項目詳細(JSON)` には13項目の `OK` / `NG` が入ります（例: `{"機体全般":"OK","プロペラ":"NG",...}`）。

---

## 5. サーバー API（`google.script.run` / `doPost` から呼ぶ関数）

| 関数 | 役割 |
|---|---|
| `getBootstrapData()` | 機体・操縦者・直近の飛行/点検・統計・選択肢を1回で返す（モバイルの往復削減） |
| `getFlights(filter)` | 期間 / 機体 / 操縦者 / キーワードで検索（50件ページング） |
| `saveFlightRecord(payload)` | 飛行＋日常点検を同一トランザクションで保存 |
| `saveDrone(payload)` / `savePilot(payload)` | マスタの新規登録・更新 |
| `saveInspection(payload)` | 20時間定期点検・修理の記録 |
| `buildDipsCsv(options)` | 様式1 CSV（BOM + CRLF、全セル引用符） |
| `buildInspectionCsv(options)` | 様式2・3 CSV（固定9列 + 13項目） |
| `fetchGeoFromAddress(address)` | 住所 → 緯度経度（`Maps.newGeocoder()`。API キー不要） |
| `fetchAddressFromGeo(lat,lng)` | 緯度経度 → 住所（逆ジオコーディング） |
| `fetchGeoInfo(lat,lng)` | 地名を返す旧インターフェース（DID・制限エリアは未実装） |
| `fetchFlightEnvironment(lat,lng)` | 天候・風速・海抜標高・DID 規制を取得（Open-Meteo / 国土地理院。API キー不要） |
| `judgeFlightCategory(input)` | 特定飛行10項目・機体重量・立入管理措置からカテゴリー（Ⅰ/ⅡA/ⅡB/Ⅲ）を判定 |
| `analyzeRiskFromCoordinates(lat,lng)` | 衛星写真（StaticMap・zoom19・600px）を Gemini で解析 |
| `analyzeRiskFromImage(base64,mimeType)` | 現場写真を Gemini で解析（data URI / 生Base64 の両対応） |
| `analyzeRiskWithGemini(imageData)` | 旧インターフェース（`analyzeRiskFromImage` の別名） |
| `recalcDroneTotals()` | 全機体の累計飛行時間を再計算 |
| `initSpreadsheet()` | シートの冪等セットアップ |
| `selfCheck()` | シート構成の診断（データ変更なし） |
| `parseDjiLog(file)` | **未実装スタブ**（入出力の型だけ固定） |

### 5.1 AI リスク診断の戻り値

```js
{
  ok: true,
  source: 'satellite' | 'photo',
  model: 'gemini-2.5-flash',
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH',
  riskLabel: '低リスク' | '中リスク' | '高リスク',
  detectedObjects: [{ objectType, description, risk }],
  suggestedFlags: { within30m, did, altitude150m, event },
  summary: '…',
  actionableAdvice: ['…'],
  satelliteImageUrl: 'data:image/png;base64,…', // photo のときは null
  analyzedAt: '2026/11/06 19:00:00'
}
```

- `suggestedFlags` は画面側で「人・物件から30m未満」「DID」「150m以上」「イベント上空」へ自動反映し、
  カテゴリーを再判定します（判定を上書きはせず、追加のみ）。
- 失敗時は日本語のメッセージで例外を投げます（キー未設定 / 401・403 / 404 / 429 / 5xx / 通信失敗 / JSON 不正）。

### 5.2 現場環境データの戻り値

```js
{
  ok: true,
  lat: 35.6861,
  lng: 139.764,
  weather: {
    text: '薄曇り',            // WMO コードを日本語化
    temperature: 18.5,          // ℃
    humidity: 58,               // %
    precipitation: 0,           // mm
    windSpeed: 3.2,             // m/s（10m 高さの平均風速）
    windGust: 5.1,              // m/s（突風）
    weatherCode: 2,
    safetyStatus: 'GOOD',       // GOOD / CAUTION / DANGER
    safetyLabel: '飛行適性: 良好（安全圏）',
    observedAt: '2026-11-06T20:00'
  },
  elevation: {
    groundElevation: 12.4,      // 海抜（m）。データなしは null
    max150mLimit: 162.4,        // 海抜 + 150m。算出不能は null
    note: 'データ源: 1m（レーザ）'
  },
  regulations: {
    isDID: true,                // true / false / null（判定不能）
    note: '人口集中地区（DID）内',
    source: '国土地理院 人口集中地区タイル（令和2年国勢調査）'
  },
  sources: { weather: 'Open-Meteo', elevation: '国土地理院 標高API', did: '…' },
  message: '天候・標高・DID の情報を取得しました。',
  fetchedAt: '2026/11/06 20:12:49'
}
```

- **風速の判定**: 5.0m/s 未満 `GOOD` / 5.0m/s 以上 7.0m/s 未満 `CAUTION` / 7.0m/s 以上 `DANGER`。
- **天候コード（WMO）**: 0 快晴 / 1〜3 晴れ・薄曇り・曇り / 45・48 霧 / 51〜57 霧雨 / 61〜67 雨 /
  71〜77 雪 / 80〜82 にわか雨 / 85・86 にわか雪 / 95〜99 雷雨 / それ以外は「不明（コード n）」。
- **150m 規制**: `max150mLimit` = 海抜 + 150m。機体の高度計基準を合わせるために使います。
- **失敗時の扱い**: 天候が取れないと飛行適性を判断できないため、天候だけは日本語メッセージで例外にします。
  標高・DID は補助情報なので、失敗しても処理は継続し `note` に理由を入れます。
- **DID の `null`**: 通信エラー等で判定できなかった場合は `false`（＝DID 外）ではなく **`null`（判定不能）** を返します。
  画面は「判定できません」と表示し、DIPS での確認を促します（安全側に倒すため）。
- **DID の判定方法**: 地理院タイル `did2020`（8bit RGBA PNG）の該当ピクセルの **alpha** を見ます。
  区域を含まないタイルは 404 を返すため、その場合は DID 外と判定できます。
  GAS には画像デコード API がないため、`Code.gs` に **PNG デコーダ（zlib + inflate + フィルタ復元）** を実装しています。

### 5.3 外部 API（`doPost`）

GitHub Pages などの外部フロントから呼ぶための JSON API です。

- リクエスト: `POST {API_CONFIG.url}` に JSON を送信
  （`Content-Type: text/plain;charset=utf-8`。`application/json` は CORS のプリフライトで失敗します）
- レスポンス: 常に HTTP 200 + `application/json`
- `args` は**配列**で、GAS 関数の引数にそのまま展開されます

```bash
curl -sL -X POST \
  -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"action":"getFlights","args":[{"limit":5}]}' \
  'https://script.google.com/macros/s/XXXXXXXXXXXX/exec'
```

```json
{ "success": true, "data": { "ok": true, "total": 3, "items": [ ... ] } }
{ "success": false, "error": "未定義のActionです: nope" }
```

| action | 呼ばれる関数 | 備考 |
|---|---|---|
| `getBootstrapData` | `getBootstrapData()` | 初期表示（1往復でまとめて取得） |
| `getCatalog` | `getCatalog()` | 選択肢・定数のみ（`getCatalog_` の公開ラッパー） |
| `getFlights` | `getFlights(filter)` | 検索・ページング |
| `getInspections` | `getInspections(filter)` | 点検一覧 |
| `saveFlightRecord` | `saveFlightRecord(payload)` | 飛行＋日常点検 |
| `saveDrone` / `savePilot` | 同名関数 | マスタ登録・更新 |
| `saveInspection` | `saveInspection(payload)` | 定期点検・修理 |
| `geocodeAddress` / `fetchGeoFromAddress` | `fetchGeoFromAddress(address)` | 別名どうし |
| `reverseGeocode` / `fetchAddressFromGeo` | `fetchAddressFromGeo(lat,lng)` | 別名どうし |
| `fetchGeoInfo` | `fetchGeoInfo(lat,lng)` | 旧インターフェース |
| `fetchFlightEnvironment` | `fetchFlightEnvironment(lat,lng)` | 外部APIを3つ叩く（タイムアウト90秒） |
| `analyzeRiskFromCoordinates` | 同名関数 | 衛星写真のAI診断 |
| `analyzeRiskFromImage` | 同名関数 | 現場写真のAI診断（Base64） |
| `analyzeRiskWithGemini` | 同名関数 | 旧インターフェース |
| `buildDipsCsv` | `buildDipsCsv(options)` | 様式1 CSV（`content` に CSV 文字列） |
| `buildInspectionCsv` | `buildInspectionCsv(options)` | 様式2・3 CSV |
| `judgeFlightCategory` | `judgeFlightCategory(input)` | カテゴリー判定 |
| `parseDjiLog` | `parseDjiLog(file)` | 未実装スタブ（エラーメッセージを返す） |

**公開しない関数**（ホワイトリスト方式のため `未定義のActionです` を返します）:
`initSpreadsheet` / `recalcDroneTotals` / `selfCheck` / `doGet` / `include` など。
シートの初期化・再計算はスプレッドシートのカスタムメニューから実行してください。

本文が空の場合は `?action=getFlights&args=[{"limit":5}]` のクエリ文字列でも呼べます（デプロイ確認用）。

---

## 6. 設計上の判断

### 6.1 点検アラートの判定基準

法定点検は「前回の20時間点検からの飛行時間」で管理するのが実務的です。
本アプリは次のように判定します。

- 「20時間定期点検」または「修理」の記録がある機体 → **その実施日より後の飛行時間**で判定
- 記録がない機体 → **累計飛行時間**で判定

閾値は 1200分（20時間）で超過、960分（80%）で警告です。
画面には累計と判定基準の両方を表示するため、どちらの数字か分かるようにしています。

### 6.2 同時実行と ID 採番

`LockService.getScriptLock()` で書き込みを直列化し、`FLT-0001` 形式の採番重複を防ぎます。
ロックのネストを避けるため、シートの遅延初期化はロック外の `setupSheets_()` を使用しています。

### 6.3 入力の正規化

- 日付: `2026/11/6` や Date も `2026-11-06` に正規化（実在日付を検証）
- 時刻: `8:5` も `08:05` に正規化。着陸 < 離陸は日跨ぎとして +24時間
- 特定飛行区分: 入力値（保存ラベル・内部キー・カンマ区切り文字列）を10項目の保存ラベルへ正規化。
  未選択は「非特定飛行」。未知の値は無視。「非特定飛行」と他区分が併用された場合は他区分を優先
- 立入管理措置: 未指定は「あり」。`なし` / `false` のときだけ「なし」
- 安全影響事象: `なし` または `あり：詳細`

### 6.4 飛行カテゴリーの判定規則

| カテゴリー | 条件 | 画面の色 |
|---|---|---|
| Ⅰ | 特定飛行の10項目がいずれも該当しない | teal |
| ⅡB | 該当あり ＋ 立入管理措置あり ＋ 機体重量25kg未満 ＋ 該当が「DID・夜間・目視外・30m未満」のみ | sky |
| ⅡA | 該当あり ＋ 立入管理措置あり ＋（「空港周辺・150m以上・緊急用務空域・イベント上空・危険物輸送・物件投下」のいずれか、または25kg以上） | amber |
| Ⅲ | 該当あり ＋ 立入管理措置なし | rose |

- 判定は `Code.gs` の `judgeCategory_` が正で、画面は即時反映用に同じ規則を `judgeCategoryLocal` に持つ
  （保存時はサーバーが再判定し、`飛行カテゴリー` 列へ書き込みます）。
- 画面上部の注記どおり、これは入力内容に基づく**目安**です。最終的な適用カテゴリーは申請内容・DIPS で確認してください。
- カテゴリーごとの手続き文言は `CATEGORY_PROCEDURES` に定数化し、判定カードへ表示します。

### 6.5 DID を「タイルのピクセル」で判定する理由

DID は国勢調査に基づく統計地区で、座標を渡すと内外を返す無償の API はありません。
一方、国土地理院は同じデータを地理院タイル `did2020`（令和2年国勢調査 / 総務省統計局）として
配信しているため、本アプリはそのタイル画像を取得し、**該当ピクセルの alpha（塗りの有無）** で内外を判定します。

- 追加の API キー・利用登録が不要（完全無料のオープンデータのみで完結）
- ズーム16（約2.4m/px）を使うため、境界付近の誤差は数m程度
- 区域を含まないタイルは 404 が返るため、「DID 外」と確定できる
- GAS には画像デコード API がないため、PNG の展開（zlib / inflate / フィルタ復元）を `Code.gs` 内に実装
  （8bit・非インターレース・カラータイプ 0/2/3/4/6 に対応。16bit とインターレースは非対応）

判定結果は「DID 内」のときだけ特定飛行区分へ**追加**し、外側と判定されたときに既存のチェックを
外すことはしません（現場の実情を利用者が上書きできる余地を残すため）。

### 6.6 「入力をクリア」で維持する項目と、進行中リクエストの扱い

保存後のリセット（`resetEntryAfterSave`）は「同じ現場で続けて記録する」ための最小限の初期化ですが、
「🗑️ 入力をクリア」は**別の現場へ移る／入力をやり直す**ための全消去として、役割を分けています。

- 維持する: 操縦者・機体（現場の連続運用で選び直す手間を省くため。未選択なら描画側の初期値のまま）
- 初期化する: 飛行年月日（当日 JST）・離着陸場所/時刻/座標・飛行目的（既定の先頭）・特記事項・
  安全影響事象・特定飛行10項目・点検13項目・実施メモ・環境/AI の結果とステータス・エラー表示
- 立入管理措置は既定の「講じる」に戻す（保存後リセットと同じ扱い）

また、クリア時は `state.entry.reqSeq` を加算します。環境取得・AI 診断の非同期応答は開始時の
`reqSeq` を保持して比較し、**クリア後に届いた古い応答は破棄**します（クリアしたのに数秒後に
カードが再表示される、という競合を防ぐため）。同様に、実行中だったボタンの `disabled` 表示も
クリア時に戻します。

---

## 7. 検証

### 7.1 バックエンド（自動テスト）

```bash
node drone-log/tests/backend.test.js
```

GAS の `SpreadsheetApp` / `Utilities` / `LockService` をスタブ化し、`vm` で `Code.gs` を読み込んで検証します。

検証している内容:

- 4シートの作成・冪等な再実行・列数
- ID の連番（`PLT-0001` / `DRN-0001` / `FLT-0001` / `INS-0001`）
- 重複機体・重複技能証明書の拒否
- 飛行＋点検の同時保存、累計時間の更新
- 日跨ぎ（22:30→00:15 = 105分）
- 特定飛行区分の排他・10項目への正規化、安全影響事象の整形
- カテゴリー判定の全分岐（Ⅰ / ⅡB / ⅡA / Ⅲ）と25kg境界（25000g=ⅡA / 24999g=ⅡB）
- `t_flights` の17列（立入管理措置・飛行カテゴリーの追加）、保存値と一覧の返却
- Gemini 診断: APIキー未設定・401/429/500・通信失敗・JSON不正・候補なしの日本語エラー
- 現場環境: 3つのAPIを1回ずつ呼ぶこと、URL（m/s・Asia/Tokyo・JSON）、天候コードの日本語化、
  風速の境界（4.9=GOOD / 5.0・6.9=CAUTION / 7.0=DANGER）、海抜+150mの算出
- DID: タイル座標の算出（z16 で x=58211 / y=25805 / px=66 / py=139）、DID 内・外、
  タイル404（＝外）、通信失敗・PNG でないタイル（＝判定不能 `null`）
- PNG デコーダ: フィルタ種別 0〜4 の復元、範囲外ピクセル、PNG でないデータのエラー
- 衛星診断: StaticMap（zoom19 / 600px / SATELLITE）と画像のbase64送信、data URI のMIME判定
- 20時間点検後は「点検後飛行時間」で判定、960分で warn / 1200分で over
- 様式1 CSV の BOM・CRLF・18列・累計の積み上げ（期間外の飛行も加算）
- CSV エスケープ（カンマ・引用符・改行・数式インジェクション）
- 様式2・3 CSV の22列（固定9 + 項目13）
- 必須項目・未入力項目のバリデーション
- `getBootstrapData` の統計値、`recalcDroneTotals` の再計算
- **`doPost` ルーター（外部 API）**: `success` / `error` の封筒、`args` の展開、未定義 action・args 非配列・
  壊れた JSON・空本文のエラー、`e.parameter`（クエリ文字列）フォールバック、別名 action
  （`geocodeAddress` / `reverseGeocode`）、管理系 action が**公開されていない**こと、サーバー例外が
  メッセージとして返ること、書き込み系（`savePilot`）と CSV 生成が通ること（46チェック）

### 7.2 フロントエンド（ブラウザ確認）

`http://localhost:8811/index.html` をモックモードで開き、次を確認済みです。

API モードまで含めて確認する場合は、同梱のモック API サーバーを使います
（静的配信 + `doPost` と同じ封筒を返す `/api`）。

```bash
node drone-log/tests/mock-api-server.js 8811
# ブラウザで http://127.0.0.1:8811/index.html?api=http://127.0.0.1:8811/api
```

- 初期表示（機体2台・操縦者1名・飛行3件・13項目の点検UI）
- 必須項目のバリデーション（6件のエラー表示、保存されないこと）
- 時刻入力からの飛行時間の自動計算（22:40→00:10 = 90分、日跨ぎ表示）
- 一括OK → 13/13・「合格」、1項目NG → 「異常あり」
- 保存 → `FLT-0004` / `INS-0004` 採番、日誌への即時反映、累計時間の更新
- 日誌のキーワード検索・機体フィルタ・条件クリア
- CSV 生成（BOM / CRLF / 18列 / 22列 / 累計値）
- 機体の追加、20時間定期点検の記録と判定基準の切り替わり
- 特定飛行10項目のチェック → カテゴリーが Ⅰ → ⅡB → ⅡA → Ⅲ と遷移すること（色: teal/sky/amber/rose）
- 機体重量の切り替えで ⅡB ⇄ ⅡA（25kg境界）、立入管理トグルで Ⅲ へ遷移
- 衛星写真の診断（モック）→ サムネイル・検出物体・助言の表示、`30m未満` の自動チェックとカテゴリー再判定
- 現場写真の診断（Canvas で生成した JPEG）→ 長辺1200pxへ圧縮して送信、`DID` の自動チェック
- 保存 → `飛行カテゴリー` チップが日誌カードに表示され、保存後に区分・診断がリセットされること
- 現場環境チェック（モック）: 東京の座標 → 天候「薄曇り / 18.5℃」・風速 3.2m/s（突風 5.1）・海抜 12.4m・
  150m上限 162.4m・「DID 内」を表示し、`DID（人口集中地区）` が自動チェックされてカテゴリーⅡBへ再判定
- 地方の座標（35.854 / 140.598）→「DID 外」表示・チェックは追加されない・再取得でも表示が更新されること
- 保存後リセットで環境カードが非表示になり、ステータス・値・チェックが初期化されること
- 「🗑️ 入力をクリア」: 入力・特定飛行・点検13項目・環境/AI の結果が揃った状態から押すと、
  確認ダイアログ「入力中の内容をすべてクリアしますか？」→ OK で 日付が当日（JST）・目的が「空撮」・
  立入管理措置 ON・特定飛行0件・点検 0/13（未入力）・カテゴリーⅠ・環境/AI カード非表示・
  エラー表示0件（`.err.show` / `.field-error`）に戻り、トースト「入力をクリアしました」が出ること。
  操縦者・機体の選択は維持されること
- クリアで確認ダイアログをキャンセルした場合は何も変わらないこと
- 環境取得／AI 診断の**実行中にクリア**しても、後から届いた応答でカードが再表示されないこと（`state.entry.reqSeq` の世代管理）
- レイアウト: 1440px / 412px ともに横スクロールなし（`scrollWidth === clientWidth`）、
  特定飛行の行は 412px で 50px 高、AI ボタンと「現場環境を取得」は 44px 高、
  保存バーの「🗑️ 入力をクリア」と「保存する」は 412px で同一行（125px / 231px・間隔8px・高さ46px）で重ならないこと
- **API モード（`?api=…`）**: モック API サーバー（`doPost` と同じ封筒を返す）へ接続し、初期表示
  （バッジ `GAS API`・`state.ready`・機体/操縦者の選択肢が API 応答から生成される）、`getFlights` の応答、
  未定義 action の日本語エラー（`未定義のActionです: nope`）、`args` の JSON 送信（`[{"limit":5}]`）を確認済み。
  API URL 未設定時は従来どおりモック（バッジ `ローカル(デモ)`）で動作することも確認済み

---

## 8. 未検証・既知の制約

- **GAS 実環境での動作は未検証**です。`google.script.run` 経由の呼び出し、実際のスプレッドシートへの書き込み、
  デプロイ後の権限・モバイル表示は、プロジェクトへ反映したうえで確認が必要です。
- `clasp` はこのリポジトリからは実行していません（`npx @google/clasp` を想定）。`appsscript.json` の
  `webapp.access` は、GitHub Pages から匿名で `fetch` できるように `ANYONE_ANONYMOUS` に変更しました。
  反映には再デプロイ（「デプロイを管理」→ 既存デプロイを編集、または新規デプロイ）が必要です。
- **GitHub Pages は未有効化**です（`https://aromabird.github.io/works/` は 404）。GitHub の
  Settings → Pages で `main` / `/ (root)` を選ぶ操作はリポジトリ管理者が行ってください。
- **実デプロイ環境での CORS は未検証**です。ローカルではモック API サーバー（同一オリジン）で経路を
  確認しています。Pages 公開後、実際の `/exec` へ接続して `text/plain` POST が通ることを確認してください。
- API は**認証なし（匿名）**で公開されます。URL を知る第三者が記録を追加できます（管理系は非公開）。
- Tailwind CSS は CDN 版です。社内ネットワーク等で CDN が使えない場合はスタイルが崩れます。
- `parseDjiLog` はスタブ（例外を投げる）です。
- Gemini 診断は **モックとスタブ環境（vm）でのみ検証済み**です。実際の Gemini API・StaticMap の応答は
  GAS へデプロイし、`GEMINI_API_KEY` を登録したうえでの確認が必要です（モデル名は `gemini-2.5-flash` 固定）。
- StaticMap は `GOOGLE_MAPS_API_KEY` 未設定だと Apps Script 既定割当で動作します。本番の呼び出し回数が
  多い場合は Maps Static API の有効化とキー登録を行ってください。
- AI 診断の判定は画像からの推定であり、法令上の該当性を保証するものではありません。最終判断は申請内容・DIPS で確認してください。
- 現場環境データは **モックとスタブ環境（vm）でのみ検証済み**です。Open-Meteo・国土地理院 標高API・
  地理院タイル `did2020` の実応答は、GAS へデプロイしたうえでの確認が必要です（API キーは不要）。
- DID は **令和2年（2020年）国勢調査** の区域です。次回国勢調査で区域が更新された場合は、
  `GSI_DID_TILE_ENDPOINT` のタイル名（`did2020`）を差し替えてください。
- DID の判定はタイル解像度（ズーム16 ≒ 2.4m/px）に依存するため、境界付近では数mの誤差があります。
  また、統計上の DID は「飛行禁止空域」そのものではありません。最終判断は DIPS で確認してください。
- DID は日本の国勢調査に基づく区域のため、**日本国外の座標**では「DID 外」と表示されます。
- 1回の「現場環境を取得」で 3 リクエスト（Open-Meteo / 標高API / 地理院タイル）を消費します。
  Apps Script の `UrlFetchApp` 割り当てに注意してください。
- 天候・風速は Open-Meteo の格子点（およそ数km四方）の値で、現地の瞬間風速ではありません。
  突風（`windGust`）も含めて現地の状況を優先してください。
- `fetchGeoFromAddress` / `fetchAddressFromGeo` は GAS 標準の `Maps.newGeocoder()` を使うため **API キーは不要**ですが、
  実行回数には Apps Script の割り当て上限があります（超過時は `status` 付きのエラーを画面に表示）。
- 「📍 現在地（GPS）」はブラウザの Geolocation API を使います。GAS のサンドボックス iframe では
  位置情報が許可されない場合があり、その場合は「位置情報の利用が許可されていません」と表示されます。
  緯度・経度の手入力／住所検索は常に利用できます。
- CSV ダウンロードはブラウザの Blob 機能を使用します。GAS のサンドボックス iframe によっては
  ダウンロードがブロックされる可能性があり、その場合はスプレッドシートから直接出力してください。
- 飛行記録の編集・削除、操縦者の削除は未実装です（追記型の記録を優先）。
- 点検項目は現行様式の13項目固定です。旧9項目様式には対応していません。

---

## 9. DIPS に関する重要な注意

**DIPS 2.0 には飛行日誌の CSV インポート機能がありません。**（公式仕様を確認済み）

本アプリが出力する CSV は、国交省「無人航空機の飛行日誌の取扱要領」様式1〜3の
記載事項に準拠した**記録・保管用**データです。DIPS への登録は画面からの入力が必要です。
この注意はアプリの日誌タブにも常時表示しています。

---

## 10. 今後の拡張

1. `parseDjiLog(file)` の実装（DJI の飛行ログから離着陸時刻・座標・高度を抽出）
2. 飛行記録の編集・削除と監査ログ
3. 住所検索の候補選択 UI（現在は最上位候補を自動採用）
4. DIPS の画面入力項目に合わせた出力順・項目名の調整（`DIPS_FLIGHT_COLUMNS` の差し替えのみで対応可能）
5. AI 診断結果の履歴保存（現状は画面表示のみ。必要なら `t_flights` へ要約列を追加）
6. 機体ごとの「機体認証の有無」をマスタへ追加し、カテゴリーⅡA/ⅡB の手続き表示をさらに精緻化
7. 現場環境の取得結果を `t_flights` へ保存（天候・風速・標高・DID の列を追加）し、飛行日誌の証跡を強化
8. 天候・標高・DID タイルの `CacheService` キャッシュ（同一地点の再取得で API 呼び出しを削減）
