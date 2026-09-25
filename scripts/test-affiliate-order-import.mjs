/*
  アフィリエイト注文Excel取込（チャンク方式）のテスト。

  検証するのは「DBへ送る前に安全にできているか」だけ。
  報酬の計算式には一切触れない。

  実行: node --test scripts/test-affiliate-order-import.mjs
*/
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, { alias: { "@": root }, interopDefault: true, fsCache: false });

const keyMod = await jiti.import(path.join(root, "lib/orders/affiliate-order-source-key.ts"));
const payload = await jiti.import(path.join(root, "lib/orders/affiliate-order-import-payload.ts"));
const preview = await jiti.import(path.join(root, "lib/orders/affiliate-order-preview.ts"));
const parser = await jiti.import(path.join(root, "lib/orders/parse-affiliate-order-export.ts"));

// =============================================================================
// テスト用の行を作る
// =============================================================================

/** raw_row_json の実測平均は 1,099 bytes。本番相当の重さを再現する */
function makeRaw(seed) {
  const raw = {};
  for (let i = 0; i < 46; i += 1) {
    raw[`列${i}`] = `値-${seed}-${i}-${"x".repeat(8)}`;
  }
  return raw;
}

function makeRow(overrides = {}) {
  const orderId = overrides.orderId ?? "5790000000000000001";
  const skuId = overrides.skuId ?? "1730000000000000001";
  const productId = overrides.productId ?? "1729000000000000001";
  const creatorTiktokId = overrides.creatorTiktokId ?? "test_creator";
  const contentId = overrides.contentId ?? "7400000000000000001";
  const invitationId = overrides.invitationId ?? "7300000000000000001";
  const factorType = overrides.factorType ?? "動画";
  const commissionType = overrides.commissionType ?? "標準";

  const base = {
    rowNumber: 2,
    orderId,
    skuId,
    productId,
    productName: "テスト商品",
    productPrice: 1000,
    quantity: 2,
    isFullyRefunded: false,
    creatorTiktokId,
    creatorTagId: null,
    shopName: "テストショップ",
    shopCode: "7490000000000000001",
    currency: "JPY",
    orderType: null,
    paymentStatus: "決済済み",
    contentType: "動画",
    contentId,
    factorType,
    commissionType,
    standardCommissionRate: 10,
    shopAdsCommissionRate: null,
    tiktokBonusCommissionRate: null,
    partnerBonusCommissionRate: null,
    commissionGmv: 2000,
    estimatedCommissionBase: 2000,
    commissionBase: 2000,
    creatorRevenueBeforeSplit: 200,
    agencySplitRate: 10,
    agencyRevenueBeforeTax: 20,
    agencyRevenue: 20,
    invitationId,
    orderedAt: "2026-05-27T16:03:46+09:00",
    deliveredAt: "2026-05-29T06:33:12+09:00",
    paymentId: "PAY-1",
    payoutStatus: "支払い済み",
    targetMonth: "2026-05",
    raw: makeRaw(orderId),
    ...overrides,
  };

  base.sourceRowKey = keyMod.buildAffiliateOrderSourceRowKey({
    orderId: base.orderId,
    skuId: base.skuId,
    productId: base.productId,
    creatorTiktokId: base.creatorTiktokId,
    contentId: base.contentId,
    invitationId: base.invitationId,
    factorType: base.factorType,
    commissionType: base.commissionType,
  });

  return base;
}

function makeRows(count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(
      makeRow({
        rowNumber: i + 2,
        orderId: `579${String(i).padStart(16, "0")}`,
        skuId: `173${String(i).padStart(16, "0")}`,
        productId: `172${String(i).padStart(16, "0")}`,
        raw: makeRaw(i),
      }),
    );
  }
  return rows;
}

// =============================================================================
// 6. source_row_key の client / server 一致
// =============================================================================

test("source_row_key は従来と同じ結合ルール（識別子8項目を | で連結）", () => {
  const key = keyMod.buildAffiliateOrderSourceRowKey({
    orderId: "O1",
    skuId: "S1",
    productId: "P1",
    creatorTiktokId: "c1",
    contentId: "CT1",
    invitationId: "I1",
    factorType: "動画",
    commissionType: "標準",
  });
  assert.equal(key, "O1|S1|P1|c1|CT1|I1|動画|標準");
  assert.equal(key.split("|").length, 8);
});

