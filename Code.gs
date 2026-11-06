/**
 * =========================================================================
 * ドローン飛行日誌 & 機体管理 Web アプリ（バックエンド）
 * -------------------------------------------------------------------------
 * 実行環境 : Google Apps Script（V8 ランタイム）
 * データ   : アクティブなスプレッドシート（4シート）
 * 構成     : Code.gs（本ファイル） + index.html
 *
 * 設計方針
 *  1. シート定義は SCHEMA に集約し、シート生成・読み書き・CSV 出力で共有する
 *  2. 日付・時刻はタイムゾーンずれを避けるため文字列（YYYY-MM-DD / HH:mm）で保存
 *  3. 書き込みは LockService で直列化し、ID 採番の重複を防止
 *  4. 拡張列は必ず末尾に追加する（既存列の順序・意味は変えない）
 *  5. 将来拡張（DJIログ解析 / Google Maps / Geminiリスク判定 / DIPS連携）は
 *     「独立した関数 + 明確な入出力」として差し込める構造にする
 *
 * 用語
 *  - 特定飛行区分: 航空法上の特定飛行に該当する形態（複数選択）
 *  - 20時間点検  : 機体の飛行時間が20時間（1200分）ごとに必要な点検整備
 * =========================================================================
 */

/** アプリ名（画面タイトル・メニュー表示に使用） */
const APP_NAME = 'ドローン飛行日誌';

/** アプリバージョン（画面フッターに表示） */
const APP_VERSION = '1.0.0';

/**
 * 外部 API（doPost）の共有トークン。
 *
 * GitHub Pages のフロントエンド（index.html の API_CONFIG.token）が送る
 * payload.token と照合し、一致しないリクエストは処理せずエラーを返す。
 *
 * 注意: この値は公開リポジトリの index.html に埋め込まれているため、
 * ソースを見れば誰でも取得できる。したがって「第三者のアプリからの
 * 誤爆や、action 名の総当たり探索を防ぐ簡易ゲート」であり、暗号学的な
 * アクセス制御ではない。厳密な秘匿が必要になった場合は、利用者ごとの
 * 認証（Google ログイン等）と、この値の Script Properties 管理へ移行する。
 */
const API_TOKEN = 'DRONE_LOG_SECURE_TOKEN_2026';

/**
 * 業務上のタイムゾーン。
 * スクリプトのタイムゾーン設定に依存すると端末やプロジェクト設定で
 * 日付がずれるため、明示的に JST 固定で扱う。
 */
const TZ = 'Asia/Tokyo';

/** シート名の定数（コード内では必ずこれを使う） */
const SHEET = {
  DRONES: 'm_drones',
  PILOTS: 'm_pilots',
  FLIGHTS: 't_flights',
  INSPECTIONS: 't_inspections'
};

/** 法定点検の基準: 飛行時間20時間 = 1200分 */
const INSPECTION_LIMIT_MINUTES = 1200;

/** 警告閾値: 20時間の80% = 960分 */
const INSPECTION_WARN_MINUTES = 960;

/**
 * 国交省 様式2「日常点検記録」の13項目（現行様式）。
 * 旧様式は9項目だが、本アプリは現行13項目に準拠する。
 */
const INSPECTION_GROUPS = [
  { label: '機体本体', items: ['機体全般', 'プロペラ', 'フレーム'] },
  {
    label: '制御・通信',
    items: ['通信系統', '推進系統', '電源系統', '自動制御系統', '操縦装置']
  },
  {
    label: '装備',
    items: ['バッテリー・燃料', '機体識別表示', 'リモートID', '灯火', 'カメラ']
  }
];

/** 点検種別（t_inspections の値） */
const INSPECTION_TYPES = ['飛行前', '飛行後', '20時間定期点検', '修理'];

/** 点検結果（t_inspections の値） */
const INSPECTION_RESULTS = ['合格', '異常あり'];

/**
 * 特定飛行の10項目（飛行空域4・飛行方法6）。
 * -------------------------------------------------------------------------
 * label はシート（t_flights.specificFlags）へ保存する表記。既存レコードとの
 * 互換のため、従来からある4項目（DID / 夜間 / 目視外 / 人・物件から30m未満）
 * は表記を変えない。key はフロント・判定ロジックで使う内部識別子。
 * severity: 'hard' = カテゴリーⅡA を決定づける項目 / 'soft' = ⅡB に留まり得る項目
 */
const SPECIFIC_FLIGHT_DEFS = [
  {
    key: 'did', label: 'DID（人口集中地区）', uiLabel: '人口集中地区（DID）の上空',
    group: 'airspace', severity: 'soft',
    description: '市街化区域など建物が密集している区域の上空'
  },
  {
    key: 'airport', label: '空港周辺', uiLabel: '空港等の周辺空域',
    group: 'airspace', severity: 'hard',
    description: '空港・ヘリポート等の周辺（進入表面等の上空）'
  },
  {
    key: 'altitude150m', label: '150m以上', uiLabel: '地表・水面から150m以上の上空',
    group: 'airspace', severity: 'hard',
    description: '地表または水面から150m以上の高さ'
  },
  {
    key: 'emergency', label: '緊急用務空域', uiLabel: '緊急用務空域',
    group: 'airspace', severity: 'hard',
    description: '災害等で国土交通省が指定した空域'
  },
  {
    key: 'night', label: '夜間', uiLabel: '夜間飛行',
    group: 'method', severity: 'soft',
    description: '日没後から日出前までの飛行'
  },
  {
    key: 'bovlos', label: '目視外', uiLabel: '目視外飛行（VLOS外）',
    group: 'method', severity: 'soft',
    description: '操縦者が機体を直接目視できない飛行（FPV・自動飛行等）'
  },
  {
    key: 'within30m', label: '人・物件から30m未満', uiLabel: '人または物件から30m未満',
    group: 'method', severity: 'soft',
    description: '人または物件（車両・建物等）から30m未満に接近'
  },
  {
    key: 'event', label: 'イベント上空', uiLabel: '多数の者が集まる催し場所の上空',
    group: 'method', severity: 'hard',
    description: '不特定多数の人が集まる催し場所の上空'
  },
  {
    key: 'hazmat', label: '危険物輸送', uiLabel: '危険物の輸送',
    group: 'method', severity: 'hard',
    description: '火薬類・高圧ガス等の危険物を積載した飛行'
  },
  {
    key: 'drop', label: '物件投下', uiLabel: '物件の投下',
    group: 'method', severity: 'hard',
    description: '機体から物件を投下する飛行'
  }
];

/** UI 表示用のグループ（飛行空域4項目 / 飛行方法6項目） */
const SPECIFIC_FLIGHT_GROUPS = [
  { key: 'airspace', label: '飛行空域', hint: '空域に関する4項目' },
  { key: 'method', label: '飛行方法', hint: '飛ばし方に関する6項目' }
];

/** 特定飛行区分の選択肢（10項目＋非特定飛行。排他制御はバックエンドで実施） */
const SPECIFIC_FLIGHT_OPTIONS = SPECIFIC_FLIGHT_DEFS.map(function (d) { return d.label; })
  .concat(['非特定飛行']);

/** カテゴリーⅡA を決定づける項目（空港周辺・150m以上・緊急用務空域・イベント・危険物・投下） */
const HARD_SPECIFIC_FLAG_KEYS = ['airport', 'altitude150m', 'emergency', 'event', 'hazmat', 'drop'];

/** 機体重量の境界（25kg）。これ以上はカテゴリーⅡA */
const CATEGORY_WEIGHT_BOUNDARY_G = 25000;

/**
 * 飛行カテゴリー（Ⅰ / ⅡA / ⅡB / Ⅲ）の表示メタ情報。
 * level はフロントの配色（good / caution / warn / danger）に対応する。
 */
const CATEGORY_META = {
  I: { label: 'カテゴリーⅠ', level: 'good', summary: '非特定飛行（許可・承認申請は不要）' },
  IIA: { label: 'カテゴリーⅡA', level: 'warn', summary: '特定飛行（機体認証＋包括申請が必要）' },
  IIB: { label: 'カテゴリーⅡB', level: 'caution', summary: '特定飛行（二等資格＋飛行許可で実施可）' },
  III: { label: 'カテゴリーⅢ', level: 'danger', summary: '特定飛行（一等資格＋事前の許可・承認が必要）' }
};

/** カテゴリーごとの手続きガイダンス（フロントと共有する） */
const CATEGORY_PROCEDURES = {
  I: ['非特定飛行に該当するため、事前の許可・承認申請は不要です。飛行日誌の記録と日常点検のみ継続してください。'],
  IIA: ['特定飛行のうち、立入管理措置は講じるもののカテゴリーⅡBの要件を満たさない飛行です。二等以上の資格に加え、機体認証と包括申請（または個別の許可・承認）が必要です。'],
  IIB: ['特定飛行のうち、立入管理措置を講じ、機体重量25kg未満で空港周辺・150m以上・緊急用務空域・イベント上空・危険物輸送・物件投下に該当しない飛行です。二等以上の資格と、飛行ごとの許可・承認（または包括申請）が必要です。'],
  III: ['特定飛行のうち、第三者の立入管理措置を講じない飛行です。一等無人航空機操縦士の資格が必要で、飛行前に国土交通省への許可・承認申請を行ってください。']
};

/** 飛行目的の候補（国交省様式1の記載例に準拠。自由入力も可） */
const FLIGHT_PURPOSES = [
  '空撮',
  '測量',
  'インフラ点検・保守',
  '設備メンテナンス',
  '農林水産業',
  '環境調査',
  '警備',
  '報道取材',
  '輸送・宅配',
  '研究開発',
  '訓練・練習',
  '趣味',
  'その他'
];

/**
 * シート定義。
 * - 配列の順序 = 新規シート作成時の列順
 * - header はシート上の見出し文字列（読み書きは見出しで列を解決するため、
 *   後から列を追加しても既存データの位置が壊れない）
 * - kind: text / number / date / time
 */
const SCHEMA = {
  m_drones: [
    { key: 'droneId', header: '機体ID', width: 110, kind: 'text' },
    { key: 'modelName', header: '機種名', width: 200, kind: 'text' },
    { key: 'maker', header: 'メーカー', width: 120, kind: 'text' },
    { key: 'weightG', header: '重量(g)', width: 90, kind: 'number' },
    { key: 'registrationNo', header: '機体登録記号', width: 150, kind: 'text' },
    { key: 'serialNo', header: '製造番号', width: 170, kind: 'text' },
    { key: 'totalMinutes', header: '総飛行時間(累計分)', width: 160, kind: 'number' },
    { key: 'note', header: '備考', width: 240, kind: 'text' }
  ],
  m_pilots: [
    { key: 'pilotId', header: '操縦者ID', width: 110, kind: 'text' },
    { key: 'name', header: '氏名', width: 140, kind: 'text' },
    { key: 'licenseNo', header: '技能証明書番号', width: 170, kind: 'text' },
    { key: 'contact', header: '連絡先', width: 170, kind: 'text' }
  ],
  t_flights: [
    { key: 'flightId', header: '飛行ID', width: 110, kind: 'text' },
    { key: 'flightDate', header: '飛行年月日', width: 110, kind: 'date' },
    { key: 'pilotId', header: '操縦者ID', width: 110, kind: 'text' },
    { key: 'droneId', header: '機体ID', width: 110, kind: 'text' },
    { key: 'takeoffPlace', header: '離陸場所', width: 200, kind: 'text' },
    { key: 'landingPlace', header: '着陸場所', width: 200, kind: 'text' },
    { key: 'lat', header: '緯度', width: 100, kind: 'number' },
    { key: 'lng', header: '経度', width: 100, kind: 'number' },
    { key: 'takeoffTime', header: '離陸時刻', width: 90, kind: 'time' },
    { key: 'landingTime', header: '着陸時刻', width: 90, kind: 'time' },
    { key: 'durationMin', header: '飛行時間(分)', width: 110, kind: 'number' },
    { key: 'specificFlags', header: '特定飛行区分', width: 240, kind: 'text' },
    { key: 'hasClearZone', header: '立入管理措置', width: 120, kind: 'text' },
    { key: 'category', header: '飛行カテゴリー', width: 130, kind: 'text' },
    { key: 'safetyEvent', header: '安全影響事象', width: 240, kind: 'text' },
    // ---- 以下は拡張列（末尾にのみ追加） ----
    { key: 'purpose', header: '飛行目的', width: 140, kind: 'text' },
    { key: 'createdAt', header: '登録日時', width: 150, kind: 'text' }
  ],
  t_inspections: [
    { key: 'inspectionId', header: '点検ID', width: 110, kind: 'text' },
    { key: 'flightId', header: '飛行ID', width: 110, kind: 'text' },
    { key: 'droneId', header: '機体ID', width: 110, kind: 'text' },
    { key: 'type', header: '点検種別', width: 130, kind: 'text' },
    { key: 'inspectionDate', header: '点検実施日', width: 110, kind: 'date' },
    { key: 'inspector', header: '実施者', width: 130, kind: 'text' },
    { key: 'result', header: '点検結果', width: 100, kind: 'text' },
    { key: 'memo', header: '点検詳細メモ', width: 280, kind: 'text' },
    // ---- 以下は拡張列（末尾にのみ追加） ----
    { key: 'itemsJson', header: '点検項目詳細(JSON)', width: 280, kind: 'text' },
    { key: 'createdAt', header: '登録日時', width: 150, kind: 'text' }
  ]
};

/**
 * DIPS 2.0 / 国交省 様式1「飛行記録」準拠の CSV 列定義。
 * -------------------------------------------------------------------------
 * 重要: DIPS 2.0 本体には「飛行日誌の CSV インポート機能」は存在しない。
 * 本 CSV は国交省「無人航空機の飛行日誌の取扱要領」様式1の記載事項に
 * 準拠した連携・保管用データである。列の増減はこの配列だけで完結する。
 */
const DIPS_FLIGHT_COLUMNS = [
  { header: '飛行年月日', value: function (f) { return f.date; } },
  { header: '操縦者氏名', value: function (f) { return f.pilotName; } },
  { header: '技能証明書番号', value: function (f) { return f.licenseNo; } },
  { header: '機体登録記号', value: function (f) { return f.registrationNo; } },
  { header: '機種名（種類及び型式）', value: function (f) { return f.droneName; } },
  { header: '製造番号', value: function (f) { return f.serialNo; } },
  { header: '飛行目的', value: function (f) { return f.purpose; } },
  { header: '飛行概要（特定飛行区分）', value: function (f) { return f.specificFlags.join('、'); } },
  { header: '離陸場所', value: function (f) { return f.takeoffPlace; } },
  { header: '着陸場所', value: function (f) { return f.landingPlace; } },
  { header: '離陸時刻', value: function (f) { return f.takeoffTime; } },
  { header: '着陸時刻', value: function (f) { return f.landingTime; } },
  { header: '飛行時間(分)', value: function (f) { return f.durationMin; } },
  { header: '総飛行時間(分)', value: function (f) { return f.cumulativeMinutes; } },
  { header: '飛行の安全に影響のあった事項', value: function (f) { return f.safetyEvent; } },
  { header: '緯度', value: function (f) { return f.lat === null ? '' : f.lat; } },
  { header: '経度', value: function (f) { return f.lng === null ? '' : f.lng; } },
  { header: '飛行ID（管理用）', value: function (f) { return f.flightId; } }
];

/** 様式2・3（日常点検記録／点検整備記録）CSV の固定列 */
const DIPS_INSPECTION_COLUMNS = [
  { header: '点検ID', value: function (i) { return i.inspectionId; } },
  { header: '点検種別', value: function (i) { return i.type; } },
  { header: '点検実施日', value: function (i) { return i.inspectionDate; } },
  { header: '機体登録記号', value: function (i) { return i.registrationNo; } },
  { header: '機種名（種類及び型式）', value: function (i) { return i.droneName; } },
  { header: '実施者', value: function (i) { return i.inspector; } },
  { header: '点検結果', value: function (i) { return i.result; } },
  { header: '飛行ID', value: function (i) { return i.flightId; } },
  { header: '備考', value: function (i) { return i.memo; } }
];

// =========================================================================
// Web アプリ エントリポイント
// =========================================================================

/**
 * Web アプリのエントリポイント。
 * スマートフォン（Pixel 10 等）と PC の両対応のため viewport を明示する。
 *
 * @param {Object} e リクエストパラメータ（未使用）
 * @return {HtmlOutput} index.html を評価した HTML
 */
