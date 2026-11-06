/**
 * GitHub Pages 運用のローカル検証用モック API サーバー。
 *
 * - GET  : drone-log/ 配下の静的ファイルを返す（GitHub Pages 相当）
 * - POST : /api に JSON を受け取り、GAS の doPost と同じ封筒
 *          （{success,data} / {success,error}）で返す。
 *          token が GAS 側の API_TOKEN と一致しない場合は「認証エラー」を返す
 *
 * 使い方:
 *   node drone-log/tests/mock-api-server.js 8811
 *   # ブラウザで http://127.0.0.1:8811/index.html?api=http://127.0.0.1:8811/api
 *
 * 実際の GAS へは接続しない。CORS・GAS の応答仕様は実デプロイで確認すること。
 */
var http = require('http');
var fs = require('fs');
var path = require('path');

var port = Number(process.argv[2] || 8811);
var root = path.join(__dirname, '..');

/** GAS 側（Code.gs の API_TOKEN）と揃えた共有トークン */
var API_TOKEN = 'DRONE_LOG_SECURE_TOKEN_2026';

var bootstrap = {
  ok: true,
  version: '1.0.0-mock-api',
  now: '2026-01-01 10:00:00',
  today: '2026-01-01',
  monthPrefix: '2026-01',
  spreadsheetUrl: '',
  drones: [{
    droneId: 'DRN-0001', modelName: 'DJI Mavic 3 Enterprise', weightG: 920,
    serialNo: 'SN-API-001', registrationNo: 'JU1234567890', totalMinutes: 0,
    lastInspectionAt: '', needsInspection: false
  }],
  pilots: [{
    pilotId: 'PLT-0001', name: 'API 検証 太郎', licenseNo: 'JP9999999999', contact: ''
  }],
  flights: [],
  flightTotal: 0,
  inspections: [],
  stats: {
    totalFlights: 0, totalMinutes: 0, totalHours: 0,
    monthFlights: 0, monthMinutes: 0, monthHours: 0,
    safetyEventCount: 0, alertDrones: 0
  },
  catalog: null
};

function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function handleApi(req, res) {
  var body = '';
  req.on('data', function (chunk) { body += chunk; });
  req.on('end', function () {
    var payload;
    try {
      payload = JSON.parse(body);
    } catch (err) {
      sendJson(res, { success: false, error: 'リクエストの JSON を解析できません' });
      return;
    }
    var action = payload && payload.action;
    var token = payload && payload.token;
    console.log('[mock-api] action=' + action + ' args=' + JSON.stringify(payload.args || []));

    // GAS 側（doPost の verifyApiToken_）と同じ検証
    if (!token) {
      sendJson(res, { success: false, error: '認証エラー: token が指定されていません。' });
      return;
    }
    if (token !== API_TOKEN) {
      sendJson(res, { success: false, error: '認証エラー: token が正しくありません。' });
      return;
    }

    switch (action) {
      case 'getBootstrapData':
        sendJson(res, { success: true, data: bootstrap });
        return;
      case 'getCatalog':
        sendJson(res, { success: true, data: { purposes: ['空撮'], limitMinutes: 1200 } });
        return;
      case 'getFlights':
        sendJson(res, { success: true, data: { ok: true, total: 0, items: [] } });
        return;
      case 'getInspections':
        sendJson(res, { success: true, data: { ok: true, total: 0, items: [] } });
        return;
      default:
        sendJson(res, { success: false, error: '未定義のActionです: ' + action });
    }
  });
}

function serveStatic(req, res) {
  var rel = decodeURIComponent(req.url.split('?')[0]);
  var file = path.join(root, rel === '/' ? 'index.html' : rel);
  if (file.indexOf(root) !== 0) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    var types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8'
    };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer(function (req, res) {
  if (req.method === 'POST' && req.url.indexOf('/api') === 0) {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
}).listen(port, '127.0.0.1', function () {
  console.log('mock api server: http://127.0.0.1:' + port + '/index.html?api=http://127.0.0.1:' + port + '/api');
});
