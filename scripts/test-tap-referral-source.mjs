/*
  紹介者報酬の TAP-only 化の検証。

  ■ DBへ書き込まない
  対象行の判定・別名の適用・未紐付けの集計はいずれも純関数なので、
  DBに触らずに検証できる。取込処理とsync処理はソースを読んで検査する。

  ■ 何を確かめるか
  ・紹介報酬の計算元が TAP だけで、affiliate_order_lines を読まないこと
  ・別名（改名）が TAP にも効き、一意キーが作り直されること
  ・知らないクリエイターを勝手に作らないこと
  ・紹介関係の期間（start_month / end_month）が効くこと
  ・返金 / 未払い / base<=0 が対象外になること
  ・旧データの置き換えが、使用済み1件でも中止されること

  実行:
    node --test scripts/test-tap-referral-source.mjs
*/
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, {
  alias: { "@": root },
  interopDefault: true,
  fsCache: false,
});

const tapSrc = await jiti.import(path.join(root, "lib/referrals/tap-referral-source.ts"));
const engine = await jiti.import(path.join(root, "lib/referrals/referral-reward-engine.ts"));
const aliasMod = await jiti.import(path.join(root, "lib/orders/creator-alias.ts"));
const tapAlias = await jiti.import(path.join(root, "lib/orders/tap-creator-alias.ts"));
const tapParse = await jiti.import(path.join(root, "lib/orders/parse-tap-affiliate-order-export.ts"));
const syncMod = await jiti.import(path.join(root, "lib/referrals/sync-referral-rewards.ts"));

const SYNC_SOURCE = fs.readFileSync("lib/referrals/sync-referral-rewards.ts", "utf8");
const IMPORT_SOURCE = fs.readFileSync("app/actions/import-tap-affiliate-orders.ts", "utf8");
const MIGRATION = fs.readFileSync(
  "supabase/migrations/20260927100000_referral_reward_tap_source.sql",
  "utf8",
);

/** コメントを外して実コードだけを見る */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// -----------------------------------------------------------------------------
// TAP-only であること
// -----------------------------------------------------------------------------
test("紹介報酬の元データが tap_affiliate_order_lines である", () => {
  assert.equal(syncMod.REFERRAL_SOURCE_TABLE, "tap_affiliate_order_lines");
  assert.match(codeOnly(SYNC_SOURCE), /REFERRAL_SOURCE_TABLE/);
});

test("紹介報酬の同期が affiliate_order_lines を読まない", () => {
  const code = codeOnly(SYNC_SOURCE);
  assert.equal(
    code.includes('"affiliate_order_lines"'),
    false,
    "同期処理に affiliate_order_lines の参照が残っている",
  );
  assert.equal(code.includes("'affiliate_order_lines'"), false);
});

test("代理店報酬と売上集計は affiliate_order_lines を使い続ける", () => {
  // TAP 化の巻き添えで他が壊れていないこと
  const agency = fs.readFileSync("lib/db/payment-queries.ts", "utf8");
  assert.match(agency, /affiliate_order_lines/);
});

// -----------------------------------------------------------------------------
// TAP 有効行の条件
// -----------------------------------------------------------------------------
function tapLine(overrides = {}) {
  return {
    source_row_key: "order|sku|prod|creator|content||",
    order_id: "order",
    product_id: "prod",
    creator_id: "creator-uuid",
    target_month: "2026-07",
    commission_base: 10000,
    payment_status: "支払い済み",
    order_status: "決済済み",
    refund_status: "いいえ",
    ...overrides,
  };
}

test("支払い済み・決済済み・返金なし・base>0 が対象", () => {
  assert.equal(tapSrc.tapLineExclusionReason(tapLine()), null);
  assert.equal(tapSrc.isTapReferralSourceLine(tapLine()), true);
});

test("返金済み（はい）は対象外", () => {
  assert.equal(
    tapSrc.tapLineExclusionReason(tapLine({ refund_status: "はい" })),
    "not_payout_eligible",
  );
});