function doGet(e) {
  const template = HtmlService.createTemplateFromFile('index');
  template.appVersion = APP_VERSION;
  template.appName = APP_NAME;
  return template
    .evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 外部フロントエンド（GitHub Pages）から呼ばれる Web API のエントリポイント。
 *
 * リクエスト: POST の本文に JSON を載せる。
 *   { "action": "getFlights", "args": [{ "droneId": "DRN-0001", "limit": 50 }],
 *     "token": "DRONE_LOG_SECURE_TOKEN_2026" }
 *
 * レスポンス: 常に HTTP 200 + JSON。
 *   成功: { "success": true,  "data": <関数の戻り値> }
 *   失敗: { "success": false, "error": "日本語のメッセージ" }
 *
 * 認証:
 * - 本文の token が API_TOKEN と一致しない場合は、action を実行せず
 *   「認証エラー: …」を返す（token の照合は action の検証より先に行う）。
 *
 * 注意:
 * - GAS の Web アプリは CORS のプリフライト（OPTIONS）に応答できない。
 *   Content-Type: application/json を付けるとプリフライトが発生して失敗するため、
 *   フロントエンドからは Content-Type: text/plain;charset=utf-8 で送信すること。
 * - GAS は HTTP ステータスコードを制御できないため、失敗も 200 で返し、
 *   本文の success で成否を判定する。
 * - デプロイ設定は「実行ユーザー: 自分 / アクセス: 全員（匿名）」が必要。
 *   管理系（シート初期化・再計算）は外部公開しない（dispatchApiAction_ 参照）。
 *
 * @param {Object} e イベント（postData.contents に JSON 文字列）
 * @return {TextOutput} JSON テキスト
 */
function doPost(e) {
  let action = '';
  try {
    const payload = parseApiRequest_(e);
    action = payload.action;

    // トークン照合は action の検証より先に行う
    // （トークンを持たない相手に「存在する action 名」を探らせない）
    verifyApiToken_(payload.token);

    const args = payload.args || [];

    if (!action) throw new Error('action が指定されていません。');
    if (!Array.isArray(args)) throw new Error('args は配列で指定してください。');

    return apiJson_({ success: true, data: dispatchApiAction_(action, args) });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    Logger.log('[doPost] ' + (action || '(no action)') + ' -> ' + message);
    return apiJson_({ success: false, error: message });
  }
}

/**
 * リクエスト本文（またはクエリ文字列）から action / args / token を取り出す。
 *
 * 本文が空でも ?action=getCatalog&token=… の形で呼べるようにしてある
 * （デプロイ後の動作確認を curl で行いやすくするため）。
 *
 * @param {Object} e イベント
 * @return {{action: string, args: Array, token: (string|undefined)}} リクエスト内容
 */
function parseApiRequest_(e) {
  const contents = e && e.postData ? e.postData.contents : '';

  if (contents) {
    let payload;
    try {
      payload = JSON.parse(contents);
    } catch (err) {
      throw new Error('リクエストの JSON を解析できません: ' + err.message);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('リクエスト本文は JSON オブジェクトで送信してください。');
    }
    return { action: String(payload.action || ''), args: payload.args, token: payload.token };
  }

  const params = (e && e.parameter) || {};
  if (!params.action) {
    throw new Error('リクエスト本文が空です（JSON を送信してください）。');
  }

  let args = [];
  if (params.args) {
    try {
      args = JSON.parse(params.args);
    } catch (err) {
      throw new Error('args の JSON を解析できません: ' + err.message);
    }
  }
  return { action: String(params.action), args: args, token: params.token };
}

/**
 * 送信された token を API_TOKEN と照合する。
 *
 * 一致しない場合は例外を投げ、doPost が {success:false, error} を返す。
 * 比較は文字数分だけ必ず走査する（一致した位置で早期 return しない）が、
 * トークン自体が公開フロントに埋め込まれた共有文字列なので、これは
 * 「入力ミスの検出と雑な総当たりの抑止」が目的であり、暗号学的な保護ではない。
 *
 * @param {*} token リクエストの token
 */
function verifyApiToken_(token) {
  const provided = token === undefined || token === null ? '' : String(token);
  if (!provided) throw new Error('認証エラー: token が指定されていません。');
  if (!timingSafeEqual_(provided, API_TOKEN)) {
    throw new Error('認証エラー: token が正しくありません。');
  }
}

/**
 * 文字列を定時間で比較する（長さの違いのみ即座に判定）。
 *
 * @param {string} a 比較対象1
 * @param {string} b 比較対象2
 * @return {boolean} 一致すれば true
 */
function timingSafeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * action 名から Code.gs の公開関数へ振り分ける。
 *
 * 実行を許可する関数だけをここに列挙する（任意の関数を呼ばせないための
 * ホワイトリスト）。管理系（initSpreadsheet / recalcDroneTotals / selfCheck）は
 * 第三者にシートを初期化・再計算されないよう外部公開しない
 * （スプレッドシートのメニューから実行する）。
 *
 * @param {string} action アクション名
 * @param {Array} args 引数
 * @return {*} 関数の戻り値
 */
function dispatchApiAction_(action, args) {
  switch (action) {
    // --- 参照 ---
    case 'getCatalog':
      return getCatalog();
    case 'getBootstrapData':
      return getBootstrapData();
    case 'getFlights':
      return getFlights(args[0]);
    case 'getInspections':
      return getInspections(args[0]);

    // --- 登録 ---
    case 'saveFlightRecord':
      return saveFlightRecord(args[0]);
    case 'saveDrone':
      return saveDrone(args[0]);
    case 'savePilot':
      return savePilot(args[0]);
    case 'saveInspection':
      return saveInspection(args[0]);

    // --- 住所・座標 ---
    case 'fetchGeoFromAddress':
    case 'geocodeAddress': // 別名（外部 API の action 名）
      return fetchGeoFromAddress(args[0]);
    case 'fetchAddressFromGeo':
    case 'reverseGeocode': // 別名（外部 API の action 名）
      return fetchAddressFromGeo(args[0], args[1]);
    case 'fetchGeoInfo':
      return fetchGeoInfo(args[0], args[1]);

    // --- 現場環境・AI 診断 ---
    case 'fetchFlightEnvironment':
      return fetchFlightEnvironment(args[0], args[1]);
    case 'analyzeRiskFromCoordinates':
      return analyzeRiskFromCoordinates(args[0], args[1]);
    case 'analyzeRiskFromImage':
      return analyzeRiskFromImage(args[0], args[1]);
    case 'analyzeRiskWithGemini':
      return analyzeRiskWithGemini(args[0], args[1]);

    // --- CSV ---
    case 'buildDipsCsv':
      return buildDipsCsv(args[0]);
    case 'buildInspectionCsv':
      return buildInspectionCsv(args[0]);

    // --- 判定・未実装スタブ ---
    case 'judgeFlightCategory':
      return judgeFlightCategory(args[0]);
    case 'parseDjiLog':
      return parseDjiLog(args[0]);

    default:
      throw new Error('未定義のActionです: ' + action);
  }
}

/**
 * 外部 API 用の JSON レスポンスを作る。
 *
 * @param {Object} obj 返却するオブジェクト
 * @return {TextOutput} JSON テキスト
 */
function apiJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * HTML から別ファイルを読み込むためのユーティリティ（将来の分割用）。
 *
 * @param {string} filename ファイル名（拡張子なし）
 * @return {string} ファイル内容
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * スプレッドシートを開いたときに表示されるカスタムメニュー。
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('ドローン日誌')
      .addItem('① シートを初期セットアップ', 'initSpreadsheet')
      .addItem('② 機体の累計時間を再計算', 'recalcDroneTotals')
      .addItem('③ セルフチェック', 'selfCheck')
      .addToUi();
  } catch (err) {
    // スプレッドシート以外（Web アプリ単体実行など）ではメニューを作らない
    Logger.log('onOpen skipped: ' + err);
  }
}

// =========================================================================
// シートの初期セットアップ
// =========================================================================

/**
 * 4つのシートを冪等にセットアップする。
 * - シートが無ければヘッダー付きで作成
 * - 既存シートに不足しているヘッダーは「末尾に追加」（既存データは変更しない）
 * - 列幅・表示書式・固定行を整える
 *
 * 何度実行しても安全（データ行は削除しない）。
 *
 * @return {Object} 実行結果サマリー
 */
function initSpreadsheet() {
  return withLock_(function () {
    return setupSheets_();
  });
}

/**
 * ロックを取らずにシートをセットアップする内部関数。
 * getSheet_ からの遅延初期化でも使うため、ロックのネストを避けて分離している。
 *
 * @return {Object} 実行結果サマリー
 */
function setupSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error(
      'スプレッドシートに紐づいていないスクリプトです。' +
      'スプレッドシートの「拡張機能 > Apps Script」から開き直してください。'
    );
  }

  const created = [];
  const headersAdded = [];
  const sheetNames = [SHEET.DRONES, SHEET.PILOTS, SHEET.FLIGHTS, SHEET.INSPECTIONS];

  sheetNames.forEach(function (name) {
    const defs = SCHEMA[name];
    let sheet = ss.getSheetByName(name);

    if (!sheet) {
      sheet = ss.insertSheet(name);
      created.push(name);
    }

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    let headers = [];

    if (lastRow >= 1 && lastCol >= 1) {
      headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) {
        return String(v).trim();
      });
    }

    // 完全に空のシート → 全ヘッダーを書き込む
    if (headers.join('') === '') {
      sheet.getRange(1, 1, 1, defs.length).setValues([
        defs.map(function (d) { return d.header; })
      ]);
    } else {
      // 既存ヘッダーに無いものだけを末尾に追加（既存列は上書きしない）
      const existing = {};
      headers.forEach(function (h) {
        if (h) existing[h] = true;
      });
      defs.forEach(function (def) {
        if (!existing[def.header]) {
          const nextCol = sheet.getLastColumn() + 1;
          sheet.getRange(1, nextCol).setValue(def.header);
          headersAdded.push(name + ':' + def.header);
        }
      });
    }

    applySheetFormat_(sheet, defs);
  });

  // タブの並び順を整える（見つかる範囲で）
  sheetNames.forEach(function (name, index) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    try {
      ss.setActiveSheet(sheet);
      ss.moveActiveSheet(index + 1);
    } catch (err) {
      Logger.log('moveActiveSheet failed: ' + err);
    }
  });

  return {
    ok: true,
    spreadsheetId: ss.getId(),
    spreadsheetUrl: ss.getUrl(),
    created: created,
    headersAdded: headersAdded,
    sheets: sheetNames.map(function (name) {
      const sheet = ss.getSheetByName(name);
      return {
        name: name,
        exists: !!sheet,
        rows: sheet ? Math.max(0, sheet.getLastRow() - 1) : 0,
        columns: sheet ? sheet.getLastColumn() : 0
      };
    }),
    message: created.length
      ? 'シートを作成しました: ' + created.join(', ')
      : 'シートは既にセットアップ済みです。'
  };
}

/**
 * シートの見た目（ヘッダー書式・列幅・固定行）を整える。
 *
 * @param {Sheet} sheet 対象シート
 * @param {Array<Object>} defs スキーマ定義
 */
function applySheetFormat_(sheet, defs) {
  const lastCol = Math.max(sheet.getLastColumn(), defs.length);
  const headerRange = sheet.getRange(1, 1, 1, lastCol);

  headerRange
    .setFontWeight('bold')
    .setBackground('#1e293b')
    .setFontColor('#f8fafc')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 34);
  sheet.setFrozenRows(1);

  const maxRows = Math.max(sheet.getMaxRows() - 1, 1);
  const headerMap = getHeaderMap_(sheet);

  defs.forEach(function (def) {
    const idx = headerMap[def.header];
    if (idx === undefined) return;
    const col = idx + 1;
    try {
      sheet.setColumnWidth(col, def.width || 140);
    } catch (err) {
      // 列幅変更は失敗しても致命的ではない
    }
    if (def.kind === 'date' || def.kind === 'time' || def.kind === 'text') {
      // 日付・時刻を文字列として保持し、勝手な日付変換を防ぐ
      sheet.getRange(2, col, maxRows, 1).setNumberFormat('@');
    } else if (def.kind === 'number') {
      sheet.getRange(2, col, maxRows, 1).setNumberFormat('0');
    }
  });
}

/**
 * シートのヘッダー文字列 → 0 始まりの列インデックス のマップを作る。
 *
 * @param {Sheet} sheet 対象シート
 * @return {Object<string, number>} ヘッダーマップ
 */
function getHeaderMap_(sheet) {
  const map = {};
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return map;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  headers.forEach(function (h, i) {
    const key = String(h).trim();
    if (key && map[key] === undefined) map[key] = i;
  });
  return map;
}

/**
 * シートを取得する。存在しない場合はセットアップしてから返す。
 *
 * @param {string} name シート名
 * @return {Sheet} シート
 */
function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('スプレッドシートに紐づいていないスクリプトです。');
  }
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    setupSheets_();
    sheet = ss.getSheetByName(name);
  }
  if (!sheet) {
    throw new Error(
      'シート「' + name + '」を用意できませんでした。initSpreadsheet() を実行してください。'
    );
  }
  return sheet;
}

/**
 * セルフチェック。シート構成とデータ件数を返す（データは変更しない）。
 *
 * @return {Object} 診断結果
 */
function selfCheck() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('スプレッドシートに紐づいていないスクリプトです。');
  const report = {
    ok: true,
    appVersion: APP_VERSION,
    spreadsheetUrl: ss.getUrl(),
    sheets: [],
    warnings: []
  };
  Object.keys(SCHEMA).forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    const defs = SCHEMA[name];
    if (!sheet) {
      report.ok = false;
      report.sheets.push({ name: name, exists: false });
      report.warnings.push(
        'シート「' + name + '」がありません。initSpreadsheet() を実行してください。'
      );
      return;
    }
    const headerMap = getHeaderMap_(sheet);
    const missing = defs
      .filter(function (d) { return headerMap[d.header] === undefined; })
      .map(function (d) { return d.header; });
    if (missing.length) {
      report.ok = false;
      report.warnings.push(name + ' に不足ヘッダー: ' + missing.join(', '));
    }
    report.sheets.push({
      name: name,
      exists: true,
      rows: Math.max(0, sheet.getLastRow() - 1),
      columns: sheet.getLastColumn(),
      missingHeaders: missing
    });
  });
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

// =========================================================================
// シート読み書きの共通ヘルパー
// =========================================================================

/**
 * シート全行をオブジェクト配列として読み込む。
 * 列はヘッダー文字列で解決するため、列順の入れ替えや末尾への列追加に耐える。
 *
 * @param {string} name シート名
 * @return {Array<Object>} 各行（_row にシート上の行番号を付与）
 */
function readTable_(name) {
  const sheet = getSheet_(name);
  const defs = SCHEMA[name];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const width = Math.max(sheet.getLastColumn(), defs.length);
  const values = sheet.getRange(1, 1, lastRow, width).getValues();

  const headerMap = {};
  values[0].forEach(function (h, i) {
    const key = String(h).trim();
    if (key && headerMap[key] === undefined) headerMap[key] = i;
  });

  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = { _row: r + 1 };
    let hasValue = false;
    for (let d = 0; d < defs.length; d++) {
      const def = defs[d];
      const idx = headerMap[def.header];
      const raw = idx === undefined ? '' : values[r][idx];
      const v = toCellValue_(def, raw);
      if (v !== '' && v !== null && v !== undefined) hasValue = true;
      row[def.key] = v;
    }
    if (hasValue) rows.push(row);
  }
  return rows;
}

/**
 * セルの生値をスキーマに沿った型へ変換する。
 *
 * @param {Object} def 列定義
 * @param {*} raw セル値
 * @return {string|number} 変換後の値
 */
function toCellValue_(def, raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (raw instanceof Date) {
    if (def.kind === 'date') return Utilities.formatDate(raw, TZ, 'yyyy-MM-dd');
    if (def.kind === 'time') return Utilities.formatDate(raw, TZ, 'HH:mm');
    return Utilities.formatDate(raw, TZ, 'yyyy-MM-dd HH:mm:ss');
  }
  if (def.kind === 'number') {
    const n = Number(raw);
    return isNaN(n) ? String(raw).trim() : n;
  }
  return String(raw).trim();
}

/**
 * オブジェクトをシートの1行分の配列へ変換する。
 *
 * @param {Sheet} sheet 対象シート
 * @param {string} name シート名
 * @param {Object} obj 書き込む値（スキーマの key を持つ）
 * @param {Array} [existingRow] 既存行（更新時に未知の列を保持する）
 * @return {Array} 行配列
 */
function rowArrayFor_(sheet, name, obj, existingRow) {
  const defs = SCHEMA[name];
  const headerMap = getHeaderMap_(sheet);
  const width = Math.max(sheet.getLastColumn(), defs.length);
  const arr = existingRow ? existingRow.slice() : [];
  while (arr.length < width) arr.push('');

  defs.forEach(function (def) {
    const idx = headerMap[def.header];
    if (idx === undefined) return;
    const v = obj[def.key];
    arr[idx] = v === undefined || v === null ? '' : v;
  });
  return arr;
}

/**
 * シート末尾に1行追加する。
 *
 * @param {Sheet} sheet 対象シート
 * @param {string} name シート名
 * @param {Object} obj 書き込む値
 */
function appendRecord_(sheet, name, obj) {
  const arr = rowArrayFor_(sheet, name, obj, null);
  sheet.appendRow(arr);
}

/**
 * 既存行を更新する（未知の列は保持）。
 *
 * @param {Sheet} sheet 対象シート
 * @param {number} rowIndex シート上の行番号（1始まり）
 * @param {string} name シート名
 * @param {Object} obj 書き込む値
 */
