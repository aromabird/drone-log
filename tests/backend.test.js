/**
 * Code.gs のロジックを GAS なしで検証するハーネス。
 * -------------------------------------------------------------------------
 * SpreadsheetApp / Utilities / LockService / Logger の最小スタブを用意し、
 * vm で Code.gs を読み込んで主要シナリオを実行する。
 *
 * 実行: node drone-log/tests/backend.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

// -------------------------------------------------------------------------
// GAS スタブ
// -------------------------------------------------------------------------

const ALLOWED_NUMBER_FORMATS = new Set(['@', '0']);

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        line.push(this.sheet._get(this.row + r, this.col + c));
      }
      out.push(line);
    }
    return out;
  }

  setValues(values) {
    for (let r = 0; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        this.sheet._set(this.row + r, this.col + c, values[r][c]);
      }
    }
    return this;
  }

  setValue(value) {
    this.sheet._set(this.row, this.col, value);
    return this;
  }

  getValue() {
    return this.sheet._get(this.row, this.col);
  }

  setNumberFormat(format) {
    if (!ALLOWED_NUMBER_FORMATS.has(format)) {
      throw new Error('unexpected number format: ' + format);
    }
    return this;
  }

  setFontWeight() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
  setHorizontalAlignment() { return this; }
  setVerticalAlignment() { return this; }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.cells = new Map();
    this.frozenRows = 0;
    this.maxRows = 1000;
    this.colWidths = {};
  }

  _key(row, col) {
    return row + ':' + col;
  }

  _get(row, col) {
    const v = this.cells.get(this._key(row, col));
    return v === undefined ? '' : v;
  }

  _set(row, col, value) {
    if (value === '' || value === null || value === undefined) {
      this.cells.delete(this._key(row, col));
    } else {
      this.cells.set(this._key(row, col), value);
    }
  }

  _maxIndex(isRow) {
    let max = 0;
    this.cells.forEach(function (_, key) {
      const parts = key.split(':').map(Number);
      const idx = isRow ? parts[0] : parts[1];
      if (idx > max) max = idx;
    });
    return max;
  }

  getLastRow() { return this._maxIndex(true); }
  getLastColumn() { return this._maxIndex(false); }
  getMaxRows() { return Math.max(this.maxRows, this.getLastRow()); }
  getMaxColumns() { return Math.max(30, this.getLastColumn()); }

  getRange(row, col, numRows, numCols) {
    return new FakeRange(
      this,
      row,
      col,
      numRows === undefined ? 1 : numRows,
      numCols === undefined ? 1 : numCols
    );
  }

  appendRow(values) {
    const row = this.getLastRow() + 1;
    values.forEach((v, i) => this._set(row, i + 1, v));
  }

  setRowHeight() { return this; }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  setColumnWidth(col, width) { this.colWidths[col] = width; return this; }
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = [];
    this.active = null;
  }

  getSheetByName(name) {
    return this.sheets.filter(function (s) { return s.name === name; })[0] || null;
  }

  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error('duplicate sheet: ' + name);
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }

  getId() { return 'fake-spreadsheet-id'; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/fake-spreadsheet-id/edit'; }
  setActiveSheet(sheet) { this.active = sheet; return sheet; }

  moveActiveSheet(index) {
    if (!this.active) return;
    const from = this.sheets.indexOf(this.active);
    this.sheets.splice(from, 1);
    this.sheets.splice(index - 1, 0, this.active);
  }

  getUi() {
    const menu = {
      addItem: function () { return menu; },
      addToUi: function () { return menu; }
    };
    return { createMenu: function () { return menu; } };
  }
}

function formatDate(date, tz, pattern) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const map = {};
  parts.forEach(function (p) { map[p.type] = p.value; });
  return pattern
    .replace('yyyy', map.year)
    .replace('MM', map.month)
    .replace('dd', map.day)
    .replace('HH', map.hour)
    .replace('mm', map.minute)
    .replace('ss', map.second);
}

// -------------------------------------------------------------------------
// Maps サービスのスタブ
// -------------------------------------------------------------------------
// テストごとに geoPlan を差し替えて、住所検索／逆ジオコーディングの
// 戻り値・ステータス・例外を再現する。

let geoPlan = { calls: [] };

function resetGeoPlan(plan) {
  geoPlan = Object.assign({ calls: [] }, plan || {});
  return geoPlan;
}

function fakeGeocoder() {
  const geocoder = {
    language: 'en',
    region: '',
    setLanguage: function (value) { geocoder.language = value; return geocoder; },
    setRegion: function (value) { geocoder.region = value; return geocoder; },
    _record: function (method, args) {
      if (geoPlan.throwOn) throw new Error(geoPlan.throwOn);
      geoPlan.calls.push({
        method: method,
        args: args,
        language: geocoder.language,
        region: geocoder.region
      });
    },
    geocode: function (address) {
      geocoder._record('geocode', [address]);
      return geoPlan.geocode || { status: 'ZERO_RESULTS', results: [] };
    },
    reverseGeocode: function (lat, lng) {
      geocoder._record('reverseGeocode', [lat, lng]);
      return geoPlan.reverseGeocode || { status: 'ZERO_RESULTS', results: [] };
    }
  };
  return geocoder;
}

/**
 * スクリプト プロパティのスタブ。
 * テストごとに resetScriptProperties() で差し替える。
 */
let scriptProperties = {};

function resetScriptProperties(props) {
  scriptProperties = Object.assign({}, props || {});
  return scriptProperties;
}

const PropertiesService = {
  getScriptProperties: function () {
    return {
      getProperty: function (key) {
        return Object.prototype.hasOwnProperty.call(scriptProperties, key)
          ? scriptProperties[key]
          : null;
      },
      setProperty: function (key, value) {
        scriptProperties[key] = String(value);
        return this;
      },
      deleteProperty: function (key) {
        delete scriptProperties[key];
        return this;
      }
    };
  }
};

// -------------------------------------------------------------------------
// UrlFetchApp のスタブ（Gemini API 呼び出しの検証用）
// -------------------------------------------------------------------------

let fetchPlan = { calls: [] };

function resetFetchPlan(plan) {
  fetchPlan = Object.assign({ calls: [] }, plan || {});
  return fetchPlan;
}

/**
 * URL ごとに応答を切り替える。routes の match（部分一致）が無ければ既定値。
 * 現場環境データは1回の呼び出しで3つのAPIを叩くため、ルーティングが必要。
 */
function pickFetchRoute(url) {
  const routes = fetchPlan.routes || [];
  for (let i = 0; i < routes.length; i++) {
    if (String(url).indexOf(routes[i].match) !== -1) return routes[i];
  }
  return fetchPlan;
}

const UrlFetchApp = {
  fetch: function (url, options) {
    fetchPlan.calls.push({ url: url, options: options });
    const route = pickFetchRoute(url);
    if (route.throwError) throw new Error(route.throwError);
    const code = route.code === undefined ? 200 : route.code;
    const body = route.body === undefined ? '{}' : route.body;
    const bytes = route.bytes || null;
    return {
      getResponseCode: function () { return code; },
      getContentText: function () {
        return typeof body === 'string' ? body : JSON.stringify(body);
      },
      getBlob: function () {
        return {
          getBytes: function () { return bytes || []; },
          getContentType: function () { return route.contentType || 'image/png'; }
        };
      }
    };
  }
};

// -------------------------------------------------------------------------
// StaticMap のスタブ（衛星写真取得の検証用）
// -------------------------------------------------------------------------

let staticMapPlan = { calls: [] };

function resetStaticMapPlan(plan) {
  staticMapPlan = Object.assign({ calls: [] }, plan || {});
  return staticMapPlan;
}

function fakeStaticMap() {
  const map = {
    center: null,
    zoom: null,
    size: null,
    mapType: null,
    setCenter: function (lat, lng) {
      map.center = [lat, lng];
      staticMapPlan.calls.push({ method: 'setCenter', args: [lat, lng] });
      return map;
    },
    setZoom: function (zoom) {
      map.zoom = zoom;
      staticMapPlan.calls.push({ method: 'setZoom', args: [zoom] });
      return map;
    },
    setSize: function (width, height) {
      map.size = [width, height];
      staticMapPlan.calls.push({ method: 'setSize', args: [width, height] });
      return map;
    },
    setMapType: function (type) {
      map.mapType = type;
      staticMapPlan.calls.push({ method: 'setMapType', args: [type] });
      return map;
    },
    getBlob: function () {
      if (staticMapPlan.throwError) throw new Error(staticMapPlan.throwError);
      const bytes = staticMapPlan.bytes || [137, 80, 78, 71];
      return {
        getBytes: function () { return bytes; },
        getContentType: function () { return staticMapPlan.contentType || 'image/png'; }
      };
    }
  };
  return map;
}