test("未払いは対象外", () => {
  assert.equal(
    tapSrc.tapLineExclusionReason(tapLine({ payment_status: "未払い" })),
    "not_payout_eligible",
  );
});

test("commission_base が 0 以下は対象外", () => {
  assert.equal(tapSrc.tapLineExclusionReason(tapLine({ commission_base: 0 })), "base_not_positive");
  assert.equal(tapSrc.tapLineExclusionReason(tapLine({ commission_base: -1 })), "base_not_positive");
  assert.equal(tapSrc.tapLineExclusionReason(tapLine({ commission_base: null })), "base_not_positive");
});

test("クリエイター未紐付け・キーなし・対象月なしは理由つきで対象外", () => {
  assert.equal(tapSrc.tapLineExclusionReason(tapLine({ creator_id: null })), "no_creator");
  assert.equal(tapSrc.tapLineExclusionReason(tapLine({ source_row_key: null })), "no_source_key");
  assert.equal(tapSrc.tapLineExclusionReason(tapLine({ target_month: null })), "no_target_month");
});

test("Production に実在する状態値をすべて判定できる", () => {
  // 実データから確認した値: 支払い済み/未払い・決済済み・いいえ/はい
  assert.equal(tapSrc.isTapReferralSourceLine(tapLine({ payment_status: "支払い済み", refund_status: "いいえ" })), true);
  assert.equal(tapSrc.isTapReferralSourceLine(tapLine({ payment_status: "未払い", refund_status: "いいえ" })), false);
  assert.equal(tapSrc.isTapReferralSourceLine(tapLine({ payment_status: "支払い済み", refund_status: "はい" })), false);
});

// -----------------------------------------------------------------------------
// 計算
// -----------------------------------------------------------------------------
test("報酬は commission_base × 料率（既定 5%）", () => {
  const computed = engine.computeReferralReward(
    tapLine({ commission_base: 12345 }),
    { creatorId: "c", referrerId: "r", accountManagementType: "standard" },
    engine.REFERRAL_REWARD_RATE,
  );
  assert.equal(engine.REFERRAL_REWARD_RATE, 0.05);
  assert.equal(computed.baseAmount, 12345);
  assert.equal(computed.rewardAmount, 617.25);
});

test("個別料率が設定されていればそれを使う", () => {
  const computed = engine.computeReferralReward(
    tapLine({ commission_base: 10000 }),
    { creatorId: "c", referrerId: "r", accountManagementType: "standard" },
    engine.resolveReferralRate(0.1),
  );
  assert.equal(computed.rewardRate, 0.1);
  assert.equal(computed.rewardAmount, 1000);
});

test("料率が未設定なら 5% へ落とす", () => {
  assert.equal(engine.resolveReferralRate(null), 0.05);
  assert.equal(engine.resolveReferralRate(0), 0.05);
  assert.equal(engine.resolveReferralRate("abc"), 0.05);
  assert.equal(engine.resolveReferralRate(0.03), 0.03);
});

test("丸めは銭単位（小数2桁）", () => {
  assert.equal(engine.referralRewardAmount(3333, 0.05), 166.65);
  assert.equal(engine.referralRewardAmount(1, 0.05), 0.05);
  assert.equal(engine.referralRewardAmount(12345.67, 0.05), 617.28);
});

test("standard 以外のクリエイターは対象外", () => {
  for (const type of ["self_operated", "account_lending"]) {
    const computed = engine.computeReferralReward(
      tapLine(),
      { creatorId: "c", referrerId: "r", accountManagementType: type },
      0.05,
    );
    assert.equal(computed, null, `${type} が対象になっている`);
  }
});

// -----------------------------------------------------------------------------
// 紹介関係の期間
// -----------------------------------------------------------------------------
test("start_month より前の月は対象外", () => {
  assert.equal(engine.isReferralMonthActive("2026-04", "2026-05", null), false);
  assert.equal(engine.isReferralMonthActive("2026-05", "2026-05", null), true);
  assert.equal(engine.isReferralMonthActive("2026-09", "2026-05", null), true);
});