function updateRecord_(sheet, rowIndex, name, obj) {
  const width = Math.max(sheet.getLastColumn(), SCHEMA[name].length);
  const current = sheet.getRange(rowIndex, 1, 1, width).getValues()[0];
  const arr = rowArrayFor_(sheet, name, obj, current);
  sheet.getRange(rowIndex, 1, 1, arr.length).setValues([arr]);
}

/**
 * 既存データから次の連番 ID を生成する（例: FLT-0007）。
 * 呼び出し側は必ず withLock_ の中で使うこと。
 *
 * @param {Sheet} sheet 対象シート
 * @param {string} name シート名
 * @param {string} prefix 接頭辞（例: 'FLT-'）
 * @return {string} 次の ID
 */
function nextId_(sheet, name, prefix) {
  const defs = SCHEMA[name];
  const headerMap = getHeaderMap_(sheet);
  const idx = headerMap[defs[0].header];
  const lastRow = sheet.getLastRow();
  let max = 0;
  if (idx !== undefined && lastRow >= 2) {
    const values = sheet.getRange(2, idx + 1, lastRow - 1, 1).getValues();
    const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)$');
    values.forEach(function (row) {
      const m = String(row[0]).trim().match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
  }
  return prefix + pad_(max + 1, 4);
}

/**
 * スクリプトロックを取得して処理を実行する。
 * ID 採番と追記を直列化し、同時実行時の重複を防ぐ。
 *
 * @param {Function} fn 実行する処理
 * @return {*} fn の戻り値
 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  const acquired = lock.tryLock(30000);
  if (!acquired) {
    throw new Error('他の処理が実行中です。数秒待ってから再度お試しください。');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// =========================================================================
// 値変換ユーティリティ
// =========================================================================

/**
 * 数値を指定桁数でゼロ埋めする（GAS でも確実に動くよう自前実装）。
 *
 * @param {number} value 数値
 * @param {number} length 桁数
 * @return {string} ゼロ埋め文字列
 */
function pad_(value, length) {
  let s = String(value);
  while (s.length < length) s = '0' + s;
  return s;
}

/**
 * 文字列化して前後の空白を除去する（null/undefined は空文字）。
 *
 * @param {*} value 値
 * @return {string} トリム済み文字列
 */
function trim_(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * 数値へ変換する。変換できない場合は fallback を返す。
 *
 * @param {*} value 値
 * @param {number} fallback 既定値
 * @return {number} 数値
 */
function toNumber_(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return isNaN(n) ? fallback : n;
}

/**
 * 数値を min〜max に収める。
 *
 * @param {number} value 値
 * @param {number} min 下限
 * @param {number} max 上限
 * @return {number} 補正後の値
 */
function clamp_(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 現在日時を 'yyyy-MM-dd HH:mm:ss'（JST）で返す。
 *
 * @return {string} タイムスタンプ
 */
function nowStamp_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

/**
 * 今日の日付を 'yyyy-MM-dd'（JST）で返す。
 *
 * @return {string} 日付文字列
 */
function today_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

/**
 * 日付を 'yyyy-MM-dd' に正規化する。
 * Date オブジェクト・'2026/11/6'・'2026-11-06' を受け付ける。
 * 不正な日付は空文字を返す（呼び出し側で必須チェックする）。
 *
 * @param {*} value 入力値
 * @return {string} 正規化した日付（不正時は空文字）
 */
function normalizeDate_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return Utilities.formatDate(value, TZ, 'yyyy-MM-dd');

  const s = String(value).trim();
  const m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (!m) return '';

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';

  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';

  return y + '-' + pad_(mo, 2) + '-' + pad_(d, 2);
}

/**
 * 時刻を 'HH:mm' に正規化する。'8:5' のような入力も受け付ける。
 *
 * @param {*} value 入力値（Date / 'HH:mm'）
 * @return {string} 正規化した時刻（不正時は空文字）
 */
function normalizeTime_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return Utilities.formatDate(value, TZ, 'HH:mm');

  const s = String(value).trim();
  const m = s.match(/^(\d{1,2})[:：](\d{1,2})$/);
  if (!m) return '';

  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return '';

  return pad_(h, 2) + ':' + pad_(mi, 2);
}

/**
 * 'HH:mm' を 0:00 からの経過分に変換する。
 *
 * @param {string} hhmm 時刻
 * @return {number} 経過分（不正時は NaN）
 */
function minutesOfDay_(hhmm) {
  const m = String(hhmm || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 離陸時刻と着陸時刻から飛行時間（分）を求める。
 * 着陸が離陸より前の場合は日をまたいだとみなし +24時間する。
 *
 * @param {string} takeoff 'HH:mm'
 * @param {string} landing 'HH:mm'
 * @return {number} 飛行時間（分）。計算不能時は NaN
 */
function minutesBetween_(takeoff, landing) {
  const a = minutesOfDay_(takeoff);
  const b = minutesOfDay_(landing);
  if (isNaN(a) || isNaN(b)) return NaN;
  let diff = b - a;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

/**
 * 分を「1時間23分」形式へ変換する。
 *
 * @param {number} minutes 分
 * @return {string} 表示用文字列
 */
function formatDuration_(minutes) {
  const m = Math.max(0, Math.round(toNumber_(minutes, 0)));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return rest + '分';
  return h + '時間' + (rest ? rest + '分' : '');
}

/**
 * カンマ・読点・スラッシュ区切りの文字列を配列にする。
 *
 * @param {string} text 入力文字列
 * @return {Array<string>} 区分の配列
 */
function splitFlags_(text) {
  const s = trim_(text);
  if (!s) return [];
  return s.split(/[、,／\/]/).map(function (v) { return v.trim(); })
    .filter(function (v) { return v !== ''; });
}

/**
 * 任意の数値項目を検証して返す（未入力は null）。
 *
 * @param {*} value 入力値
 * @param {number} min 下限
 * @param {number} max 上限
 * @param {string} label エラーメッセージ用の項目名
 * @return {number|null} 検証済みの数値
 */
function optionalNumber_(value, min, max, label) {
  const s = trim_(value);
  if (s === '') return null;
  const n = Number(s);
  if (isNaN(n)) throw new Error(label + 'は数値で入力してください。');
  if (n < min || n > max) {
    throw new Error(label + 'は ' + min + ' 〜 ' + max + ' の範囲で入力してください。');
  }
  return n;
}

// =========================================================================
// 機体マスタ（m_drones）
// =========================================================================

/**
 * 機体ごとの飛行時間の集計コンテキストを作る。
 * - totals: 機体ID → 累計飛行時間（分）
 * - since : 機体ID → 直近の「20時間定期点検 / 修理」以降の飛行時間（分）
 * - last  : 機体ID → 直近の点検（日付とID）
 *
 * 判定基準について:
 *   法定点検は「前回の20時間点検からの飛行時間」で管理するのが実務的だが、
 *   点検記録が無い機体は累計飛行時間で判定する。どちらも画面に表示する。
 *
 * @return {Object} 集計コンテキスト
 */
function buildDroneContext_() {
  const flights = readTable_(SHEET.FLIGHTS);
  const inspections = readTable_(SHEET.INSPECTIONS);

  const totals = {};
  const since = {};
  const last = {};

  flights.forEach(function (f) {
    const id = trim_(f.droneId);
    if (!id) return;
    totals[id] = (totals[id] || 0) + toNumber_(f.durationMin, 0);
  });

  inspections.forEach(function (i) {
    const type = trim_(i.type);
    if (type !== '20時間定期点検' && type !== '修理') return;
    const id = trim_(i.droneId);
    if (!id) return;
    const date = trim_(i.inspectionDate);
    if (!last[id] || date > last[id].date) {
      last[id] = { date: date, inspectionId: trim_(i.inspectionId) };
    }
  });

  Object.keys(last).forEach(function (id) {
    since[id] = 0;
  });
  flights.forEach(function (f) {
    const id = trim_(f.droneId);
    if (!id || !last[id]) return;
    // 点検実施日「より後」の飛行をカウントする（点検当日の飛行は点検前の
    // 20時間に含まれるため二重計上しない）
    if (trim_(f.flightDate) > last[id].date) {
      since[id] = (since[id] || 0) + toNumber_(f.durationMin, 0);
    }
  });

  return { totals: totals, since: since, last: last };
}

/**
 * 機体マスタを、飛行時間の集計値・点検アラート状態を付けて返す。
 *
 * @return {Array<Object>} 機体一覧
 */
function getDrones() {
  const rows = readTable_(SHEET.DRONES);
  const ctx = buildDroneContext_();
  return rows.map(function (row) {
    return decorateDrone_(row, ctx);
  });
}

/**
 * 機体1件に集計値とアラート情報を付与する。
 *
 * @param {Object} row シート行
 * @param {Object} ctx buildDroneContext_ の結果
 * @return {Object} 画面表示用の機体情報
 */
function decorateDrone_(row, ctx) {
  const droneId = trim_(row.droneId);
  const totalMinutes = toNumber_(ctx.totals[droneId], 0);
  const periodic = ctx.last[droneId] || null;
  const minutesSinceInspection = periodic ? toNumber_(ctx.since[droneId], 0) : totalMinutes;
  const basisMinutes = periodic ? minutesSinceInspection : totalMinutes;

  const level = basisMinutes >= INSPECTION_LIMIT_MINUTES
    ? 'over'
    : basisMinutes >= INSPECTION_WARN_MINUTES ? 'warn' : 'ok';

  return {
    droneId: droneId,
    modelName: trim_(row.modelName),
    maker: trim_(row.maker),
    weightG: toNumber_(row.weightG, 0),
    registrationNo: trim_(row.registrationNo),
    serialNo: trim_(row.serialNo),
    note: trim_(row.note),
    totalMinutes: totalMinutes,
    totalHours: Math.round(totalMinutes / 6) / 10,
    basisMinutes: basisMinutes,
    basisHours: Math.round(basisMinutes / 6) / 10,
    basisLabel: periodic ? '前回の20時間点検以降' : '累計飛行時間',
    minutesSinceInspection: minutesSinceInspection,
    lastInspectionDate: periodic ? periodic.date : '',
    lastInspectionId: periodic ? periodic.inspectionId : '',
    remainingMinutes: Math.max(0, INSPECTION_LIMIT_MINUTES - basisMinutes),
    limitMinutes: INSPECTION_LIMIT_MINUTES,
    warnMinutes: INSPECTION_WARN_MINUTES,
    progress: Math.min(100, Math.round((basisMinutes / INSPECTION_LIMIT_MINUTES) * 100)),
    level: level,
    needsInspection: level !== 'ok'
  };
}

/**
 * 機体を新規登録または更新する。
 *
 * @param {Object} payload 機体情報（droneId があれば更新）
 * @return {Object} 実行結果
 */
function saveDrone(payload) {
  const p = payload || {};
  const modelName = trim_(p.modelName);
  if (!modelName) throw new Error('機種名を入力してください。');

  const weightG = toNumber_(p.weightG, 0);
  if (weightG < 0 || weightG > 1000000) {
    throw new Error('重量(g)は 0 〜 1,000,000 の範囲で入力してください。');
  }

  const registrationNo = trim_(p.registrationNo).toUpperCase();
  const serialNo = trim_(p.serialNo);
  const maker = trim_(p.maker);
  const note = trim_(p.note);
  const droneId = trim_(p.droneId);

  return withLock_(function () {
    const sheet = getSheet_(SHEET.DRONES);
    const rows = readTable_(SHEET.DRONES);
    const warnings = [];

    if (registrationNo && !/^JU[0-9A-Z]{10}$/.test(registrationNo)) {
      warnings.push('機体登録記号は「JU + 英数字10桁」の形式です。入力値を確認してください。');
    }

    if (droneId) {
      const target = rows.filter(function (r) { return trim_(r.droneId) === droneId; })[0];
      if (!target) throw new Error('機体ID「' + droneId + '」が見つかりません。');
      updateRecord_(sheet, target._row, SHEET.DRONES, {
        droneId: droneId,
        modelName: modelName,
        maker: maker,
        weightG: weightG,
        registrationNo: registrationNo,
        serialNo: serialNo,
        totalMinutes: toNumber_(target.totalMinutes, 0),
        note: note
      });
      return {
        ok: true,
        created: false,
        droneId: droneId,
        warnings: warnings,
        message: '機体情報を更新しました（' + droneId + '）。'
      };
    }

    const duplicate = rows.filter(function (r) {
      if (serialNo && trim_(r.serialNo) === serialNo) return true;
      return registrationNo !== '' && trim_(r.registrationNo) === registrationNo;
    })[0];
    if (duplicate) {
      throw new Error(
        '同じ製造番号または機体登録記号の機体が登録済みです（' + trim_(duplicate.droneId) + '）。'
      );
    }

    const newId = nextId_(sheet, SHEET.DRONES, 'DRN-');
    appendRecord_(sheet, SHEET.DRONES, {
      droneId: newId,
      modelName: modelName,
      maker: maker,
      weightG: weightG,
      registrationNo: registrationNo,
      serialNo: serialNo,
      totalMinutes: 0,
      note: note
    });

    return {
      ok: true,
      created: true,
      droneId: newId,
      warnings: warnings,
      message: '機体を登録しました（' + newId + '）。'
    };
  });
}

// =========================================================================
// 操縦者マスタ（m_pilots）
// =========================================================================

/**
 * 操縦者一覧を、飛行回数を付けて返す。
 *
 * @return {Array<Object>} 操縦者一覧
 */
function getPilots() {
  const rows = readTable_(SHEET.PILOTS);
  const counts = {};
  readTable_(SHEET.FLIGHTS).forEach(function (f) {
    const id = trim_(f.pilotId);
    if (id) counts[id] = (counts[id] || 0) + 1;
  });
  return rows.map(function (r) {
    const pilotId = trim_(r.pilotId);
    return {
      pilotId: pilotId,
      name: trim_(r.name),
      licenseNo: trim_(r.licenseNo),
      contact: trim_(r.contact),
      flightCount: counts[pilotId] || 0
    };
  });
}

/**
 * 操縦者を新規登録または更新する。
 *
 * @param {Object} payload 操縦者情報（pilotId があれば更新）
 * @return {Object} 実行結果
 */
function savePilot(payload) {
  const p = payload || {};
  const name = trim_(p.name);
  if (!name) throw new Error('氏名を入力してください。');

  const licenseNo = trim_(p.licenseNo).toUpperCase();
  const contact = trim_(p.contact);
  const pilotId = trim_(p.pilotId);

  return withLock_(function () {
    const sheet = getSheet_(SHEET.PILOTS);
    const rows = readTable_(SHEET.PILOTS);
    const warnings = [];

    if (!licenseNo) {
      warnings.push('技能証明書番号が未入力です。様式1の記載事項のため、入力をおすすめします。');
    }

    const duplicate = rows.filter(function (r) {
      if (trim_(r.pilotId) === pilotId) return false;
      return licenseNo !== '' && trim_(r.licenseNo).toUpperCase() === licenseNo;
    })[0];
    if (duplicate) {
      throw new Error(
        '同じ技能証明書番号の操縦者が登録済みです（' + trim_(duplicate.pilotId) + '）。'
      );
    }

    if (pilotId) {
      const target = rows.filter(function (r) { return trim_(r.pilotId) === pilotId; })[0];
      if (!target) throw new Error('操縦者ID「' + pilotId + '」が見つかりません。');
      updateRecord_(sheet, target._row, SHEET.PILOTS, {
        pilotId: pilotId,
        name: name,
        licenseNo: licenseNo,
        contact: contact
      });
      return {
        ok: true,
        created: false,
        pilotId: pilotId,
        warnings: warnings,
        message: '操縦者情報を更新しました（' + pilotId + '）。'
      };
    }

    const newId = nextId_(sheet, SHEET.PILOTS, 'PLT-');
    appendRecord_(sheet, SHEET.PILOTS, {
      pilotId: newId,
      name: name,
      licenseNo: licenseNo,
      contact: contact
    });
    return {
      ok: true,
      created: true,
      pilotId: newId,
      warnings: warnings,
      message: '操縦者を登録しました（' + newId + '）。'
    };
  });
}

// =========================================================================
// 飛行記録（t_flights）
// =========================================================================

/**
 * 入力値を検証して、シートへ書き込める形に正規化する。
 *
 * @param {Object} input 画面から渡された飛行情報
 * @return {Object} 正規化済みの飛行情報
 */
function normalizeFlight_(input) {
  const f = input || {};

  const flightDate = normalizeDate_(f.date);
  if (!flightDate) throw new Error('飛行年月日を入力してください（YYYY-MM-DD）。');

  const pilotId = trim_(f.pilotId);
  if (!pilotId) throw new Error('操縦者を選択してください。');

  const droneId = trim_(f.droneId);
  if (!droneId) throw new Error('機体を選択してください。');

  const takeoffPlace = trim_(f.takeoffPlace);
  if (!takeoffPlace) throw new Error('離陸場所を入力してください。');

  const landingPlace = trim_(f.landingPlace) || takeoffPlace;

  const takeoffTime = normalizeTime_(f.takeoffTime);
  if (!takeoffTime) throw new Error('離陸時刻を入力してください（例: 09:30）。');

  const landingTime = normalizeTime_(f.landingTime);
  if (!landingTime) throw new Error('着陸時刻を入力してください（例: 10:15）。');

  let durationMin;
  if (trim_(f.durationMin) === '') {
    durationMin = minutesBetween_(takeoffTime, landingTime);
  } else {
    durationMin = Math.round(toNumber_(f.durationMin, 0));
  }
  if (isNaN(durationMin) || durationMin <= 0) {
    throw new Error('飛行時間を計算できませんでした。離着陸時刻を確認してください。');
  }
  if (durationMin > 24 * 60) {
    throw new Error('飛行時間は24時間以内で入力してください。');
  }

  const lat = optionalNumber_(f.lat, -90, 90, '緯度');
  const lng = optionalNumber_(f.lng, -180, 180, '経度');

  // 特定飛行区分: 既知の10項目へ正規化する（旧表記・キー入力も受け付ける）。
  // 未選択なら「非特定飛行」とみなす。他の区分と併用された場合は他の区分を優先。
  let flags = specificFlagLabels_(f.specificFlags);
  if (flags.length === 0) flags = ['非特定飛行'];
  if (flags.length > 1) {
    flags = flags.filter(function (v) { return v !== '非特定飛行'; });
  }

  // 立入管理措置（第三者の立入りを制限する措置）: 明示的に「なし」の場合のみ false。
  // 未指定は「講じる」を既定とする（カテゴリーⅡB/ⅡA の判定に使用）。
  const hasClearZone = !(
    f.hasClearZone === false ||
    trim_(f.hasClearZone) === 'なし' ||
    trim_(f.hasClearZone) === 'false'
  );

  // 安全影響事象: なし / あり＋詳細
  const safety = f.safetyEvent || {};
  const hasEvent = safety.hasEvent === true || safety.hasEvent === 'true';
  let safetyEvent = 'なし';
  if (hasEvent) {
    const detail = trim_(safety.detail);
    if (!detail) throw new Error('安全に影響のあった事項の内容を入力してください。');
    safetyEvent = 'あり：' + detail;
  }

  const purpose = trim_(f.purpose) || 'その他';

  return {
    flightDate: flightDate,
    pilotId: pilotId,
    droneId: droneId,
    takeoffPlace: takeoffPlace,
    landingPlace: landingPlace,
    lat: lat === null ? '' : lat,
    lng: lng === null ? '' : lng,
    takeoffTime: takeoffTime,
    landingTime: landingTime,
    durationMin: durationMin,
    specificFlags: flags.join('、'),
    hasClearZone: hasClearZone,
    safetyEvent: safetyEvent,
    purpose: purpose
  };
}

// =========================================================================
// 特定飛行カテゴリー判定（Ⅰ / ⅡA / ⅡB / Ⅲ）
// =========================================================================

/**
 * 特定飛行区分の入力値（ラベル・キー・カンマ区切り文字列のいずれか）を
 * SPECIFIC_FLIGHT_DEFS のキー配列へ正規化する。未知の値は無視する。
 *
 * @param {Array<string>|string} values 入力値
 * @return {Array<string>} キー配列
 */
function specificFlagKeys_(values) {
  const list = Array.isArray(values) ? values : splitFlags_(values);
  const keys = [];
  list.forEach(function (value) {
    const v = trim_(value);
    if (!v) return;
    const def = SPECIFIC_FLIGHT_DEFS.filter(function (d) {
      return d.key === v || d.label === v || d.uiLabel === v;
    })[0];
    if (def && keys.indexOf(def.key) === -1) keys.push(def.key);
  });
  return keys;
}

/**
 * 特定飛行区分の入力値をシート保存用のラベル配列へ正規化する。
 *
 * @param {Array<string>|string} values 入力値
 * @return {Array<string>} 保存ラベルの配列
 */
function specificFlagLabels_(values) {
  return specificFlagKeys_(values).map(function (key) {
    const def = SPECIFIC_FLIGHT_DEFS.filter(function (d) { return d.key === key; })[0];
    return def ? def.label : key;
  });
}

/** キーから保存ラベルを引く（未知はそのまま返す） */
function specificFlagLabelOf_(key) {
  const def = SPECIFIC_FLIGHT_DEFS.filter(function (d) { return d.key === key; })[0];
  return def ? def.label : key;
}

/**
 * 特定飛行の10項目・機体重量・立入管理措置から飛行カテゴリーを判定する。
 * -------------------------------------------------------------------------
 * Ⅰ   : 該当項目なし（非特定飛行）
 * Ⅲ   : 該当あり ＋ 立入管理措置なし
 * ⅡA  : 該当あり ＋ 立入管理措置あり ＋ (hard項目あり or 25kg以上)
 * ⅡB  : 該当あり ＋ 立入管理措置あり ＋ 25kg未満 ＋ soft項目のみ
 *
 * @param {Array<string>|string} flagValues 特定飛行区分（ラベル/キー）
 * @param {number} weightG 機体重量(g)。未選択・不明は 0（25kg未満）扱い
 * @param {boolean} hasClearZone 立入管理措置を講じるか（既定 true）
 * @return {Object} 判定結果
 */
function judgeCategory_(flagValues, weightG, hasClearZone) {
  const keys = specificFlagKeys_(flagValues);
  const weight = toNumber_(weightG, 0);
  const clear = !(hasClearZone === false || trim_(hasClearZone) === 'なし' || trim_(hasClearZone) === 'false');

  let category = 'I';
  if (keys.length > 0) {
    if (!clear) {
      category = 'III';
    } else if (keys.some(function (k) { return HARD_SPECIFIC_FLAG_KEYS.indexOf(k) !== -1; })) {
      category = 'IIA';
    } else if (weight >= CATEGORY_WEIGHT_BOUNDARY_G) {
      category = 'IIA';
    } else {
      category = 'IIB';
    }
  }

  const meta = CATEGORY_META[category];

  // 判定理由（画面表示用）
  const reasons = keys.map(specificFlagLabelOf_);
  if (keys.length > 0) {
    if (!clear) reasons.push('立入管理措置なし');
    if (weight >= CATEGORY_WEIGHT_BOUNDARY_G) reasons.push('機体重量25kg以上');
  }

  return {
    category: category,
    label: meta.label,
    level: meta.level,
    summary: meta.summary,
    procedures: CATEGORY_PROCEDURES[category].slice(),
    reasons: reasons,
    flags: keys,
    flagLabels: keys.map(specificFlagLabelOf_),
    weightG: weight,
    weightLabel: weight >= CATEGORY_WEIGHT_BOUNDARY_G ? '25kg以上' : '25kg未満',
    hasClearZone: clear
  };
}

/**
 * 画面から呼び出すカテゴリー判定API。
 *
 * @param {Object} input { flags|specificFlags, weightG, hasClearZone }
 * @return {Object} 判定結果（ok 付き）
 */
function judgeFlightCategory(input) {
  const p = input || {};
  const result = judgeCategory_(
    p.flags || p.specificFlags || [],
    p.weightG,
    p.hasClearZone
  );
  return {
    ok: true,
    category: result.category,
    label: result.label,
    level: result.level,
    summary: result.summary,
    procedures: result.procedures,
    reasons: result.reasons,
    flags: result.flags,
    flagLabels: result.flagLabels,
    weightG: result.weightG,
    weightLabel: result.weightLabel,
    hasClearZone: result.hasClearZone
  };
}

/**
 * 日常点検（13項目）の全項目名を返す。
 *
 * @return {Array<string>} 項目名の配列
 */
function allInspectionItems_() {
  const items = [];
  INSPECTION_GROUPS.forEach(function (group) {
    group.items.forEach(function (name) { items.push(name); });
  });
  return items;
}

/**
 * 点検情報を検証して正規化する。
 *
 * @param {Object} input 画面から渡された点検情報
 * @param {Object} [opts] 既定値（defaultDate / defaultInspector）
 * @return {Object} 正規化済みの点検情報
 */
function normalizeInspection_(input, opts) {
  const o = opts || {};
  const i = input || {};

  const type = trim_(i.type);
  if (INSPECTION_TYPES.indexOf(type) === -1) {
    throw new Error('点検種別が不正です（' + INSPECTION_TYPES.join(' / ') + '）。');
  }

  const inspectionDate = normalizeDate_(i.date) || normalizeDate_(o.defaultDate);
  if (!inspectionDate) throw new Error('点検実施日を入力してください。');

  const inspector = trim_(i.inspector) || trim_(o.defaultInspector);
  if (!inspector) throw new Error('点検の実施者を入力してください。');

  const rawItems = i.items || {};
  const items = {};
  allInspectionItems_().forEach(function (name) {
    const v = trim_(rawItems[name]).toUpperCase();
    if (v === 'OK' || v === 'NG') items[name] = v;
  });

  const isDaily = type === '飛行前' || type === '飛行後';
  let result = trim_(i.result);

  if (isDaily) {
    const missing = allInspectionItems_().filter(function (name) { return !items[name]; });
    if (missing.length) {
      throw new Error('未入力の点検項目があります: ' + missing.join('、'));
    }
    result = allInspectionItems_().some(function (name) { return items[name] === 'NG'; })
      ? '異常あり'
      : '合格';
  } else if (INSPECTION_RESULTS.indexOf(result) === -1) {
    throw new Error('点検結果（合格 / 異常あり）を選択してください。');
  }

  return {
    type: type,
    inspectionDate: inspectionDate,
    inspector: inspector,
    result: result,
    memo: trim_(i.memo),
    itemsJson: JSON.stringify(items)
  };
}

/**
 * 飛行記録と日常点検を「1トランザクション」として保存する。
 * - 飛行記録を追記
 * - 点検情報が渡された場合は点検記録も追記（同じロック内）
 * - 機体の累計飛行時間を再計算して m_drones に反映
 *
 * @param {Object} payload { flight: Object, inspection: Object|null }
 * @return {Object} 保存結果（flightId / inspectionId / 機体の最新状態）
 */
function saveFlightRecord(payload) {
  const p = payload || {};
  const flight = normalizeFlight_(p.flight || p);

  const inspectionInput = p.inspection || null;
  const inspection = inspectionInput
    ? normalizeInspection_(inspectionInput, { defaultDate: flight.flightDate })
    : null;

  return withLock_(function () {
    const drones = readTable_(SHEET.DRONES);
    const drone = drones.filter(function (d) {
      return trim_(d.droneId) === flight.droneId;
    })[0];
    if (!drone) {
      throw new Error('機体ID「' + flight.droneId + '」がマスタに登録されていません。');
    }

    const pilots = readTable_(SHEET.PILOTS);
    const pilot = pilots.filter(function (pl) {
      return trim_(pl.pilotId) === flight.pilotId;
    })[0];
    if (!pilot) {
      throw new Error('操縦者ID「' + flight.pilotId + '」がマスタに登録されていません。');
    }

    const createdAt = nowStamp_();

    // カテゴリーは機体重量に依存するため、機体マスタを引いた後に確定する
    const category = judgeCategory_(flight.specificFlags, drone.weightG, flight.hasClearZone);

    const flightSheet = getSheet_(SHEET.FLIGHTS);
    const flightId = nextId_(flightSheet, SHEET.FLIGHTS, 'FLT-');
    appendRecord_(flightSheet, SHEET.FLIGHTS, {
      flightId: flightId,
      flightDate: flight.flightDate,
      pilotId: flight.pilotId,
      droneId: flight.droneId,
      takeoffPlace: flight.takeoffPlace,
      landingPlace: flight.landingPlace,
      lat: flight.lat,
      lng: flight.lng,
      takeoffTime: flight.takeoffTime,
      landingTime: flight.landingTime,
      durationMin: flight.durationMin,
      specificFlags: flight.specificFlags,
      hasClearZone: flight.hasClearZone ? 'あり' : 'なし',
      category: category.label,
      safetyEvent: flight.safetyEvent,
      purpose: flight.purpose,
      createdAt: createdAt
    });

    let inspectionId = '';
    if (inspection) {
      const inspectionSheet = getSheet_(SHEET.INSPECTIONS);
      inspectionId = nextId_(inspectionSheet, SHEET.INSPECTIONS, 'INS-');
      appendRecord_(inspectionSheet, SHEET.INSPECTIONS, {
        inspectionId: inspectionId,
        flightId: flightId,
        droneId: flight.droneId,
        type: inspection.type,
        inspectionDate: inspection.inspectionDate,
        inspector: inspection.inspector,
        result: inspection.result,
        memo: inspection.memo,
        itemsJson: inspection.itemsJson,
        createdAt: createdAt
      });
    }

    const totalMinutes = recalcDroneTotal_(flight.droneId);
    const droneView = getDrones().filter(function (d) {
      return d.droneId === flight.droneId;
    })[0] || null;

    const messages = ['飛行記録を保存しました（' + flightId + '）。'];
    if (inspectionId) messages.push('点検記録も保存しました（' + inspectionId + '）。');
    if (inspection && inspection.result === '異常あり') {
      messages.push('点検で異常が記録されています。飛行の可否を確認してください。');
    }

    return {
      ok: true,
      flightId: flightId,
      inspectionId: inspectionId,
      inspectionResult: inspection ? inspection.result : '',
      durationMin: flight.durationMin,
      cumulativeMinutes: totalMinutes,
      specificFlags: flight.specificFlags,
      hasClearZone: flight.hasClearZone,
      category: category.label,
      categoryLevel: category.level,
      categorySummary: category.summary,
      categoryProcedures: category.procedures,
      drone: droneView,
      message: messages.join(' ')
    };
  });
}

/**
 * 飛行記録に紐づかない点検（20時間定期点検・修理）を保存する。
 *
 * @param {Object} payload 点検情報（droneId / type / date / inspector / result / memo）
 * @return {Object} 保存結果
 */
function saveInspection(payload) {
  const p = payload || {};
  const droneId = trim_(p.droneId);
  if (!droneId) throw new Error('機体を選択してください。');

  const type = trim_(p.type);
  if (type === '飛行前' || type === '飛行後') {
    throw new Error('日常点検（飛行前・飛行後）は、飛行記録と一緒に保存してください。');
  }

  const inspection = normalizeInspection_(
    { type: type, date: p.date, inspector: p.inspector, result: p.result, memo: p.memo, items: p.items },
    { defaultDate: today_() }
  );

  return withLock_(function () {
    const drones = readTable_(SHEET.DRONES);
    if (!drones.some(function (d) { return trim_(d.droneId) === droneId; })) {
      throw new Error('機体ID「' + droneId + '」がマスタに登録されていません。');
    }

    const flightId = trim_(p.flightId);
    if (flightId) {
      const exists = readTable_(SHEET.FLIGHTS).some(function (f) {
        return trim_(f.flightId) === flightId;
      });
      if (!exists) throw new Error('飛行ID「' + flightId + '」が見つかりません。');
    }

    const sheet = getSheet_(SHEET.INSPECTIONS);
    const inspectionId = nextId_(sheet, SHEET.INSPECTIONS, 'INS-');
    appendRecord_(sheet, SHEET.INSPECTIONS, {
      inspectionId: inspectionId,
      flightId: flightId,
      droneId: droneId,
      type: inspection.type,
      inspectionDate: inspection.inspectionDate,
      inspector: inspection.inspector,
      result: inspection.result,
      memo: inspection.memo,
      itemsJson: inspection.itemsJson,
      createdAt: nowStamp_()
    });

    const droneView = getDrones().filter(function (d) {
      return d.droneId === droneId;
    })[0] || null;

    return {
      ok: true,
      inspectionId: inspectionId,
      drone: droneView,
      message: '点検記録を保存しました（' + inspectionId + '）。'
    };
  });
}

/**
 * 機体1台の累計飛行時間を t_flights から再計算し、m_drones に書き戻す。
 * 呼び出し側は withLock_ の中で使うこと。
 *
 * @param {string} droneId 機体ID
 * @return {number} 再計算後の累計飛行時間（分）
 */
function recalcDroneTotal_(droneId) {
  const id = trim_(droneId);
  let total = 0;
  readTable_(SHEET.FLIGHTS).forEach(function (f) {
    if (trim_(f.droneId) === id) total += toNumber_(f.durationMin, 0);
  });

  const sheet = getSheet_(SHEET.DRONES);
  const rows = readTable_(SHEET.DRONES);
  const target = rows.filter(function (r) { return trim_(r.droneId) === id; })[0];

  if (target) {
    const headerMap = getHeaderMap_(sheet);
    const def = SCHEMA[SHEET.DRONES].filter(function (d) { return d.key === 'totalMinutes'; })[0];
    const idx = headerMap[def.header];
    if (idx !== undefined) {
      sheet.getRange(target._row, idx + 1).setValue(total);
    }
  }
  return total;
}

/**
 * 全機体の累計飛行時間を再計算する（メニューから手動実行できる）。
 *
 * @return {Object} 再計算結果
 */
function recalcDroneTotals() {
  return withLock_(function () {
    const drones = readTable_(SHEET.DRONES);
    const totals = drones.map(function (d) {
      const id = trim_(d.droneId);
      return { droneId: id, totalMinutes: recalcDroneTotal_(id) };
    });
    return {
      ok: true,
      count: totals.length,
      totals: totals,
      message: '機体 ' + totals.length + ' 台の累計飛行時間を再計算しました。'
    };
  });
}

// =========================================================================
// 飛行記録の参照（t_flights + t_inspections の結合）
// =========================================================================

/**
 * JSON 文字列を安全にパースする。
 *
 * @param {string} text JSON 文字列
 * @param {*} fallback 失敗時の値
 * @return {*} パース結果
 */
function parseJson_(text, fallback) {
  const s = trim_(text);
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch (err) {
    return fallback;
  }
}

/**
 * 点検記録1件に機体情報を付けて表示用オブジェクトにする。
 *
 * @param {Object} row t_inspections の行
 * @param {Object} droneMap 機体ID → 機体行
 * @return {Object} 表示用の点検記録
 */
function decorateInspection_(row, droneMap) {
  const drone = droneMap[trim_(row.droneId)] || {};
  return {
    inspectionId: trim_(row.inspectionId),
    flightId: trim_(row.flightId),
    droneId: trim_(row.droneId),
    droneName: trim_(drone.modelName),
    registrationNo: trim_(drone.registrationNo),
    type: trim_(row.type),
    inspectionDate: trim_(row.inspectionDate),
    inspector: trim_(row.inspector),
    result: trim_(row.result),
    memo: trim_(row.memo),
    items: parseJson_(row.itemsJson, {}),
    createdAt: trim_(row.createdAt)
  };
}

/**
 * 飛行記録を全件読み込み、機体・操縦者・点検記録を結合して返す。
 * 並び順は「飛行年月日の新しい順 → 離陸時刻の新しい順」。
 *
 * @param {Object} [filter] from / to / droneId / pilotId / q
 * @return {Array<Object>} 飛行記録の配列
 */
function collectFlights_(filter) {
  const f = filter || {};
  const from = normalizeDate_(f.from) || '';
  const to = normalizeDate_(f.to) || '';
  const droneIdFilter = trim_(f.droneId);
  const pilotIdFilter = trim_(f.pilotId);
  const q = trim_(f.q).toLowerCase();

  const droneMap = {};
  readTable_(SHEET.DRONES).forEach(function (d) {
    droneMap[trim_(d.droneId)] = d;
  });

  const pilotMap = {};
  readTable_(SHEET.PILOTS).forEach(function (p) {
    pilotMap[trim_(p.pilotId)] = p;
  });

  const insByFlight = {};
  readTable_(SHEET.INSPECTIONS).forEach(function (i) {
    const fid = trim_(i.flightId);
    if (!fid) return;
    if (!insByFlight[fid]) insByFlight[fid] = [];
    insByFlight[fid].push(decorateInspection_(i, droneMap));
  });
  Object.keys(insByFlight).forEach(function (key) {
    insByFlight[key].sort(function (a, b) {
      if (a.inspectionDate === b.inspectionDate) {
        return a.inspectionId < b.inspectionId ? -1 : 1;
      }
      return a.inspectionDate < b.inspectionDate ? -1 : 1;
    });
  });

  const items = [];

  readTable_(SHEET.FLIGHTS).forEach(function (row) {
    const flightId = trim_(row.flightId);
    const date = trim_(row.flightDate);
    const drone = droneMap[trim_(row.droneId)] || {};
    const pilot = pilotMap[trim_(row.pilotId)] || {};
    const inspections = insByFlight[flightId] || [];
    const flags = splitFlags_(row.specificFlags);
    const hasClearZone = trim_(row.hasClearZone) !== 'なし';
    const categoryJudge = judgeCategory_(flags, drone.weightG, hasClearZone);
    const categoryLabel = trim_(row.category) || categoryJudge.label;
    const safetyEvent = trim_(row.safetyEvent);
    const droneId = trim_(row.droneId);

    if (from && date < from) return;
    if (to && date > to) return;
    if (droneIdFilter && droneId !== droneIdFilter) return;
    if (pilotIdFilter && trim_(row.pilotId) !== pilotIdFilter) return;

    const item = {
      flightId: flightId,
      date: date,
      yearMonth: date.slice(0, 7),
      pilotId: trim_(row.pilotId),
      pilotName: trim_(pilot.name) || trim_(row.pilotId),
      licenseNo: trim_(pilot.licenseNo),
      droneId: droneId,
      droneName: trim_(drone.modelName) || droneId,
      registrationNo: trim_(drone.registrationNo),
      serialNo: trim_(drone.serialNo),
      takeoffPlace: trim_(row.takeoffPlace),
      landingPlace: trim_(row.landingPlace) || trim_(row.takeoffPlace),
      lat: trim_(row.lat) === '' ? null : toNumber_(row.lat, null),
      lng: trim_(row.lng) === '' ? null : toNumber_(row.lng, null),
      takeoffTime: trim_(row.takeoffTime),
      landingTime: trim_(row.landingTime),
      durationMin: toNumber_(row.durationMin, 0),
      specificFlags: flags,
      hasClearZone: hasClearZone,
      category: categoryLabel,
      categoryLevel: categoryJudge.level,
      safetyEvent: safetyEvent,
      hasSafetyEvent: safetyEvent.indexOf('あり') === 0,
      purpose: trim_(row.purpose),
      createdAt: trim_(row.createdAt),
      inspections: inspections,
      hasAbnormalInspection: inspections.some(function (i) { return i.result === '異常あり'; })
    };
    item.durationLabel = formatDuration_(item.durationMin);

    if (q) {
      const hay = [
        item.flightId, item.droneName, item.registrationNo, item.pilotName,
        item.takeoffPlace, item.landingPlace, item.purpose,
        item.specificFlags.join(' '), item.category, item.safetyEvent
      ].join(' ').toLowerCase();
      if (hay.indexOf(q) === -1) return;
    }

    items.push(item);
  });

  items.sort(function (a, b) {
    const ka = a.date + ' ' + a.takeoffTime + ' ' + a.flightId;
    const kb = b.date + ' ' + b.takeoffTime + ' ' + b.flightId;
    if (ka === kb) return 0;
    return ka < kb ? 1 : -1;
  });

  return items;
}

/**
 * 飛行記録をページングして返す（一覧表示用）。
 *
 * @param {Object} [filter] from / to / droneId / pilotId / q / limit / offset
 * @return {Object} 一覧と集計
 */
function getFlights(filter) {
  const f = filter || {};
  const all = collectFlights_(f);
  const limit = clamp_(toNumber_(f.limit, 50), 1, 500);
  const offset = Math.max(0, toNumber_(f.offset, 0));
  const items = all.slice(offset, offset + limit);

  let totalMinutes = 0;
  all.forEach(function (i) { totalMinutes += i.durationMin; });

  return {
    ok: true,
    total: all.length,
    limit: limit,
    offset: offset,
    hasMore: offset + limit < all.length,
    totalMinutes: totalMinutes,
    items: items
  };
}

/**
 * 点検記録を返す（飛行に紐づかない定期点検・修理も含む）。
 *
 * @param {Object} [filter] from / to / droneId / type / limit
 * @return {Object} 点検記録一覧
 */
function getInspections(filter) {
  const f = filter || {};
  const from = normalizeDate_(f.from) || '';
  const to = normalizeDate_(f.to) || '';
  const droneIdFilter = trim_(f.droneId);
  const typeFilter = trim_(f.type);

  const droneMap = {};
  readTable_(SHEET.DRONES).forEach(function (d) {
    droneMap[trim_(d.droneId)] = d;
  });

  const items = [];
  readTable_(SHEET.INSPECTIONS).forEach(function (row) {
    const item = decorateInspection_(row, droneMap);
    if (from && item.inspectionDate < from) return;
    if (to && item.inspectionDate > to) return;
    if (droneIdFilter && item.droneId !== droneIdFilter) return;
    if (typeFilter && item.type !== typeFilter) return;
    items.push(item);
  });

  items.sort(function (a, b) {
    const ka = a.inspectionDate + ' ' + a.createdAt + ' ' + a.inspectionId;
    const kb = b.inspectionDate + ' ' + b.createdAt + ' ' + b.inspectionId;
    if (ka === kb) return 0;
    return ka < kb ? 1 : -1;
  });

  const limit = clamp_(toNumber_(f.limit, 100), 1, 1000);
  return {
    ok: true,
    total: items.length,
    limit: limit,
    items: items.slice(0, limit)
  };
}

/**
 * 画面の選択肢・定数をまとめて返す。
 * フロントとバックエンドで選択肢が二重管理にならないようサーバーを正とする。
 *
 * @return {Object} マスタ定数
 */
function getCatalog_() {
  return {
    specificOptions: SPECIFIC_FLIGHT_OPTIONS,
    specificFlagDefs: SPECIFIC_FLIGHT_DEFS,
    specificFlagGroups: SPECIFIC_FLIGHT_GROUPS,
    categoryMeta: CATEGORY_META,
    categoryProcedures: CATEGORY_PROCEDURES,
    purposes: FLIGHT_PURPOSES,
    inspectionGroups: INSPECTION_GROUPS,
    inspectionTypes: INSPECTION_TYPES,
    inspectionResults: INSPECTION_RESULTS,
    limitMinutes: INSPECTION_LIMIT_MINUTES,
    warnMinutes: INSPECTION_WARN_MINUTES
  };
}

/**
 * 画面の選択肢・定数を返す公開ラッパー（外部 API の getCatalog action 用）。
 *
 * @return {Object} マスタ定数
 */
function getCatalog() {
  return getCatalog_();
}

/**
 * 初回描画に必要なデータを1回の呼び出しでまとめて返す。
 * モバイル回線での往復回数を減らすための設計。
 *
 * @return {Object} 機体・操縦者・直近の飛行/点検・統計・選択肢
 */
function getBootstrapData() {
  const drones = getDrones();
  const pilots = getPilots();
  const allFlights = collectFlights_({});

  const monthPrefix = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  let totalMinutes = 0;
  let monthMinutes = 0;
  let monthFlights = 0;
  let safetyEventCount = 0;

  allFlights.forEach(function (f) {
    totalMinutes += f.durationMin;
    if (f.yearMonth === monthPrefix) {
      monthFlights += 1;
      monthMinutes += f.durationMin;
    }
    if (f.hasSafetyEvent) safetyEventCount += 1;
  });

  let spreadsheetUrl = '';
  try {
    spreadsheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();
  } catch (err) {
    spreadsheetUrl = '';
  }

  return {
    ok: true,
    version: APP_VERSION,
    now: nowStamp_(),
    today: today_(),
    monthPrefix: monthPrefix,
    spreadsheetUrl: spreadsheetUrl,
    drones: drones,
    pilots: pilots,
    flights: allFlights.slice(0, 100),
    flightTotal: allFlights.length,
    inspections: getInspections({ limit: 300 }).items,
    stats: {
      totalFlights: allFlights.length,
      totalMinutes: totalMinutes,
      totalHours: Math.round(totalMinutes / 6) / 10,
      monthFlights: monthFlights,
      monthMinutes: monthMinutes,
      monthHours: Math.round(monthMinutes / 6) / 10,
      safetyEventCount: safetyEventCount,
      alertDrones: drones.filter(function (d) { return d.needsInspection; }).length
    },
    catalog: getCatalog_()
  };
}

// =========================================================================
// CSV 出力（国交省 様式1 / 様式2・3 準拠）
// =========================================================================

/**
 * CSV ファイル名を組み立てる（日本語を避けて文字化けを防ぐ）。
 *
 * @param {string} prefix 接頭辞
 * @param {string} from 開始日（YYYY-MM-DD）
 * @param {string} to 終了日（YYYY-MM-DD）
 * @return {string} ファイル名
 */
function buildCsvFileName_(prefix, from, to) {
  const f = String(from || '').replace(/-/g, '');
  const t = String(to || '').replace(/-/g, '');
  const today = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  if (f && t) return prefix + '_' + f + '-' + t + '.csv';
  if (f || t) return prefix + '_' + (f || t) + '-' + today + '.csv';
  return prefix + '_' + today + '.csv';
}

/**
 * CSV のセルをエスケープする。
 * - 全セルをダブルクォートで囲む
 * - 改行は LF に正規化
 * - Excel の数式インジェクションを防ぐ（= + @ と、数値でない - の先頭）
 *
 * @param {*} value 値
 * @return {string} エスケープ済みセル
 */
function csvCell_(value) {
  let s = value === null || value === undefined ? '' : String(value);
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/^[=+@\t]/.test(s) || /^-(?![\d.])/.test(s)) {
    s = "'" + s;
  }
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * 見出し行とデータ行から CSV 文字列を作る。
 * Excel（日本語環境）で文字化けしないよう BOM を付け、CRLF で改行する。
 *
 * @param {Array<string>} headers 見出し
 * @param {Array<Array<*>>} rows データ行
 * @return {string} CSV 文字列
 */
function buildCsv_(headers, rows) {
  const lines = [headers.map(csvCell_).join(',')];
  rows.forEach(function (row) {
    lines.push(row.map(csvCell_).join(','));
  });
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/**
 * 飛行記録の昇順比較（CSV は時系列で出力する）。
 *
 * @param {Object} a 飛行記録
 * @param {Object} b 飛行記録
 * @return {number} 比較結果
 */
function compareFlightAsc_(a, b) {
  const ka = a.date + ' ' + a.takeoffTime + ' ' + a.flightId;
  const kb = b.date + ' ' + b.takeoffTime + ' ' + b.flightId;
  if (ka === kb) return 0;
  return ka < kb ? -1 : 1;
}

/**
 * 国交省 様式1「飛行記録」準拠の CSV を生成する。
 *
 * 総飛行時間(分) は「その機体の全飛行記録を時系列に積み上げた値」であり、
 * 絞り込み期間より前の飛行も含めて計算する（様式1の記載要件）。
 *
 * @param {Object} [options] from / to / droneId / pilotId
 * @return {Object} CSV 文字列・件数・列定義
 */
function buildDipsCsv(options) {
  const o = options || {};

  // 累計はフィルタ前の全件で積み上げる
  const allFlights = collectFlights_({}).slice().sort(compareFlightAsc_);
  const cumulativeByFlight = {};
  const running = {};
  allFlights.forEach(function (f) {
    const key = f.droneId || '(未設定)';
    running[key] = (running[key] || 0) + f.durationMin;
    cumulativeByFlight[f.flightId] = running[key];
  });

  const flights = collectFlights_({
    from: o.from,
    to: o.to,
    droneId: o.droneId,
    pilotId: o.pilotId
  }).slice().sort(compareFlightAsc_);

  let totalMinutes = 0;
  const rows = flights.map(function (f) {
    totalMinutes += f.durationMin;
    const merged = {};
    Object.keys(f).forEach(function (k) { merged[k] = f[k]; });
    merged.cumulativeMinutes = cumulativeByFlight[f.flightId] || f.durationMin;
    return DIPS_FLIGHT_COLUMNS.map(function (col) { return col.value(merged); });
  });

  const headers = DIPS_FLIGHT_COLUMNS.map(function (col) { return col.header; });

  return {
    ok: true,
    format: 'dips-shikou-kiroku-1',
    count: rows.length,
    totalMinutes: totalMinutes,
    columns: headers,
    content: buildCsv_(headers, rows),
    fileName: buildCsvFileName_('dips_flight_log', o.from, o.to),
    mimeType: 'text/csv;charset=utf-8',
    empty: rows.length === 0,
    note: 'DIPS 2.0 には飛行日誌の CSV インポート機能がありません。' +
      '本ファイルは国交省「無人航空機の飛行日誌の取扱要領」様式1の記載事項に準拠した' +
      '記録・保管用データです（DIPS へは画面から入力してください）。'
  };
}

/**
 * 国交省 様式2「日常点検記録」／様式3「点検整備記録」準拠の CSV を生成する。
 * 13項目は「良 / 異常 / 空欄（対象外）」で出力する。
 *
 * @param {Object} [options] from / to / droneId / type
 * @return {Object} CSV 文字列・件数・列定義
 */
function buildInspectionCsv(options) {
  const o = options || {};
  const items = allInspectionItems_();

  const inspections = getInspections({
    from: o.from,
    to: o.to,
    droneId: o.droneId,
    type: o.type,
    limit: 1000
  }).items.slice();

  inspections.sort(function (a, b) {
    const ka = a.inspectionDate + ' ' + a.createdAt + ' ' + a.inspectionId;
    const kb = b.inspectionDate + ' ' + b.createdAt + ' ' + b.inspectionId;
    if (ka === kb) return 0;
    return ka < kb ? -1 : 1;
  });

  const headers = DIPS_INSPECTION_COLUMNS.map(function (c) { return c.header; })
    .concat(items.map(function (name) { return '点検項目:' + name; }));

  const rows = inspections.map(function (i) {
    const base = DIPS_INSPECTION_COLUMNS.map(function (c) { return c.value(i); });
    const itemCells = items.map(function (name) {
      const v = i.items ? i.items[name] : '';
      if (v === 'OK') return '良';
      if (v === 'NG') return '異常';
      return '';
    });
    return base.concat(itemCells);
  });

  return {
    ok: true,
    format: 'dips-tenken-kiroku-2-3',
    count: rows.length,
    columns: headers,
    content: buildCsv_(headers, rows),
    fileName: buildCsvFileName_('dips_inspection_log', o.from, o.to),
    mimeType: 'text/csv;charset=utf-8',
    empty: rows.length === 0,
    note: 'DIPS 2.0 には点検記録の CSV インポート機能がありません。' +
      '本ファイルは様式2・3の記載事項に準拠した記録・保管用データです。'
  };
}

// =========================================================================
// 将来拡張用スタブ（インターフェースを先に固定しておく）
// -------------------------------------------------------------------------
// いずれも「入力 → 構造化された戻り値」を固定しているため、実装時は
// 関数の中身だけを差し替えればフロント側の変更が不要になる。
// =========================================================================

/**
 * DJI の飛行ログ（.txt / .csv）を解析して飛行情報へ変換する。【未実装】
 *
 * 想定する戻り値:
 * {
 *   ok: boolean,
 *   records: Array<{
 *     date: string,          // YYYY-MM-DD
 *     takeoffTime: string,   // HH:mm
 *     landingTime: string,   // HH:mm
 *     durationMin: number,
 *     takeoffPlace: string,
 *     landingPlace: string,
 *     lat: number|null,
 *     lng: number|null,
 *     maxAltitudeM: number|null,
 *     maxSpeedMs: number|null,
 *     warnings: Array<string>
 *   }>,
 *   message: string
 * }
 *
 * @param {string|Object} file Drive のファイルID、またはアップロードされた内容
 * @return {Object} 解析結果（上記構造）
 */
function parseDjiLog(file) {
  throw new Error(
    'DJI ログの自動解析は未実装です（受け取り: ' + (file ? typeof file : 'none') + '）。' +
    '現時点では飛行時間・離着陸時刻を手入力してください。'
  );
}

/**
 * 住所から緯度経度を取得する（GAS 標準の Maps サービス。API キー不要）。
 *
 * Maps.newGeocoder() は Apps Script 組み込みのため、Google Cloud の
 * Geocoding API キーを用意する必要がない。見つからない場合や API が
 * エラーを返した場合は、理由を添えた Error を投げる
 * （google.script.run の failureHandler でそのまま画面表示できる）。
 *
 * @param {string} address 住所（例: '千葉県香取市小見川'）
 * @return {{ok: boolean, address: string, lat: number, lng: number,
 *           formattedAddress: string, partial: boolean, status: string, message: string}}
 */
function fetchGeoFromAddress(address) {
  const text = String(address === null || address === undefined ? '' : address)
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    throw new Error('住所を入力してください。');
  }

  const response = geocodeRequest_(function (geocoder) {
    return geocoder.geocode(text);
  }, '住所検索');

  const results = (response && response.results) || [];
  const status = (response && response.status) || 'UNKNOWN';

  if (!results.length) {
    if (status === 'ZERO_RESULTS') {
      throw new Error('住所が見つかりませんでした: 「' + text + '」。都道府県名から入力してください。');
    }
    throw new Error('住所検索に失敗しました（status: ' + status + '）。時間をおいて再試行してください。');
  }

  const best = pickBestGeoResult_(results);
  const location = (best.geometry && best.geometry.location) || {};
  const lat = roundGeo_(location.lat);
  const lng = roundGeo_(location.lng);

  if (lat === null || lng === null) {
    throw new Error('座標を取得できませんでした: 「' + text + '」。');
  }

  return {
    ok: true,
    address: text,
    lat: lat,
    lng: lng,
    formattedAddress: best.formatted_address || text,
    partial: best.partial_match === true,
    status: status,
    message: '「' + text + '」の座標を取得しました。'
  };
}

/**
 * 緯度経度から住所文字列を取得する（GAS 標準の Maps サービス。API キー不要）。
 *
 * @param {number|string} lat 緯度（-90〜90）
 * @param {number|string} lng 経度（-180〜180）
 * @return {{ok: boolean, address: string, formattedAddress: string,
 *           lat: number, lng: number, status: string, message: string}}
 */
function fetchAddressFromGeo(lat, lng) {
  const isEmpty = lat === '' || lng === '' || lat === null || lng === null ||
    lat === undefined || lng === undefined;
  const latNum = Number(lat);
  const lngNum = Number(lng);

  if (isEmpty || !isFinite(latNum) || !isFinite(lngNum)) {
    throw new Error('緯度・経度を数値で指定してください（緯度: ' + lat + ' / 経度: ' + lng + '）。');
  }
  if (latNum < -90 || latNum > 90) {
    throw new Error('緯度は -90〜90 の範囲で指定してください（指定値: ' + latNum + '）。');
  }
  if (lngNum < -180 || lngNum > 180) {
    throw new Error('経度は -180〜180 の範囲で指定してください（指定値: ' + lngNum + '）。');
  }

  const response = geocodeRequest_(function (geocoder) {
    return geocoder.reverseGeocode(latNum, lngNum);
  }, '逆ジオコーディング');

  const results = (response && response.results) || [];
  const status = (response && response.status) || 'UNKNOWN';

  if (!results.length) {
    if (status === 'ZERO_RESULTS') {
      throw new Error('この座標の住所は見つかりませんでした（緯度: ' + latNum + ' / 経度: ' + lngNum + '）。');
    }
    throw new Error('住所の取得に失敗しました（status: ' + status + '）。時間をおいて再試行してください。');
  }

  const best = pickBestGeoResult_(results);
  const address = best.formatted_address || '';

  if (!address) {
    throw new Error('住所文字列を取得できませんでした（緯度: ' + latNum + ' / 経度: ' + lngNum + '）。');
  }

  return {
    ok: true,
    address: address,
    formattedAddress: address,
    lat: roundGeo_(latNum),
    lng: roundGeo_(lngNum),
    status: status,
    message: '座標から住所を取得しました。'
  };
}

/**
 * 緯度経度から地名を返す（旧インターフェース互換）。
 *
 * isDID / restrictions はこの旧IFでは未実装（null / 空配列）。
 * DID と周辺環境（天候・標高）が必要な場合は fetchFlightEnvironment を使う。
 *
 * @param {number} lat 緯度
 * @param {number} lng 経度
 * @return {{ok: boolean, address: string, isDID: boolean|null,
 *           restrictions: Array<string>, lat: number, lng: number, message: string}}
 */
function fetchGeoInfo(lat, lng) {
  const geo = fetchAddressFromGeo(lat, lng);
  return {
    ok: true,
    address: geo.address,
    isDID: null,
    restrictions: [],
    lat: geo.lat,
    lng: geo.lng,
    message: '地名を取得しました: ' + geo.address
  };
}


/**
 * Maps サービス呼び出しの共通ラッパー（日本語・日本リージョンで問い合わせる）。
 *
 * status が OK / ZERO_RESULTS 以外の場合はここで Error にするため、
 * 各呼び出し側は「結果が0件だった場合」だけを個別に扱えばよい。
 *
 * @param {function(Object): Object} run geocoder を受け取って結果を返す関数
 * @param {string} label エラーメッセージ用の処理名
 * @return {Object} Maps サービスの生レスポンス
 * @private
 */
function geocodeRequest_(run, label) {
  let response;
  try {
    const geocoder = Maps.newGeocoder().setLanguage('ja').setRegion('JP');
    response = run(geocoder);
  } catch (err) {
    throw new Error(
      label + 'でエラーが発生しました: ' + (err && err.message ? err.message : err) +
      '。Maps サービスの割り当てを確認してください。'
    );
  }

  if (!response) {
    throw new Error(label + 'の応答が空でした。時間をおいて再試行してください。');
  }

  const status = response.status;
  if (status && status !== 'OK' && status !== 'ZERO_RESULTS') {
    throw new Error(label + 'に失敗しました（status: ' + status + '）。時間をおいて再試行してください。');
  }
  return response;
}

/**
 * 複数の候補から最も精度の高い結果を選ぶ。
 *
 * location_type は ROOFTOP > RANGE_INTERPOLATED > GEOMETRIC_CENTER > APPROXIMATE の順に
 * 精度が高い。座標を持たない候補は除外する。
 *
 * @param {Array<Object>} results Maps サービスの結果配列
 * @return {Object} 採用する結果（全滅時は先頭）
 * @private
 */
function pickBestGeoResult_(results) {
  const rank = { ROOFTOP: 0, RANGE_INTERPOLATED: 1, GEOMETRIC_CENTER: 2, APPROXIMATE: 3 };
  let best = null;

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (!item || !item.geometry || !item.geometry.location) continue;
    const score = rank[item.geometry.location_type];
    const order = score === undefined ? 9 : score;
    if (!best || order < best.order) best = { order: order, item: item };
  }

  return best ? best.item : results[0];
}

/**
 * 緯度経度を小数6桁（約0.1m）に丸める。数値化できない場合は null。
 *
 * @param {number|string} value 緯度または経度
 * @return {number|null} 丸めた値
 * @private
 */
function roundGeo_(value) {
  const num = Number(value);
  if (value === null || value === undefined || value === '' || !isFinite(num)) return null;
  return Math.round(num * 1e6) / 1e6;
}

// =========================================================================
// 現場環境データ（天候・風速 / 海抜標高 / DID規制）
// -------------------------------------------------------------------------
// 事前準備: なし（3つとも API キー不要のオープンデータ）。
//   A. Open-Meteo              : 天候・気温・降水量・風速・突風
//   B. 国土地理院 標高API       : 海抜標高（150m規制の基準値を算出）
//   C. 国土地理院 人口集中地区タイル: DID（令和2年国勢調査 / 総務省統計局）
// =========================================================================

/** Open-Meteo（天候・風速）のエンドポイント */
const OPEN_METEO_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/** 国土地理院 標高APIのエンドポイント */
const GSI_ELEVATION_ENDPOINT =
  'https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php';

/**
 * 地理院タイル「人口集中地区 令和2年（総務省統計局）」。
 *
 * DID の内側は不透明（赤 / alpha 102）、外側は透明で、
 * 区域を含まないタイルは 404 を返す。画像を読む必要があるため、
 * GAS でも動くよう PNG デコーダ（inflate 含む）を本ファイル内に持つ。
 */
const GSI_DID_TILE_ENDPOINT = 'https://cyberjapandata.gsi.go.jp/xyz/did2020/';

/** DID 判定に使うタイルのズーム（16 = 約2.4m/px） */
const DID_TILE_ZOOM = 16;

/** 地理院タイルの一辺（px） */
const DID_TILE_SIZE = 256;

/** 風速の注意閾値（m/s）。この値以上で CAUTION */
const WIND_CAUTION_MS = 5.0;

/** 風速の危険閾値（m/s）。この値以上で DANGER */
const WIND_DANGER_MS = 7.0;

/** 航空法の飛行上限（地表・水面から150m） */
const AGL_LIMIT_METERS = 150;

/**
 * 離着陸座標の周辺環境（天候・風速・海抜標高・DID規制）を取得する。
 *
 * 3つのオープンAPIを順に呼び、1つのオブジェクトに統合して返す。
 * 天候が取れないと飛行適性を判断できないため、天候の失敗だけは例外にする。
 * 標高・DID は補助情報のため、取得できなくても処理は継続し `note` に理由を入れる
 * （DID が判定できない場合は「外」と誤って返さず `isDID: null` にする）。
 *
 * @param {number|string} lat 緯度（-90〜90）
 * @param {number|string} lng 経度（-180〜180）
 * @return {{ok: boolean, lat: number, lng: number,
 *   weather: {text: string, temperature: (number|null), humidity: (number|null),
 *     precipitation: (number|null), windSpeed: number, windGust: (number|null),
 *     weatherCode: (number|null), safetyStatus: string, safetyLabel: string},
 *   elevation: {groundElevation: (number|null), max150mLimit: (number|null), note: string},
 *   regulations: {isDID: (boolean|null), note: string, source: string},
 *   sources: {weather: string, elevation: string, did: string},
 *   message: string, fetchedAt: string}}
 */
function fetchFlightEnvironment(lat, lng) {
  const point = assertLatLng_(lat, lng);
  const weather = fetchWeather_(point.lat, point.lng);
  const elevation = fetchGroundElevation_(point.lat, point.lng);
  const did = judgeDID_(point.lat, point.lng);

  return {
    ok: true,
    lat: point.lat,
    lng: point.lng,
    weather: weather,
    elevation: elevation,
    regulations: did,
    sources: {
      weather: 'Open-Meteo',
      elevation: '国土地理院 標高API',
      did: '国土地理院 人口集中地区タイル（令和2年国勢調査）'
    },
    message: '天候・標高・DID の情報を取得しました。',
    fetchedAt: nowStamp_()
  };
}

/**
 * 緯度・経度を検証し、小数6桁に丸めた数値で返す。
 *
 * @param {number|string} lat 緯度
 * @param {number|string} lng 経度
 * @return {{lat: number, lng: number}} 検証済みの座標
 * @private
 */
function assertLatLng_(lat, lng) {
  const isEmpty = lat === '' || lng === '' || lat === null || lng === null ||
    lat === undefined || lng === undefined;
  const la = Number(lat);
  const ln = Number(lng);

  if (isEmpty || !isFinite(la) || !isFinite(ln)) {
    throw new Error('緯度・経度を数値で指定してください（緯度: ' + lat + ' / 経度: ' + lng + '）。');
  }
  if (la < -90 || la > 90) {
    throw new Error('緯度は -90〜90 の範囲で指定してください（指定値: ' + la + '）。');
  }
  if (ln < -180 || ln > 180) {
    throw new Error('経度は -180〜180 の範囲で指定してください（指定値: ' + ln + '）。');
  }

  return { lat: roundGeo_(la), lng: roundGeo_(ln) };
}

/**
 * 小数第1位に丸める。数値化できない場合は null。
 *
 * @param {*} value 値
 * @return {number|null} 丸めた値
 * @private
 */
function round1_(value) {
  const num = Number(value);
  if (value === null || value === undefined || value === '' || !isFinite(num)) return null;
  return Math.round(num * 10) / 10;
}

/**
 * 天候・風速を Open-Meteo から取得する（API キー不要）。
 *
 * current の単位は wind_speed_unit=ms で m/s に固定している。
 *
 * @param {number} lat 緯度
 * @param {number} lng 経度
 * @return {{text: string, temperature: (number|null), humidity: (number|null),
 *   precipitation: (number|null), windSpeed: number, windGust: (number|null),
 *   weatherCode: (number|null), safetyStatus: string, safetyLabel: string}}
 * @private
 */
function fetchWeather_(lat, lng) {
  const url = OPEN_METEO_ENDPOINT +
    '?latitude=' + lat + '&longitude=' + lng +
    '&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,' +
    'wind_speed_10m,wind_gusts_10m' +
    '&wind_speed_unit=ms&timezone=Asia%2FTokyo';

  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    throw new Error(
      '天候情報の取得に失敗しました（Open-Meteo へ接続できません）。' +
      'ネットワークまたは UrlFetchApp の権限を確認してください。'
    );
  }

  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('天候情報を取得できませんでした（Open-Meteo HTTP ' + code + '）。時間をおいて再試行してください。');
  }

  let json;
  try {
    json = JSON.parse(res.getContentText());
  } catch (err) {
    throw new Error('天候情報の応答を JSON として解釈できませんでした。再試行してください。');
  }

  const current = json && json.current;
  if (!current) {
    throw new Error('天候情報が空でした（Open-Meteo）。時間をおいて再試行してください。');
  }

  const windSpeed = round1_(current.wind_speed_10m);
  if (windSpeed === null) {
    throw new Error('風速を取得できませんでした（Open-Meteo）。時間をおいて再試行してください。');
  }

  const weatherCode = toNumber_(current.weather_code, null);
  const safety = judgeWindSafety_(windSpeed);

  return {
    text: weatherCodeToJa_(weatherCode),
    temperature: round1_(current.temperature_2m),
    humidity: round1_(current.relative_humidity_2m),
    precipitation: round1_(current.precipitation),
    windSpeed: windSpeed,
    windGust: round1_(current.wind_gusts_10m),
    weatherCode: weatherCode,
    safetyStatus: safety.status,
    safetyLabel: safety.label,
    observedAt: trim_(current.time)
  };
}

/**
 * WMO 天候コード（Open-Meteo の weather_code）を日本語表記にする。
 *
 * @param {number|null} code 天候コード
 * @return {string} 日本語の天候
 * @private
 */
function weatherCodeToJa_(code) {
  const n = Number(code);
  if (code === null || code === undefined || code === '' || !isFinite(n)) return '不明';

  if (n === 0) return '快晴';
  if (n === 1) return '晴れ';
  if (n === 2) return '薄曇り';
  if (n === 3) return '曇り';
  if (n === 45) return '霧';
  if (n === 48) return '着氷性の霧';
  if (n >= 51 && n <= 57) return '霧雨';
  if (n >= 61 && n <= 67) return '雨';
  if (n >= 71 && n <= 77) return '雪';
  if (n >= 80 && n <= 82) return 'にわか雨';
  if (n >= 85 && n <= 86) return 'にわか雪';
  if (n >= 95 && n <= 99) return '雷雨';
  return '不明（コード ' + n + '）';
}

/**
 * 風速から飛行適性を判定する（10m 高さの平均風速）。
 *
 * 5.0m/s 未満: GOOD / 5.0〜7.0m/s 未満: CAUTION / 7.0m/s 以上: DANGER
 *
 * @param {number} windSpeed 風速（m/s）
 * @return {{status: string, label: string}} 判定結果
 * @private
 */
function judgeWindSafety_(windSpeed) {
  const speed = Number(windSpeed);
  if (!isFinite(speed)) {
    return { status: 'CAUTION', label: '注意: 風速を取得できませんでした（現地の風を確認してください）' };
  }
  if (speed >= WIND_DANGER_MS) {
    return { status: 'DANGER', label: '危険: 風速7m/s以上（飛行中止を検討）' };
  }
  if (speed >= WIND_CAUTION_MS) {
    return { status: 'CAUTION', label: '注意: 風速5m/s超（安定飛行に注意）' };
  }
  return { status: 'GOOD', label: '飛行適性: 良好（安全圏）' };
}

/**
 * 海抜標高を国土地理院 標高APIから取得する（API キー不要）。
 *
 * 標高は補助情報のため、失敗しても例外にせず note に理由を入れて返す
 * （海上やデータ範囲外では elevation が null で返る）。
 *
 * @param {number} lat 緯度
 * @param {number} lng 経度
 * @return {{groundElevation: (number|null), max150mLimit: (number|null), note: string}}
 * @private
 */
function fetchGroundElevation_(lat, lng) {
  const url = GSI_ELEVATION_ENDPOINT + '?lat=' + lat + '&lon=' + lng + '&outtype=JSON';

  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    return {
      groundElevation: null,
      max150mLimit: null,
      note: '標高を取得できませんでした（国土地理院 標高API へ接続できません）。'
    };
  }

  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    return {
      groundElevation: null,
      max150mLimit: null,
      note: '標高を取得できませんでした（国土地理院 標高API HTTP ' + code + '）。'
    };
  }

  let json;
  try {
    json = JSON.parse(res.getContentText());
  } catch (err) {
    return {
      groundElevation: null,
      max150mLimit: null,
      note: '標高の応答を JSON として解釈できませんでした。'
    };
  }

  const ground = round1_(json && json.elevation);
  if (ground === null) {
    return {
      groundElevation: null,
      max150mLimit: null,
      note: 'この地点の標高データがありません（海上・データ範囲外の可能性）。'
    };
  }

  return {
    groundElevation: ground,
    max150mLimit: round1_(ground + AGL_LIMIT_METERS),
    note: trim_(json.hsrc) ? 'データ源: ' + trim_(json.hsrc) : ''
  };
}

