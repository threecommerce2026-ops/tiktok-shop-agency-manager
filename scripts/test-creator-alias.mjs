/*
  クリエイター改名（別名）のテスト。

  改名で source_row_key が変わると同じ注文明細が二重登録される。
  別名を適用したとき「旧名で作られた既存キーと一致するか」が要点。

  実行: node --test scripts/test-creator-alias.mjs
*/
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, { alias: { "@": root }, interopDefault: true, fsCache: false });

const aliasMod = await jiti.import(path.join(root, "lib/orders/creator-alias.ts"));
const keyMod = await jiti.import(path.join(root, "lib/orders/affiliate-order-source-key.ts"));
const payload = await jiti.import(path.join(root, "lib/orders/affiliate-order-import-payload.ts"));

const OLD_NAME = "kanyatoyselect_jp";
const NEW_NAME = "kanyaselect_jp";

function makeRow(overrides = {}) {
  const base = {
    rowNumber: 2,
    orderId: "584807621643699594",
    skuId: "1730000000000000001",
    productId: "1729000000000000001",
    productName: "テスト商品",
    productPrice: 1430,
    quantity: 1,
    isFullyRefunded: false,
    creatorTiktokId: NEW_NAME,
    creatorTagId: null,
    shopName: "テストショップ",
    shopCode: "7490000000000000001",
    currency: "JPY",
    orderType: null,
    paymentStatus: "決済済み",
    contentType: "動画",
    contentId: "7652657758390521109",
    factorType: "",
    commissionType: "全注文に同一成果報酬率を適用",
    standardCommissionRate: 10,
    shopAdsCommissionRate: null,
    tiktokBonusCommissionRate: null,
    partnerBonusCommissionRate: null,
    commissionGmv: 1430,
    estimatedCommissionBase: 1430,
    commissionBase: 1430,
    creatorRevenueBeforeSplit: 143,
    agencySplitRate: 10,
    agencyRevenueBeforeTax: 114,
    agencyRevenue: 114,
    invitationId: "7300000000000000001",
    orderedAt: "2026-07-05T10:00:00+09:00",
    deliveredAt: null,
    paymentId: "PAY-1",
    payoutStatus: "支払い済み",
    targetMonth: "2026-07",
    raw: { "クリエイターのユーザー名": NEW_NAME },
    ...overrides,
  };

  base.sourceRowKey = keyMod.buildAffiliateOrderSourceRowKey(base);
  return base;
}

const ALIAS = [{ aliasTiktokId: NEW_NAME, canonicalTiktokId: OLD_NAME }];

// =============================================================================
// 正規化と解決
// =============================================================================

test("別名が無いクリエイターは従来どおり（キーが変わらない）", () => {
  const map = aliasMod.buildCreatorAliasMap(ALIAS);
  const row = makeRow({ creatorTiktokId: "other_creator" });
  const before = row.sourceRowKey;

  const applied = aliasMod.applyCreatorAliases([row], map);

  assert.equal(applied.aliasedRowCount, 0);
  assert.equal(applied.rows[0].sourceRowKey, before);
  assert.equal(applied.rows[0].creatorTiktokId, "other_creator");
});

test("別名表が空なら何も起きない", () => {
  const row = makeRow();
  const applied = aliasMod.applyCreatorAliases([row], new Map());
  assert.equal(applied.aliasedRowCount, 0);
  assert.equal(applied.rows[0].sourceRowKey, row.sourceRowKey);
});

test("別名のクリエイターは正式名のキーになる", () => {
  const map = aliasMod.buildCreatorAliasMap(ALIAS);
  const newRow = makeRow({ creatorTiktokId: NEW_NAME });
  const oldRow = makeRow({ creatorTiktokId: OLD_NAME });

  const applied = aliasMod.applyCreatorAliases([newRow], map);

  assert.equal(applied.aliasedRowCount, 1);
  assert.equal(applied.rows[0].creatorTiktokId, OLD_NAME);
  // 旧名で作られた既存キーと完全一致する = UPSERT で更新になる
  assert.equal(applied.rows[0].sourceRowKey, oldRow.sourceRowKey);
});