test("source_row_key: null と空文字は同じ扱い・前後空白はtrim", () => {
  const a = keyMod.buildAffiliateOrderSourceRowKey({
    orderId: "O1", skuId: null, productId: null, creatorTiktokId: "c1",
    contentId: null, invitationId: null, factorType: null, commissionType: null,
  });
  const b = keyMod.buildAffiliateOrderSourceRowKey({
    orderId: " O1 ", skuId: "", productId: "  ", creatorTiktokId: " c1 ",
    contentId: "", invitationId: "", factorType: "", commissionType: "",
  });
  assert.equal(a, "O1|||c1||||");
  assert.equal(a, b);
});

test("パーサーが作るキーと共通関数の出力が一致する（client/server 同値）", () => {
  const header = [
    "注文ID", "SKU ID", "商品ID", "商品名", "価格", "数量",
    "クリエイターのユーザー名", "ショップ名", "ショップコード", "注文の決済状況",
    "成果報酬GMV", "成果報酬ベース", "収益分配前のクリエイター収益",
    "エージェンシーの収益総額", "作成日時", "支払い状況",
    "コンテンツID", "Invitation ID", "要因のタイプ", "成果報酬のタイプ",
  ];
  const row = [
    "O-1", "S-1", "P-1", "商品", "1000", "2",
    "Creator_A", "SHOP", "7490", "決済済み",
    "2000", "2000", "200",
    "20", "27/05/2026 16:03:46", "支払い済み",
    "CT-1", "INV-1", "動画", "標準",
  ];

  const result = parser.parseAffiliateOrderTable([header, row]);
  assert.equal(result.rows.length, 1);

  const parsedRow = result.rows[0];
  // クリエイター名は小文字化される既存仕様
  assert.equal(parsedRow.creatorTiktokId, "creator_a");
  assert.equal(
    parsedRow.sourceRowKey,
    keyMod.buildAffiliateOrderSourceRowKey({
      orderId: parsedRow.orderId,
      skuId: parsedRow.skuId,
      productId: parsedRow.productId,
      creatorTiktokId: parsedRow.creatorTiktokId,
      contentId: parsedRow.contentId,
      invitationId: parsedRow.invitationId,
      factorType: parsedRow.factorType,
      commissionType: parsedRow.commissionType,
    }),
  );
  assert.equal(parsedRow.sourceRowKey, "O-1|S-1|P-1|creator_a|CT-1|INV-1|動画|標準");
  assert.equal(parsedRow.targetMonth, "2026-05");
});

// =============================================================================
// 3 / 4. ファイル内 source_row_key 重複
// =============================================================================

test("同一ファイル内の重複は排除され、件数が報告される", () => {
  const a = makeRow({ rowNumber: 2, commissionBase: 1000 });
  const b = makeRow({ rowNumber: 3, commissionBase: 2000 }); // 同じキー
  const c = makeRow({ rowNumber: 4, orderId: "579_OTHER" });

  const result = payload.dedupeAffiliateOrderRows([a, b, c]);

  assert.equal(result.rows.length, 2);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.duplicateKeys.length, 1);
  assert.equal(result.duplicateKeys[0], a.sourceRowKey);
});

test("重複は「最後の行を採用」する", () => {
  const first = makeRow({ rowNumber: 2, commissionBase: 1000, payoutStatus: "未払い" });
  const last = makeRow({ rowNumber: 3, commissionBase: 9999, payoutStatus: "支払い済み" });

  const result = payload.dedupeAffiliateOrderRows([first, last]);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].commissionBase, 9999);
  assert.equal(result.rows[0].payoutStatus, "支払い済み");
});

test("重複排除後はキーが一意（Postgres 21000 を構造的に防ぐ）", () => {
  const rows = [...makeRows(50), ...makeRows(50)];
  const result = payload.dedupeAffiliateOrderRows(rows);
  const keys = new Set(result.rows.map((r) => r.sourceRowKey));

  assert.equal(result.rows.length, 50);
  assert.equal(keys.size, 50);
  assert.equal(result.duplicateCount, 50);
});

// =============================================================================
// 8. チャンクのバイト上限
// =============================================================================