/**
 * DID（人口集中地区）の内側かどうかを地理院タイルで判定する。
 *
 * タイルの該当ピクセルの alpha が 0 より大きければ DID の内側。
 * 区域を含まないタイルは 404 が返るため「外」と判定できる。
 * 通信・解析に失敗した場合は、誤って「外」と返さないよう isDID: null にする
 * （呼び出し側は「要確認」として扱う）。
 *
 * @param {number} lat 緯度
 * @param {number} lng 経度
 * @return {{isDID: (boolean|null), note: string, source: string}} 判定結果
 * @private
 */
function judgeDID_(lat, lng) {
  const source = '国土地理院 人口集中地区タイル（令和2年国勢調査）';
  const tile = latLngToTilePixel_(lat, lng, DID_TILE_ZOOM);
  const url = GSI_DID_TILE_ENDPOINT + tile.z + '/' + tile.x + '/' + tile.y + '.png';

  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    return {
      isDID: null,
      note: 'DID を判定できませんでした（地理院タイルへ接続できません）。飛行前に DIPS で確認してください。',
      source: source
    };
  }

  const code = res.getResponseCode();

  // 区域を含まないタイルは 404（= DID の外側）
  if (code === 404) {
    return { isDID: false, note: '人口集中地区（DID）外', source: source };
  }
  if (code < 200 || code >= 300) {
    return {
      isDID: null,
      note: 'DID を判定できませんでした（地理院タイル HTTP ' + code + '）。飛行前に DIPS で確認してください。',
      source: source
    };
  }

  let png;
  try {
    png = decodePng_(toByteArray_(res.getBlob().getBytes()));
  } catch (err) {
    return {
      isDID: null,
      note: 'DID を判定できませんでした（タイル画像を解析できません: ' +
        (err && err.message ? err.message : err) + '）。飛行前に DIPS で確認してください。',
      source: source
    };
  }

  const pixel = pngPixelAt_(png, tile.px, tile.py);
  const inside = !!pixel && pixel[3] > 0;

  return {
    isDID: inside,
    note: inside ? '人口集中地区（DID）内' : '人口集中地区（DID）外',
    source: source
  };
}

