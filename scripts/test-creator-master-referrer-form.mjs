/*
  クリエイターマスタの紹介者フォームのテスト。

  DBへは接続せず、実装の形と純粋な判定を確かめる。
  実行: node --test scripts/test-creator-master-referrer-form.mjs

  ■ このテストが守っているもの
  画面で選び直した紹介者が保存時に送られないまま
  「保存しました」とだけ出る事故を防ぐ。

  kanya_land で実際に起きた。DB は
      紹介者 （株）3 / start_month 2026-03
  なのに、保存しても紹介者だけ元へ戻った。
  代理店と区分は更新され、creator_referral_logs には何も残らなかった
  （referrerChanged が false で紹介者処理ごと飛んでいた）。

  原因は useState の初期値がマウント時に一度しか評価されないこと。
  保存して revalidate されても内部 state が古い値を握ったままだった。

  ■ 「なし」と「-」は別物
  なし  … 紹介関係そのものを持たない状態に戻す（referrer_id = null）
  「-」 … 名前が「-」の紹介者を正式に設定する
  同じ表示・同じ扱いにしない。
*/
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* このテストは実装の形と純粋な判定だけを見るので DB も jiti も要らない */
const root = process.cwd();
const read = (file) => readFileSync(path.join(root, file), "utf8");
const UI_RAW = read("app/(app)/creators/CreatorMasterClient.tsx");
const ACTION_RAW = read("app/actions/update-creator-master.ts");

/** コメントを除いたコード本体（説明文で誤検知させない） */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const UI = codeOnly(UI_RAW);
const ACTION = codeOnly(ACTION_RAW);

// =============================================================================
// 1-2. DB の値がそのまま画面に出る
// =============================================================================
test("1. 紹介者と開始月の初期値は DB の現在値から作る", () => {
  assert.match(UI, /useState\(row\.referrerId \?\? ""\)/);
  assert.match(UI, /useState\(\s*row\.referrerStartMonth \?\? currentMonthLabel\(\),\s*\)/);
});