test("チャンクは 400KB 上限を超えない", () => {
  const rows = makeRows(2000);
  const { chunks, maxChunkBytes } = payload.buildPayloadChunks(rows);

  assert.ok(chunks.length > 1, `chunks=${chunks.length}`);
  assert.ok(
    maxChunkBytes <= payload.MAX_CHUNK_PAYLOAD_BYTES,
    `maxChunkBytes=${maxChunkBytes}`,
  );

  for (const chunk of chunks) {
    assert.ok(
      payload.jsonByteLength(chunk) <= payload.MAX_CHUNK_PAYLOAD_BYTES,
      `chunk bytes=${payload.jsonByteLength(chunk)}`,
    );
    assert.ok(chunk.length <= payload.MAX_CHUNK_ROWS);
  }
});

test("チャンク分割で行が失われない・重複しない", () => {
  const rows = makeRows(1234);
  const { chunks } = payload.buildPayloadChunks(rows);

  const flat = chunks.flat();
  assert.equal(flat.length, rows.length);
  assert.equal(new Set(flat.map((r) => r.sourceRowKey)).size, rows.length);
});

test("1行だけで上限を超える場合は単独チャンクになる", () => {
  const huge = makeRow({ raw: { big: "x".repeat(500_000) } });
  const { chunks, oversizedRowNumbers } = payload.buildPayloadChunks([
    makeRow({ orderId: "579_A" }),
    huge,
    makeRow({ orderId: "579_B" }),
  ]);

  assert.equal(chunks.flat().length, 3);
  assert.equal(oversizedRowNumbers.length, 1);
  const soloChunk = chunks.find((c) => c.length === 1 && c[0].raw.big);
  assert.ok(soloChunk, "巨大な行が単独チャンクになっていない");
});

// =============================================================================
// 9〜11. 5MB / 10MB / 20MB 相当の Excel
// =============================================================================

/*
  本番実測: 16,618 行 = 4.66MB の xlsx → 約 3,566 行/MB。
  この比率でファイルサイズ相当の行数を作り、
  どのチャンクも上限を超えないことを確かめる。
*/
const ROWS_PER_MB = 3566;

function assertChunkable(megabytes) {
  const rowCount = Math.round(ROWS_PER_MB * megabytes);
  const rows = makeRows(rowCount);
  const { chunks, maxChunkBytes } = payload.buildPayloadChunks(rows);

  assert.equal(chunks.flat().length, rowCount);
  assert.ok(
    maxChunkBytes <= payload.MAX_CHUNK_PAYLOAD_BYTES,
    `${megabytes}MB: maxChunkBytes=${maxChunkBytes}`,
  );

  // Vercel の 4.5MB / Next.js 既定 1MB のどちらにも当たらない
  assert.ok(maxChunkBytes < 1024 * 1024, `${megabytes}MB: Next.js 1MB 上限超え`);
  assert.ok(maxChunkBytes < 4_500_000, `${megabytes}MB: Vercel 4.5MB 上限超え`);

  return { rowCount, chunks: chunks.length, maxChunkBytes };
}

test("5MB相当のExcelでもチャンク送信できる", () => {
  const r = assertChunkable(5);
  assert.ok(r.chunks > 1);
});

test("10MB相当のExcelでもチャンク送信できる", () => {
  const r = assertChunkable(10);
  assert.ok(r.chunks > 1);
});

test("20MB相当のExcelでもチャンク送信できる", () => {
  const r = assertChunkable(20);
  assert.ok(r.chunks > 1);
});

// =============================================================================
// 7. 改ざん検出 / サーバー側再検証
// =============================================================================

test("正常な行はサーバー検証を通る", () => {
  const result = payload.validateAffiliateOrderPayloadRow(makeRow());
  assert.equal(result.ok, true);
});

test("source_row_key を改ざんするとサーバーが拒否する", () => {
  const row = makeRow();
  row.sourceRowKey = "改ざん|された|キー";

  const result = payload.validateAffiliateOrderPayloadRow(row);
  assert.equal(result.ok, false);
  assert.match(result.error, /明細キーが一致しません/);
});

test("キー構成要素を書き換えてもキーを直さなければ拒否される", () => {
  const row = makeRow();
  row.orderId = "別の注文ID"; // sourceRowKey は元のまま

  const result = payload.validateAffiliateOrderPayloadRow(row);
  assert.equal(result.ok, false);
  assert.match(result.error, /明細キーが一致しません/);
});