/**
 * 緯度・経度をタイル座標（XYZ）とタイル内ピクセルへ変換する（Web メルカトル）。
 *
 * @param {number} lat 緯度
 * @param {number} lng 経度
 * @param {number} zoom ズームレベル
 * @return {{z: number, x: number, y: number, px: number, py: number}} タイル座標
 * @private
 */
function latLngToTilePixel_(lat, lng, zoom) {
  const limit = 85.05112878;
  const la = Math.max(-limit, Math.min(limit, Number(lat)));
  const ln = Number(lng);
  const size = Math.pow(2, zoom);

  const worldX = (ln + 180) / 360 * size;
  const rad = la * Math.PI / 180;
  const worldY = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * size;

  const tx = Math.floor(worldX);
  const ty = Math.floor(worldY);

  return {
    z: zoom,
    x: tx,
    y: ty,
    px: clamp_(Math.floor((worldX - tx) * DID_TILE_SIZE), 0, DID_TILE_SIZE - 1),
    py: clamp_(Math.floor((worldY - ty) * DID_TILE_SIZE), 0, DID_TILE_SIZE - 1)
  };
}

/**
 * GAS の byte[]（Java の符号付きバイト配列を含む）を Uint8Array に変換する。
 *
 * @param {Object} bytes getBytes() の戻り値
 * @return {Uint8Array} 0〜255 の配列
 * @private
 */
