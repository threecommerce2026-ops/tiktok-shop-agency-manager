/*
  締め対象月（cutoff month）の単体テスト。

  ■ DBへ触らない
  lib/payments/cutoff-month.ts の純粋関数だけを検証する。
*/
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, { alias: { "@": root }, interopDefault: true, fsCache: false });

const cutoff = await jiti.import(path.join(root, "lib/payments/cutoff-month.ts"));

// 2026-09-26 12:00 JST = 2026-09-26T03:00:00Z
const NOW = new Date("2026-09-26T03:00:00.000Z");

test("既定の締め対象月は JST の前月（当月にしない）", () => {
  assert.equal(cutoff.currentMonthJst(NOW), "2026-09");
  assert.equal(cutoff.defaultCutoffMonth(NOW), "2026-08");
});

test("JSTの日付境界をまたいでも前月判定が崩れない", () => {
  // 2026-10-01 00:30 JST = 2026-09-30T15:30Z（UTCではまだ9月）
  const jstNewMonth = new Date("2026-09-30T15:30:00.000Z");
  assert.equal(cutoff.currentMonthJst(jstNewMonth), "2026-10");
  assert.equal(cutoff.defaultCutoffMonth(jstNewMonth), "2026-09");
});

test("年またぎの前月", () => {
  assert.equal(cutoff.previousMonthOf("2027-01"), "2026-12");
  assert.equal(cutoff.previousMonthOf("2026-12"), "2026-11");
});

test("YYYY-MM 形式だけを受け付ける", () => {
  assert.equal(cutoff.isCutoffMonth("2026-07"), true);
  assert.equal(cutoff.isCutoffMonth("2026-12"), true);
  for (const bad of ["2026-7", "2026/07", "abc", "", "2026-13", "2026-00", "202607", null, undefined, 202607]) {
    assert.equal(cutoff.isCutoffMonth(bad), false, `${bad} を受け付けてはいけない`);
  }
});

test("指定が無ければ既定（JST前月）を使う", () => {
  const r = cutoff.resolveCutoffMonth(null, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.cutoffMonth, "2026-08");
});

test("URLの指定が最優先される", () => {
  const r = cutoff.resolveCutoffMonth("2026-07", NOW);
  assert.equal(r.ok, true);
  assert.equal(r.cutoffMonth, "2026-07");
});

test("未来月は拒否し、勝手に丸めない", () => {
  const r = cutoff.resolveCutoffMonth("2026-10", NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /未来月/);
  // 安全側の既定を fallback として返すが、cutoffMonth としては採用しない
  assert.equal(r.fallbackMonth, "2026-08");
  assert.equal(r.cutoffMonth, undefined);
});

test("不正な形式は拒否し、近い月へ補正しない", () => {
  for (const bad of ["2026-7", "2026/07", "abc"]) {
    const r = cutoff.resolveCutoffMonth(bad, NOW);
    assert.equal(r.ok, false, `${bad}`);
    assert.match(r.error, /形式が不正/);
    assert.equal(r.cutoffMonth, undefined);
  }
});

test("データ開始より前の月は拒否する", () => {
  const r = cutoff.resolveCutoffMonth("2025-12", NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /2026-01/);
});

test("当月そのものは指定できる（明示的に選んだ場合のみ）", () => {
  const r = cutoff.resolveCutoffMonth("2026-09", NOW);
  assert.equal(r.ok, true);
  assert.equal(r.cutoffMonth, "2026-09");
  // ただし既定にはしない
  assert.notEqual(cutoff.defaultCutoffMonth(NOW), "2026-09");
});

test("選択肢は EARLIEST 〜 当月を新しい順で返す", () => {
  const options = cutoff.cutoffMonthOptions(NOW);
  assert.equal(options[0], "2026-09");
  assert.equal(options.at(-1), cutoff.EARLIEST_CUTOFF_MONTH);
  assert.ok(options.includes("2026-07"));
  // 未来月は入らない
  assert.equal(options.includes("2026-10"), false);
  // 降順
  assert.deepEqual([...options].sort().reverse(), options);
});

test("表示ラベルは「2026年7月末」の形", () => {
  assert.equal(cutoff.formatCutoffLabel("2026-07"), "2026年7月末");
  assert.equal(cutoff.formatCutoffLabel("2026-12"), "2026年12月末");
  // 不正値はそのまま返す（勝手に整形しない）
  assert.equal(cutoff.formatCutoffLabel("abc"), "abc");
});