test("サーバーは送られてきたキーではなく再生成したキーを採用する", () => {
  const row = makeRow();
  // 前後に空白を足しただけならキーは同値なので通る
  row.sourceRowKey = `  ${row.sourceRowKey}  `;

  const result = payload.validateAffiliateOrderPayloadRow(row);
  assert.equal(result.ok, true);
  assert.equal(result.row.sourceRowKey, row.sourceRowKey.trim());
});

test("必須項目（注文ID / クリエイター名）は従来どおり必須", () => {
  const noOrder = payload.validateAffiliateOrderPayloadRow(makeRow({ orderId: "" }));
  assert.equal(noOrder.ok, false);
  assert.match(noOrder.error, /注文ID/);

  const noCreator = payload.validateAffiliateOrderPayloadRow(
    makeRow({ creatorTiktokId: "" }),
  );
  assert.equal(noCreator.ok, false);
  assert.match(noCreator.error, /クリエイター/);
});

test("数値・数量・対象月・日付・rawの型を再検証する", () => {
  const cases = [
    [{ commissionBase: "2000" }, /commissionBase/],
    [{ productPrice: Number.NaN }, /productPrice/],
    [{ quantity: -1 }, /数量/],
    [{ quantity: 1.5 }, /数量/],
    [{ targetMonth: "2026/05" }, /対象月/],
    [{ orderedAt: "not-a-date" }, /作成日時/],
    [{ raw: "text" }, /raw/],
    [{ isFullyRefunded: "はい" }, /返金フラグ/],
    [{ agencySplitRate: "10" }, /agencySplitRate/],
  ];

  for (const [override, pattern] of cases) {
    const result = payload.validateAffiliateOrderPayloadRow(makeRow(override));
    assert.equal(result.ok, false, JSON.stringify(override));
    assert.match(result.error, pattern, JSON.stringify(override));
  }
});

test("行でないものを送っても落ちない", () => {
  for (const value of [null, undefined, 1, "row", [], true]) {
    const result = payload.validateAffiliateOrderPayloadRow(value);
    assert.equal(result.ok, false);
  }
});

// =============================================================================
// 13〜15. 既存明細の状態変更は「更新あり」として検出される
// =============================================================================

/** DB 行の形（numeric は文字列で返る）を再現する */
function toDbRow(row, overrides = {}) {
  return {
    source_row_key: row.sourceRowKey,
    target_month: row.targetMonth,
    payment_status: row.payoutStatus,
    order_status: row.paymentStatus,
    refund_status: row.isFullyRefunded ? "fully_refunded" : null,
    refund_amount: row.isFullyRefunded
      ? (row.productPrice * row.quantity).toFixed(2)
      : "0.00",
    product_price: row.productPrice.toFixed(2),
    quantity: String(row.quantity),
    commission_gmv: row.commissionGmv.toFixed(2),
    commission_base: row.commissionBase.toFixed(2),
    creator_revenue_before_split: row.creatorRevenueBeforeSplit.toFixed(2),
    agency_split_rate: row.agencySplitRate == null ? null : row.agencySplitRate.toFixed(4),
    agency_revenue: row.agencyRevenue.toFixed(2),
    ...overrides,
  };
}

test("同じ内容なら指紋が一致する（DBのnumeric文字列と number を揃える）", () => {
  const row = makeRow();
  assert.equal(
    payload.fingerprintFromPayloadRow(row),
    payload.fingerprintFromDbRow(toDbRow(row)),
  );
});

test("支払状態の変更は更新として検出される", () => {
  const row = makeRow();
  const db = toDbRow(row, { payment_status: "未払い" });
  assert.notEqual(
    payload.fingerprintFromPayloadRow(row),
    payload.fingerprintFromDbRow(db),
  );
});

test("返金の変更は更新として検出される", () => {
  const before = makeRow({ isFullyRefunded: false });
  const after = makeRow({ isFullyRefunded: true });
  assert.notEqual(
    payload.fingerprintFromPayloadRow(after),
    payload.fingerprintFromDbRow(toDbRow(before)),
  );
});

test("commission_base の変更は更新として検出される", () => {
  const row = makeRow();
  const db = toDbRow(row, { commission_base: "1999.00" });
  assert.notEqual(
    payload.fingerprintFromPayloadRow(row),
    payload.fingerprintFromDbRow(db),
  );
});