test("end_month より後の月は対象外", () => {
  assert.equal(engine.isReferralMonthActive("2026-08", "2026-05", "2026-07"), false);
  assert.equal(engine.isReferralMonthActive("2026-07", "2026-05", "2026-07"), true);
});

test("期間を持たない紐付けだけでは報酬を作らない", () => {
  /*
    creators.referred_by_referrer_id は期間を持たない。
    それだけを根拠にすると、現在の紐付けで過去の全月へ報酬が付く。
  */
  const code = codeOnly(SYNC_SOURCE);
  assert.match(code, /const referral = referralByCreator\.get\(creatorId\);\s*\n\s*if \(!referral\) continue;/);
  assert.equal(
    /config\.referrerId \?\? referral\?\.referrerId/.test(code),
    false,
    "creators.referred_by_referrer_id を優先する経路が残っている",
  );
});

// -----------------------------------------------------------------------------
// 別名（改名）
// -----------------------------------------------------------------------------
function tapRow(overrides = {}) {
  return {
    sourceRowKey: "",
    orderId: "order-1",
    skuId: "sku-1",
    productId: "prod-1",
    productName: "商品",
    creatorTikTokId: "oldname",
    creatorName: "oldname",
    shopName: null,
    shopCode: null,
    targetMonth: "2026-07",
    contentType: "動画",
    contentId: "content-1",
    invitationId: null,
    commissionType: null,
    productPrice: 1000,
    quantity: 1,
    commissionGmv: 1000,
    commissionBase: 1000,
    partnerEstimatedCommission: 0,
    partnerShopAdsEstimatedCommission: 0,
    partnerBonusEstimatedCommission: 0,
    tapRevenue: 0,
    paymentStatus: "支払い済み",
    orderStatus: "決済済み",
    refundStatus: "いいえ",
    orderedAt: null,
    deliveredAt: null,
    paidAt: null,
    rawRowJson: {},
    ...overrides,
  };
}

test("TAP にも別名が効き、一意キーが作り直される", () => {
  const map = aliasMod.buildCreatorAliasMap([
    { aliasTiktokId: "oldname", canonicalTiktokId: "newname" },
  ]);
  const before = tapRow({
    sourceRowKey: tapParse.buildTapAffiliateOrderSourceRowKey({
      orderId: "order-1",
      skuId: "sku-1",
      productId: "prod-1",
      creatorTikTokId: "oldname",
      contentId: "content-1",
      invitationId: null,
      commissionType: null,
    }),
  });

  const applied = tapAlias.applyCreatorAliasesToTapRows([before], map);
  assert.equal(applied.aliasedRowCount, 1);
  assert.equal(applied.rows[0].creatorTikTokId, "newname");
  assert.notEqual(applied.rows[0].sourceRowKey, before.sourceRowKey);
  assert.match(applied.rows[0].sourceRowKey, /\|newname\|/);
  assert.deepEqual(applied.appliedAliases, [{ from: "oldname", to: "newname", rowCount: 1 }]);
});

test("別名が無ければ行はそのまま", () => {
  const applied = tapAlias.applyCreatorAliasesToTapRows([tapRow()], new Map());
  assert.equal(applied.aliasedRowCount, 0);
  assert.deepEqual(applied.appliedAliases, []);
});

test("別名の解決は共通実装を使う（独自ロジックを持たない）", () => {
  const source = fs.readFileSync("lib/orders/tap-creator-alias.ts", "utf8");
  assert.match(source, /resolveCanonicalTiktokId/);
  assert.match(source, /from "@\/lib\/orders\/creator-alias"/);
  // 連鎖のたどり直しを自前で書いていないこと
  assert.equal(codeOnly(source).includes("MAX_ALIAS_DEPTH"), false);
});

