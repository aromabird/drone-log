/**
 * D-log フェーズ運用の E2E テスト（puppeteer）。
 *
 * 検証する流れ:
 *   1. GPS → 現場環境からリスク判定（実行中 disabled / 取得時刻とソース表示）
 *   2. すべて異常なし / 異常ありで備考欄が開く
 *   3. 飛行前点検を保存（status: pre_flight_ready）→ フェーズ1・2が折りたたみ
 *   4. 再読み込み → 再開バナー → フェーズ3 → 打刻 → 飛行後点検 → 完了保存
 *   5. 下書きの自動保存 / 復元
 *   6. status 未設定の旧データが completed として扱われる
 *
 * 実行（puppeteer は npx キャッシュを自動検出）:
 *   node tests/e2e_phases.cjs
 *   npx --yes -p puppeteer node tests/e2e_phases.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** キャッシュ済み Chrome が起動できない環境（macOS の署名問題など）ではシステム Chrome を使う */
function launchOptions() {
  const options = { headless: 'new', args: ['--no-sandbox'] };
  if (fs.existsSync(SYSTEM_CHROME)) options.executablePath = SYSTEM_CHROME;
  return options;
}

function loadPuppeteer() {
  try {
    return require('puppeteer');
  } catch (err) {
    // npx のキャッシュ（~/.npm/_npx/*/node_modules/puppeteer）を探す
    const base = path.join(os.homedir(), '.npm', '_npx');
    if (fs.existsSync(base)) {
      for (const dir of fs.readdirSync(base)) {
        const candidate = path.join(base, dir, 'node_modules', 'puppeteer');
        if (fs.existsSync(candidate)) return require(candidate);
      }
    }
    throw new Error(
      'puppeteer が見つかりません。`npx --yes -p puppeteer node tests/e2e_phases.cjs` で実行してください。'
    );
  }
}

const ITEM_NAMES = [
  '機体全般', 'プロペラ', 'フレーム',
  '通信系統', '推進系統', '電源系統', '自動制御系統', '操縦装置',
  'バッテリー・燃料', '機体識別表示', 'リモートID', '灯火', 'カメラ'
];

function buildStore() {
  const allOk = {};
  ITEM_NAMES.forEach((name) => { allOk[name] = 'OK'; });
  return {
    next: { drone: 2, pilot: 2, flight: 1, inspection: 1 },
    drones: [{
      droneId: 'DRN-0001',
      modelName: 'テスト機体',
      maker: 'テスト',
      weightG: 900,
      registrationNo: 'JU1234567890',
      serialNo: 'SN-0001',
      note: '',
      createdAt: '2026-11-01 09:00:00'
    }],
    pilots: [{
      pilotId: 'PLT-0001',
      name: 'テスト 太郎',
      licenseNo: 'LIC-0001',
      contact: '',
      licenseType: '二等無人航空機操縦士',
      licenseExpiry: '',
      licenseEndorsements: [],
      createdAt: '2026-11-01 09:00:00'
    }],
    flights: [],
    inspections: []
  };
}