test("2. 選択中の月が選択肢に無くて先頭へ落ちることがない", () => {
  /*
    select の value が option に無いと、ブラウザは先頭
    （EARLIEST_ASSIGNMENT_MONTH = 2026-01）を表示する。
    DB が 2026-03 なのに画面が 2026-01 に見える原因になる。
  */
  assert.match(
    UI,
    /for \(const value of \[row\.referrerStartMonth, selected\]\) \{\s*if \(value && !out\.includes\(value\)\) out\.push\(value\);/,
    "現在値を選択肢へ必ず入れていない",
  );
  assert.match(UI, /monthOptions\(row, startMonth\)/, "選択中の月を渡していない");

  // 実際に呼んで確かめる（純粋関数として切り出せないのでロジックを再現）
  const EARLIEST = "2026-01";
  const build = (row, selected) => {
    const candidates = [row.referrerStartMonth, row.agencyAssignedStartMonth, selected, EARLIEST]
      .filter(Boolean);
    const start = candidates.slice().sort()[0] ?? EARLIEST;
    const end = ["2026-09", ...candidates].slice().sort().at(-1);
    const out = [];
    let [y, m] = start.split("-").map(Number);
    for (let g = 0; g < 120; g += 1) {
      const cur = `${y}-${String(m).padStart(2, "0")}`;
      out.push(cur);
      if (cur >= end) break;
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    for (const v of [row.referrerStartMonth, selected]) if (v && !out.includes(v)) out.push(v);
    return [...new Set(out)].sort();
  };

  // kanya_land の実データ
  const options = build(
    { referrerStartMonth: "2026-03", agencyAssignedStartMonth: "2026-02" },
    "2026-03",
  );
  assert.ok(options.includes("2026-03"), "2026-03 が選択肢に無い");
  assert.equal(options[0], "2026-01", "選択肢の先頭は 2026-01（一覧の範囲としては正しい）");
});

// =============================================================================
// 3-4. 「なし」の送信値と解釈
// =============================================================================
test("3. 「なし」は空文字を送る", () => {
  assert.match(UI_RAW, /<option value="">なし<\/option>/);
  assert.match(UI, /name="referrer_id"/);
});

test("4. Server Action は空文字を null として扱う", () => {
  assert.match(
    ACTION,
    /const referrerId = referrerRaw\.length > 0 \? referrerRaw : null;/,
    "空文字を null にしていない",
  );
  assert.match(ACTION, /const referrerChanged = fromReferrerId !== referrerId;/);
  // 「なし」を「変更なし」として飛ばさない
  assert.equal(
    /if \(!referrerId\) return/.test(ACTION),
    false,
    "紹介者なしを変更なしとして飛ばしている",
  );
});

// =============================================================================
// 5-6. 解除と「-」を混同しない
// =============================================================================
test("5. 既存relationあり → なし はプレビューで「解除」と出る", () => {
  assert.match(UI_RAW, /紹介者relationを解除します/);
  assert.match(UI, /plan\.referrerId == null/);
  assert.match(UI_RAW, /紹介者なし（解除）/);
});

test("6. 「なし」と「-」を同じ表示にしない", () => {
  assert.match(UI_RAW, /紹介者を「-」へ変更します/);
  assert.match(UI, /function isDashReferrerLabel/);

  // 判定は名前だけで行い、未設定（null）と分ける
  const isDash = (name) => {
    const t = String(name ?? "").trim();
    return t === "-" || t === "−" || t === "ー" || t === "—";
  };
  for (const n of ["-", " - ", "−", "ー", "—"]) assert.equal(isDash(n), true, `${n} を「-」と認識しない`);
  for (const n of [null, undefined, "", "（株）3", "--"]) assert.equal(isDash(n), false, `${n} を「-」と誤認`);

  // 解除の判定は referrerId が null かどうかで行う（名前では判断しない）
  assert.match(
    UI,
    /plan\.referrerId == null\s*\?\s*"紹介者relationを解除します"/,
    "解除の判定を名前で行っている",
  );
});

// =============================================================================
// 7-9. 古い state を握り続けない
// =============================================================================
test("7-8. DB の紹介者・開始月が変わったら state を作り直す", () => {
  assert.match(
    UI,
    /key=\{`\$\{row\.id\}:\$\{row\.referrerId \?\? ""\}:\$\{row\.referrerStartMonth \?\? ""\}`\}/,
    "key に現在値を含めていない（再マウントされない）",
  );
  // key は ReferrerAssignment 自体に付ける
  const idx = UI.indexOf("key={`${row.id}:${row.referrerId");
  const after = UI.slice(idx, idx + 200);
  assert.match(after, /row=\{row\}/, "key を付けた要素が ReferrerAssignment でない");
  assert.match(after, /referrers=\{referrers\}/);
});

test("9. 保存後は再取得した DB 値が画面へ反映される", () => {
  // 保存経路が一覧を revalidate する
  assert.match(ACTION, /revalidatePath\("\/creators"\)/);
});

// =============================================================================
// 10-13. 変更項目の分離
// =============================================================================
test("10-11. 代理店・区分・紹介者は別々に判定して別々に記録する", () => {
  assert.match(ACTION, /const assignmentChanged =/);
  assert.match(ACTION, /const typeChanged =/);
  assert.match(ACTION, /const referrerChanged = fromReferrerId !== referrerId;/);

  // 実際に変わった項目だけを成功表示へ積む
  assert.match(ACTION, /if \(fromAgencyId !== agencyId\) changes\.push\("代理店"\);/);
  assert.match(ACTION, /changes\.push\("区分"\);/);
  assert.match(ACTION, /changes\.push\(referrerChanged \? "紹介者" : "紹介者の適用開始月"\);/);
  assert.match(ACTION, /保存しました（\$\{changes\.join\(" \/ "\)\}）/);
});

test("12-13. 紹介者だけ／解除だけでも保存対象になる", () => {
  /*
    referrerChanged は fromReferrerId !== referrerId で決まる。
    (株)3 → null でも true になるので、解除だけでも処理へ入る。
  */
  assert.match(ACTION, /if \(referrerChanged \|\| referrerStartMonthChanged\) \{/);

  const changed = (from, to) => from !== to;
  assert.equal(changed("e1ab6054", null), true, "解除が変更として扱われない");
  assert.equal(changed(null, "e1ab6054"), true, "新規設定が変更として扱われない");
  assert.equal(changed("e1ab6054", "e1ab6054"), false);
});

test("紹介者を変えるときは確認してからでないと保存できない", () => {
  assert.match(UI, /disabled=\{pending \|\| referrerNeedsPreview\}/);
  assert.match(UI_RAW, /「変更内容を確認」を押してから保存してください/);
  // 通知は描画中ではなく操作時に行う
  assert.match(UI, /const notifyPending = \(/);
  assert.equal(
    /onPendingChange\?\.\(needsPreview\);/.test(UI),
    false,
    "描画中に親の state を更新している",
  );
});

// =============================================================================
// 14-16. 既存のガードと副作用
// =============================================================================
test("14. 既存の正式ガードをすべて通す", () => {
  assert.match(ACTION, /buildReferralChangePlan\(/);
  assert.match(ACTION, /canApplyReferralChange\(plan\)/);
  assert.match(ACTION, /linkCreatorToReferrer\(/);
  assert.match(ACTION, /requireAdminAction\(\)/);
  // audit log 2種
  assert.match(ACTION, /log: \{\s*plan,/);
  assert.match(ACTION, /"creator_master_change_logs"/);
});

test("15-16. 紹介者の保存で reward / payout を動かさない", () => {
  for (const forbidden of [
    /syncReferralRewardsForMonth/,
    /refreshReferralPayouts/,
    /finalize_referral_month/,
    /claim_payment_batch_items/,
  ]) {
    assert.equal(forbidden.test(ACTION), false, `保存経路が ${forbidden} を呼んでいる`);
    assert.equal(forbidden.test(UI), false, `画面が ${forbidden} を呼んでいる`);
  }
  for (const table of ["referral_reward_items", "referral_payouts", "referral_month_settlements"]) {
    assert.equal(
      ACTION.includes(`"${table}"`),
      false,
      `保存経路が ${table} を触っている`,
    );
  }
});