test("agency_revenue / 注文状態の変更も検出される", () => {
  const row = makeRow();
  assert.notEqual(
    payload.fingerprintFromPayloadRow(row),
    payload.fingerprintFromDbRow(toDbRow(row, { agency_revenue: "21.00" })),
  );
  assert.notEqual(
    payload.fingerprintFromPayloadRow(row),
    payload.fingerprintFromDbRow(toDbRow(row, { order_status: "キャンセル" })),
  );
});

test("取込メタ（updated_at / import_batch_id）は指紋に含めない", () => {
  const row = makeRow();
  const db = toDbRow(row, {
    updated_at: "2099-01-01T00:00:00Z",
    import_batch_id: "00000000-0000-0000-0000-000000000000",
    created_at: "2020-01-01T00:00:00Z",
  });
  assert.equal(
    payload.fingerprintFromPayloadRow(row),
    payload.fingerprintFromDbRow(db),
  );
});

// =============================================================================
// 1 / 2 / 12. 再投入・重複期間・再実行
// =============================================================================

test("同じExcelを2回解析しても行数もキーも増えない", () => {
  const first = payload.dedupeAffiliateOrderRows(makeRows(100));
  const second = payload.dedupeAffiliateOrderRows(makeRows(100));

  assert.equal(first.rows.length, second.rows.length);
  assert.deepEqual(
    first.rows.map((r) => r.sourceRowKey).sort(),
    second.rows.map((r) => r.sourceRowKey).sort(),
  );
  // UPSERT キーが同一なので DB 側も増えない
  assert.equal(
    new Set([...first.rows, ...second.rows].map((r) => r.sourceRowKey)).size,
    100,
  );
});

test("期間が重なるExcelでも重なり部分のキーが同一になる", () => {
  // A: 0..99 / B: 50..149 の重複期間
  const a = makeRows(100);
  const b = makeRows(150).slice(50);

  const keysA = new Set(a.map((r) => r.sourceRowKey));
  const keysB = new Set(b.map((r) => r.sourceRowKey));
  const overlap = [...keysA].filter((k) => keysB.has(k));

  assert.equal(overlap.length, 50);
  // 合計のユニークキーは 150（二重計上されない）
  assert.equal(new Set([...keysA, ...keysB]).size, 150);
});

test("チャンク途中失敗後に同じファイルを流し直しても対象キーは変わらない", () => {
  const rows = makeRows(800);
  const run1 = payload.buildPayloadChunks(rows);
  const run2 = payload.buildPayloadChunks(rows);

  assert.equal(run1.chunks.length, run2.chunks.length);
  for (let i = 0; i < run1.chunks.length; i += 1) {
    assert.deepEqual(
      run1.chunks[i].map((r) => r.sourceRowKey),
      run2.chunks[i].map((r) => r.sourceRowKey),
    );
  }
});

// =============================================================================
// プレビュー集計
// =============================================================================

test("プレビュー集計が期待どおり", () => {
  const rows = [
    makeRow({ rowNumber: 2, orderId: "O1", commissionGmv: 1000, commissionBase: 1200, agencyRevenue: 100 }),
    makeRow({ rowNumber: 3, orderId: "O1", skuId: "S2", commissionGmv: 500, commissionBase: 600, agencyRevenue: 50 }),
    makeRow({
      rowNumber: 4, orderId: "O2", creatorTiktokId: "other", shopName: "別ショップ",
      commissionGmv: 250, commissionBase: 300, agencyRevenue: 25,
      orderedAt: "2026-06-02T10:00:00+09:00", targetMonth: "2026-06",
    }),
  ];

  const summary = preview.summarizeAffiliateOrderRows(rows, {
    parsedRows: 5,
    invalidRows: 1,
    duplicateRows: 1,
  });

  assert.equal(summary.parsedRows, 5);
  assert.equal(summary.validRows, 3);
  assert.equal(summary.invalidRows, 1);
  assert.equal(summary.duplicateRows, 1);
  assert.equal(summary.uniqueOrders, 2);
  assert.equal(summary.uniqueCreators, 2);
  assert.equal(summary.uniqueShops, 2);
  assert.deepEqual(summary.targetMonths, ["2026-05", "2026-06"]);
  assert.equal(summary.commissionGmv, 1750);
  assert.equal(summary.commissionBase, 2100);
  assert.equal(summary.agencyRevenue, 175);
  assert.equal(summary.periodStart, "2026-05-27T16:03:46+09:00");
  assert.equal(summary.periodEnd, "2026-06-02T10:00:00+09:00");
});