const Maps = {
  newGeocoder: function () { return fakeGeocoder(); },
  newStaticMap: function () {
    const map = fakeStaticMap();
    staticMapPlan.last = map;
    return map;
  },
  setAuthenticationByApiKey: function (key) {
    staticMapPlan.apiKey = key;
  },
  StaticMap: { Type: { SATELLITE: 2 } }
};

// -------------------------------------------------------------------------
// テスト用 PNG 生成（DID タイルのスタブ用）
// -------------------------------------------------------------------------
// 地理院タイルは 8bit RGBA の PNG。Code.gs 側の PNG デコーダを検証するため、
// zlib で圧縮した本物の PNG を組み立てる（フィルタ種別も指定できる）。

const CRC_TABLE = (function () {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 8bit RGBA の PNG を組み立てる（非インターレース）。
 *
 * @param {number} width 幅
 * @param {number} height 高さ
 * @param {function(number, number): Array<number>} pixel (x, y) => [r, g, b, a]
 * @param {number} [filterType] 全行に適用する PNG フィルタ種別（0〜4）
 * @return {Buffer} PNG バイト列
 */
function buildPng(width, height, pixel, filterType) {
  const filter = filterType || 0;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  let p = 0;

  for (let y = 0; y < height; y++) {
    raw[p++] = filter;
    for (let x = 0; x < width; x++) {
      const rgba = pixel(x, y);
      for (let i = 0; i < 4; i++) {
        const left = x > 0 ? pixel(x - 1, y)[i] : 0;
        const up = y > 0 ? pixel(x, y - 1)[i] : 0;
        const upLeft = (x > 0 && y > 0) ? pixel(x - 1, y - 1)[i] : 0;
        let pred = 0;
        if (filter === 1) pred = left;
        else if (filter === 2) pred = up;
        else if (filter === 3) pred = Math.floor((left + up) / 2);
        else if (filter === 4) pred = paethPredictor(left, up, upLeft);
        raw[p++] = (rgba[i] - pred) & 0xff;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Code.gs を読み込んだ vm コンテキストを作る。
 *
 * @return {{context: Object, ss: FakeSpreadsheet}} 実行環境
 */
function createContext() {
  resetScriptProperties({});
  resetFetchPlan({});
  resetStaticMapPlan({});

  const ss = new FakeSpreadsheet();
  const SpreadsheetApp = {
    getActiveSpreadsheet: function () { return ss; },
    getUi: function () { return ss.getUi(); }
  };
  const Utilities = {
    formatDate: formatDate,
    base64Encode: function (bytes) {
      return Buffer.from(bytes || []).toString('base64');
    }
  };
  const LockService = {
    getScriptLock: function () {
      return { tryLock: function () { return true; }, releaseLock: function () {} };
    }
  };
  const Logger = { log: function () {} };
  const HtmlService = {
    createTemplateFromFile: function () {
      const output = {
        setTitle: function () { return output; },
        addMetaTag: function () { return output; },
        setXFrameOptionsMode: function () { return output; }
      };
      return { evaluate: function () { return output; } };
    },
    createHtmlOutputFromFile: function () { return { getContent: function () { return ''; } }; },
    XFrameOptionsMode: { ALLOWALL: 1 }
  };

  const ContentService = {
    createTextOutput: function (content) {
      const output = {
        content: String(content === undefined ? '' : content),
        mimeType: '',
        getContent: function () { return output.content; },
        setMimeType: function (mime) {
          output.mimeType = mime;
          return output;
        }
      };
      return output;
    },
    MimeType: { JSON: 'application/json', TEXT: 'text/plain' }
  };

  const context = vm.createContext({
    SpreadsheetApp: SpreadsheetApp,
    Utilities: Utilities,
    LockService: LockService,
    Logger: Logger,
    HtmlService: HtmlService,
    ContentService: ContentService,
    Maps: Maps,
    PropertiesService: PropertiesService,
    UrlFetchApp: UrlFetchApp,
    console: console
  });
  const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  vm.runInContext(code, context, { filename: 'Code.gs' });
  return { context: context, ss: ss };
}

// -------------------------------------------------------------------------
// テスト本体
// -------------------------------------------------------------------------

const ITEM_NAMES = [
  '機体全般', 'プロペラ', 'フレーム',
  '通信系統', '推進系統', '電源系統', '自動制御系統', '操縦装置',
  'バッテリー・燃料', '機体識別表示', 'リモートID', '灯火', 'カメラ'
];

let failures = 0;

function check(condition, label) {
  if (condition) {
    console.log('  ok   ' + label);
  } else {
    failures += 1;
    console.log('  FAIL ' + label);
  }
}

function checkEqual(actual, expected, label) {
  check(actual === expected, label + ' (expected=' + expected + ', actual=' + actual + ')');
}

function checkThrows(fn, label, includeText) {
  try {
    fn();
    check(false, label + '（例外が発生しませんでした）');
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    check(includeText ? msg.indexOf(includeText) !== -1 : true, label + ' -> ' + msg);
  }
}

function buildItems(overrides) {
  const o = overrides || {};
  const items = {};
  ITEM_NAMES.forEach(function (name) { items[name] = o[name] || 'OK'; });
  return items;
}

function baseFlight(overrides) {
  return Object.assign({
    date: '2026-11-01',
    pilotId: 'PLT-0001',
    droneId: 'DRN-0001',
    takeoffPlace: 'テスト飛行場A',
    landingPlace: 'テスト飛行場A',
    takeoffTime: '09:00',
    landingTime: '10:30',
    purpose: '空撮',
    specificFlags: ['目視外', '夜間'],
    safetyEvent: { hasEvent: false, detail: '' }
  }, overrides || {});
}

const { context, ss } = createContext();

console.log('\n[1] シート初期化');
const init = context.initSpreadsheet();
checkEqual(init.created.length, 4, '4シートを作成');
check(!!ss.getSheetByName('m_drones'), 'm_drones が存在');
check(!!ss.getSheetByName('m_pilots'), 'm_pilots が存在');
check(!!ss.getSheetByName('t_flights'), 't_flights が存在');
check(!!ss.getSheetByName('t_inspections'), 't_inspections が存在');
checkEqual(ss.getSheetByName('t_flights').getLastColumn(), 17, 't_flights の列数は17（立入管理措置・飛行カテゴリーを追加）');
checkEqual(ss.getSheetByName('t_inspections').getLastColumn(), 10, 't_inspections の列数は10');
checkEqual(ss.getSheetByName('m_drones').frozenRows, 1, 'ヘッダー行を固定');
const reinit = context.initSpreadsheet();
checkEqual(reinit.created.length, 0, '再実行してもシートを重複作成しない');
checkEqual(reinit.headersAdded.length, 0, '再実行してもヘッダーを重複追加しない');

console.log('\n[2] マスタ登録');
const pilot = context.savePilot({ name: '普施 太郎', licenseNo: 'JP1234567890', contact: '090-0000-0000' });
checkEqual(pilot.pilotId, 'PLT-0001', '操縦者IDは PLT-0001');
const drone1 = context.saveDrone({
  modelName: 'DJI Mavic 3 Enterprise',
  maker: 'DJI',
  weightG: 920,
  registrationNo: 'JU1234567890',
  serialNo: 'SN-M3E-001'
});
checkEqual(drone1.droneId, 'DRN-0001', '機体IDは DRN-0001');
const drone2 = context.saveDrone({ modelName: 'DJI Mini 4 Pro', weightG: 249, serialNo: 'SN-M4P-001' });
checkEqual(drone2.droneId, 'DRN-0002', '機体IDは連番で DRN-0002');
checkThrows(function () {
  context.saveDrone({ modelName: '重複機体', serialNo: 'SN-M3E-001' });
}, '製造番号の重複を拒否', '登録済み');
checkThrows(function () {
  context.savePilot({ name: '重複操縦者', licenseNo: 'JP1234567890' });
}, '技能証明書番号の重複を拒否', '登録済み');

console.log('\n[3] 飛行記録と日常点検の同時保存');
const f1 = context.saveFlightRecord({
  flight: baseFlight({}),
  inspection: {
    type: '飛行前',
    date: '2026-11-01',
    inspector: '普施 太郎',
    memo: '異常なし',
    items: buildItems()
  }
});
checkEqual(f1.flightId, 'FLT-0001', '飛行IDは FLT-0001');
checkEqual(f1.inspectionId, 'INS-0001', '点検IDは INS-0001');
checkEqual(f1.durationMin, 90, '09:00-10:30 は 90分');
checkEqual(f1.inspectionResult, '合格', '全項目OKなら合格');
checkEqual(f1.cumulativeMinutes, 90, '累計飛行時間は 90分');
checkEqual(f1.drone.level, 'ok', 'アラートは ok');
checkEqual(f1.drone.basisLabel, '累計飛行時間', '点検前は累計で判定');

console.log('\n[4] 日跨ぎ・特定飛行区分・安全影響事象');
const f2 = context.saveFlightRecord({
  flight: baseFlight({
    date: '2026-11-02',
    takeoffTime: '22:30',
    landingTime: '00:15',
    specificFlags: ['非特定飛行', '目視外'],
    safetyEvent: { hasEvent: true, detail: 'バッテリー低下により自動帰還' }
  }),
  inspection: {
    type: '飛行後',
    inspector: '普施 太郎',
    result: '合格',
    items: buildItems({ 'プロペラ': 'NG' })
  }
});
checkEqual(f2.durationMin, 105, '22:30-00:15 は 105分（日跨ぎ）');
checkEqual(f2.inspectionResult, '異常あり', 'NGが1件でも異常ありに強制');
const listAfter = context.getFlights({});
checkEqual(listAfter.total, 2, '飛行記録は2件');
checkEqual(listAfter.items[0].flightId, 'FLT-0002', '一覧は新しい順');
checkEqual(listAfter.items[0].specificFlags.join('、'), '目視外', '非特定飛行は他区分と併用しない');
checkEqual(listAfter.items[0].safetyEvent, 'あり：バッテリー低下により自動帰還', '安全影響事象を整形');
checkEqual(listAfter.items[0].hasSafetyEvent, true, '安全影響事象フラグ');
checkEqual(listAfter.items[0].inspections.length, 1, '飛行に点検が紐づく');
checkEqual(listAfter.items[1].specificFlags.join('、'), '目視外、夜間', '複数区分を保持');
checkEqual(context.getFlights({ q: '夜間' }).total, 1, '全文検索でヒット');
checkEqual(context.getFlights({ droneId: 'DRN-0002' }).total, 0, '機体で絞り込み');
checkEqual(context.getFlights({ from: '2026-11-02' }).total, 1, '期間で絞り込み');

console.log('\n[5] 20時間定期点検とアラート判定');
const periodic = context.saveInspection({
  droneId: 'DRN-0001',
  type: '20時間定期点検',
  date: '2026-11-02',
  inspector: '普施 太郎',
  result: '合格',
  memo: '20時間点検を実施'
});
checkEqual(periodic.inspectionId, 'INS-0003', '点検IDは INS-0003');
const afterPeriodic = context.getDrones()[0];
checkEqual(afterPeriodic.basisMinutes, 0, '点検直後の基準時間は0分');
checkEqual(afterPeriodic.totalMinutes, 195, '累計は保持される');
checkEqual(afterPeriodic.basisLabel, '前回の20時間点検以降', '判定基準が点検後に切り替わる');
checkEqual(afterPeriodic.lastInspectionDate, '2026-11-02', '直近点検日を保持');

context.saveFlightRecord({
  flight: baseFlight({ date: '2026-11-03', takeoffTime: '00:00', landingTime: '01:00' })
});
context.saveFlightRecord({
  flight: baseFlight({
    date: '2026-11-04',
    takeoffTime: '15:00',
    landingTime: '06:00',
    specificFlags: ['非特定飛行']
  })
});
const warnDrone = context.getDrones()[0];
checkEqual(warnDrone.basisMinutes, 960, '点検後 960分（60 + 900）');
checkEqual(warnDrone.level, 'warn', '960分で警告');
checkEqual(warnDrone.remainingMinutes, 240, '残り240分');
checkEqual(warnDrone.progress, 80, '進捗80%');

context.saveFlightRecord({
  flight: baseFlight({ date: '2026-11-05', takeoffTime: '00:00', landingTime: '04:00' })
});
const overDrone = context.getDrones()[0];
checkEqual(overDrone.basisMinutes, 1200, '点検後 1200分');
checkEqual(overDrone.level, 'over', '1200分で超過');
checkEqual(overDrone.remainingMinutes, 0, '残り0分');
checkEqual(overDrone.progress, 100, '進捗100%で頭打ち');
checkEqual(overDrone.totalMinutes, 1395, '累計は 1395分');
checkEqual(overDrone.totalHours, 23.3, '時間表示は小数1桁');

console.log('\n[6] CSV 出力（様式1）');
const csv = context.buildDipsCsv({});
checkEqual(csv.count, 5, '5件を出力');
checkEqual(csv.columns.length, 18, '様式1の列数は18');
checkEqual(csv.content.charCodeAt(0), 0xFEFF, 'BOM付き');
check(csv.content.indexOf('\r\n') !== -1, 'CRLF 改行');
const csvLines = csv.content.split('\r\n').filter(function (l) { return l !== ''; });
checkEqual(csvLines.length, 6, 'ヘッダー + 5行');
check(csvLines[0].indexOf('"飛行年月日"') !== -1, '全セルを引用符で囲む');
check(csvLines[1].indexOf('"FLT-0001"') !== -1, '昇順の先頭は FLT-0001');
check(csvLines[1].indexOf('"90"') !== -1, '飛行時間90分');
check(csvLines[5].indexOf('"1395"') !== -1, '最終行の累計は1395');
const partialCsv = context.buildDipsCsv({ from: '2026-11-04' });
const partialLines = partialCsv.content.split('\r\n').filter(function (l) { return l !== ''; });
checkEqual(partialCsv.count, 2, '期間絞り込みで2件');
check(partialLines[1].indexOf('"1155"') !== -1, '期間外の飛行も累計に含める（1155）');
check(partialLines[2].indexOf('"1395"') !== -1, '期間内最終行の累計は1395');

console.log('\n[7] CSV エスケープ');
checkEqual(context.csvCell_('=SUM(A1)'), '"\'=SUM(A1)"', '数式インジェクションを無効化');
checkEqual(context.csvCell_(-5), '"-5"', '負の数はそのまま');
checkEqual(context.csvCell_('a,b"c\nd'), '"a,b""c\nd"', 'カンマ・引用符・改行を処理');
checkEqual(context.csvCell_(null), '""', 'null は空セル');

console.log('\n[8] CSV 出力（様式2・3）');
const inspectionCsv = context.buildInspectionCsv({});
checkEqual(inspectionCsv.count, 3, '点検3件を出力');
checkEqual(inspectionCsv.columns.length, 22, '固定9列 + 13項目');

console.log('\n[9] 入力バリデーション');
checkThrows(function () {
  context.saveFlightRecord({ flight: baseFlight({ date: '' }) });
}, '飛行年月日の必須チェック', '飛行年月日');
checkThrows(function () {
  context.saveFlightRecord({ flight: baseFlight({ pilotId: 'PLT-9999' }) });
}, '未登録の操縦者を拒否', 'マスタに登録');
const missingItems = buildItems();
delete missingItems['カメラ'];
checkThrows(function () {
  context.saveFlightRecord({
    flight: baseFlight({ date: '2026-11-06' }),
    inspection: { type: '飛行前', inspector: '普施 太郎', items: missingItems }
  });
}, '点検項目の未入力を拒否', '未入力');
checkThrows(function () {
  context.saveFlightRecord({
    flight: baseFlight({ date: '2026-11-06', safetyEvent: { hasEvent: true, detail: '' } })
  });
}, '安全影響事象の詳細必須', '内容を入力');

console.log('\n[10] ブートストラップと再計算');
const boot = context.getBootstrapData();
checkEqual(boot.drones.length, 2, '機体2台');
checkEqual(boot.pilots.length, 1, '操縦者1名');
checkEqual(boot.stats.totalFlights, 5, '総飛行5件');
checkEqual(boot.stats.totalMinutes, 1395, '総飛行時間1395分');
checkEqual(boot.stats.alertDrones, 1, 'アラート対象1台');
checkEqual(boot.catalog.inspectionGroups.length, 3, '点検項目は3グループ');
checkEqual(boot.flights.length, 5, '直近の飛行を返す');

// 累計セルを壊してから再計算する
ss.getSheetByName('m_drones')._set(2, 7, 999999);
const recalc = context.recalcDroneTotals();
checkEqual(recalc.count, 2, '2台を再計算');
checkEqual(context.getDrones()[0].totalMinutes, 1395, '再計算で1395分に戻る');

console.log('\n[11] ジオコーディング（Maps サービス）');

const geoPlanHit = resetGeoPlan({
  geocode: {
    status: 'OK',
    results: [
      {
        formatted_address: '日本、千葉県香取市',
        geometry: { location: { lat: 35.0, lng: 140.0 }, location_type: 'APPROXIMATE' }
      },
      {
        formatted_address: '日本、〒289-0313 千葉県香取市小見川',
        partial_match: false,
        geometry: { location: { lat: 35.854123456, lng: 140.598765432 }, location_type: 'ROOFTOP' }
      }
    ]
  }
});
const geoHit = context.fetchGeoFromAddress('  千葉県  香取市小見川  ');
checkEqual(geoHit.ok, true, '住所検索は ok を返す');
checkEqual(geoHit.lat, 35.854123, '精度の高い候補を採用し小数6桁に丸める');
checkEqual(geoHit.lng, 140.598765, '経度も小数6桁に丸める');
checkEqual(geoHit.formattedAddress, '日本、〒289-0313 千葉県香取市小見川', '整形済み住所を返す');
checkEqual(geoHit.address, '千葉県 香取市小見川', '連続空白を1つに畳んで問い合わせる');
checkEqual(geoHit.partial, false, 'partial_match をそのまま返す');
checkEqual(geoHit.status, 'OK', 'ステータスを返す');
checkEqual(geoPlanHit.calls.length, 1, 'ジオコーダ呼び出しは1回');
checkEqual(geoPlanHit.calls[0].method, 'geocode', 'geocode を呼ぶ');
checkEqual(geoPlanHit.calls[0].args[0], '千葉県 香取市小見川', '正規化した住所を渡す');
checkEqual(geoPlanHit.calls[0].language, 'ja', '日本語で問い合わせる');
checkEqual(geoPlanHit.calls[0].region, 'JP', '日本リージョンで問い合わせる');

resetGeoPlan({ geocode: { status: 'ZERO_RESULTS', results: [] } });
checkThrows(function () {
  context.fetchGeoFromAddress('存在しない住所');
}, 'ZERO_RESULTS は住所なしエラー', '住所が見つかりませんでした');

resetGeoPlan({ geocode: { status: 'OVER_QUERY_LIMIT', results: [] } });
checkThrows(function () {
  context.fetchGeoFromAddress('千葉県香取市');
}, '割り当て超過はステータス付きエラー', 'OVER_QUERY_LIMIT');

resetGeoPlan({ throwOn: 'Service invoked too many times' });
checkThrows(function () {
  context.fetchGeoFromAddress('千葉県香取市');
}, 'Maps の例外は案内メッセージに変換', 'Maps サービスの割り当て');

resetGeoPlan({});
checkThrows(function () {
  context.fetchGeoFromAddress('   ');
}, '空白のみの住所を拒否', '住所を入力');
checkThrows(function () {
  context.fetchGeoFromAddress(null);
}, 'null の住所を拒否', '住所を入力');
checkEqual(geoPlan.calls.length, 0, '住所が空なら Maps を呼ばない');

const geoPlanRev = resetGeoPlan({
  reverseGeocode: {
    status: 'OK',
    partial_match: undefined,
    results: [
      {
        formatted_address: '日本、〒289-0313 千葉県香取市小見川',
        geometry: { location: { lat: 35.854, lng: 140.598 }, location_type: 'ROOFTOP' }
      }
    ]
  }
});
const geoRev = context.fetchAddressFromGeo(35.8541, 140.5981);
checkEqual(geoRev.ok, true, '逆ジオコーディングは ok を返す');
checkEqual(geoRev.address, '日本、〒289-0313 千葉県香取市小見川', '座標から住所を返す');
checkEqual(geoRev.formattedAddress, geoRev.address, 'formattedAddress も同じ住所');
checkEqual(geoRev.lat, 35.8541, '入力の緯度を保持');
checkEqual(geoRev.lng, 140.5981, '入力の経度を保持');
checkEqual(geoPlanRev.calls[0].method, 'reverseGeocode', 'reverseGeocode を呼ぶ');
checkEqual(geoPlanRev.calls[0].args[0], 35.8541, '緯度は数値で渡す');
checkEqual(geoPlanRev.calls[0].args[1], 140.5981, '経度は数値で渡す');
checkEqual(geoPlanRev.calls[0].language, 'ja', '逆ジオコーディングも日本語');

checkThrows(function () {
  context.fetchAddressFromGeo(91, 140);
}, '緯度の範囲外を拒否', '緯度は -90〜90');
checkThrows(function () {
  context.fetchAddressFromGeo(35, 181);
}, '経度の範囲外を拒否', '経度は -180〜180');
checkThrows(function () {
  context.fetchAddressFromGeo('', '');
}, '空の座標を拒否', '数値で指定');
checkThrows(function () {
  context.fetchAddressFromGeo('abc', 'def');
}, '数値でない座標を拒否', '数値で指定');

resetGeoPlan({ reverseGeocode: { status: 'ZERO_RESULTS', results: [] } });
checkThrows(function () {
  context.fetchAddressFromGeo(0, 0);
}, 'ZERO_RESULTS は住所なしエラー', '住所は見つかりませんでした');

resetGeoPlan({
  reverseGeocode: {
    status: 'OK',
    results: [{
      formatted_address: '日本、東京都千代田区',
      geometry: { location: { lat: 35.68, lng: 139.76 }, location_type: 'ROOFTOP' }
    }]
  }
});
const compat = context.fetchGeoInfo(35.68, 139.76);
checkEqual(compat.address, '日本、東京都千代田区', 'fetchGeoInfo は住所を返す');
checkEqual(compat.isDID, null, 'DID 判定は未実装（null）');
checkEqual(compat.restrictions.length, 0, '制限エリアは空配列');
checkEqual(compat.lat, 35.68, 'fetchGeoInfo も緯度を返す');

console.log('\n[12] 特定飛行10項目とカテゴリー判定');

const catalogAtStart = context.getCatalog_();
const flagDefs = catalogAtStart.specificFlagDefs;
checkEqual(flagDefs.length, 10, '特定飛行の項目は10');
checkEqual(flagDefs.filter(function (d) { return d.group === 'airspace'; }).length, 4, '空域の項目は4');
checkEqual(flagDefs.filter(function (d) { return d.group === 'method'; }).length, 6, '飛行方法の項目は6');
checkEqual(catalogAtStart.specificOptions.length, 11, '選択肢は10項目＋非特定飛行');

const optionLabels = catalogAtStart.specificOptions;
['DID（人口集中地区）', '夜間', '目視外', '人・物件から30m未満'].forEach(function (label) {
  check(optionLabels.indexOf(label) !== -1, '既存ラベルを維持: ' + label);
});
checkEqual(flagDefs[2].label, '150m以上', '150m以上の保存ラベル');

const catI = context.judgeFlightCategory({ flags: ['非特定飛行'], weightG: 920, hasClearZone: true });
checkEqual(catI.category, 'I', '非特定飛行はカテゴリーⅠ');
checkEqual(catI.level, 'good', 'レベルは good');
checkEqual(catI.procedures.length, 1, '手続きガイダンスを1件返す');
check(catI.procedures[0].indexOf('許可・承認申請は不要') !== -1, 'Ⅰは申請不要を案内');

const catSoft = context.judgeFlightCategory({ flags: ['目視外', '夜間'], weightG: 920, hasClearZone: true });
checkEqual(catSoft.category, 'IIB', '目視外＋夜間＋25kg未満はⅡB');
checkEqual(catSoft.weightLabel, '25kg未満', '25kg未満を返す');

const catDid = context.judgeFlightCategory({ flags: ['DID（人口集中地区）'], weightG: 920, hasClearZone: true });
checkEqual(catDid.category, 'IIB', 'DID のみはⅡB（ⅡA を決定づけない）');

const catHard = context.judgeFlightCategory({ flags: ['150m以上'], weightG: 920, hasClearZone: true });
checkEqual(catHard.category, 'IIA', '150m以上はⅡA');
check(catHard.procedures[0].indexOf('機体認証') !== -1, 'ⅡA は機体認証を案内');

checkEqual(context.judgeFlightCategory({ flags: ['イベント上空'], weightG: 920 }).category, 'IIA', 'イベント上空はⅡA');
checkEqual(context.judgeFlightCategory({ flags: ['危険物輸送'], weightG: 920 }).category, 'IIA', '危険物輸送はⅡA');
checkEqual(context.judgeFlightCategory({ flags: ['物件投下'], weightG: 920 }).category, 'IIA', '物件投下はⅡA');
checkEqual(context.judgeFlightCategory({ flags: ['空港周辺'], weightG: 920 }).category, 'IIA', '空港周辺はⅡA');
checkEqual(context.judgeFlightCategory({ flags: ['緊急用務空域'], weightG: 920 }).category, 'IIA', '緊急用務空域はⅡA');

const catBoundary = context.judgeFlightCategory({ flags: ['夜間'], weightG: 25000, hasClearZone: true });
checkEqual(catBoundary.category, 'IIA', '25kgちょうどはⅡA');
checkEqual(catBoundary.weightLabel, '25kg以上', '25kg以上を返す');
checkEqual(context.judgeFlightCategory({ flags: ['夜間'], weightG: 24999 }).category, 'IIB', '24999g はⅡB');

const catIII = context.judgeFlightCategory({ flags: ['夜間'], weightG: 920, hasClearZone: false });
checkEqual(catIII.category, 'III', '立入管理措置なしはⅢ');
check(catIII.reasons.indexOf('立入管理措置なし') !== -1, 'Ⅲの理由に立入管理措置なしを含む');
check(catIII.procedures[0].indexOf('一等無人航空機操縦士') !== -1, 'Ⅲは一等資格を案内');
checkEqual(context.judgeFlightCategory({ flags: ['未知の区分'] }).category, 'I', '未知の項目は無視してⅠ');

const heavyDrone = context.saveDrone({ modelName: '重量機体', weightG: 25000, serialNo: 'SN-HEAVY-001' });
const saveNight = context.saveFlightRecord({
  flight: baseFlight({ date: '2026-11-06', specificFlags: ['夜間'], hasClearZone: true })
});
checkEqual(saveNight.category, 'カテゴリーⅡB', '920g機の夜間はⅡBで保存');
checkEqual(saveNight.hasClearZone, true, '立入管理措置ありを返す');

const saveHeavy = context.saveFlightRecord({
  flight: baseFlight({ date: '2026-11-06', droneId: heavyDrone.droneId, specificFlags: ['夜間'] })
});
checkEqual(saveHeavy.category, 'カテゴリーⅡA', '25kg機の夜間はⅡAで保存');

const saveNoZone = context.saveFlightRecord({
  flight: baseFlight({ date: '2026-11-07', specificFlags: ['目視外'], hasClearZone: false })
});
checkEqual(saveNoZone.category, 'カテゴリーⅢ', '立入管理なしはⅢで保存');
checkEqual(saveNoZone.hasClearZone, false, '立入管理措置なしを返す');

const saveEmpty = context.saveFlightRecord({
  flight: baseFlight({ date: '2026-11-07', specificFlags: [] })
});
checkEqual(saveEmpty.specificFlags, '非特定飛行', '未選択は非特定飛行で保存');
checkEqual(saveEmpty.category, 'カテゴリーⅠ', '未選択はⅠで保存');

const saveAlias = context.saveFlightRecord({
  flight: baseFlight({ date: '2026-11-08', specificFlags: ['bovlos', 'altitude150m'] })
});
checkEqual(saveAlias.specificFlags, '目視外、150m以上', 'キー入力を保存ラベルへ正規化');
checkEqual(saveAlias.category, 'カテゴリーⅡA', '正規化後の項目で判定する');

const flightSheet = ss.getSheetByName('t_flights');
const flightHeaders = flightSheet.getRange(1, 1, 1, flightSheet.getLastColumn()).getValues()[0];
check(flightHeaders.indexOf('立入管理措置') !== -1, 'ヘッダーに立入管理措置を追加');
check(flightHeaders.indexOf('飛行カテゴリー') !== -1, 'ヘッダーに飛行カテゴリーを追加');

const lastValues = flightSheet.getRange(flightSheet.getLastRow(), 1, 1, flightSheet.getLastColumn()).getValues()[0];
const lastRecord = {};
flightHeaders.forEach(function (h, i) { lastRecord[h] = lastValues[i]; });
checkEqual(lastRecord['飛行カテゴリー'], 'カテゴリーⅡA', 'シートに飛行カテゴリーを保存');
checkEqual(lastRecord['立入管理措置'], 'あり', 'シートに立入管理措置を保存');

const collected = context.getFlights({ limit: 500 });
const collectedNoZone = collected.items.filter(function (i) { return i.flightId === saveNoZone.flightId; })[0];
checkEqual(collectedNoZone.category, 'カテゴリーⅢ', '一覧にもカテゴリーを返す');
checkEqual(collectedNoZone.hasClearZone, false, '一覧にも立入管理措置を返す');

const catalog = context.getCatalog_();
checkEqual(catalog.specificFlagDefs.length, 10, 'カタログに10項目を返す');
checkEqual(catalog.categoryMeta.IIB.label, 'カテゴリーⅡB', 'カタログにカテゴリーメタを返す');
checkEqual(catalog.categoryProcedures.III.length, 1, 'カタログに手続き文言を返す');

console.log('\n[13] Gemini 画像リスク判定');

resetScriptProperties({});
checkThrows(function () {
  context.analyzeRiskFromCoordinates(35.68, 139.76);
}, 'APIキー未設定はエラー', 'GEMINI_API_KEY');

resetScriptProperties({ GEMINI_API_KEY: 'test-key-123' });
checkThrows(function () {
  context.analyzeRiskFromCoordinates('abc', 139.76);
}, '緯度が数値でない場合はエラー', '数値で指定');
checkThrows(function () {
  context.analyzeRiskFromCoordinates(35.68, 181);
}, '経度の範囲外はエラー', '範囲が不正');

const geminiBody = {
  candidates: [{
    content: {
      parts: [{
        text: '```json\n' + JSON.stringify({
          riskLevel: 'HIGH',
          detectedObjects: [
            { objectType: '人', description: '南側に2名', risk: 'HIGH' },
            { objectType: '車両', description: '東側に1台', risk: 'LOW' }
          ],
          suggestedFlags: { within30m: true, did: true, altitude150m: false, event: false },
          summary: '第三者が近接しています。',
          actionableAdvice: ['補助者を配置する', '離陸を待つ']
        }) + '\n```'
      }]
    }
  }]
};

resetStaticMapPlan({ bytes: [1, 2, 3], contentType: 'image/jpeg' });
resetFetchPlan({ body: geminiBody });

const sat = context.analyzeRiskFromCoordinates(35.681236, 139.767125);
checkEqual(sat.ok, true, '衛星診断は ok を返す');
checkEqual(sat.source, 'satellite', 'source は satellite');
checkEqual(sat.riskLevel, 'HIGH', 'リスクは HIGH');
checkEqual(sat.riskLabel, '高リスク', '日本語ラベルを返す');
checkEqual(sat.detectedObjects.length, 2, '検出物体を2件返す');
checkEqual(sat.suggestedFlags.within30m, true, '30m未満フラグを返す');
checkEqual(sat.suggestedFlags.altitude150m, false, '未検出フラグは false');
checkEqual(sat.actionableAdvice.length, 2, '助言を返す');
checkEqual(sat.satelliteImageUrl.indexOf('data:image/jpeg;base64,'), 0, '衛星画像をdata URIで返す');
checkEqual(staticMapPlan.calls[0].method, 'setCenter', 'setCenter を呼ぶ');
checkEqual(staticMapPlan.calls[0].args[0], 35.681236, 'setCenter に緯度を渡す');
checkEqual(staticMapPlan.calls[1].args[0], 19, 'ズーム19で取得');
checkEqual(staticMapPlan.calls[2].args[0], 600, '600pxで取得');
checkEqual(staticMapPlan.last.mapType, 2, '地図種別は SATELLITE');
check(fetchPlan.calls[0].url.indexOf('gemini-2.5-flash') !== -1, 'モデルは gemini-2.5-flash');
check(fetchPlan.calls[0].url.indexOf('key=test-key-123') !== -1, 'APIキーをクエリに付与');
const sentPayload = JSON.parse(fetchPlan.calls[0].options.payload);
checkEqual(sentPayload.generation_config.response_mime_type, 'application/json', 'JSON応答を要求');
checkEqual(sentPayload.contents[0].parts[1].inline_data.mime_type, 'image/jpeg', '画像MIMEを送信');
checkEqual(sentPayload.contents[0].parts[1].inline_data.data, Buffer.from([1, 2, 3]).toString('base64'), '画像をbase64で送信');

resetFetchPlan({ body: geminiBody });
const photo = context.analyzeRiskFromImage('data:image/png;base64,' + Buffer.from([9, 8, 7]).toString('base64'));
checkEqual(photo.source, 'photo', 'source は photo');
checkEqual(photo.satelliteImageUrl, null, '現場写真は衛星画像を返さない');
const photoPayload = JSON.parse(fetchPlan.calls[0].options.payload);
checkEqual(photoPayload.contents[0].parts[1].inline_data.mime_type, 'image/png', 'data URI からMIMEを判定');
checkEqual(photoPayload.contents[0].parts[1].inline_data.data, Buffer.from([9, 8, 7]).toString('base64'), 'data URI からbase64を取り出す');

const legacy = context.analyzeRiskWithGemini(Buffer.from([5, 5]).toString('base64'), 'image/jpeg');
checkEqual(legacy.source, 'photo', '後方互換APIも動作する');

checkThrows(function () {
  context.analyzeRiskFromImage('');
}, '空画像はエラー', '空です');
checkThrows(function () {
  context.analyzeRiskFromImage('data:text/plain;base64,AAAA');
}, '画像以外はエラー', '画像ファイルではありません');

resetFetchPlan({ code: 401, body: JSON.stringify({ error: { message: 'API key not valid' } }) });
checkThrows(function () {
  context.analyzeRiskFromImage('AAAA');
}, '401 はキーエラー', 'GEMINI_API_KEY');

resetFetchPlan({ code: 429, body: '{}' });
checkThrows(function () {
  context.analyzeRiskFromImage('AAAA');
}, '429 は利用上限', '利用上限');

resetFetchPlan({ code: 500, body: 'oops' });
checkThrows(function () {
  context.analyzeRiskFromImage('AAAA');
}, '500 は一時的なエラー', '一時的なエラー');

resetFetchPlan({ body: { candidates: [] } });
checkThrows(function () {
  context.analyzeRiskFromImage('AAAA');
}, '候補なしはエラー', '解析結果が返りません');

resetFetchPlan({ body: { candidates: [{ content: { parts: [{ text: 'JSON ではありません' }] } }] } });
checkThrows(function () {
  context.analyzeRiskFromImage('AAAA');
}, 'JSONでない応答はエラー', '解釈できません');

resetFetchPlan({ throwError: 'DNS エラー' });
checkThrows(function () {
  context.analyzeRiskFromImage('AAAA');
}, '通信失敗はエラー', '通信に失敗');

resetScriptProperties({ GEMINI_API_KEY: 'k', GOOGLE_MAPS_API_KEY: 'maps-key' });
resetStaticMapPlan({});
resetFetchPlan({ body: geminiBody });
context.analyzeRiskFromCoordinates(35, 139);
checkEqual(staticMapPlan.apiKey, 'maps-key', 'GOOGLE_MAPS_API_KEY があれば StaticMap を認証');

console.log('\n[14] 現場環境データ（天候・標高・DID）');

const weatherBody = {
  current: {
    time: '2026-11-06T20:00',
    temperature_2m: 18.5,
    relative_humidity_2m: 58,
    precipitation: 0,
    weather_code: 2,
    wind_speed_10m: 3.2,
    wind_gusts_10m: 5.1
  }
};

// DID タイル: 左半分を DID 内（地理院タイルと同じ赤 / alpha 102）、他は透明
// 対象ピクセルは (66, 139) なので、左半分に入るようにしている
const didTile = buildPng(256, 256, function (x) {
  return x < 128 ? [250, 0, 0, 102] : [0, 0, 0, 0];
});
const noDidTile = buildPng(256, 256, function () { return [0, 0, 0, 0]; });

function envRoutes(overrides) {
  const o = overrides || {};
  const route = function (match, extra) {
    return Object.assign({ match: match }, extra);
  };
  return {
    routes: [
      route('api.open-meteo.com', {
        body: o.weather || weatherBody,
        code: o.weatherCode === undefined ? 200 : o.weatherCode,
        throwError: o.weatherThrow
      }),
      route('getelevation.php', {
        body: o.elevation || { elevation: 12.4, hsrc: '5m（標高）' },
        code: o.elevationCode === undefined ? 200 : o.elevationCode,
        throwError: o.elevationThrow
      }),
      route('did2020', {
        bytes: o.didBytes === undefined ? didTile : o.didBytes,
        code: o.didCode === undefined ? 200 : o.didCode,
        throwError: o.didThrow
      })
    ]
  };
}

resetScriptProperties({});

const tile = context.latLngToTilePixel_(35.6861, 139.764, 16);
checkEqual(tile.x, 58211, 'タイルX座標（ズーム16）');
checkEqual(tile.y, 25805, 'タイルY座標（ズーム16）');
checkEqual(tile.px, 66, 'タイル内Xピクセル');
checkEqual(tile.py, 139, 'タイル内Yピクセル');

resetFetchPlan(envRoutes({}));
const env = context.fetchFlightEnvironment(35.6861, 139.764);
checkEqual(env.ok, true, '環境取得は ok を返す');
checkEqual(env.weather.text, '薄曇り', '天候コード2は薄曇り');
checkEqual(env.weather.temperature, 18.5, '気温を返す');
checkEqual(env.weather.windSpeed, 3.2, '風速を返す');
checkEqual(env.weather.windGust, 5.1, '突風を返す');
checkEqual(env.weather.safetyStatus, 'GOOD', '風速3.2m/sはGOOD');
checkEqual(env.weather.safetyLabel, '飛行適性: 良好（安全圏）', 'GOODのラベル');
checkEqual(env.elevation.groundElevation, 12.4, '海抜標高を返す');
checkEqual(env.elevation.max150mLimit, 162.4, '150m規制の上限を算出');
checkEqual(env.regulations.isDID, true, 'DID内を判定');
checkEqual(env.regulations.note, '人口集中地区（DID）内', 'DID内の注記');
checkEqual(env.sources.weather, 'Open-Meteo', '取得元を返す');
check(fetchPlan.calls.length === 3, '3つのAPIを1回ずつ呼ぶ');
check(fetchPlan.calls[0].url.indexOf('wind_speed_unit=ms') !== -1, '風速単位はm/sで要求');
check(fetchPlan.calls[0].url.indexOf('timezone=Asia%2FTokyo') !== -1, 'タイムゾーンはAsia/Tokyo');
check(fetchPlan.calls[1].url.indexOf('outtype=JSON') !== -1, '標高APIはJSONで要求');
check(fetchPlan.calls[2].url.indexOf('did2020/16/58211/25805.png') !== -1, 'DIDタイルのURLを組み立てる');

resetFetchPlan(envRoutes({ didBytes: noDidTile }));
checkEqual(context.fetchFlightEnvironment(35.6861, 139.764).regulations.isDID, false,
  '透明ピクセルはDID外');

resetFetchPlan(envRoutes({ didCode: 404, didBytes: null }));
const outside = context.fetchFlightEnvironment(35.68, 139.76);
checkEqual(outside.regulations.isDID, false, 'タイル404はDID外');
checkEqual(outside.regulations.note, '人口集中地区（DID）外', 'DID外の注記');

resetFetchPlan(envRoutes({ didThrow: 'DNS エラー' }));
const unknown = context.fetchFlightEnvironment(35.68, 139.76);
checkEqual(unknown.regulations.isDID, null, '通信失敗時はDID判定不能（null）');
check(unknown.regulations.note.indexOf('判定できませんでした') !== -1, 'DID判定不能の注記');

resetFetchPlan(envRoutes({ didBytes: Buffer.from([1, 2, 3]) }));
const brokenTile = context.fetchFlightEnvironment(35.68, 139.76);
checkEqual(brokenTile.regulations.isDID, null, 'PNGでないタイルは判定不能');
check(brokenTile.regulations.note.indexOf('解析できません') !== -1, '画像解析失敗の注記');

resetFetchPlan(envRoutes({ elevation: { elevation: null } }));
const noElevation = context.fetchFlightEnvironment(35.68, 139.76);
checkEqual(noElevation.elevation.groundElevation, null, '標高なしはnull');
checkEqual(noElevation.elevation.max150mLimit, null, '標高なしは上限もnull');
check(noElevation.elevation.note.indexOf('標高データがありません') !== -1, '標高なしの注記');

resetFetchPlan(envRoutes({ elevationCode: 503 }));
checkEqual(context.fetchFlightEnvironment(35.68, 139.76).elevation.groundElevation, null,
  '標高APIのエラーは例外にしない');

resetFetchPlan(envRoutes({ weatherCode: 500 }));
checkThrows(function () {
  context.fetchFlightEnvironment(35.68, 139.76);
}, '天候のHTTPエラーは例外', 'HTTP 500');

resetFetchPlan(envRoutes({ weatherThrow: 'DNS エラー' }));
checkThrows(function () {
  context.fetchFlightEnvironment(35.68, 139.76);
}, '天候の通信失敗は例外', '接続できません');

resetFetchPlan(envRoutes({ weather: {} }));
checkThrows(function () {
  context.fetchFlightEnvironment(35.68, 139.76);
}, 'current が無い応答は例外', '天候情報が空');

resetFetchPlan(envRoutes({ weather: { current: { temperature_2m: 20 } } }));
checkThrows(function () {
  context.fetchFlightEnvironment(35.68, 139.76);
}, '風速が無い応答は例外', '風速を取得できません');

checkThrows(function () {
  context.fetchFlightEnvironment('abc', 139.76);
}, '緯度が数値でない場合はエラー', '数値で指定');
checkThrows(function () {
  context.fetchFlightEnvironment(35.68, 181);
}, '経度の範囲外はエラー', '範囲で指定');
checkThrows(function () {
  context.fetchFlightEnvironment(91, 139.76);
}, '緯度の範囲外はエラー', '-90〜90');

checkEqual(context.judgeWindSafety_(0).status, 'GOOD', '風速0m/sはGOOD');
checkEqual(context.judgeWindSafety_(4.9).status, 'GOOD', '風速4.9m/sはGOOD');
checkEqual(context.judgeWindSafety_(5.0).status, 'CAUTION', '風速5.0m/sはCAUTION');
checkEqual(context.judgeWindSafety_(6.9).status, 'CAUTION', '風速6.9m/sはCAUTION');
checkEqual(context.judgeWindSafety_(7.0).status, 'DANGER', '風速7.0m/sはDANGER');
checkEqual(context.judgeWindSafety_(12).label, '危険: 風速7m/s以上（飛行中止を検討）', 'DANGERのラベル');

checkEqual(context.weatherCodeToJa_(0), '快晴', 'コード0は快晴');
checkEqual(context.weatherCodeToJa_(1), '晴れ', 'コード1は晴れ');
checkEqual(context.weatherCodeToJa_(3), '曇り', 'コード3は曇り');
checkEqual(context.weatherCodeToJa_(45), '霧', 'コード45は霧');
checkEqual(context.weatherCodeToJa_(53), '霧雨', 'コード53は霧雨');
checkEqual(context.weatherCodeToJa_(63), '雨', 'コード63は雨');
checkEqual(context.weatherCodeToJa_(73), '雪', 'コード73は雪');
checkEqual(context.weatherCodeToJa_(81), 'にわか雨', 'コード81はにわか雨');
checkEqual(context.weatherCodeToJa_(95), '雷雨', 'コード95は雷雨');
checkEqual(context.weatherCodeToJa_(null), '不明', 'コードなしは不明');

for (let f = 0; f <= 4; f++) {
  const png = buildPng(8, 6, function (x, y) {
    return [x * 10, y * 20, (x + y) % 256, 255];
  }, f);
  const decoded = context.decodePng_(new Uint8Array(png));
  const px = context.pngPixelAt_(decoded, 5, 4);
  check(!!px && px.join(',') === '50,80,9,255', 'PNGフィルタ' + f + 'を復元できる' +
    (px ? ' (got=' + px.join(',') + ')' : ''));
}

checkEqual(context.pngPixelAt_(context.decodePng_(new Uint8Array(
  buildPng(4, 4, function () { return [1, 2, 3, 4]; })
)), 4, 0), null, '範囲外のピクセルはnull');

checkThrows(function () {
  context.decodePng_(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
}, 'PNG以外はエラー', 'PNG 形式ではありません');

// -------------------------------------------------------------------------
// [15] 外部 API（doPost ルーター）
// -------------------------------------------------------------------------
// GitHub Pages から呼ばれる Web API の入口。ブラウザは
// Content-Type: text/plain で JSON を POST する（CORS プリフライト回避）。
console.log('\n[15] 外部 API（doPost ルーター）');

/** Code.gs の共有トークン（認証テストで使う。const は context のプロパティにならない） */
const API_TOKEN = vm.runInContext('API_TOKEN', context);

/**
 * doPost を JSON 本文で呼ぶ（ブラウザからの POST を再現）。
 * token を省略した場合は正しいトークンを自動で付与する
 * （認証そのものを試すときは token を明示的に指定する）。
 */
function postApi(payload) {
  const body = Object.prototype.hasOwnProperty.call(payload, 'token')
    ? payload
    : Object.assign({ token: API_TOKEN }, payload);
  const output = context.doPost({ postData: { contents: JSON.stringify(body) } });
  return { text: output.getContent(), mime: output.mimeType, json: JSON.parse(output.getContent()) };
}

// --- トークン認証 ---
checkEqual(API_TOKEN, 'DRONE_LOG_SECURE_TOKEN_2026', 'API_TOKEN は既定の共有トークン');

const apiNoToken = postApi({ action: 'getCatalog', args: [], token: undefined });
checkEqual(apiNoToken.json.success, false, 'token 未指定は success:false');
checkEqual(apiNoToken.json.error, '認証エラー: token が指定されていません。', 'token 未指定のメッセージ');

const apiBlankToken = postApi({ action: 'getCatalog', args: [], token: '' });
checkEqual(apiBlankToken.json.success, false, 'token が空文字は success:false');
checkEqual(apiBlankToken.json.error, '認証エラー: token が指定されていません。', 'token 空文字のメッセージ');

const apiWrongToken = postApi({ action: 'getCatalog', args: [], token: 'WRONG_TOKEN' });
checkEqual(apiWrongToken.json.success, false, 'token 不一致は success:false');
checkEqual(apiWrongToken.json.error, '認証エラー: token が正しくありません。', 'token 不一致のメッセージ');
checkEqual(Object.prototype.hasOwnProperty.call(apiWrongToken.json, 'data'), false,
  '認証エラー時は data を返さない');

const apiTokenGuess = postApi({ action: 'initSpreadsheet', token: 'WRONG_TOKEN' });
check(apiTokenGuess.json.error.indexOf('認証エラー') === 0,
  'token 不正なら未定義 action の判定より先に拒否される（action 名を探らせない）');

const apiBoot = postApi({ action: 'getBootstrapData', args: [] });
checkEqual(apiBoot.json.success, true, 'getBootstrapData は success:true');
checkEqual(apiBoot.json.data.ok, true, 'getBootstrapData は data.ok を返す');
checkEqual(apiBoot.mime, 'application/json', 'レスポンスの MIME は JSON');
checkEqual(typeof apiBoot.text, 'string', 'レスポンス本文は文字列（JSON）');
check(!!apiBoot.json.data.catalog && !!apiBoot.json.data.catalog.purposes,
  'getBootstrapData は catalog を含む');

const apiCatalog = postApi({ action: 'getCatalog', args: [] });
checkEqual(apiCatalog.json.success, true, 'getCatalog は success:true');
checkEqual(apiCatalog.json.data.purposes.length, 13, 'getCatalog は飛行目的13件を返す');
checkEqual(apiCatalog.json.data.limitMinutes, 1200, 'getCatalog は点検上限を返す');

const apiFlights = postApi({ action: 'getFlights', args: [{ droneId: 'DRN-0001', limit: 2 }] });
checkEqual(apiFlights.json.success, true, 'getFlights は success:true');
check(apiFlights.json.data.items.length > 0, 'getFlights は記録を返す');
check(apiFlights.json.data.items.length <= 2, 'args で limit を渡せる');
check(apiFlights.json.data.items.every(function (i) { return i.droneId === 'DRN-0001'; }),
  'args で droneId を絞り込める');

const apiInsp = postApi({ action: 'getInspections', args: [{ limit: 3 }] });
checkEqual(apiInsp.json.success, true, 'getInspections は success:true');
checkEqual(apiInsp.json.data.limit, 3, 'getInspections も args を受け取る');

// 失敗系: 未定義 action / action 未指定 / args が配列でない
const apiUnknown = postApi({ action: 'nope' });
checkEqual(apiUnknown.json.success, false, '未定義 action は success:false');
checkEqual(apiUnknown.json.error, '未定義のActionです: nope', '未定義 action のメッセージ');
checkEqual(Object.prototype.hasOwnProperty.call(apiUnknown.json, 'data'), false,
  '失敗時は data を返さない');

const apiNoAction = postApi({ args: [] });
checkEqual(apiNoAction.json.success, false, 'action 未指定は success:false');
check(apiNoAction.json.error.indexOf('action が指定されていません') !== -1,
  'action 未指定のメッセージ');

const apiBadArgs = postApi({ action: 'getFlights', args: {} });
checkEqual(apiBadArgs.json.success, false, 'args が配列でない場合は success:false');
check(apiBadArgs.json.error.indexOf('args は配列') !== -1, 'args が配列でない場合のメッセージ');

// 管理系は外部公開しない（第三者によるシート初期化・再計算の防止）
checkEqual(postApi({ action: 'initSpreadsheet' }).json.success, false,
  'initSpreadsheet は公開しない');
checkEqual(postApi({ action: 'recalcDroneTotals' }).json.success, false,
  'recalcDroneTotals は公開しない');
checkEqual(postApi({ action: 'selfCheck' }).json.success, false, 'selfCheck は公開しない');

// 本文が壊れている / 空のリクエスト
const apiBrokenBody = JSON.parse(context.doPost({ postData: { contents: '{oops' } }).getContent());
checkEqual(apiBrokenBody.success, false, 'JSON 不正な本文は success:false');
check(apiBrokenBody.error.indexOf('JSON を解析できません') !== -1, 'JSON 不正のメッセージ');

const apiArrayBody = JSON.parse(
  context.doPost({ postData: { contents: '[1,2,3]' } }).getContent()
);
checkEqual(apiArrayBody.success, false, 'JSON 配列の本文は success:false');

const apiEmpty = JSON.parse(context.doPost({}).getContent());
checkEqual(apiEmpty.success, false, '本文が空の場合は success:false');
check(apiEmpty.error.indexOf('本文が空') !== -1, '本文が空のメッセージ');

// 本文なし + クエリ文字列（curl での動作確認用）
const apiQuery = JSON.parse(
  context.doPost({ parameter: { action: 'getCatalog', token: API_TOKEN } }).getContent()
);
checkEqual(apiQuery.success, true, 'e.parameter.action でも呼べる');

const apiQueryArgs = JSON.parse(
  context.doPost({
    parameter: { action: 'getFlights', args: '[{"limit":1}]', token: API_TOKEN }
  }).getContent()
);
checkEqual(apiQueryArgs.data.items.length, 1, 'クエリ文字列の args を JSON として解釈');

const apiQueryBadArgs = JSON.parse(
  context.doPost({ parameter: { action: 'getFlights', args: '{oops', token: API_TOKEN } }).getContent()
);
check(apiQueryBadArgs.error.indexOf('args の JSON') !== -1, 'args の JSON 不正はエラー');

const apiQueryNoToken = JSON.parse(
  context.doPost({ parameter: { action: 'getCatalog' } }).getContent()
);
checkEqual(apiQueryNoToken.success, false, 'クエリ文字列でも token は必須');
checkEqual(apiQueryNoToken.error, '認証エラー: token が指定されていません。',
  'クエリ文字列の token 未指定メッセージ');

// サーバー側の例外は success:false + メッセージで返す
const apiEnvError = postApi({ action: 'fetchFlightEnvironment', args: ['abc', 139.7] });
checkEqual(apiEnvError.json.success, false, '例外は success:false で返す');
check(apiEnvError.json.error.indexOf('数値で指定') !== -1, '例外メッセージをそのまま返す');

// 別名 action（geocodeAddress → fetchGeoFromAddress / reverseGeocode → fetchAddressFromGeo）
resetGeoPlan({
  geocode: {
    status: 'OK',
    results: [{
      formatted_address: '日本、東京都千代田区丸の内',
      geometry: { location: { lat: 35.681236, lng: 139.767125 }, location_type: 'ROOFTOP' }
    }]
  }
});
const apiGeo = postApi({ action: 'geocodeAddress', args: ['東京駅'] });
checkEqual(apiGeo.json.success, true, 'geocodeAddress は成功する');
checkEqual(apiGeo.json.data.lat, 35.681236, 'geocodeAddress は緯度を返す');

resetGeoPlan({
  reverseGeocode: {
    status: 'OK',
    results: [{
      formatted_address: '日本、東京都千代田区丸の内',
      geometry: { location: { lat: 35.68, lng: 139.76 }, location_type: 'ROOFTOP' }
    }]
  }
});
const apiRev = postApi({ action: 'reverseGeocode', args: [35.68, 139.76] });
checkEqual(apiRev.json.success, true, 'reverseGeocode は成功する');
check(apiRev.json.data.address.length > 0, 'reverseGeocode は住所を返す');

// 未実装スタブもルーティングできる（画面には準備中のメッセージが出る）
const apiDji = postApi({ action: 'parseDjiLog', args: [{ name: 'a.txt', size: 1 }] });
checkEqual(apiDji.json.success, false, 'parseDjiLog は未実装エラーを返す');
check(apiDji.json.error.indexOf('未実装') !== -1, 'parseDjiLog のメッセージ');

// 書き込み系もルーター経由で動く
const apiPilot = postApi({
  action: 'savePilot',
  args: [{ name: 'API 太郎', licenseNo: 'JP9999999999', contact: '090-1111-2222' }]
});
checkEqual(apiPilot.json.success, true, 'savePilot は成功する');
check(/^PLT-\d{4}$/.test(apiPilot.json.data.pilotId), 'savePilot は採番した pilotId を返す');

const apiCsv = postApi({ action: 'buildDipsCsv', args: [{}] });
checkEqual(apiCsv.json.success, true, 'buildDipsCsv は成功する');
checkEqual(apiCsv.json.data.format, 'dips-shikou-kiroku-1', 'buildDipsCsv は様式1の形式を返す');
check(!!apiCsv.json.data.content && apiCsv.json.data.content.indexOf(',') !== -1,
  'buildDipsCsv は CSV 文字列を返す');

// ディスパッチャのホワイトリストは公開 action のみを通す
checkThrows(function () { context.dispatchApiAction_('doGet', []); },
  '未公開関数はディスパッチャから呼べない', '未定義のActionです');

console.log('\n----------------------------------------');
if (failures === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.log(failures + ' TEST(S) FAILED');
  process.exit(1);
}