function toByteArray_(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] & 0xff;
  return out;
}

// =========================================================================
// PNG デコーダ（地理院タイルの DID 判定用）
// -------------------------------------------------------------------------
// GAS には画像のピクセルを読む API がないため、地理院タイル（8bit PNG）を
// 自前で展開し「DID の塗りが乗っているか」だけを判定する。
// 対応: 8bit / 非インターレース / カラータイプ 0,2,3,4,6
// 非対応: 16bit、インターレース（例外を投げる）
// =========================================================================

/**
 * PNG を展開し、ピクセルを読み出せる形にする。
 *
 * @param {Uint8Array} bytes PNG のバイト列
 * @return {{width: number, height: number, colorType: number, bitDepth: number,
 *   channels: number, stride: number, pixels: Uint8Array,
 *   palette: (Uint8Array|null)}} 展開結果
 * @private
 */
function decodePng_(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!bytes || bytes.length < 8) throw new Error('画像データが空です。');
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) throw new Error('PNG 形式ではありません。');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  const idat = [];

  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length = readUint32_(bytes, pos);
    const type = String.fromCharCode(
      bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]
    );
    const start = pos + 8;
    const end = start + length;
    if (end > bytes.length) throw new Error('PNG のチャンクが壊れています。');

    if (type === 'IHDR') {
      if (length < 13) throw new Error('PNG のヘッダーが不正です。');
      width = readUint32_(bytes, start);
      height = readUint32_(bytes, start + 4);
      bitDepth = bytes[start + 8];
      colorType = bytes[start + 9];
      interlace = bytes[start + 12];
    } else if (type === 'PLTE') {
      palette = bytes.subarray(start, end);
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }

    pos = end + 4;
  }

  if (!width || !height) throw new Error('PNG のサイズを取得できませんでした。');
  if (bitDepth !== 8) throw new Error('8bit 以外の PNG には対応していません（' + bitDepth + 'bit）。');
  if (interlace !== 0) throw new Error('インターレース PNG には対応していません。');
  if (!idat.length) throw new Error('PNG の画像データがありません。');

  const channelMap = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelMap[colorType];
  if (!channels) throw new Error('未対応の PNG カラータイプです（' + colorType + '）。');
  if (colorType === 3 && !palette) throw new Error('PNG のパレットがありません。');

  let total = 0;
  idat.forEach(function (part) { total += part.length; });
  const compressed = new Uint8Array(total);
  let offset = 0;
  idat.forEach(function (part) {
    compressed.set(part, offset);
    offset += part.length;
  });

  const raw = inflateZlib_(compressed, 0, compressed.length);
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) {
    throw new Error('PNG の展開サイズが不足しています。');
  }

  const pixels = new Uint8Array(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = y * stride;
    const prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const value = raw[p++];
      const a = i >= channels ? pixels[row + i - channels] : 0;
      const b = y > 0 ? pixels[prev + i] : 0;
      const c = (y > 0 && i >= channels) ? pixels[prev + i - channels] : 0;
      let out;
      if (filter === 0) out = value;
      else if (filter === 1) out = value + a;
      else if (filter === 2) out = value + b;
      else if (filter === 3) out = value + ((a + b) >> 1);
      else if (filter === 4) out = value + paeth_(a, b, c);
      else throw new Error('PNG のフィルタ種別が不正です（' + filter + '）。');
      pixels[row + i] = out & 0xff;
    }
  }

  return {
    width: width,
    height: height,
    colorType: colorType,
    bitDepth: bitDepth,
    channels: channels,
    stride: stride,
    pixels: pixels,
    palette: palette
  };
}