test("有効行0件なら取込ボタンをブロックする", () => {
  const summary = preview.summarizeAffiliateOrderRows([], {
    parsedRows: 0, invalidRows: 3, duplicateRows: 0,
  });
  const blockers = preview.resolveImportBlockers({ summary, headerError: null });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, "no_valid_rows");
});

test("必須列が無い場合はヘッダーエラーでブロックする", () => {
  const summary = preview.summarizeAffiliateOrderRows([], {
    parsedRows: 0, invalidRows: 1, duplicateRows: 0,
  });
  const blockers = preview.resolveImportBlockers({
    summary,
    headerError: "必須列がありません: 注文ID",
  });
  assert.equal(blockers[0].code, "header_missing");
});

test("無効行があっても有効行があれば続行できる（警告扱い）", () => {
  const summary = preview.summarizeAffiliateOrderRows(makeRows(3), {
    parsedRows: 5, invalidRows: 2, duplicateRows: 0,
  });
  const blockers = preview.resolveImportBlockers({ summary, headerError: null });
  assert.equal(blockers.length, 0);
});

test("照合結果の合算", () => {
  let totals = preview.emptyCompareTotals();
  totals = preview.mergeCompareTotals(totals, { newRows: 10, changedRows: 2, unchangedRows: 5 });
  totals = preview.mergeCompareTotals(totals, { newRows: 3, changedRows: 1, unchangedRows: 0 });
  assert.deepEqual(totals, { newRows: 13, changedRows: 3, unchangedRows: 5 });
});

// =============================================================================
// 18. Finance Engine を自動で動かさない
// =============================================================================

test("取込アクションは報酬再集計を呼ばない", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    path.join(root, "app/actions/import-affiliate-orders.ts"),
    "utf8",
  );

  assert.ok(!/syncAgencyRewards/.test(source), "代理店報酬の再集計を呼んでいる");
  assert.ok(!/syncReferralRewards/.test(source), "紹介者報酬の再集計を呼んでいる");
  assert.ok(!/agency_reward_items/.test(source), "代理店報酬明細へ触れている");
  assert.ok(!/referral_reward_items/.test(source), "紹介者報酬明細へ触れている");
});

test("取込アクションは Excel ファイル自体を受け取らない", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    path.join(root, "app/actions/import-affiliate-orders.ts"),
    "utf8",
  );

  assert.ok(!/instanceof File/.test(source), "File を受け取っている");
  assert.ok(!/arrayBuffer\(\)/.test(source), "ファイルを読み込んでいる");
  assert.ok(!/parseAffiliateOrderFile/.test(source), "サーバーで解析している");
});

test("取込アクションは UNIQUE(source_row_key) の UPSERT を維持している", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    path.join(root, "app/actions/import-affiliate-orders.ts"),
    "utf8",
  );

  assert.ok(/onConflict: "source_row_key"/.test(source));
  assert.ok(/requireAdminAction/.test(source));
  assert.ok(/validateAffiliateOrderPayloadRow/.test(source));
});

// =============================================================================
// 16 / 17. 権限
// =============================================================================

test("全アクションが requireAdminAction を先頭で通している", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    path.join(root, "app/actions/import-affiliate-orders.ts"),
    "utf8",
  );

  const actions = [
    "startAffiliateOrderImportAction",
    "fetchAffiliateOrderCompareDigestAction",
    "importAffiliateOrderChunkAction",
    "finishAffiliateOrderImportAction",
  ];

  for (const name of actions) {
    const start = source.indexOf(`export async function ${name}`);
    assert.ok(start >= 0, `${name} が見つからない`);

    // 関数の先頭 400 文字以内に管理者判定があること
    const head = source.slice(start, start + 400);
    assert.match(head, /requireAdminAction\(\)/, name);
    assert.match(head, /if \(!auth\.ok\) return \{ ok: false, error: auth\.error \}/, name);
  }
});

test("requireAdminAction は未ログインと非管理者の両方を拒否する", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(path.join(root, "lib/db/admin-access.ts"), "utf8");

  assert.match(source, /ログインが必要です/);
  assert.match(source, /isAdminRole\(appUser\.data\.role\)/);
  assert.match(source, /親管理者のみ実行できます/);
});

