/*
  「対象月の時点で有効だった紹介関係」の選択テスト。

  DBには一切アクセスしない純粋な判定ロジックのテスト。
  実行: node --test scripts/test-referral-period.mjs

  ■ このテストが守っているもの
  紹介者を付け替えたときに、過去月の紹介報酬まで消えてはいけない
  （2026-09-27 EMI承認の期間ルール）。

      旧 start_month = 2026-05 / end_month = 2026-08 / is_active = false
      新 start_month = 2026-09 / is_active = true
        → 2026-07 は旧、2026-09 は新

  実装が is_active だけを見る方式へ戻ると CASE 1 が落ちる。

  ■ 2026-09-30 の改定
  「無効化されていて終了月も無い」関係は誤登録を直した履歴として、
  期間計算から外すようになった（referral-period.ts 冒頭に理由）。
  そのため、本当の紹介者変更を表すテストデータには
  旧関係に end_month を明示する。end_month があることが
  「実際に有効だった期間」の根拠になる。

  過去月の報酬を守るという CASE 1 の意図は変えていない。
  守り方が「is_active を無視する」から
  「end_month が記録されていれば使う」へ変わっただけ。
*/
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, {
  alias: { "@": root },
  interopDefault: true,
  fsCache: false,
});

const period = await jiti.import(path.join(root, "lib/referrals/referral-period.ts"));

const CREATOR = "creator-1";
const A = "referrer-A";
const B = "referrer-B";