/**
 * 展開済み PNG の指定座標の RGBA を返す。範囲外は null。
 *
 * カラータイプ 3（パレット）は tRNS を扱わないため alpha は 255 固定。
 *
 * @param {Object} png decodePng_ の戻り値
 * @param {number} x X 座標（0 始まり）
 * @param {number} y Y 座標（0 始まり）
 * @return {Array<number>|null} [r, g, b, a]
 * @private
 */
function pngPixelAt_(png, x, y) {
  if (!png || x < 0 || y < 0 || x >= png.width || y >= png.height) return null;
  const index = y * png.stride + x * png.channels;
  const px = png.pixels;

  if (png.colorType === 6) return [px[index], px[index + 1], px[index + 2], px[index + 3]];
  if (png.colorType === 2) return [px[index], px[index + 1], px[index + 2], 255];
  if (png.colorType === 4) return [px[index], px[index], px[index], px[index + 1]];
  if (png.colorType === 0) return [px[index], px[index], px[index], 255];

  const p = px[index] * 3;
  if (!png.palette || p + 2 >= png.palette.length) return [0, 0, 0, 255];
  return [png.palette[p], png.palette[p + 1], png.palette[p + 2], 255];
}

/**
 * PNG のビッグエンディアン 32bit 整数を読む。
 *
 * @param {Uint8Array} bytes バイト列
 * @param {number} index 読み出し位置
 * @return {number} 符号なし整数
 * @private
 */
function readUint32_(bytes, index) {
  return ((bytes[index] << 24) | (bytes[index + 1] << 16) |
    (bytes[index + 2] << 8) | bytes[index + 3]) >>> 0;
}

/**
 * PNG フィルタ種別 4（Paeth）の予測値を求める。
 *
 * @param {number} a 左
 * @param {number} b 上
 * @param {number} c 左上
 * @return {number} 予測値
 * @private
 */
function paeth_(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// =========================================================================
// DEFLATE（RFC1951）展開
// -------------------------------------------------------------------------
// PNG の IDAT は zlib 形式（2バイトヘッダー + deflate + Adler-32）だが、
// GAS には展開 API がないため、ストアブロック・固定ハフマン・可変ハフマンに
// 対応した最小限の inflate を実装する（PNG 以外の用途は想定しない）。
// 復号は zlib の puff.c と同じ「符号長カウント方式」で行う。
// =========================================================================

/** 長さコード（257〜285）の基準値 */
const INFLATE_LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
];

/** 長さコードの追加ビット数 */
const INFLATE_LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
];

/** 距離コード（0〜29）の基準値 */
const INFLATE_DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577
];

/** 距離コードの追加ビット数 */
const INFLATE_DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
];

/** 可変ハフマンの符号長を並べる順序（RFC1951 3.2.7） */
const INFLATE_CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** 展開後データの上限（壊れたデータによるメモリ肥大を防ぐ） */
const INFLATE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * zlib（RFC1950）形式の圧縮データを展開する。
 *
 * @param {Uint8Array} bytes 圧縮データ
 * @param {number} offset zlib ヘッダーの位置
 * @param {number} length zlib データ全体の長さ（Adler-32 を含む）
 * @return {Uint8Array} 展開したデータ
 * @private
 */
function inflateZlib_(bytes, offset, length) {
  if (length < 6) throw new Error('圧縮データが短すぎます。');

  const cmf = bytes[offset];
  const flg = bytes[offset + 1];
  if ((cmf & 0x0f) !== 8) throw new Error('deflate 以外の圧縮形式には対応していません。');
  if (((cmf << 8) + flg) % 31 !== 0) throw new Error('zlib ヘッダーが不正です。');
  if (flg & 0x20) throw new Error('プリセット辞書付きの圧縮データには対応していません。');

  // 末尾4バイトは Adler-32（データ本体の検証は行わない）
  return inflateRaw_(bytes, offset + 2, offset + length - 4);
}

/**
 * deflate（RFC1951）の生データを展開する。
 *
 * @param {Uint8Array} bytes 圧縮データ
 * @param {number} start 開始位置
 * @param {number} end 終了位置（この位置の手前まで）
 * @return {Uint8Array} 展開したデータ
 * @private
 */
function inflateRaw_(bytes, start, end) {
  let pos = start;
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(8192);
  let outLen = 0;

  function ensure(extra) {
    if (outLen + extra <= out.length) return;
    if (outLen + extra > INFLATE_MAX_BYTES) {
      throw new Error('展開後のデータが大きすぎます。');
    }
    let size = out.length;
    while (size < outLen + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(out.subarray(0, outLen));
    out = next;
  }

  function need(count) {
    while (bitCnt < count) {
      if (pos >= end) throw new Error('圧縮データが途中で終わっています。');
      bitBuf = (bitBuf | (bytes[pos++] << bitCnt)) >>> 0;
      bitCnt += 8;
    }
  }

  function bits(count) {
    if (!count) return 0;
    need(count);
    const value = (bitBuf & ((1 << count) - 1)) >>> 0;
    bitBuf >>>= count;
    bitCnt -= count;
    return value;
  }

  function buildHuffman(lengths) {
    const counts = new Array(16).fill(0);
    for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
    counts[0] = 0;

    const offsets = new Array(16).fill(0);
    for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len] + counts[len];

    const symbols = new Array(lengths.length).fill(0);
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
    }

    return { counts: counts, symbols: symbols };
  }

  function decodeSymbol(huffman) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const count = huffman.counts[len];
      if (code - first < count) return huffman.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('ハフマン符号が不正です。');
  }

  const fixedLit = new Array(288).fill(0);
  for (let i = 0; i <= 143; i++) fixedLit[i] = 8;
  for (let i = 144; i <= 255; i++) fixedLit[i] = 9;
  for (let i = 256; i <= 279; i++) fixedLit[i] = 7;
  for (let i = 280; i <= 287; i++) fixedLit[i] = 8;
  const fixedDist = new Array(30).fill(5);

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);

    if (type === 0) {
      // ストアブロック（無圧縮）: 次のバイト境界まで読み捨てる
      const drop = bitCnt % 8;
      if (drop) {
        bitBuf >>>= drop;
        bitCnt -= drop;
      }
      const len = bits(16);
      const nlen = bits(16);
      if ((len ^ 0xffff) !== nlen) throw new Error('ストアブロックの長さが不正です。');
      ensure(len);
      for (let i = 0; i < len; i++) out[outLen++] = bits(8);
      continue;
    }

    if (type === 3) throw new Error('未対応の圧縮ブロック種別です。');

    let litHuffman;
    let distHuffman;

    if (type === 1) {
      litHuffman = buildHuffman(fixedLit);
      distHuffman = buildHuffman(fixedDist);
    } else {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;

      const clenLengths = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) clenLengths[INFLATE_CLEN_ORDER[i]] = bits(3);
      const clenHuffman = buildHuffman(clenLengths);

      const lengths = [];
      while (lengths.length < hlit + hdist) {
        const sym = decodeSymbol(clenHuffman);
        if (sym < 16) {
          lengths.push(sym);
        } else if (sym === 16) {
          if (!lengths.length) throw new Error('符号長の繰り返しが不正です。');
          const prev = lengths[lengths.length - 1];
          const repeat = 3 + bits(2);
          for (let i = 0; i < repeat; i++) lengths.push(prev);
        } else if (sym === 17) {
          const repeat = 3 + bits(3);
          for (let i = 0; i < repeat; i++) lengths.push(0);
        } else {
          const repeat = 11 + bits(7);
          for (let i = 0; i < repeat; i++) lengths.push(0);
        }
      }

      litHuffman = buildHuffman(lengths.slice(0, hlit));
      distHuffman = buildHuffman(lengths.slice(hlit, hlit + hdist));
    }

    while (true) {
      const sym = decodeSymbol(litHuffman);

      if (sym < 256) {
        ensure(1);
        out[outLen++] = sym;
        continue;
      }
      if (sym === 256) break;

      const lenIndex = sym - 257;
      if (lenIndex < 0 || lenIndex >= INFLATE_LEN_BASE.length) {
        throw new Error('長さコードが不正です。');
      }
      const copyLen = INFLATE_LEN_BASE[lenIndex] + bits(INFLATE_LEN_EXTRA[lenIndex]);

      const distSym = decodeSymbol(distHuffman);
      if (distSym >= INFLATE_DIST_BASE.length) throw new Error('距離コードが不正です。');
      const distance = INFLATE_DIST_BASE[distSym] + bits(INFLATE_DIST_EXTRA[distSym]);
      if (distance > outLen) throw new Error('参照距離が展開データを超えています。');

      ensure(copyLen);
      for (let i = 0; i < copyLen; i++) {
        out[outLen] = out[outLen - distance];
        outLen++;
      }
    }
  }

  return out.subarray(0, outLen);
}