/** すべてのページで動くスタブ（fetch / geolocation / localStorage 初期値） */
function pageStubs(seed) {
  // 初回表示だけシードする（リロードで保存済みの記録を消さない）
  if (!localStorage.getItem('drone-log:mock:v1')) {
    localStorage.setItem('drone-log:mock:v1', JSON.stringify(seed));
  }
  if (!localStorage.getItem('drone-log:inspector')) {
    localStorage.setItem('drone-log:inspector', 'テスト 太郎');
  }
  window.__bffCalls = [];

  const json = (data) => Promise.resolve(new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  }));

  // 日の出・日の入り（既定は薄明。テストで window.__testSun により差し替える）
  const sunTimes = () => window.__testSun || {
    sunrise: '06:20',
    sunset: '16:31',
    is_night: false,
    is_twilight_margin: true
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/weather') !== -1) {
      return json({
        weather: {
          text: '晴れ',
          temperature: 18.4,
          humidity: 55,
          precipitation: 0,
          wind_speed: 2.1,
          wind_gust: 3.0,
          wind_direction: '北',
          code: 1,
          observed_at: '2026-11-15T12:40:00+09:00'
        },
        source: 'jma_amedas',
        source_label: 'テスト気象',
        station: { name: 'テスト観測所', distance_km: 1.9 },
        notes: [],
        cached: false,
        stale: false,
        observed_at: '2026-11-15T12:40:00+09:00',
        sun_times: sunTimes()
      });
    }
    if (url.indexOf('/api/reverse-geocode') !== -1) {
      return json({
        address: '千葉県香取市小見川',
        formatted_address: '千葉県香取市小見川',
        lat: 35.681236,
        lng: 139.767125,
        place_id: 'test-place'
      });
    }
    if (url.indexOf('api.open-meteo.com') !== -1) {
      return json({
        current: {
          temperature_2m: 18.4,
          relative_humidity_2m: 55,
          precipitation: 0,
          weather_code: 1,
          wind_speed_10m: 7.56,   // 2.1 m/s
          wind_gusts_10m: 10.8,
          time: '2026-11-15T12:40'
        }
      });
    }
    if (url.indexOf('getelevation.php') !== -1) {
      return json({ elevation: 12.3, hsrc: 'テスト標高' });
    }
    if (url.indexOf('did2020') !== -1) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (url.indexOf('nominatim.openstreetmap.org') !== -1) {
      return json({ display_name: '千葉県香取市小見川' });
    }
    if (url.indexOf('mreversegeocoder.gsi.go.jp') !== -1) {
      return json({ results: { lv01Nm: '香取市小見川' } });
    }
    if (url.indexOf('/api/flight-records') !== -1) {
      const body = JSON.parse((init && init.body) || '{}');
      window.__bffCalls.push(body);
      return json({ ok: true, record: body });
    }
    if (url.indexOf('/api/check-infrastructure') !== -1) {
      return json({
        power_risk_detected: false,
        towers_count: 0,
        lines_count: 0,
        message: '周辺インフラの異常なし',
        sun_times: sunTimes()
      });
    }
    return originalFetch(input, init);
  };

  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition(success) {
        success({ coords: { latitude: 35.681236, longitude: 139.767125 } });
      }
    }
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(port, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('静的サーバーの起動を待てませんでした');
}

