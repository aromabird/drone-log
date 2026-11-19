/**
 * D-log フロントの純粋ロジック単体テスト。
 *
 * index.html の `/* === DLOG_PURE_START === *\/` ～ `DLOG_PURE_END` だけを抽出し、
 * ブラウザ用DOMなしで検証する（依存パッケージ不要）。
 *
 * 実行: node --test tests/core.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const block = html.match(/\/\* === DLOG_PURE_START === \*\/([\s\S]*?)\/\* === DLOG_PURE_END === \*\//);

assert.ok(block, 'index.html に DLOG_PURE ブロックが見つかりません');

const context = vm.createContext({});
vm.runInContext(block[1], context, { filename: 'index.html#DLOG_PURE' });

const {
  FLIGHT_STATUS,
  normalizeFlightStatus,
  isPreFlightReady,
  buildPreflightSummary,
  computeDurationMinutes,
  summarizeInspection,
  serializeDraft,
  parseDraft,
  summarizeSunTimes,
  shouldAutoCheckNight
} = context;

const ITEMS = ['機体全般', 'プロペラ', 'フレーム'];

/** vm コンテキスト由来のオブジェクトはプロトタイプが異なるため、素のJSONへ落として比較する */
const plain = (value) => JSON.parse(JSON.stringify(value));

test('normalizeFlightStatus: status 未設定の旧データは completed', () => {
  assert.equal(normalizeFlightStatus(undefined), FLIGHT_STATUS.COMPLETED);
  assert.equal(normalizeFlightStatus(null), FLIGHT_STATUS.COMPLETED);
  assert.equal(normalizeFlightStatus(''), FLIGHT_STATUS.COMPLETED);
  assert.equal(normalizeFlightStatus('completed'), FLIGHT_STATUS.COMPLETED);
  assert.equal(normalizeFlightStatus('pre_flight_ready'), FLIGHT_STATUS.PRE_FLIGHT_READY);
  assert.equal(normalizeFlightStatus('flying'), FLIGHT_STATUS.COMPLETED);
});

test('isPreFlightReady: 待機中だけ true', () => {
  assert.equal(isPreFlightReady({ status: 'pre_flight_ready' }), true);
  assert.equal(isPreFlightReady({ status: 'completed' }), false);
  assert.equal(isPreFlightReady({}), false);
  assert.equal(isPreFlightReady(null), false);
});

test('buildPreflightSummary: 例どおりの要約を返す', () => {
  assert.equal(
    buildPreflightSummary({ savedAt: '2026-11-15T10:15:00+09:00', windSpeed: 2.14 }),
    '✅ 飛行前点検済 10:15 / 風速2.1m/s'
  );
  // mockNow() の 'YYYY-MM-DD HH:MM:SS' 形式にも対応する
  assert.equal(
    buildPreflightSummary({ savedAt: '2026-11-15 10:15:00', windSpeed: 3 }),
    '✅ 飛行前点検済 10:15 / 風速3m/s'
  );
  assert.equal(
    buildPreflightSummary({ savedAt: '2026-11-15 10:15:00', windSpeed: null }),
    '✅ 飛行前点検済 10:15 / 風速 —'
  );
  assert.equal(
    buildPreflightSummary({ time: '10:15', windSpeed: 2.1, result: '異常あり' }),
    '⚠️ 飛行前点検（異常あり） 10:15 / 風速2.1m/s'
  );
});

test('computeDurationMinutes: 通常・日跨ぎ・不正値', () => {
  assert.deepEqual(plain(computeDurationMinutes('10:00', '10:45')),
    { minutes: 45, overnight: false, valid: true });
  assert.deepEqual(plain(computeDurationMinutes('23:50', '00:10')),
    { minutes: 20, overnight: true, valid: true });
  assert.deepEqual(plain(computeDurationMinutes('', '10:00')),
    { minutes: 0, overnight: false, valid: false });
  assert.deepEqual(plain(computeDurationMinutes('25:00', '10:00')),
    { minutes: 0, overnight: false, valid: false });
});

test('summarizeInspection: 未入力・入力中・合格・異常あり', () => {
  assert.deepEqual(plain(summarizeInspection({}, ITEMS)),
    { filled: 0, ng: 0, total: 3, result: '未入力' });
  assert.deepEqual(plain(summarizeInspection({ 機体全般: 'OK' }, ITEMS)),
    { filled: 1, ng: 0, total: 3, result: '入力中' });
  assert.deepEqual(plain(summarizeInspection({ 機体全般: 'OK', プロペラ: 'OK', フレーム: 'OK' }, ITEMS)),
    { filled: 3, ng: 0, total: 3, result: '合格' });
  assert.deepEqual(plain(summarizeInspection({ 機体全般: 'OK', プロペラ: 'NG', フレーム: 'OK' }, ITEMS)),
    { filled: 3, ng: 1, total: 3, result: '異常あり' });
});

test('serializeDraft / parseDraft: 往復と壊れた下書きの扱い', () => {
  const draft = {
    savedAt: '2026-11-15 12:40:00',
    resumeFlightId: 'FLT-0001',
    form: { 'flight-takeoff-place': '千葉県香取市' },
    entry: { preItems: { 機体全般: 'OK' }, postItems: {}, safety: 'none' },
    envResult: { weather: { windSpeed: 2.1 } },
    ignored: 'this should not be serialized'
  };
  const raw = serializeDraft(draft);
  assert.equal(JSON.parse(raw).ignored, undefined);

  const parsed = parseDraft(raw);
  assert.equal(parsed.resumeFlightId, 'FLT-0001');
  assert.equal(parsed.form['flight-takeoff-place'], '千葉県香取市');
  assert.equal(parsed.entry.preItems['機体全般'], 'OK');
  assert.equal(parsed.envResult.weather.windSpeed, 2.1);

  assert.equal(parseDraft(''), null);
  assert.equal(parseDraft('{'), null);
  assert.equal(parseDraft('[]'), null);
  assert.equal(parseDraft('{"form":{}}'), null);
});

test('summarizeSunTimes: 日の出・日の入りと夜間/薄明の要約', () => {
  assert.equal(summarizeSunTimes(null), null);
  assert.equal(summarizeSunTimes({}), null);
  assert.equal(summarizeSunTimes({ sunrise: null, sunset: null }), null);

  const day = summarizeSunTimes({
    sunrise: '06:20', sunset: '16:31',
    is_night: false, is_twilight_margin: false
  });
  assert.equal(day.text, '日の出 06:20 / 日の入り 16:31');
  assert.equal(day.isNight, false);
  assert.equal(day.twilight, false);

  const twilight = summarizeSunTimes({
    sunrise: '06:20', sunset: '16:31',
    is_night: false, is_twilight_margin: true
  });
  assert.equal(twilight.twilight, true);
  assert.equal(twilight.isNight, false);
});

test('shouldAutoCheckNight: 夜間だけ自動ONし、薄明はONしない', () => {
  assert.equal(shouldAutoCheckNight(null), false);
  assert.equal(shouldAutoCheckNight(undefined), false);
  assert.equal(shouldAutoCheckNight({}), false);
  assert.equal(shouldAutoCheckNight({ is_night: true }), true);
  assert.equal(shouldAutoCheckNight({ is_night: true, is_twilight_margin: true }), true);
  // 文字列の "true" などは自動ONしない（BFF の boolean だけを信頼する）
  assert.equal(shouldAutoCheckNight({ is_night: 'true' }), false);
  assert.equal(shouldAutoCheckNight({ is_twilight_margin: true }), false);
});