test("正規化（大文字・空白・先頭@）を取込側と揃えている", () => {
  const map = aliasMod.buildCreatorAliasMap([
    { aliasTiktokId: "  @KanyaSelect_JP ", canonicalTiktokId: " KANYATOYSELECT_JP " },
  ]);
  assert.equal(aliasMod.resolveCanonicalTiktokId("@KanyaSelect_JP", map), OLD_NAME);
  assert.equal(aliasMod.resolveCanonicalTiktokId(NEW_NAME, map), OLD_NAME);
});

test("元のExcel値は raw に残る（source identity を失わない）", () => {
  const map = aliasMod.buildCreatorAliasMap(ALIAS);
  const applied = aliasMod.applyCreatorAliases([makeRow()], map);
  assert.equal(applied.rows[0].raw["クリエイターのユーザー名"], NEW_NAME);
  assert.equal(applied.rows[0].creatorTiktokId, OLD_NAME);
});

// =============================================================================
// 連鎖・循環・自己参照
// =============================================================================

test("連鎖する別名（A→B→C）は最終的な寄せ先まで辿る", () => {
  const map = aliasMod.buildCreatorAliasMap([
    { aliasTiktokId: "a", canonicalTiktokId: "b" },
    { aliasTiktokId: "b", canonicalTiktokId: "c" },
  ]);
  assert.equal(aliasMod.resolveCanonicalTiktokId("a", map), "c");
  assert.equal(aliasMod.resolveCanonicalTiktokId("b", map), "c");
  assert.equal(aliasMod.resolveCanonicalTiktokId("c", map), "c");
});

test("循環する別名（A→B, B→A）は解決せず元の名前を返す", () => {
  const map = aliasMod.buildCreatorAliasMap([
    { aliasTiktokId: "a", canonicalTiktokId: "b" },
    { aliasTiktokId: "b", canonicalTiktokId: "a" },
  ]);
  assert.equal(aliasMod.resolveCanonicalTiktokId("a", map), "a");
  assert.equal(aliasMod.resolveCanonicalTiktokId("b", map), "b");
});

test("自己参照はMap構築時に捨てられる", () => {
  const map = aliasMod.buildCreatorAliasMap([
    { aliasTiktokId: "a", canonicalTiktokId: "a" },
  ]);
  assert.equal(map.size, 0);
  assert.equal(aliasMod.resolveCanonicalTiktokId("a", map), "a");
});

test("連鎖が深すぎる場合は解決しない", () => {
  const records = [];
  for (let i = 0; i < 30; i += 1) {
    records.push({ aliasTiktokId: `n${i}`, canonicalTiktokId: `n${i + 1}` });
  }
  const map = aliasMod.buildCreatorAliasMap(records);
  assert.equal(aliasMod.resolveCanonicalTiktokId("n0", map), "n0");
});

test("連鎖している別名を洗い出せる", () => {
  const chained = aliasMod.findChainedAliases([
    { aliasTiktokId: "a", canonicalTiktokId: "b" },
    { aliasTiktokId: "b", canonicalTiktokId: "c" },
  ]);
  assert.equal(chained.length, 1);
  assert.deepEqual(chained[0], { alias: "a", via: "b", canonical: "c" });
});

// =============================================================================
// 登録時の検証
// =============================================================================

test("登録: 正常な別名は通る", () => {
  const result = aliasMod.validateCreatorAliasInput(
    { aliasTiktokId: "  @NewName ", canonicalTiktokId: "OldName" },
    [],
  );
  assert.equal(result.ok, true);
  assert.equal(result.aliasTiktokId, "newname");
  assert.equal(result.canonicalTiktokId, "oldname");
});

test("登録: 自己参照は拒否", () => {
  const result = aliasMod.validateCreatorAliasInput(
    { aliasTiktokId: "a", canonicalTiktokId: "A" },
    [],
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /同じ/);
});

test("登録: 空欄は拒否", () => {
  assert.equal(
    aliasMod.validateCreatorAliasInput({ aliasTiktokId: "", canonicalTiktokId: "b" }, []).ok,
    false,
  );
  assert.equal(
    aliasMod.validateCreatorAliasInput({ aliasTiktokId: "a", canonicalTiktokId: "  " }, []).ok,
    false,
  );
});