async function waitFor(fn, options = {}) {
  const timeout = options.timeout || 10000;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(options.message || '待機がタイムアウトしました');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const puppeteer = loadPuppeteer();
  const port = await getFreePort();
  const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore'
  });
  let browser;
  try {
    await waitForServer(port);
    browser = await puppeteer.launch(launchOptions());
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
    await page.evaluateOnNewDocument(pageStubs, buildStore());
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => {
      const el = document.querySelector('#flight-pilot');
      return el && el.value === 'PLT-0001';
    });
    console.log('1) 初期化（マスタ反映）OK');

    await page.$eval('#inspection-inspector', (el) => { el.value = 'テスト 太郎'; });
    await page.$eval('#inspection-post-inspector', (el) => { el.value = 'テスト 太郎'; });

    await page.click('#btn-gps');
    await waitFor(async () => (await page.$eval('#flight-lat', (el) => el.value)) !== '', {
      message: 'GPS座標が入りません'
    });
    await waitFor(async () => (await page.$eval('#flight-takeoff-place', (el) => el.value)).indexOf('香取市') !== -1, {
      message: '逆ジオコーディング結果が入りません'
    });
    const gpsMeta = await page.$eval('#gps-meta', (el) => el.textContent);
    assert(/^\d{2}:\d{2}取得 \/ GPS/.test(gpsMeta), 'GPSメタ表示が不正: ' + gpsMeta);
    console.log('2) GPS + 取得時刻/ソース表示 OK:', gpsMeta);

    const busy = await page.evaluate(() => {
      const btn = document.querySelector('#btn-env');
      btn.click();
      return { disabled: btn.disabled, html: btn.innerHTML };
    });
    assert(busy.disabled === true, 'リスク判定中にボタンが disabled になっていません');
    assert(busy.html.indexOf('空域・気象を判定中') !== -1, '処理中文言が出ていません: ' + busy.html);
    await page.waitForFunction(() => document.querySelector('#env-meta').textContent.length > 0);
    const envMeta = await page.$eval('#env-meta', (el) => el.textContent);
    assert(/^\d{2}:\d{2}取得 \/ テスト気象/.test(envMeta), 'リスク判定メタが不正: ' + envMeta);
    const windText = await page.$eval('#env-wind', (el) => el.textContent);
    assert(windText.indexOf('2.1 m/s') !== -1, '風速が想定値ではありません: ' + windText);
    console.log('3) リスク判定（disabled/スピナー/メタ）OK:', envMeta);

    const envSun = await page.$eval('#env-sun', (el) => el.textContent);
    assert(envSun === '日の出 06:20 / 日の入り 16:31', '日の出/日の入り表示が不正: ' + envSun);
    const envSunBadge = await page.$eval('#env-sun-badge', (el) => el.textContent);
    assert(envSunBadge === '薄明注意', '薄明のバッジが不正: ' + envSunBadge);
    let nightChecked = await page.$eval('#specific-flags input[data-key="night"]', (el) => el.checked);
    assert(nightChecked === false, '薄明だけで夜間飛行が自動ONになっています');

    // 周辺インフラの結果カードにも日の出・日の入りを表示する
    // （固定フッターの重なりを避けるため DOM の click() を使う）
    await page.evaluate(() => document.querySelector('#btn-infra-check').click());
    await page.waitForFunction(() => {
      const el = document.querySelector('#infra-sun');
      return !!(el && el.textContent.length > 0);
    });
    const infraSun = await page.$eval('#infra-sun', (el) => el.textContent);
    assert(infraSun === '日の出 06:20 / 日の入り 16:31（薄明注意）',
      '周辺インフラの日の出表示が不正: ' + infraSun);

    // 夜間のレスポンスでは「夜間飛行」を片方向（ONのみ）で自動反映する
    await page.evaluate(() => {
      window.__testSun = {
        sunrise: '06:20', sunset: '16:31',
        is_night: true, is_twilight_margin: false
      };
    });
    await page.waitForFunction(() => {
      const btn = document.querySelector('#btn-env');
      return !!(btn && !btn.disabled);
    });
    await page.evaluate(() => document.querySelector('#btn-env').click());
    await page.waitForFunction(() =>
      document.querySelector('#env-sun-badge').textContent === '夜間');
    nightChecked = await page.$eval('#specific-flags input[data-key="night"]', (el) => el.checked);
    assert(nightChecked === true, '夜間の「夜間飛行」自動ONが効いていません');

    // 後続ステップへ影響させないよう手動で戻し、スタブも既定へ戻す
    await page.evaluate(() => {
      const input = document.querySelector('#specific-flags input[data-key="night"]');
      if (input && input.checked) input.click();
      window.__testSun = null;
      // 通知が積み上がると後続のボタン操作を遮るため消す
      const toastRoot = document.querySelector('#toast');
      if (toastRoot) toastRoot.innerHTML = '';
    });
    console.log('3b) 日の出/日の入り・薄明警告・夜間の片方向自動ON OK');

    await page.click('#inspection-items [data-item="機体全般"] [data-item-btn="NG"]');
    const memoVisible = await page.$eval('#inspection-memo-wrap', (el) => !el.classList.contains('hidden'));
    assert(memoVisible, 'NG時に備考欄が開きません');
    const resultNg = await page.$eval('#inspection-result', (el) => el.textContent);
    assert(resultNg === '異常あり', 'NG時の結果表示が不正: ' + resultNg);

    await page.click('#btn-all-ok');
    const memoHidden = await page.$eval('#inspection-memo-wrap', (el) => el.classList.contains('hidden'));
    assert(memoHidden, 'すべて異常なしで備考欄が閉じません');
    const resultOk = await page.$eval('#inspection-result', (el) => el.textContent);
    assert(resultOk === '合格', '一括OK後の結果表示が不正: ' + resultOk);
    console.log('4) 一括チェック / 異常時のみ備考欄 OK');

    await page.click('#btn-save-preflight');
    await waitFor(async () => {
      const db = await page.evaluate(() => JSON.parse(localStorage.getItem('drone-log:mock:v1')));
      return db.flights.length === 1 && db.flights[0].status === 'pre_flight_ready';
    }, { message: 'pre_flight_ready が保存されません' });
    await waitFor(async () => (await page.evaluate(() => window.__bffCalls.length)) >= 1, {
      message: 'BFF への同期が行われません'
    });

    const states = await page.evaluate(() => ({
      p1: document.querySelector('#phase1').open,
      p2: document.querySelector('#phase2').open,
      p3: document.querySelector('#phase3').open,
      summary: document.querySelector('#phase2-summary').textContent,
      bff: window.__bffCalls.map((c) => ({ status: c.status, n: c.inspections.length }))
    }));
    assert(states.p1 === false && states.p2 === false, 'フェーズ1・2が折りたたまれていません');
    assert(states.p3 === true, 'フェーズ3が開いていません');
    assert(states.summary.indexOf('飛行前点検済') !== -1 && states.summary.indexOf('m/s') !== -1,
      'summary が不正: ' + states.summary);
    const lastPre = states.bff[states.bff.length - 1];
    assert(lastPre.status === 'pre_flight_ready' && lastPre.n === 1,
      'BFFへ pre_flight_ready が同期されていません: ' + JSON.stringify(lastPre));
    console.log('5) 待機保存 + 自動折りたたみ + BFF同期 OK:', states.summary);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const banner = document.querySelector('#resume-banner');
      return banner && !banner.classList.contains('hidden');
    });
    const resumeId = await page.$eval('#btn-resume-banner', (el) => el.getAttribute('data-resume-flight-id'));
    assert(resumeId === 'FLT-0001', '再開バナーのIDが不正: ' + resumeId);
    await page.click('#btn-resume-banner');
    await page.waitForFunction(() =>
      document.querySelector('#phase3').open === true && document.querySelector('#phase1').open === false);
    const resumed = await page.evaluate(() => ({
      pre: document.querySelector('#inspection-result').textContent,
      takeoff: document.querySelector('#flight-takeoff-time').value,
      place: document.querySelector('#flight-takeoff-place').value
    }));
    assert(resumed.pre === '合格', '再開時に飛行前点検が復元されていません: ' + resumed.pre);
    assert(resumed.takeoff === '', '再開時に離陸時刻が空ではありません: ' + resumed.takeoff);
    assert(resumed.place.indexOf('香取市') !== -1, '再開時に離陸場所が復元されていません: ' + resumed.place);
    console.log('6) 再開バナー → フェーズ3復元 OK');

    await page.click('#btn-now-takeoff');
    const stamped = await page.$eval('#flight-takeoff-time', (el) => el.value);
    assert(/^\d{2}:\d{2}$/.test(stamped), '打刻ボタンで時刻が入りません: ' + stamped);
    await page.$eval('#flight-takeoff-time', (el) => {
      el.value = '10:00';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.$eval('#flight-landing-time', (el) => {
      el.value = '10:45';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const duration = await page.$eval('#flight-duration', (el) => el.value);
    assert(duration === '45', '飛行時間の自動計算が不正: ' + duration);

    await page.click('#btn-all-ok-post');
    const postResult = await page.$eval('#inspection-post-result', (el) => el.textContent);
    assert(postResult === '合格', '飛行後点検の一括OKが反映されていません: ' + postResult);
    console.log('7) 打刻 + 飛行時間の自動計算 + 飛行後点検 OK');

    await page.click('#save-btn');
    await waitFor(async () => {
      const status = await page.evaluate(() => {
        const db = JSON.parse(localStorage.getItem('drone-log:mock:v1'));
        return db.flights[0] && db.flights[0].status;
      });
      return status === 'completed';
    }, { message: 'completed が保存されません' });
    await waitFor(async () => {
      const calls = await page.evaluate(() => window.__bffCalls.map((c) => c.status));
      return calls[calls.length - 1] === 'completed';
    }, { message: 'BFFへ completed が同期されません' });

    const saved = await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('drone-log:mock:v1'));
      return {
        flight: db.flights[0],
        inspectionCount: db.inspections.filter((i) => i.flightId === db.flights[0].flightId).length,
        draft: localStorage.getItem('drone-log:draft:v1'),
        bff: window.__bffCalls.map((c) => ({ status: c.status, n: c.inspections.length, id: c.flight_id }))
      };
    });
    assert(saved.flight.durationMin === 45, '完了時の飛行時間が不正: ' + saved.flight.durationMin);
    assert(saved.inspectionCount === 2, '点検が2件（前後）になっていません: ' + saved.inspectionCount);
    assert(saved.flight.flightId === 'FLT-0001', '既存IDを更新していません: ' + saved.flight.flightId);
    assert(saved.draft === null, '保存後に下書きが残っています');
    const lastBff = saved.bff[saved.bff.length - 1];
    assert(lastBff.status === 'completed' && lastBff.n === 2, 'BFF同期が不正: ' + JSON.stringify(lastBff));
    console.log('8) 完了保存（upsert / 点検2件 / 下書きクリア / BFF同期）OK');

    await page.$eval('#flight-takeoff-place', (el) => {
      el.value = '下書きテスト場所';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitFor(async () => (await page.evaluate(() => localStorage.getItem('drone-log:draft:v1'))) !== null, {
      message: '下書きが保存されません'
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const b = document.querySelector('#draft-banner');
      return b && !b.classList.contains('hidden');
    });
    await page.click('#btn-draft-restore');
    const restored = await page.$eval('#flight-takeoff-place', (el) => el.value);
    assert(restored === '下書きテスト場所', '下書きが復元されません: ' + restored);
    const draftGone = await page.evaluate(() => localStorage.getItem('drone-log:draft:v1'));
    assert(draftGone === null, '復元後に下書きが残っています');
    console.log('9) 下書きの自動退避 / 復元 OK');

    await page.evaluate(() => {
      const key = 'drone-log:mock:v1';
      const db = JSON.parse(localStorage.getItem(key));
      db.flights.push({
        flightId: 'FLT-0099', date: '2026-11-10', pilotId: 'PLT-0001', droneId: 'DRN-0001',
        takeoffPlace: '旧データ場所', landingPlace: '旧データ場所', lat: null, lng: null,
        takeoffTime: '09:00', landingTime: '09:30', durationMin: 30,
        specificFlags: ['非特定飛行'], hasClearZone: true, category: 'カテゴリーⅠ',
        safetyEvent: 'なし', purpose: '空撮', createdAt: '2026-11-10 09:40:00'
      });
      localStorage.setItem(key, JSON.stringify(db));
      localStorage.removeItem('drone-log:draft:v1');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.state && window.state.ready === true);
    const legacy = await page.evaluate(() => ({
      pending: window.state.data.pendingCount,
      total: window.state.data.stats.totalFlights,
      pendingChip: document.querySelector('#log-list').textContent.indexOf('飛行待機') !== -1
    }));
    assert(legacy.pending === 0, 'statusなしの旧データが待機扱いになっています');
    assert(legacy.total >= 2, '旧データが完了として数えられていません: ' + legacy.total);
    assert(legacy.pendingChip === false, '旧データに待機チップが付いています');
    console.log('10) 旧データ（statusなし）の後方互換 OK');

    assert(pageErrors.length === 0, 'ページ内でJSエラーが発生しました: ' + pageErrors.join(' / '));
    console.log('E2E PASSED');
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('E2E FAILED:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  ROOT,
  loadPuppeteer,
  buildStore,
  pageStubs,
  getFreePort,
  waitForServer,
  waitFor,
  assert
};