test("TAP のキー組み立ては1箇所だけが持つ", () => {
  const parser = fs.readFileSync("lib/orders/parse-tap-affiliate-order-export.ts", "utf8");
  const joins = codeOnly(parser).match(/\]\.join\("\|"\)/g) ?? [];
  assert.equal(joins.length, 1, "キーの組み立てが複数ある");
  assert.equal(
    tapParse.buildTapAffiliateOrderSourceRowKey({
      orderId: "o", skuId: "s", productId: "p", creatorTikTokId: "c",
      contentId: "ct", invitationId: null, commissionType: null,
    }),
    "o|s|p|c|ct||",
  );
});

// -----------------------------------------------------------------------------
// 未知クリエイター
// -----------------------------------------------------------------------------
test("知らないクリエイターを creators へ作らない", () => {
  const code = codeOnly(IMPORT_SOURCE);
  assert.equal(
    /\.from\("creators"\)[\s\S]{0,200}\.upsert\(/.test(code),
    false,
    "TAP取込に creators の upsert が残っている",
  );
  assert.match(code, /summarizeUnknownCreators/);
});

test("未知クリエイターを件数・金額・月でまとめる", () => {
  const rows = [
    tapRow({ creatorTikTokId: "unknown1", commissionBase: 1000, targetMonth: "2026-06" }),
    tapRow({ creatorTikTokId: "unknown1", commissionBase: 2000, targetMonth: "2026-07" }),
    tapRow({ creatorTikTokId: "known1", commissionBase: 5000 }),
    tapRow({ creatorTikTokId: "@Unknown2", commissionBase: 500 }),
  ];
  const summary = tapAlias.summarizeUnknownCreators(rows, new Set(["known1"]));
  assert.equal(summary.length, 2);
  assert.equal(summary[0].tiktokId, "unknown1");
  assert.equal(summary[0].rowCount, 2);
  assert.equal(summary[0].commissionBase, 3000);
  assert.deepEqual(summary[0].months, ["2026-06", "2026-07"]);
  // @ と大文字は正規化される
  assert.equal(summary[1].tiktokId, "unknown2");
});

test("紐付かない行は取り込まない", () => {
  const code = codeOnly(IMPORT_SOURCE);
  assert.match(code, /const linkedRows = rows\.filter/);
  assert.match(code, /skippedUnlinkedRowCount/);
});

// -----------------------------------------------------------------------------
// 取込の安全装置
// -----------------------------------------------------------------------------
test("同じファイルの再取込を止める仕組みが残っている", () => {
  const code = codeOnly(IMPORT_SOURCE);
  assert.match(code, /getTapFileHash/);
  assert.match(code, /\.eq\("file_hash", fileHash\)/);
  assert.match(code, /duplicateFile: true/);
});

test("同じ明細の後日更新は upsert で1行に収まる", () => {
  const code = codeOnly(IMPORT_SOURCE);
  assert.match(code, /onConflict: "source_row_key"/);
  // キーに金額・支払状況を含めない（含めると更新が別行になる）
  const key = tapParse.buildTapAffiliateOrderSourceRowKey({
    orderId: "o", skuId: "s", productId: "p", creatorTikTokId: "c",
    contentId: "ct", invitationId: null, commissionType: null,
  });
  assert.equal(key.includes("支払い済み"), false);
  assert.equal(/\d{4,}/.test(key), false, "キーに金額らしき数値が入っている");
});

test("取込前に必ずプレビューを返せる", () => {
  const code = codeOnly(IMPORT_SOURCE);
  assert.match(code, /dry_run/);
  assert.match(code, /if \(dryRun\)/);
  for (const field of [
    "fileHash", "totalRows", "monthCounts", "knownCreatorCount",
    "aliasedRowCount", "unknownCreators", "commissionBaseTotal",
    "existingRowCount", "newRowCount", "excludedCounts",
  ]) {
    assert.match(code, new RegExp(field), `プレビューに ${field} が無い`);
  }
});

test("既存行の照合に source_row_key の .in() を使わない（URLが長くなる）", () => {
  const code = codeOnly(IMPORT_SOURCE);
  assert.equal(
    /\.in\("source_row_key"/.test(code),
    false,
    "source_row_key の .in() は 414 の原因になる",
  );
  assert.match(code, /\.in\("creator_id", slice\)/);
});

// -----------------------------------------------------------------------------
// 移行（migration / RPC）
// -----------------------------------------------------------------------------
test("出所を記録する列が追加される", () => {
  assert.match(MIGRATION, /add column if not exists source_table text/);
  assert.match(MIGRATION, /set source_table = 'affiliate_order_lines'/);
  assert.match(MIGRATION, /check \(source_table in \('affiliate_order_lines', 'tap_affiliate_order_lines'\)\)/);
  assert.match(MIGRATION, /set default 'tap_affiliate_order_lines'/);
});

test("旧データの置き換えは使用済み1件で中止する", () => {
  assert.match(MIGRATION, /purge_affiliate_sourced_referral_rewards/);
  assert.match(MIGRATION, /is_paid = true or payment_batch_id is not null or payout_id is not null or paid_at is not null/);
  assert.match(MIGRATION, /置き換えを中止しました/);
  // 既定は dry-run
  assert.match(MIGRATION, /p_dry_run boolean default true/);
  // 削除条件にも未使用の4条件を重ねて書く
  assert.match(MIGRATION, /and is_paid = false\s*\n\s*and payment_batch_id is null\s*\n\s*and payout_id is null\s*\n\s*and paid_at is null/);
});

test("置き換え関数は報酬を計算し直さない", () => {
  // SQL 側に計算式を持つとアプリ側と二重管理になる
  const fn = MIGRATION.slice(MIGRATION.indexOf("purge_affiliate_sourced_referral_rewards"));
  assert.equal(fn.includes("0.05"), false, "SQL に料率が書かれている");
  assert.equal(fn.includes("commission_base"), false, "SQL に計算元が書かれている");
  assert.equal(fn.includes("insert into public.referral_reward_items"), false);
});

test("確定していない月は紹介者の支払明細を作れない", () => {
  assert.match(MIGRATION, /referral_month_settlements/);
  assert.match(MIGRATION, /check \(status in \('unfinalized', 'ready', 'finalized'\)\)/);
  assert.match(MIGRATION, /assert_referral_months_finalized/);
  assert.match(MIGRATION, /紹介者報酬が未確定の月があります/);
  // 行が無い月も未確定として扱う
  assert.match(MIGRATION, /coalesce\(s\.status, 'unfinalized'\) <> 'finalized'/);
});

test("管理者以外は置き換えを実行できない", () => {
  assert.match(MIGRATION, /if not public\.is_app_admin\(\) then/);
  assert.match(MIGRATION, /revoke all on function public\.purge_affiliate_sourced_referral_rewards\(boolean\) from public, anon;/);
});

test("dry-run スクリプトは書き込みを行わない", () => {
  const source = fs.readFileSync("scripts/dry-run-tap-referral-rewards.mjs", "utf8");
  const code = codeOnly(source);
  for (const banned of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
    assert.equal(code.includes(banned), false, `dry-run に ${banned} がある`);
  }
});

// -----------------------------------------------------------------------------
// 認証（画面の制御だけに頼らない）
// -----------------------------------------------------------------------------
const IMPORT_PAGE = fs.readFileSync("app/admin/tap-orders-import/page.tsx", "utf8");
const IMPORT_CLIENT = fs.readFileSync(
  "app/admin/tap-orders-import/TapOrdersImportClient.tsx",
  "utf8",
);
const LOCK_MIGRATION = fs.readFileSync(
  "supabase/migrations/20260927110000_claim_referral_finalized_lock.sql",
  "utf8",
);

test("TAP取込アクションは親管理者だけが実行できる", () => {
  const code = codeOnly(IMPORT_SOURCE);
  assert.match(code, /requireAdminAction/);
  // 認可がファイル読み取りより前にあること
  const authAt = code.indexOf("await requireAdminAction()");
  const fileAt = code.indexOf('formData.get("file")');
  assert.ok(authAt >= 0, "requireAdminAction を呼んでいない");
  assert.ok(authAt < fileAt, "認可より先にファイルを読んでいる");
});

test("認可は既存の共通実装を使う（独自認証を作らない）", () => {
  assert.match(IMPORT_SOURCE, /from "@\/lib\/db\/admin-access"/);
  const code = codeOnly(IMPORT_SOURCE);
  assert.equal(code.includes("is_app_admin"), false);
  assert.equal(code.includes("auth.getUser()"), false);
});

test("プレビューも確定取込も同じ認可を通る", () => {
  const code = codeOnly(IMPORT_SOURCE);
  // dry_run の判定より前に認可がある＝両方に効く
  assert.ok(code.indexOf("await requireAdminAction()") < code.indexOf('formData.get("dry_run")'));
});

test("TAP取込ページは未ログイン / 非admin を弾く", () => {
  assert.match(IMPORT_PAGE, /redirect\("\/login\?next=\/admin\/tap-orders-import"\)/);
  assert.match(IMPORT_PAGE, /isAdminRole\(appUser\.data\.role\)/);
  assert.match(IMPORT_PAGE, /redirect\("\/dashboard"\)/);
  // ページ自体はサーバーコンポーネント（"use client" を持たない）
  assert.equal(IMPORT_PAGE.includes('"use client"'), false);
});

// -----------------------------------------------------------------------------
// 確定取込のガード
// -----------------------------------------------------------------------------
test("未登録クリエイターがあると確定取込を拒否する（サーバー側）", () => {
  const code = codeOnly(IMPORT_SOURCE);
  assert.match(code, /if \(!dryRun\) \{[\s\S]*?if \(unknownCreators\.length > 0\)/);
  assert.match(code, /未登録のクリエイターが/);
});

test("プレビューと違うファイルなら確定取込を拒否する", () => {
  const code = codeOnly(IMPORT_SOURCE);
  assert.match(code, /preview_file_hash/);
  assert.match(code, /if \(confirmedHash !== fileHash\)/);
  assert.match(code, /先にプレビューで内容を確認してください/);
});

test("拒否されたときに取込履歴だけ残さない", () => {
  const code = codeOnly(IMPORT_SOURCE);
  // 取込履歴の INSERT は、すべての検査を通ったあとにある
  const guardAt = code.indexOf("if (!dryRun) {");
  const insertAt = code.indexOf('.from("tap_affiliate_order_import_batches")\n      .insert(');
  assert.ok(guardAt >= 0 && insertAt >= 0);
  assert.ok(guardAt < insertAt, "検査より先に取込履歴を作っている");
});

test("画面は未登録クリエイターがあると確定取込を押せない", () => {
  assert.match(IMPORT_CLIENT, /const canConfirm = Boolean\(preview\) && unknownCount === 0/);
  assert.match(IMPORT_CLIENT, /disabled=\{!canConfirm\}/);
  // ファイルを変えたらプレビューを捨てる
  assert.match(IMPORT_CLIENT, /setPreview\(null\)/);
});

test("画面は処理中に二重送信できない", () => {
  assert.match(IMPORT_CLIENT, /disabled=\{!file \|\| isPending\}/);
  assert.match(IMPORT_CLIENT, /const canConfirm = Boolean\(preview\) && unknownCount === 0 && !isPending/);
});

test("画面はプレビューであることを明示する", () => {
  assert.match(IMPORT_CLIENT, /これはプレビューです。まだデータベースには保存されていません。/);
});

test("プレビュー画面に必要な項目が出る", () => {
  for (const label of [
    "ファイル名", "ファイルhash", "総行数", "対象期間",
    "新規候補", "更新候補", "スキップ", "成果報酬ベース総額",
    "クリエイター数", "既知クリエイター", "別名で寄せた行", "未登録クリエイター",
  ]) {
    assert.ok(IMPORT_CLIENT.includes(label), `プレビューに「${label}」が無い`);
  }
});

// -----------------------------------------------------------------------------
// 支払ロック
// -----------------------------------------------------------------------------
test("ロックが claim の referrer 分岐へ接続されている", () => {
  assert.match(
    LOCK_MIGRATION,
    /if p_payee_kind = 'referrer' then\s*\n\s*perform public\.assert_referral_months_finalized\(v_start_month, p_cutoff_month\);/,
  );
});

test("ロックの範囲は claim が占有する範囲と同じ", () => {
  // claim は target_month between v_start_month and p_cutoff_month を占有する
  assert.match(LOCK_MIGRATION, /target_month >= v_start_month/);
  assert.match(LOCK_MIGRATION, /assert_referral_months_finalized\(v_start_month, p_cutoff_month\)/);
});

test("明細が1件も無い月も未確定として扱う", () => {
  // TAP 未取込で明細ゼロの月を「問題なし」と通さない
  assert.match(LOCK_MIGRATION, /generate_series/);
  assert.match(LOCK_MIGRATION, /coalesce\(\s*\n?\s*\(select s\.status from public\.referral_month_settlements s/);
  assert.match(LOCK_MIGRATION, /'unfinalized'\s*\n?\s*\) <> 'finalized'/);
});

test("代理店の支払にはロックを掛けない", () => {
  const fn = LOCK_MIGRATION.slice(LOCK_MIGRATION.indexOf("claim_payment_batch_items"));
  // agency 分岐に assert が入っていないこと
  const agencyBranch = fn.slice(fn.indexOf("if p_payee_kind = 'agency' then"));
  const referrerAssert = agencyBranch.indexOf("assert_referral_months_finalized");
  const elseAt = agencyBranch.indexOf("\n  else\n");
  assert.ok(
    referrerAssert === -1 || (elseAt >= 0 && referrerAssert > elseAt),
    "agency 分岐にロックが入っている",
  );
});

test("旧の代理店帰属ガードを今回は外さない", () => {
  assert.match(LOCK_MIGRATION, /は代理店に帰属しています/);
});

test("ロック接続のmigrationは報酬の金額・支払状態を書き換えない", () => {
  // 追加・削除はしない
  for (const banned of [
    "delete from public.referral_reward_items",
    "insert into public.referral_reward_items",
  ]) {
    assert.equal(LOCK_MIGRATION.includes(banned), false, `${banned} がある`);
  }

  /*
    referral_reward_items の UPDATE は claim 本来の占有だけ。
    金額・支払状態の列に代入していないことを確かめる。
  */
  // SET句だけを取り出す（WHERE句の比較を代入と誤認しないため）
  const setClauses = [
    ...LOCK_MIGRATION.matchAll(
      /update\s+public\.referral_reward_items\s+set([\s\S]*?)\s+where/gi,
    ),
  ].map((m) => m[1]);
  assert.ok(setClauses.length > 0, "claim の UPDATE が見つからない");

  for (const col of [
    "reward_amount", "adjusted_reward_amount", "original_reward_amount",
    "base_amount", "reward_rate", "referrer_id", "creator_id",
    "is_paid", "payout_id", "paid_at", "is_reward_target",
  ]) {
    for (const clause of setClauses) {
      assert.equal(
        new RegExp(`\\b${col}\\s*=`).test(clause),
        false,
        `${col} に代入している: ${clause.trim()}`,
      );
    }
  }
  // 代入されるのは占有の2列だけ
  for (const clause of setClauses) {
    const assigned = [...clause.matchAll(/(\w+)\s*=/g)].map((m) => m[1]).sort();
    assert.deepEqual(assigned, ["payment_batch_id", "updated_at"]);
  }
  // 占有は payment_batch_id だけ
  assert.match(LOCK_MIGRATION, /set payment_batch_id = v_batch_id/);

  // settlement を勝手に finalized にしない
  assert.equal(/update public\.referral_month_settlements/.test(LOCK_MIGRATION), false);
  assert.equal(/insert into public\.referral_month_settlements/.test(LOCK_MIGRATION), false);
});