/** creator_referrals の1行を作る。既定は「有効・上限既定・料率5%」 */
function row(overrides = {}) {
  return {
    creator_id: CREATOR,
    referrer_id: A,
    referral_rate: 0.05,
    start_month: "2026-05",
    end_month: null,
    is_active: true,
    lifetime_payout_cap: null,
    lifetime_paid_amount: 0,
    created_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

/** 対象月に選ばれた紹介者を返す（該当なしは null） */
function referrerFor(rows, month) {
  const index = period.buildReferralPeriods(rows);
  const resolution = period.resolveReferralForMonth(
    index.byCreator.get(CREATOR),
    month,
  );
  assert.equal(
    resolution.conflicts.length,
    0,
    `期間の重なりを検出しました: ${month}`,
  );
  return resolution.period?.referrerId ?? null;
}

// =============================================================================
// CASE 1 / 2: 付け替え前後で対象月に応じて紹介者が切り替わる
// =============================================================================
const HANDOVER = [
  /*
    本当に紹介者が変わった場合の表し方（2026-09-30 確定）。
    旧関係は end_month を明示して無効化する。
  */
  row({
    referrer_id: A,
    start_month: "2026-05",
    end_month: "2026-08",
    is_active: false,
  }),
  row({
    referrer_id: B,
    start_month: "2026-09",
    is_active: true,
    created_at: "2026-09-27T00:00:00Z",
  }),
];

test("CASE 1: 旧A(05・無効) + 新B(09・有効) → 2026-07 は A", () => {
  assert.equal(referrerFor(HANDOVER, "2026-07"), A);
});

test("CASE 2: 同条件 → 2026-09 は B", () => {
  assert.equal(referrerFor(HANDOVER, "2026-09"), B);
});

test("CASE 1-b: 旧Aの実効終了月は 2026-08（記録値をそのまま使う）", () => {
  const index = period.buildReferralPeriods(HANDOVER);
  const periods = index.byCreator.get(CREATOR);
  const a = periods.find((p) => p.referrerId === A);
  assert.equal(a.endMonth, "2026-08");
  assert.equal(a.endMonthRestored, false, "記録値なので復元ではない");
  assert.equal(index.restoredCount, 0);
});

test("CASE 1-b-2: 終了月が無い関係は後続の開始月から復元する", () => {
  /*
    復元は「期間計算に使える関係」同士の間でだけ起きる。
    終了月の無い有効な関係が2件並ぶとき、前の関係の終了月を
    後続の開始月の前月として導出する。
  */
  const index = period.buildReferralPeriods([
    row({ referrer_id: A, start_month: "2026-05", is_active: true }),
    row({
      referrer_id: B,
      start_month: "2026-09",
      is_active: true,
      created_at: "2026-09-27T00:00:00Z",
    }),
  ]);
  const a = index.byCreator.get(CREATOR).find((p) => p.referrerId === A);
  assert.equal(a.endMonth, "2026-08");
  assert.equal(a.endMonthRestored, true, "後続から導出したことを記録する");
  assert.equal(index.restoredCount, 1);
});

test("CASE 1-c: 境界。2026-08 は A、2026-09 は B", () => {
  assert.equal(referrerFor(HANDOVER, "2026-08"), A);
  assert.equal(referrerFor(HANDOVER, "2026-09"), B);
});

test("CASE 1-d: 開始前の月は誰にも該当しない", () => {
  assert.equal(referrerFor(HANDOVER, "2026-04"), null);
});

test("CASE 1-e: 終了月が記録された無効関係は過去月の報酬根拠になる（退行防止）", () => {
  /*
    「is_active が false なら全期間対象外」という実装へ戻ると、
    2026-05〜08 がすべて null になってここで落ちる。
    誤登録の履歴を外すようになった後も、end_month が記録された
    関係は過去の正式な期間として残さなければならない。
  */
  for (const month of ["2026-05", "2026-06", "2026-07", "2026-08"]) {
    assert.equal(referrerFor(HANDOVER, month), A, `${month} が A でない`);
  }
});

// =============================================================================
// CASE 3: end_month が記録されていればそれを優先する
// =============================================================================
test("CASE 3: 旧Aに end_month=2026-06 → 07 は B ではなく該当なし", () => {
  const rows = [
    row({
      referrer_id: A,
      start_month: "2026-05",
      end_month: "2026-06",
      is_active: false,
    }),
    row({
      referrer_id: B,
      start_month: "2026-09",
      is_active: true,
      created_at: "2026-09-27T00:00:00Z",
    }),
  ];
  assert.equal(referrerFor(rows, "2026-06"), A);
  // 記録された終了月が後続の前月より早い。間の月は空白になる（推測で埋めない）
  assert.equal(referrerFor(rows, "2026-07"), null);
  assert.equal(referrerFor(rows, "2026-09"), B);
});

test("CASE 3-b: end_month 記録済みは復元として数えない", () => {
  const index = period.buildReferralPeriods([
    row({ start_month: "2026-05", end_month: "2026-06", is_active: false }),
    row({
      referrer_id: B,
      start_month: "2026-09",
      created_at: "2026-09-27T00:00:00Z",
    }),
  ]);
  const a = index.byCreator.get(CREATOR).find((p) => p.referrerId === A);
  assert.equal(a.endMonthRestored, false);
  assert.equal(index.restoredCount, 0);
});

// =============================================================================
// CASE 4: 後続なし + is_active=true → 継続中
// =============================================================================
test("CASE 4: 後続なし・有効 → 終了月なしで継続", () => {
  const rows = [row({ start_month: "2026-05", is_active: true })];
  const index = period.buildReferralPeriods(rows);
  const a = index.byCreator.get(CREATOR)[0];
  assert.equal(a.endMonth, null);
  assert.equal(a.endMonthRestored, false);
  assert.equal(referrerFor(rows, "2026-05"), A);
  assert.equal(referrerFor(rows, "2099-12"), A, "継続中なので先の月も該当する");
  assert.equal(index.unresolved.length, 0);
});

// =============================================================================
// CASE 5: is_active=false + end_month なし → 誤登録の履歴として期間計算から外す
// =============================================================================
test("CASE 5: 終了月の無い無効関係は期間を作らない", () => {
  /*
    2026-09-30 改定。以前はこの行を unresolved（missing_end_month）
    として報告していたが、いまは入口で除外する。

    どちらの実装でも「期間を推測しない」という意図は同じで、
    期間が作られないことが要点。誤登録を直した履歴が大量に残る
    運用になったため、毎月の unresolved 報告に出し続けても
    対応のしようがなく、ノイズにしかならない。
  */
  const rows = [row({ start_month: "2026-05", is_active: false })];
  const index = period.buildReferralPeriods(rows);

  assert.equal(index.byCreator.has(CREATOR), false, "期間を作ってはいけない");
  assert.equal(index.unresolved.length, 0, "誤登録の履歴は報告対象にしない");
  assert.equal(referrerFor(rows, "2026-07"), null);
});

test("CASE 5-b: 無効化日時から期間を作らない", () => {
  /*
    updated_at（無効化した時刻）を終了月に流用すると、
    DB に無い事実を作ることになる。使っていないことを確かめる。
  */
  const index = period.buildReferralPeriods([
    row({
      start_month: "2026-05",
      is_active: false,
      updated_at: "2026-09-27T00:00:00Z",
    }),
  ]);
  assert.equal(index.byCreator.has(CREATOR), false);
});

// =============================================================================
// CASE 6: 同一 creator × 同一月に複数該当 → 黙って選ばない
// =============================================================================
test("CASE 6: 期間が重なる異常データ → period を返さず conflicts に入れる", () => {
  /*
    A は end_month=2026-10 が記録済み、B は 2026-09 開始。
    2026-09 と 2026-10 は両方に該当する。
  */
  const rows = [
    row({ referrer_id: A, start_month: "2026-05", end_month: "2026-10" }),
    row({
      referrer_id: B,
      start_month: "2026-09",
      created_at: "2026-09-27T00:00:00Z",
    }),
  ];
  const index = period.buildReferralPeriods(rows);
  const resolution = period.resolveReferralForMonth(
    index.byCreator.get(CREATOR),
    "2026-09",
  );

  assert.equal(resolution.period, null, "黙って1件選んではいけない");
  assert.equal(resolution.conflicts.length, 2);

  const found = period.findReferralPeriodConflicts(index, "2026-09");
  assert.equal(found.length, 1);
  assert.equal(found[0].creatorId, CREATOR);
});

test("CASE 6-b: 重なっていない月は通常どおり解決する", () => {
  const rows = [
    row({ referrer_id: A, start_month: "2026-05", end_month: "2026-10" }),
    row({
      referrer_id: B,
      start_month: "2026-09",
      created_at: "2026-09-27T00:00:00Z",
    }),
  ];
  assert.equal(referrerFor(rows, "2026-07"), A);
  assert.equal(period.findReferralPeriodConflicts(
    period.buildReferralPeriods(rows),
    "2026-07",
  ).length, 0);
});

// =============================================================================
// CASE 7: creator × month に対して選ばれる関係は常に1件以下
// =============================================================================
test("CASE 7: 3世代でも各月ちょうど1件（二重生成なし）", () => {
  const rows = [
    row({
      referrer_id: A,
      start_month: "2026-01",
      end_month: "2026-04",
      is_active: false,
    }),
    row({
      referrer_id: B,
      start_month: "2026-05",
      end_month: "2026-08",
      is_active: false,
      created_at: "2026-05-01T00:00:00Z",
    }),
    row({
      referrer_id: "referrer-C",
      start_month: "2026-09",
      is_active: true,
      created_at: "2026-09-01T00:00:00Z",
    }),
  ];
  const index = period.buildReferralPeriods(rows);
  const periods = index.byCreator.get(CREATOR);

  assert.equal(periods.length, 3);
  assert.equal(index.unresolved.length, 0);

  const expected = {
    "2026-01": A, "2026-04": A,
    "2026-05": B, "2026-08": B,
    "2026-09": "referrer-C", "2026-12": "referrer-C",
  };

  for (const [month, referrerId] of Object.entries(expected)) {
    const resolution = period.resolveReferralForMonth(periods, month);
    assert.equal(resolution.conflicts.length, 0, `${month} で重なり`);
    assert.equal(resolution.period?.referrerId, referrerId, `${month} の紹介者`);
  }

  // どの月でも該当は1件以下
  for (let m = 1; m <= 12; m += 1) {
    const month = `2026-${String(m).padStart(2, "0")}`;
    const matched = periods.filter(
      (p) => month >= p.startMonth && (p.endMonth == null || month <= p.endMonth),
    );
    assert.ok(matched.length <= 1, `${month} に ${matched.length} 件該当`);
  }
});

test("CASE 7-b: 年をまたぐ境界（12月→1月）", () => {
  const rows = [
    row({
      referrer_id: A,
      start_month: "2026-11",
      end_month: "2026-12",
      is_active: false,
    }),
    row({
      referrer_id: B,
      start_month: "2027-01",
      is_active: true,
      created_at: "2027-01-01T00:00:00Z",
    }),
  ];
  assert.equal(referrerFor(rows, "2026-12"), A, "前月は 2026-12");
  assert.equal(referrerFor(rows, "2027-01"), B);
});

// =============================================================================
// 付随: 料率・上限・不正データ
// =============================================================================
test("料率は関係ごとに引き継ぐ（未設定は5%）", () => {
  const index = period.buildReferralPeriods([
    row({
      referrer_id: A,
      start_month: "2026-05",
      end_month: "2026-08",
      referral_rate: 0.03,
      is_active: false,
    }),
    row({
      referrer_id: B,
      start_month: "2026-09",
      referral_rate: null,
      created_at: "2026-09-27T00:00:00Z",
    }),
  ]);
  const periods = index.byCreator.get(CREATOR);
  assert.equal(periods.find((p) => p.referrerId === A).referralRate, 0.03);
  assert.equal(periods.find((p) => p.referrerId === B).referralRate, 0.05);
});

test("start_month が不正な行は対象外にして理由を残す", () => {
  const index = period.buildReferralPeriods([
    row({ start_month: "2026-5" }),
    row({ start_month: "" }),
  ]);
  assert.equal(index.byCreator.has(CREATOR), false);
  assert.equal(index.unresolved.length, 2);
  assert.ok(index.unresolved.every((u) => u.reason === "invalid_start_month"));
});

test("後続が同月以前に始まる行は superseded として対象外", () => {
  const index = period.buildReferralPeriods([
    row({ referrer_id: A, start_month: "2026-05", created_at: "2026-05-01T00:00:00Z" }),
    row({ referrer_id: B, start_month: "2026-05", created_at: "2026-05-02T00:00:00Z" }),
  ]);
  const unresolved = index.unresolved.filter((u) => u.reason === "superseded");
  assert.equal(unresolved.length, 1, "先に作られた A の期間が0か月になる");
  assert.equal(unresolved[0].referrerId, A);
  assert.equal(index.byCreator.get(CREATOR).length, 1);
  assert.equal(index.byCreator.get(CREATOR)[0].referrerId, B);
});

test("creator が混在しても取り違えない", () => {
  const index = period.buildReferralPeriods([
    row({
      creator_id: "c1",
      referrer_id: A,
      start_month: "2026-05",
      end_month: "2026-08",
      is_active: false,
    }),
    row({
      creator_id: "c1",
      referrer_id: B,
      start_month: "2026-09",
      created_at: "2026-09-27T00:00:00Z",
    }),
    row({ creator_id: "c2", referrer_id: "referrer-Z", start_month: "2026-05" }),
  ]);
  assert.equal(index.byCreator.get("c1").length, 2);
  assert.equal(index.byCreator.get("c2").length, 1);
  assert.equal(
    period.resolveReferralForMonth(index.byCreator.get("c2"), "2026-07").period
      ?.referrerId,
    "referrer-Z",
  );
});

test("紹介関係が無い creator は該当なし", () => {
  const index = period.buildReferralPeriods([]);
  assert.equal(
    period.resolveReferralForMonth(index.byCreator.get(CREATOR), "2026-07").period,
    null,
  );
  assert.equal(period.resolveReferralForMonth(undefined, "2026-07").period, null);
});

// =============================================================================
// 実装が期間ルールから外れないようにする（コード側の検査）
// =============================================================================
const syncSource = readFileSync(
  path.join(root, "lib/referrals/sync-referral-rewards.ts"),
  "utf8",
);
const dryRunSource = readFileSync(
  path.join(root, "scripts/dry-run-tap-referral-rewards.mjs"),
  "utf8",
);

/** コメントを除いたコード本体（コメント中の文字列で誤検知しないため） */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("本番の同期処理は共通helperで紹介関係を引く", () => {
  const code = codeOnly(syncSource);
  assert.ok(
    code.includes("buildReferralPeriods"),
    "buildReferralPeriods を使っていない",
  );
  assert.ok(
    code.includes("resolveReferralForMonth"),
    "resolveReferralForMonth を使っていない",
  );
});

test("本番の同期処理は is_active で紹介関係を絞らない", () => {
  const code = codeOnly(syncSource);
  assert.ok(
    !/\.eq\(\s*["']is_active["']\s*,\s*true\s*\)/.test(code),
    "creator_referrals を is_active=true で絞っている",
  );
  assert.ok(
    !/if\s*\(\s*!\s*referral\.is_active/.test(code),
    "is_active で関係を除外している（過去月の報酬が消える）",
  );
});

test("本番の同期処理は期間の重なりを黙って通さない", () => {
  const code = codeOnly(syncSource);
  assert.ok(
    /resolution\.conflicts\.length\s*>\s*0/.test(code),
    "conflicts を検査していない",
  );
});

test("dry-run も同じ共通helperを使う（本番と食い違わせない）", () => {
  const code = codeOnly(dryRunSource);
  assert.ok(code.includes("buildReferralPeriods"));
  assert.ok(code.includes("resolveReferralForMonth"));
  assert.ok(
    !/linkByCreator/.test(code),
    "旧方式（is_active の先頭1件）が残っている",
  );
});

test("dry-run は復元分と重なりを必ず表示する", () => {
  assert.ok(dryRunSource.includes("restoredCount"), "復元件数を出していない");
  assert.ok(dryRunSource.includes("conflicts"), "重なりを出していない");
  assert.ok(
    dryRunSource.includes("unresolved"),
    "期間を決められなかった関係を出していない",
  );
});

// =============================================================================
// 生成の副作用で旧データが消えないこと
// =============================================================================
/*
  紹介報酬の置き換えは「TAP生成 → 検証 → 旧affiliate purge」の順で行う。
  生成のついでに旧データが消えると、検証前に戻せなくなる。

  affiliate 由来の source_row_key は TAP と重複しない
  （affiliate は factorType を含む8項目 / TAP は7項目。実測で重複0）。
  そのため source_table で絞らないと、旧明細が「TAPのキー集合に無い」
  と判定されて掃除の対象になってしまう。
*/
test("再集計の掃除は source_table を TAP に絞って読む", () => {
  const code = codeOnly(syncSource);
  assert.match(
    code,
    /\.eq\("target_month",\s*targetMonth\)\s*\n\s*\.eq\("source_table",\s*REFERRAL_SOURCE_TABLE\)/,
    "既存明細の読み込みが source_table で絞られていない（旧affiliateを巻き込む）",
  );
});

test("削除クエリ自体も source_table で守られている", () => {
  const code = codeOnly(syncSource);
  const deleteBlock = code.slice(code.indexOf('.from("referral_reward_items")\n      .delete()'));
  assert.ok(
    deleteBlock.includes('.eq("source_table", REFERRAL_SOURCE_TABLE)'),
    "DELETE に source_table の歯止めが無い",
  );
});

// =============================================================================
// CASE 8: 誤登録の履歴を期間計算に入れない（2026-09-30 確定の業務ルール）
//
// 現時点で「途中から紹介者が変わった」クリエイターは1人も居ない。
// creator_referrals に複数行あるのは期間の切り替えではなく、
// 登録されていた紹介者が間違っていたので後から直した履歴である。
//
// 誤登録の行を期間計算に混ぜると、現在の紹介者の期間がそこで切られる。
// end_month が「実際に有効だった」ことの唯一の根拠になる。
// =============================================================================

/** 有効な関係を1件だけ持つ creator の、対象月の紹介者 */
function onlyReferrer(rows, month) {
  return referrerFor(rows, month);
}

test("CASE 8-1: 有効な関係だけなら開始月以降をすべてカバーする", () => {
  const rows = [row({ referrer_id: B, start_month: "2026-04", is_active: true })];
  const index = period.buildReferralPeriods(rows);

  assert.equal(index.byCreator.get(CREATOR).length, 1);
  assert.equal(index.unresolved.length, 0);
  assert.equal(onlyReferrer(rows, "2026-03"), null, "開始前は該当なし");
  for (const month of ["2026-04", "2026-05", "2026-08", "2027-01"]) {
    assert.equal(onlyReferrer(rows, month), B, `${month} が B でない`);
  }
});

test("CASE 8-2: 誤登録の無効関係があっても有効な関係が切られない", () => {
  /*
    A は無効化されていて終了月も無い＝誤登録の履歴。
    B の期間の境界に使ってはいけない。
  */
  const rows = [
    row({ referrer_id: A, start_month: "2026-05", is_active: false }),
    row({
      referrer_id: B,
      start_month: "2026-04",
      is_active: true,
      created_at: "2026-09-27T00:00:00Z",
    }),
  ];
  const index = period.buildReferralPeriods(rows);

  assert.equal(index.byCreator.get(CREATOR).length, 1, "有効な関係だけが残る");
  assert.equal(index.byCreator.get(CREATOR)[0].referrerId, B);
  assert.equal(index.byCreator.get(CREATOR)[0].endMonth, null, "継続中のまま");
  assert.equal(index.unresolved.length, 0);
  for (const month of ["2026-04", "2026-05", "2026-06", "2026-08"]) {
    assert.equal(onlyReferrer(rows, month), B, `${month} が B でない`);
  }
});

test("CASE 8-3: 有効な関係を過去へ遡らせても全期間をカバーする", () => {
  const before = [
    row({ referrer_id: A, start_month: "2026-05", is_active: false }),
    row({
      referrer_id: B,
      start_month: "2026-09",
      is_active: true,
      created_at: "2026-09-27T00:00:00Z",
    }),
  ];
  const after = [
    row({ referrer_id: A, start_month: "2026-05", is_active: false }),
    row({
      referrer_id: B,
      start_month: "2026-03",
      is_active: true,
      created_at: "2026-09-27T00:00:00Z",
    }),
  ];

  // 遡らせる前は開始月より前なので該当なし（誤登録の A も使わない）
  assert.equal(onlyReferrer(before, "2026-06"), null);
  assert.equal(onlyReferrer(before, "2026-09"), B);

  // 遡らせると、その月以降がすべて B になる
  for (const month of ["2026-03", "2026-05", "2026-06", "2026-08", "2026-09"]) {
    assert.equal(onlyReferrer(after, month), B, `${month} が B でない`);
  }
  assert.equal(onlyReferrer(after, "2026-02"), null, "開始前は該当なし");
});

test("CASE 8-4: 無効関係の開始月が有効関係より後でも切られない（退行防止）", () => {
  /*
    eripyon.ec で実際に起きた形。
    有効な関係を 2026-04 へ遡らせたところ、誤登録の 2026-05 行が
    「後続」と見なされ、有効な関係が 2026-04 の1か月で終わった。
    その結果 2026-05 の報酬がどの紹介者にも帰属しなくなった。
  */
  const rows = [
    row({ referrer_id: A, start_month: "2026-05", is_active: false }),
    row({
      referrer_id: B,
      start_month: "2026-04",
      is_active: true,
      created_at: "2026-09-27T00:00:00Z",
    }),
  ];
  const b = period.buildReferralPeriods(rows).byCreator.get(CREATOR)[0];

  assert.equal(b.referrerId, B);
  assert.equal(b.endMonth, null, "誤登録の行で終了月を作ってはいけない");
  assert.equal(onlyReferrer(rows, "2026-05"), B, "2026-05 が帰属先を失っている");
});

test("CASE 8-5: 本当の紹介者変更（end_month あり）はこれまでどおり分割する", () => {
  const rows = [
    row({
      referrer_id: A,
      start_month: "2026-01",
      end_month: "2026-05",
      is_active: false,
    }),
    row({
      referrer_id: B,
      start_month: "2026-06",
      is_active: true,
      created_at: "2026-06-01T00:00:00Z",
    }),
  ];
  for (const month of ["2026-01", "2026-03", "2026-05"]) {
    assert.equal(onlyReferrer(rows, month), A, `${month} が A でない`);
  }
  for (const month of ["2026-06", "2026-08", "2027-01"]) {
    assert.equal(onlyReferrer(rows, month), B, `${month} が B でない`);
  }
  assert.equal(period.buildReferralPeriods(rows).unresolved.length, 0);
});

test("CASE 8-6: 誤登録が複数あっても有効な関係1本になる", () => {
  const rows = [
    row({ referrer_id: A, start_month: "2026-05", is_active: false }),
    row({
      referrer_id: B,
      start_month: "2026-06",
      is_active: false,
      created_at: "2026-06-01T00:00:00Z",
    }),
    row({
      referrer_id: "referrer-C",
      start_month: "2026-09",
      is_active: false,
      created_at: "2026-09-01T00:00:00Z",
    }),
    row({
      referrer_id: "referrer-D",
      start_month: "2026-03",
      is_active: true,
      created_at: "2026-09-27T00:00:00Z",
    }),
  ];
  const index = period.buildReferralPeriods(rows);

  assert.equal(index.byCreator.get(CREATOR).length, 1);
  assert.equal(index.byCreator.get(CREATOR)[0].referrerId, "referrer-D");
  assert.equal(index.unresolved.length, 0);
  for (const month of ["2026-03", "2026-05", "2026-06", "2026-09"]) {
    assert.equal(onlyReferrer(rows, month), "referrer-D", `${month} の紹介者`);
  }
});

test("CASE 8-7: 紹介者名に関係なく同じ扱いをする（「-」も正式な紹介者）", () => {
  /*
    取込時に自動生成された「-」という名前の紹介者も、
    期間計算では他と区別しない。名前で分岐しないことを確かめる。
  */
  const DASH = "referrer-dash";
  const rows = [
    row({ referrer_id: A, start_month: "2026-05", is_active: false }),
    row({
      referrer_id: DASH,
      start_month: "2026-05",
      is_active: true,
      created_at: "2026-09-27T00:00:00Z",
    }),
  ];
  assert.equal(onlyReferrer(rows, "2026-05"), DASH);
  assert.equal(onlyReferrer(rows, "2026-08"), DASH);
});

test("CASE 8-8: eripyon.ec の実データ（（株）3 誤登録 + 「-」2026-04〜）", () => {
  const KABU3 = "referrer-kabu3";
  const DASH = "referrer-dash";
  const rows = [
    row({
      referrer_id: KABU3,
      start_month: "2026-05",
      is_active: false,
      created_at: "2026-09-16T01:54:25Z",
    }),
    row({
      referrer_id: DASH,
      start_month: "2026-04",
      is_active: true,
      created_at: "2026-09-27T06:02:02Z",
    }),
  ];
  // 2026-04 と 2026-05 の両方に eligible な TAP 実績がある creator
  assert.equal(onlyReferrer(rows, "2026-04"), DASH);
  assert.equal(onlyReferrer(rows, "2026-05"), DASH, "2026-05 が抜け落ちている");
  assert.equal(period.buildReferralPeriods(rows).unresolved.length, 0);
});

test("CASE 8-9: odebu888 の実データ（誤登録2件 + 「-」2026-05〜）", () => {
  const MAEHARA = "referrer-maehara";
  const KABU3 = "referrer-kabu3";
  const DASH = "referrer-dash";
  const rows = [
    row({
      referrer_id: MAEHARA,
      start_month: "2026-05",
      is_active: false,
      created_at: "2026-09-16T01:54:25Z",
    }),
    row({
      referrer_id: KABU3,
      start_month: "2026-09",
      is_active: false,
      created_at: "2026-09-17T04:18:23Z",
    }),
    row({
      referrer_id: DASH,
      start_month: "2026-05",
      is_active: true,
      created_at: "2026-09-27T06:01:40Z",
    }),
  ];
  const index = period.buildReferralPeriods(rows);

  assert.equal(index.byCreator.get(CREATOR).length, 1);
  assert.equal(index.unresolved.length, 0);
  assert.equal(onlyReferrer(rows, "2026-05"), DASH);
  assert.equal(onlyReferrer(rows, "2026-06"), DASH);
});

test("CASE 8-10: 本当の変更と誤登録が混ざっていても end_month だけが境界になる", () => {
  const rows = [
    row({
      referrer_id: A,
      start_month: "2026-01",
      end_month: "2026-03",
      is_active: false,
    }),
    row({
      referrer_id: "referrer-X",
      start_month: "2026-02",
      is_active: false,
      created_at: "2026-02-01T00:00:00Z",
    }),
    row({
      referrer_id: B,
      start_month: "2026-04",
      is_active: true,
      created_at: "2026-04-01T00:00:00Z",
    }),
  ];
  const index = period.buildReferralPeriods(rows);

  assert.equal(index.byCreator.get(CREATOR).length, 2, "誤登録の X は入らない");
  assert.equal(index.unresolved.length, 0);
  for (const month of ["2026-01", "2026-02", "2026-03"]) {
    assert.equal(onlyReferrer(rows, month), A, `${month} が A でない`);
  }
  for (const month of ["2026-04", "2026-08"]) {
    assert.equal(onlyReferrer(rows, month), B, `${month} が B でない`);
  }
});

test("CASE 8-11: 有効な関係が無く誤登録だけの creator は期間も報告も無い", () => {
  /*
    51samiy / ___hana16 の形。無効化されていて終了月も無い行が
    1件だけある。報酬は発生せず、unresolved にも出さない。
  */
  const rows = [row({ start_month: "2026-05", is_active: false })];
  const index = period.buildReferralPeriods(rows);

  assert.equal(index.byCreator.has(CREATOR), false);
  assert.equal(index.unresolved.length, 0);
  assert.equal(onlyReferrer(rows, "2026-05"), null);
});

test("CASE 8-12: 三世代の本当の変更（end_month 明示）は3分割される", () => {
  const rows = [
    row({
      referrer_id: A,
      start_month: "2026-01",
      end_month: "2026-03",
      is_active: false,
    }),
    row({
      referrer_id: B,
      start_month: "2026-04",
      end_month: "2026-06",
      is_active: false,
      created_at: "2026-04-01T00:00:00Z",
    }),
    row({
      referrer_id: "referrer-C",
      start_month: "2026-07",
      is_active: true,
      created_at: "2026-07-01T00:00:00Z",
    }),
  ];
  const index = period.buildReferralPeriods(rows);

  assert.equal(index.byCreator.get(CREATOR).length, 3);
  assert.equal(index.unresolved.length, 0);
  const expected = {
    "2026-01": A, "2026-03": A,
    "2026-04": B, "2026-06": B,
    "2026-07": "referrer-C", "2026-12": "referrer-C",
  };
  for (const [month, referrerId] of Object.entries(expected)) {
    assert.equal(onlyReferrer(rows, month), referrerId, `${month} の紹介者`);
  }
});

test("CASE 8-13: 除外の判定は is_active と end_month だけで決める", () => {
  /*
    実装が名前・料率・上限・作成日などで分岐していないことを確かめる。
    入口のフィルタが2条件だけであることをコードでも確認する。
  */
  const source = readFileSync(
    path.join(root, "lib/referrals/referral-period.ts"),
    "utf8",
  );
  assert.match(source, /function isUsableForPeriod/, "入口のフィルタが無い");
  assert.match(source, /row\.is_active === true/, "is_active を見ていない");
  assert.match(source, /row\.end_month != null/, "end_month を見ていない");

  // 4通りの組み合わせがそのまま効く
  const cases = [
    { is_active: true, end_month: null, used: true },
    { is_active: true, end_month: "2026-08", used: true },
    { is_active: false, end_month: "2026-08", used: true },
    { is_active: false, end_month: null, used: false },
  ];
  for (const c of cases) {
    const index = period.buildReferralPeriods([
      row({ start_month: "2026-05", is_active: c.is_active, end_month: c.end_month }),
    ]);
    assert.equal(
      index.byCreator.has(CREATOR),
      c.used,
      `is_active=${c.is_active} / end_month=${c.end_month} の扱いが違う`,
    );
  }
});

test("CASE 8-14: sync は期間判定を自前で書かない（既存 reward の退行防止）", () => {
  /*
    紹介報酬の生成が referral-period.ts を通り続けること。
    ここで期間を書き直すと、画面のプレビューと生成結果が食い違う。
  */
  const sync = readFileSync(
    path.join(root, "lib/referrals/sync-referral-rewards.ts"),
    "utf8",
  );
  assert.match(sync, /buildReferralPeriods\(/);
  assert.match(sync, /resolveReferralForMonth\(/);
  assert.equal(
    /\.eq\("is_active",\s*true\)/.test(sync),
    false,
    "sync 側で is_active を絞ると過去月の期間が壊れる",
  );
});