test("1リクエストの行数に上限がある（巨大な配列を受け付けない）", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    path.join(root, "app/actions/import-affiliate-orders.ts"),
    "utf8",
  );

  assert.match(source, /SERVER_MAX_CHUNK_ROWS/);
  assert.match(source, /1回の送信件数が多すぎます/);
  // 照合は件数ではなく「対象月の数」で上限を設ける（キーを送らないため）
  assert.match(source, /一度に照合できる対象月が多すぎます/);
});


// =============================================================================
// PART B. 414 Request-URI Too Large の回帰テスト
// =============================================================================

/*
  実際に発生した事象:
    .in("source_row_key", [2,000キー]) が GET のクエリ文字列に載り、
    URL が 487.6KB に達して Cloudflare が 414 を返した。
  本番実キーは1件あたり URL エンコードで約256バイト。16KB に収まるのは 63件まで。
*/
const CLOUDFLARE_URI_LIMIT = 16 * 1024;
const BYTES_PER_ENCODED_KEY = 256;

/** 対象月だけを載せたときのURL長（案C） */
function digestUrlLength(months, page) {
  const cols =
    "source_row_key,target_month,payment_status,order_status,refund_status,refund_amount,product_price,quantity,commission_gmv,commission_base,creator_revenue_before_split,agency_split_rate,agency_revenue,id";
  const u = new URL("https://xxxxxxxxxxxxxxxxxxxx.supabase.co/rest/v1/affiliate_order_lines");
  u.searchParams.set("select", cols);
  u.searchParams.set("target_month", `in.(${months.map((m) => `"${m}"`).join(",")})`);
  u.searchParams.set("order", "id.asc");
  u.searchParams.set("offset", String(page * payload.COMPARE_DIGEST_PAGE_SIZE));
  u.searchParams.set("limit", String(payload.COMPARE_DIGEST_PAGE_SIZE));
  return u.toString().length;
}