test("登録: 同じ旧名の二重登録は拒否", () => {
  const result = aliasMod.validateCreatorAliasInput(
    { aliasTiktokId: "a", canonicalTiktokId: "c" },
    [{ aliasTiktokId: "a", canonicalTiktokId: "b" }],
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /既に別名として登録/);
});

test("登録: 循環を生む組み合わせは拒否", () => {
  const result = aliasMod.validateCreatorAliasInput(
    { aliasTiktokId: "a", canonicalTiktokId: "b" },
    [{ aliasTiktokId: "b", canonicalTiktokId: "a" }],
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /循環/);
});

test("登録: 寄せ先がさらに別名でも登録できる（連鎖は解決される）", () => {
  const result = aliasMod.validateCreatorAliasInput(
    { aliasTiktokId: "a", canonicalTiktokId: "b" },
    [{ aliasTiktokId: "b", canonicalTiktokId: "c" }],
  );
  assert.equal(result.ok, true);
});

// =============================================================================
// preview と import で同じ解決になること
// =============================================================================

test("サーバーは正式名へ寄せていない行を受け付けない", () => {
  const map = aliasMod.buildCreatorAliasMap(ALIAS);

  // ブラウザ側で別名を適用し忘れた（旧名のまま送ってきた）行
  const notCanonical = makeRow({ creatorTiktokId: NEW_NAME });

  const result = payload.validateAffiliateOrderPayloadRow(notCanonical, map);
  assert.equal(result.ok, false);
  assert.match(result.error, /正式名へ寄せられていません/);
});

test("サーバーは正式名へ寄せた行を受け付け、同じキーを再生成する", () => {
  const map = aliasMod.buildCreatorAliasMap(ALIAS);
  const applied = aliasMod.applyCreatorAliases([makeRow()], map);

  const result = payload.validateAffiliateOrderPayloadRow(applied.rows[0], map);
  assert.equal(result.ok, true);
  assert.equal(result.row.creatorTiktokId, OLD_NAME);
  assert.equal(result.row.sourceRowKey, applied.rows[0].sourceRowKey);
});

test("別名表が無いサーバーでは従来どおり検証される", () => {
  const row = makeRow({ creatorTiktokId: "plain_creator" });
  const result = payload.validateAffiliateOrderPayloadRow(row);
  assert.equal(result.ok, true);
});

test("preview と import は同じ関数で解決するため差が出ない", () => {
  const map = aliasMod.buildCreatorAliasMap(ALIAS);
  const rows = [makeRow({ orderId: "A" }), makeRow({ orderId: "B" })];

  // preview 側
  const previewRows = aliasMod.applyCreatorAliases(rows, map).rows;

  // import 側（サーバー再検証）
  const importRows = previewRows.map(
    (r) => payload.validateAffiliateOrderPayloadRow(r, map).row,
  );

  assert.deepEqual(
    previewRows.map((r) => r.sourceRowKey),
    importRows.map((r) => r.sourceRowKey),
  );
  assert.deepEqual(
    previewRows.map((r) => r.creatorTiktokId),
    importRows.map((r) => r.creatorTiktokId),
  );
});

// =============================================================================
// 二重登録の防止
// =============================================================================

test("改名前Excel → 改名後Excel でも重複しない", () => {
  const map = aliasMod.buildCreatorAliasMap(ALIAS);

  // 1回目: 旧名のExcel
  const first = aliasMod.applyCreatorAliases(
    [makeRow({ creatorTiktokId: OLD_NAME })],
    map,
  ).rows;

  // 2回目: 改名後のExcel（同じ注文明細）
  const second = aliasMod.applyCreatorAliases(
    [makeRow({ creatorTiktokId: NEW_NAME })],
    map,
  ).rows;

  assert.equal(first[0].sourceRowKey, second[0].sourceRowKey);
  // UPSERT キーが同一 = INSERT ではなく UPDATE
  assert.equal(new Set([...first, ...second].map((r) => r.sourceRowKey)).size, 1);
});