// =========================================================================
// Gemini による画像リスク判定（衛星写真 / 現場写真）
// -------------------------------------------------------------------------
// 事前準備: スクリプト プロパティ GEMINI_API_KEY を登録する（必須）。
// 任意: GOOGLE_MAPS_API_KEY を登録すると StaticMap が本番割当で利用できる。
// =========================================================================

/** 使用モデル（変更する場合はここだけ書き換える） */
const GEMINI_MODEL = 'gemini-2.5-flash';

/** Gemini REST のベースURL */
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

/** インライン送信する画像の上限（Base64 文字数。約8MB） */
const GEMINI_MAX_BASE64_LENGTH = 8 * 1024 * 1024;

/** 衛星写真のズーム（19 = 地上分解能 約0.3m/px） */
const SATELLITE_ZOOM = 19;

/** 衛星写真の一辺（px） */
const SATELLITE_SIZE = 600;

/**
 * スクリプト プロパティから Gemini の API キーを取得する。
 *
 * @return {string} API キー
 */
function geminiApiKey_() {
  const props = PropertiesService.getScriptProperties();
  const key = trim_(props.getProperty('GEMINI_API_KEY'));
  if (!key) {
    throw new Error(
      'Gemini の API キーが未設定です。Apps Script の「プロジェクトの設定 > スクリプト プロパティ」に' +
      ' GEMINI_API_KEY を登録してください。'
    );
  }
  return key;
}

/**
 * GOOGLE_MAPS_API_KEY があれば StaticMap の認証を設定する（任意）。
 * 未設定でも既定の割当で動作するため、失敗しても処理は継続する。
 */
function authenticateMapsIfConfigured_() {
  try {
    const key = trim_(PropertiesService.getScriptProperties().getProperty('GOOGLE_MAPS_API_KEY'));
    if (key && typeof Maps.setAuthenticationByApiKey === 'function') {
      Maps.setAuthenticationByApiKey(key);
    }
  } catch (err) {
    // 既定の割当で続行する
  }
}

/**
 * 指定座標の衛星写真を取得する。
 *
 * @param {number} lat 緯度
 * @param {number} lng 経度
 * @return {{base64: string, mimeType: string}} 画像データ
 */
function fetchSatelliteImage_(lat, lng) {
  authenticateMapsIfConfigured_();

  const map = Maps.newStaticMap()
    .setCenter(lat, lng)
    .setZoom(SATELLITE_ZOOM)
    .setSize(SATELLITE_SIZE, SATELLITE_SIZE);

  // 実行環境によっては Type 列挙子が無い場合があるためフォールバックする
  try {
    map.setMapType(Maps.StaticMap.Type.SATELLITE);
  } catch (err) {
    try {
      map.setMapType('satellite');
    } catch (err2) {
      // 地図種別を指定できなくても解析は継続する
    }
  }

  const blob = map.getBlob();
  if (!blob) throw new Error('衛星写真を取得できませんでした。座標を確認してください。');

  return {
    base64: Utilities.base64Encode(blob.getBytes()),
    mimeType: blob.getContentType() || 'image/png'
  };
}

/**
 * data URI / 生Base64 のどちらでも受け取り、Base64 本体と MIME を取り出す。
 *
 * @param {string} data 画像データ
 * @return {{base64: string, mimeType: string}} 正規化した画像データ
 */
function parseImagePayload_(data) {
  const s = String(data === null || data === undefined ? '' : data).trim();
  const m = s.match(/^data:([^;,]+);base64,([\s\S]*)$/);
  if (m) return { mimeType: trim_(m[1]), base64: m[2].replace(/\s/g, '') };
  return { mimeType: '', base64: s.replace(/\s/g, '') };
}

/**
 * 画像データの妥当性を検証する。
 *
 * @param {string} base64 Base64 本体
 * @param {string} mimeType MIME タイプ
 */
function assertImagePayload_(base64, mimeType) {
  if (!base64) throw new Error('解析する画像が空です。画像を選択し直してください。');
  if (base64.length > GEMINI_MAX_BASE64_LENGTH) {
    const mb = Math.round((base64.length / 1024 / 1024) * 10) / 10;
    throw new Error('画像サイズが大きすぎます（約' + mb + 'MB）。長辺1200px程度に縮小してから再試行してください。');
  }
  if (mimeType && !/^image\//.test(mimeType)) {
    throw new Error('画像ファイルではありません（' + mimeType + '）。JPEG / PNG を指定してください。');
  }
}

/** Gemini のシステムプロンプト */
function geminiSystemPrompt_() {
  return [
    'あなたは日本の航空法（無人航空機の飛行ルール）と飛行安全に詳しい安全管理の専門家です。',
    '与えられた画像だけを根拠に、これから行う飛行のリスクと、特定飛行（10項目）への該当可能性を評価します。',
    '画像から読み取れない事項は推測で断定せず、該当フラグは false にしてください。',
    '出力は指定された JSON スキーマに厳密に従い、日本語で記述してください。'
  ].join('\n');
}

/**
 * 画像解析用のユーザープロンプト。
 *
 * @param {string} source 'satellite' | 'photo'
 * @param {string} contextText 座標などの補足
 * @return {string} プロンプト
 */
function geminiUserPrompt_(source, contextText) {
  const kind = source === 'satellite'
    ? '衛星写真（真上から撮影。1px ≒ 0.3m）'
    : '現場で撮影した写真（人が見た目線に近い方向）';
  return [
    '次の画像を分析し、ドローン飛行のリスクを評価してください。',
    '画像種別: ' + kind,
    '対象: ' + contextText,
    '',
    '観点:',
    '1. 人・車両・建物など、機体から30m以内に入りそうな物体（位置と概算距離）',
    '2. 住宅が密集しているか（DID＝人口集中地区らしさ）',
    '3. 電線・鉄塔・高圧線・樹木・構造物など飛行の障害物',
    '4. 第三者の立入りを制限できるか（フェンス・柵・見通し・人の出入り）',
    '5. 地表・水面から150m以上の高度が必要になりそうな地形や構造物',
    '6. 人が多数集まるイベント会場らしさ',
    '',
    'suggestedFlags は「該当する可能性が高い」場合のみ true にしてください。',
    'actionableAdvice は当日の飛行前確認として実行できる具体的な行動を3〜5件、簡潔に書いてください。'
  ].join('\n');
}

/** Gemini の responseSchema（JSON を厳密に返させる） */
function geminiResponseSchema_() {
  const level = { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] };
  return {
    type: 'object',
    properties: {
      riskLevel: level,
      detectedObjects: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            objectType: { type: 'string' },
            description: { type: 'string' },
            risk: level
          },
          required: ['objectType', 'description', 'risk']
        }
      },
      suggestedFlags: {
        type: 'object',
        properties: {
          within30m: { type: 'boolean' },
          did: { type: 'boolean' },
          altitude150m: { type: 'boolean' },
          event: { type: 'boolean' }
        },
        required: ['within30m', 'did', 'altitude150m', 'event']
      },
      summary: { type: 'string' },
      actionableAdvice: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['riskLevel', 'detectedObjects', 'suggestedFlags', 'summary', 'actionableAdvice']
  };
}

/**
 * HTTP ステータスを日本語のエラーメッセージへ変換する。
 *
 * @param {number} code HTTP ステータス
 * @param {string} body レスポンス本文
 * @return {string} エラーメッセージ
 */
function geminiHttpError_(code, body) {
  let detail = '';
  try {
    const json = JSON.parse(body);
    detail = trim_(json && json.error && json.error.message);
  } catch (err) {
    detail = trim_(String(body || '').slice(0, 200));
  }
  const suffix = detail ? '（' + detail + '）' : '';
  if (code === 400) return 'Gemini のリクエストが不正です' + suffix;
  if (code === 401 || code === 403) {
    return 'Gemini の API キーが無効、または権限がありません。スクリプト プロパティ GEMINI_API_KEY を確認してください' + suffix;
  }
  if (code === 404) return 'Gemini のモデル（' + GEMINI_MODEL + '）が見つかりません' + suffix;
  if (code === 429) return 'Gemini の利用上限に達しました。しばらく待ってから再試行してください' + suffix;
  if (code >= 500) return 'Gemini 側で一時的なエラーが発生しました（HTTP ' + code + '）。再試行してください' + suffix;
  return 'Gemini の呼び出しに失敗しました（HTTP ' + code + '）' + suffix;
}

/**
 * Gemini のレスポンスから本文テキストを取り出す。
 *
 * @param {Object} json レスポンスJSON
 * @return {string} テキスト（無ければ空文字）
 */
function extractGeminiText_(json) {
  const candidates = (json && json.candidates) || [];
  for (let i = 0; i < candidates.length; i++) {
    const parts = (candidates[i].content && candidates[i].content.parts) || [];
    const text = parts.map(function (p) { return p.text || ''; }).join('').trim();
    if (text) return text;
  }
  return '';
}

/**
 * コードフェンスや前後の説明文を許容して JSON をパースする。
 *
 * @param {string} text Gemini の応答テキスト
 * @return {Object} パース結果
 */
function parseJsonLoose_(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch (err) {
    throw new Error('AI の解析結果を JSON として解釈できませんでした。再試行してください。');
  }
}

/**
 * リスク表記を LOW / MEDIUM / HIGH に正規化する。
 *
 * @param {string} value 入力値
 * @return {string} 正規化したリスク
 */
function normalizeRiskLevel_(value) {
  const s = trim_(value).toUpperCase();
  if (s === 'HIGH' || s === '高' || s === '高リスク') return 'HIGH';
  if (s === 'LOW' || s === '低' || s === '低リスク') return 'LOW';
  return 'MEDIUM';
}

/**
 * Gemini の解析結果を画面が扱いやすい形へ整える。
 *
 * @param {Object} parsed パース済みJSON
 * @return {Object} 正規化した解析結果
 */
function normalizeRiskResult_(parsed) {
  const p = parsed || {};
  const riskLevel = normalizeRiskLevel_(p.riskLevel);

  const objects = (Array.isArray(p.detectedObjects) ? p.detectedObjects : [])
    .map(function (o) {
      const obj = o || {};
      return {
        objectType: trim_(obj.objectType) || '物体',
        description: trim_(obj.description) || '詳細不明',
        risk: normalizeRiskLevel_(obj.risk)
      };
    });

  const flags = p.suggestedFlags || {};
  const advice = (Array.isArray(p.actionableAdvice) ? p.actionableAdvice : [])
    .map(function (a) { return trim_(a); })
    .filter(function (a) { return a !== ''; });

  return {
    riskLevel: riskLevel,
    riskLabel: riskLevel === 'HIGH' ? '高リスク' : riskLevel === 'LOW' ? '低リスク' : '中リスク',
    detectedObjects: objects,
    suggestedFlags: {
      within30m: flags.within30m === true || flags.within30m === 'true',
      did: flags.did === true || flags.did === 'true',
      altitude150m: flags.altitude150m === true || flags.altitude150m === 'true',
      event: flags.event === true || flags.event === 'true'
    },
    summary: trim_(p.summary) || '画像から明確なリスクは読み取れませんでした。',
    actionableAdvice: advice.length ? advice : ['離陸前に周囲の第三者の有無と障害物を目視で確認してください。']
  };
}

/**
 * Gemini へ画像を送り、リスク解析結果を返す（衛星・現場写真の共通処理）。
 *
 * @param {string} base64 Base64 本体
 * @param {string} mimeType MIME タイプ
 * @param {string} contextText 座標などの補足情報
 * @param {string} source 'satellite' | 'photo'
 * @return {Object} 正規化した解析結果
 */
function geminiAnalyze_(base64, mimeType, contextText, source) {
  assertImagePayload_(base64, mimeType);
  const key = geminiApiKey_();
  const url = GEMINI_ENDPOINT + GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(key);

  const payload = {
    system_instruction: { parts: [{ text: geminiSystemPrompt_() }] },
    contents: [{
      role: 'user',
      parts: [
        { text: geminiUserPrompt_(source, contextText) },
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64 } }
      ]
    }],
    generation_config: {
      temperature: 0.2,
      response_mime_type: 'application/json',
      response_schema: geminiResponseSchema_()
    }
  };

  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    throw new Error('Gemini への通信に失敗しました。ネットワークまたは UrlFetchApp の権限を確認してください。');
  }

  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error(geminiHttpError_(code, body));
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new Error('Gemini の応答を JSON として解釈できませんでした。再試行してください。');
  }

  const text = extractGeminiText_(json);
  if (!text) {
    throw new Error('Gemini から解析結果が返りませんでした。画像を変えて再試行してください。');
  }

  return normalizeRiskResult_(parseJsonLoose_(text));
}

/**
 * 緯度経度から衛星写真を取得し、Gemini でリスク解析する。
 *
 * @param {number|string} lat 緯度
 * @param {number|string} lng 経度
 * @return {Object} 解析結果（satelliteImageUrl を含む）
 */
function analyzeRiskFromCoordinates(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!isFinite(la) || !isFinite(ln)) {
    throw new Error('緯度・経度を数値で指定してください。');
  }
  if (la < -90 || la > 90 || ln < -180 || ln > 180) {
    throw new Error('緯度・経度の範囲が不正です（緯度 -90〜90 / 経度 -180〜180）。');
  }

  const image = fetchSatelliteImage_(la, ln);
  const context = '緯度 ' + la.toFixed(6) + ' / 経度 ' + ln.toFixed(6) +
    '（ズーム' + SATELLITE_ZOOM + 'の衛星写真）';
  const result = geminiAnalyze_(image.base64, image.mimeType, context, 'satellite');

  return {
    ok: true,
    source: 'satellite',
    model: GEMINI_MODEL,
    lat: la,
    lng: ln,
    riskLevel: result.riskLevel,
    riskLabel: result.riskLabel,
    detectedObjects: result.detectedObjects,
    suggestedFlags: result.suggestedFlags,
    summary: result.summary,
    actionableAdvice: result.actionableAdvice,
    satelliteImageUrl: 'data:' + image.mimeType + ';base64,' + image.base64,
    analyzedAt: nowStamp_()
  };
}

/**
 * 現場写真（Base64 / data URI）を Gemini でリスク解析する。
 *
 * @param {string} base64Data 画像データ
 * @param {string} [mimeType] MIME タイプ（省略時は data URI から判定）
 * @return {Object} 解析結果
 */
function analyzeRiskFromImage(base64Data, mimeType) {
  const parsed = parseImagePayload_(base64Data);
  const mime = trim_(mimeType) || parsed.mimeType || 'image/jpeg';
  const result = geminiAnalyze_(parsed.base64, mime, '現場で撮影した写真（飛行予定地点の周辺状況）', 'photo');

  return {
    ok: true,
    source: 'photo',
    model: GEMINI_MODEL,
    riskLevel: result.riskLevel,
    riskLabel: result.riskLabel,
    detectedObjects: result.detectedObjects,
    suggestedFlags: result.suggestedFlags,
    summary: result.summary,
    actionableAdvice: result.actionableAdvice,
    satelliteImageUrl: null,
    analyzedAt: nowStamp_()
  };
}

/**
 * 旧API（後方互換）。画像データからリスクを推定する。
 *
 * @param {string} imageData Base64 / data URI
 * @param {string} [mimeType] MIME タイプ
 * @return {Object} 解析結果
 */
function analyzeRiskWithGemini(imageData, mimeType) {
  return analyzeRiskFromImage(imageData, mimeType);
}