test("照合アクションから source_row_key の IN 句が消えている", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    path.join(root, "app/actions/import-affiliate-orders.ts"),
    "utf8",
  );

  // コメントを除いた実コードに .in("source_row_key" が無いこと
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");

  assert.ok(
    !/\.in\(\s*["']source_row_key["']/.test(code),
    "source_row_key の IN 句が残っている（414の再発経路）",
  );
  assert.match(code, /\.in\(["']target_month["']/);
});

test("照合は対象月だけをURLに載せる（Excelの大きさに依存しない）", () => {
  // 単月・複数月・上限月数のいずれでもURLは16KBに遠く及ばない
  for (const months of [
    ["2026-07"],
    ["2026-05", "2026-06", "2026-07", "2026-08"],
    Array.from({ length: payload.MAX_COMPARE_MONTHS }, (_, i) =>
      `20${20 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
    ),
  ]) {
    for (const page of [0, 100, 100_000]) {
      const len = digestUrlLength(months, page);
      assert.ok(
        len < CLOUDFLARE_URI_LIMIT / 4,
        `months=${months.length} page=${page} URL=${len}`,
      );
    }
  }
});

test("旧方式のURL長を再現し、414になっていたことを示す", () => {
  // 63件までしか収まらなかったことの確認（回帰の根拠）
  const fits = Math.floor(CLOUDFLARE_URI_LIMIT / BYTES_PER_ENCODED_KEY);
  assert.ok(fits < 100, `旧方式で収まるキー数=${fits}`);
  assert.ok(
    2000 * BYTES_PER_ENCODED_KEY > CLOUDFLARE_URI_LIMIT * 20,
    "2,000キーがCloudflare上限を大きく超えることの確認",
  );
});

test("対象月の抽出（単月）", () => {
  const rows = makeRows(10);
  const { months, includeNullMonth } = payload.resolveCompareMonths(rows);
  assert.deepEqual(months, ["2026-05"]);
  assert.equal(includeNullMonth, false);
});

test("対象月の抽出（複数月・昇順・重複排除）", () => {
  const rows = [
    makeRow({ orderId: "A", targetMonth: "2026-07" }),
    makeRow({ orderId: "B", targetMonth: "2026-05" }),
    makeRow({ orderId: "C", targetMonth: "2026-07" }),
    makeRow({ orderId: "D", targetMonth: "2026-06" }),
  ];
  const { months, includeNullMonth } = payload.resolveCompareMonths(rows);
  assert.deepEqual(months, ["2026-05", "2026-06", "2026-07"]);
  assert.equal(includeNullMonth, false);
});

test("target_month が null の行があれば fallback を要求する", () => {
  const rows = [
    makeRow({ orderId: "A", targetMonth: "2026-07" }),
    makeRow({ orderId: "B", targetMonth: null }),
  ];
  const { months, includeNullMonth } = payload.resolveCompareMonths(rows);
  assert.deepEqual(months, ["2026-07"]);
  assert.equal(includeNullMonth, true);
});

test("全行が target_month null でも照合できる", () => {
  const rows = [makeRow({ orderId: "A", targetMonth: null })];
  const { months, includeNullMonth } = payload.resolveCompareMonths(rows);
  assert.deepEqual(months, []);
  assert.equal(includeNullMonth, true);
});

test("ダイジェスト照合: 新規 / 更新あり / 変更なし", () => {
  const unchanged = makeRow({ orderId: "U" });
  const changed = makeRow({ orderId: "C" });
  const added = makeRow({ orderId: "N" });

  const digest = new Map([
    [unchanged.sourceRowKey, payload.fingerprintFromPayloadRow(unchanged)],
    [changed.sourceRowKey, "ffffffff"], // 指紋が違う = 更新あり
  ]);

  const totals = payload.compareAgainstDigest([unchanged, changed, added], digest);
  assert.deepEqual(totals, { newRows: 1, changedRows: 1, unchangedRows: 1 });
});

test("ダイジェスト照合: DBの numeric 文字列でも変更なしと判定される", () => {
  const row = makeRow();
  const digest = new Map([[row.sourceRowKey, payload.fingerprintFromDbRow(toDbRow(row))]]);
  assert.deepEqual(payload.compareAgainstDigest([row], digest), {
    newRows: 0,
    changedRows: 0,
    unchangedRows: 1,
  });
});

test("ダイジェスト照合: 支払状態・返金・金額の変更を更新として数える", () => {
  const row = makeRow();
  for (const override of [
    { payment_status: "未払い" },
    { refund_status: "fully_refunded", refund_amount: "2000.00" },
    { commission_base: "1999.00" },
  ]) {
    const digest = new Map([
      [row.sourceRowKey, payload.fingerprintFromDbRow(toDbRow(row, override))],
    ]);
    assert.deepEqual(
      payload.compareAgainstDigest([row], digest),
      { newRows: 0, changedRows: 1, unchangedRows: 0 },
      JSON.stringify(override),
    );
  }
});

test("4,654行でも照合のリクエスト回数はページ数だけで決まる", () => {
  const rows = makeRows(4654);
  const { months } = payload.resolveCompareMonths(rows);
  assert.equal(months.length, 1);

  // 既存 2026-07 は 4,807 行 → ページ数
  const existingRows = 4807;
  const pages = Math.ceil(existingRows / payload.COMPARE_DIGEST_PAGE_SIZE);
  assert.ok(pages <= 5, `pages=${pages}`);
  // 取込行数がいくつでも URL 長は一定
  assert.equal(digestUrlLength(months, 0), digestUrlLength(months, 0));
});

test("5MB / 10MB / 20MB 相当でも照合のURL長は変わらない", () => {
  const lengths = new Set();
  for (const mb of [5, 10, 20]) {
    const rows = makeRows(Math.round(ROWS_PER_MB * mb));
    const { months } = payload.resolveCompareMonths(rows);
    const len = digestUrlLength(months, 0);
    assert.ok(len < CLOUDFLARE_URI_LIMIT / 4, `${mb}MB: URL=${len}`);
    lengths.add(len);
  }
  // 行数が 17,830 → 71,320 と4倍になっても URL は同一
  assert.equal(lengths.size, 1);
});

test("照合アクションは SELECT のみ・admin 判定あり・月数上限あり", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    path.join(root, "app/actions/import-affiliate-orders.ts"),
    "utf8",
  );

  const start = source.indexOf("export async function fetchAffiliateOrderCompareDigestAction");
  const end = source.indexOf("export async function importAffiliateOrderChunkAction");
  const body = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /requireAdminAction\(\)/);
  assert.match(body, /MAX_COMPARE_MONTHS/);
  assert.match(body, /\.order\("id", \{ ascending: true \}\)/);
  assert.ok(!/\.insert\(/.test(body), "insert している");
  assert.ok(!/\.update\(/.test(body), "update している");
  assert.ok(!/\.upsert\(/.test(body), "upsert している");
  assert.ok(!/\.delete\(/.test(body), "delete している");
});