test("同じExcelを再投入しても冪等", () => {
  const map = aliasMod.buildCreatorAliasMap(ALIAS);
  const a = aliasMod.applyCreatorAliases([makeRow()], map).rows;
  const b = aliasMod.applyCreatorAliases([makeRow()], map).rows;
  assert.equal(a[0].sourceRowKey, b[0].sourceRowKey);
});

test("別人は統合されない（別名に無いクリエイター同士）", () => {
  const map = aliasMod.buildCreatorAliasMap(ALIAS);
  const x = aliasMod.applyCreatorAliases(
    [makeRow({ creatorTiktokId: "creator_x" })],
    map,
  ).rows[0];
  const y = aliasMod.applyCreatorAliases(
    [makeRow({ creatorTiktokId: "creator_y" })],
    map,
  ).rows[0];

  assert.notEqual(x.sourceRowKey, y.sourceRowKey);
});

test("別名の適用件数と内訳が報告される", () => {
  const map = aliasMod.buildCreatorAliasMap(ALIAS);
  const rows = [
    makeRow({ orderId: "A", creatorTiktokId: NEW_NAME }),
    makeRow({ orderId: "B", creatorTiktokId: NEW_NAME }),
    makeRow({ orderId: "C", creatorTiktokId: "other" }),
  ];

  const applied = aliasMod.applyCreatorAliases(rows, map);

  assert.equal(applied.aliasedRowCount, 2);
  assert.equal(applied.appliedAliases.length, 1);
  assert.deepEqual(applied.appliedAliases[0], {
    from: NEW_NAME,
    to: OLD_NAME,
    rowCount: 2,
  });
});

// =============================================================================
// キー定義・Finance Engine を変えていないこと
// =============================================================================

test("source_row_key の組み立てルール自体は変更していない", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    path.join(root, "lib/orders/affiliate-order-source-key.ts"),
    "utf8",
  );

  // 8項目を "|" で連結する定義がそのまま残っていること
  assert.match(source, /keyPart\(parts\.orderId\)/);
  assert.match(source, /keyPart\(parts\.commissionType\)/);
  assert.match(source, /\.join\("\|"\)/);
  // 別名の概念はこのファイルに持ち込まない
  assert.ok(!/alias/i.test(source), "キー定義に alias が混入している");
});

test("別名モジュールは報酬計算に一切触れない", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(path.join(root, "lib/orders/creator-alias.ts"), "utf8");

  for (const forbidden of [
    "agency_reward_items",
    "referral_reward_items",
    "reward_amount",
    "commission_base *=",
    "payment_batch",
  ]) {
    assert.ok(
      !new RegExp(forbidden).test(source),
      `別名モジュールが ${forbidden} に触れている`,
    );
  }
});

test("別名の登録・削除は管理者のみ", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(path.join(root, "app/actions/creator-aliases.ts"), "utf8");

  for (const name of [
    "fetchCreatorAliasesForAdmin",
    "createCreatorAliasAction",
    "deleteCreatorAliasAction",
  ]) {
    const start = source.indexOf(`export async function ${name}`);
    assert.ok(start >= 0, `${name} が見つからない`);
    const head = source.slice(start, start + 300);
    assert.match(head, /requireAdminAction\(\)/, name);
  }

  // 注文データ・報酬データへ書き込まないこと（コメントを除いた実コードで判定）
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  assert.ok(!/affiliate_order_lines/.test(code), "注文データに触れている");
  assert.ok(!/agency_reward_items/.test(code), "代理店報酬に触れている");
  assert.ok(!/referral_reward_items/.test(code), "紹介者報酬に触れている");
  assert.ok(!/from\("creators"\)/.test(code), "creators に触れている");
});

test("414修正が維持されている（source_row_key の IN 句が無い）", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    path.join(root, "app/actions/import-affiliate-orders.ts"),
    "utf8",
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*/g, "");

  assert.ok(!/\.in\(\s*["']source_row_key["']/.test(code));
  assert.match(code, /\.in\(["']target_month["']/);
});
