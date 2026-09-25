import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, { alias: { "@": root }, interopDefault: true, fsCache: false });

const S = await jiti.import(path.join(root, "lib/sellers/shop-id-candidates.ts"));
const Q = await jiti.import(path.join(root, "lib/db/shop-id-candidate-queries.ts"));

const linkSeller = (o) => ({
  id: o.id,
  seller_name: o.seller_name ?? o.id,
  shop_name: o.shop_name ?? "",
  shop_id: o.shop_id ?? null,
});
const source = (shopId, shopName) => ({
  shopId,
  shopName,
  sourceLabel: "ショップ実績",
  note: null,
});

/** 実績スナップショットから候補状況を作る（fetchShopIdLinkSummary と同じ組み立て） */
function summarize(sellers, sources, aliases = []) {
  const rows = S.buildShopIdLinkRows({ sellers, sources, aliases });
  return { rows, counts: S.summarizeShopIdLinkRows(rows), sources, error: null };
}

/* ===================== CSV → 候補更新 ===================== */

test("実績が増えると候補が再計算される", () => {
  const sellers = [
    linkSeller({ id: "A", seller_name: "株式会社6FARM", shop_name: "6FARM" }),
    linkSeller({ id: "B", seller_name: "株式会社新規", shop_name: "新規SHOP" }),
  ];

  const before = summarize(sellers, [source("7494573593353880665", "6FARM")]);
  assert.equal(before.counts.confident, 1);
  assert.equal(before.counts.none, 1);

  // 取込で新しい shop_name / shop_id が増えた
  const after = summarize(sellers, [
    source("7494573593353880665", "6FARM"),
    source("7494000000000000111", "新規SHOP"),
  ]);
  assert.equal(after.counts.confident, 2);
  assert.equal(after.counts.none, 0);
});

test("取込前後の差分から「新しく候補になったセラー」が分かる（migration不要）", () => {
  const sellers = [
    linkSeller({ id: "A", seller_name: "株式会社6FARM", shop_name: "6FARM" }),
    linkSeller({ id: "B", seller_name: "株式会社新規", shop_name: "新規SHOP" }),
  ];
  const before = summarize(sellers, [source("7494573593353880665", "6FARM")]);
  const after = summarize(sellers, [
    source("7494573593353880665", "6FARM"),
    source("7494000000000000111", "新規SHOP"),
  ]);

  const delta = Q.diffShopIdLinkSummary(before, after);
  assert.equal(delta.newlyConfident.length, 1);
  assert.equal(delta.newlyConfident[0].sellerName, "株式会社新規");
  assert.equal(delta.newlyConfident[0].shopId, "7494000000000000111");
  assert.equal(delta.confident, 2, "合計も返す");
});

test("実績が増えても既に候補だったセラーは「新しく候補」に数えない", () => {
  const sellers = [linkSeller({ id: "A", shop_name: "6FARM" })];
  const s = [source("7494573593353880665", "6FARM")];
  const delta = Q.diffShopIdLinkSummary(summarize(sellers, s), summarize(sellers, s));
  assert.equal(delta.newlyConfident.length, 0);
  assert.equal(delta.confident, 1);
});

test("新しく要確認になったセラーも差分で分かる", () => {
  const sellers = [linkSeller({ id: "A", shop_name: "ビジュエルパフェ" })];
  const before = summarize(sellers, []);
  const after = summarize(sellers, [
    source("7494253297786980020", "ビジュエルパフェ｜誕生日カラーの推し活カフェ"),
  ]);
  const delta = Q.diffShopIdLinkSummary(before, after);
  assert.equal(delta.newlyReview.length, 1);
  assert.equal(delta.newlyConfident.length, 0);
});

test("候補生成は buildShopIdLinkRows ただ1つ（別実装を作っていない）", () => {
  const q = fs.readFileSync(path.join(root, "lib/db/shop-id-candidate-queries.ts"), "utf8");
  assert.ok(q.includes("buildShopIdLinkRows("), "共有ロジックを使っていない");

  const action = fs.readFileSync(path.join(root, "app/actions/shop-performance.ts"), "utf8");
  assert.ok(
    action.includes("fetchShopIdLinkSummary("),
    "取込側が共有の集計を使っていない",
  );
  assert.ok(
    !/(state|matchReason)\s*[:=]\s*["']confident["']/.test(action),
    "取込側で候補判定を別実装している",
  );
});

test("CSV取込が sellers.shop_id を自動UPDATEしない", () => {
  const action = fs.readFileSync(path.join(root, "app/actions/shop-performance.ts"), "utf8");
  /*
    executeShopPerformanceImportAction の本体に sellers への update が無いこと。
    （同ファイル内の createSellerFromShopPerformanceAction は
      新規セラー作成専用なので対象外）
  */
  const start = action.indexOf("export async function executeShopPerformanceImportAction");
  const end = action.indexOf("export async function linkShopPerformanceToSellerAction");
  assert.ok(start > 0 && end > start, "対象関数が見つからない");
  const body = action.slice(start, end);

  assert.ok(
    !/\.from\(\s*["']sellers["']\s*\)[\s\S]{0,200}?\.update\(/.test(body),
    "CSV取込が sellers を更新している",
  );
  assert.ok(!/shop_id:\s*a\.shopId/.test(body), "CSV取込が shop_id を書いている");
});

test("CSV取込は shop_performance_imports 側の shop_id を null のまま保存する", () => {
  const action = fs.readFileSync(path.join(root, "app/actions/shop-performance.ts"), "utf8");
  assert.ok(
    /shop_id:\s*null as string \| null/.test(action),
    "ShopList CSV には Shop ID 列が無いという前提が崩れている",
  );
});

test("候補生成に TikTok API を使用していない", () => {
  for (const f of [
    "lib/sellers/shop-id-candidates.ts",
    "lib/db/shop-id-candidate-queries.ts",
    "app/(app)/admin/sellers/ShopIdLinkPanel.tsx",
  ]) {
    // コメントを除いた実コードだけを見る
    const src = fs
      .readFileSync(path.join(root, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !/fetchTikTokAuthorizedShops|tiktok_api_connections|authorization\/202309|TIKTOK_/.test(src),
      `${f} が TikTok API に依存している`,
    );
  }
});

/* ===================== 候補判定 ===================== */

test("正規化一致は確定候補（全角半角・大小文字）", () => {
  assert.equal(
    summarize([linkSeller({ id: "A", shop_name: "-ippo-" })], [source("7494708971290395728", "-IPPO-")])
      .counts.confident,
    1,
  );
});

test("近似名は要確認にとどめる", () => {
  const r = summarize(
    [linkSeller({ id: "A", shop_name: "ビジュエルパフェ" })],
    [source("7494253297786980020", "ビジュエルパフェ｜誕生日カラーの推し活カフェ")],
  );
  assert.equal(r.counts.review, 1);
  assert.equal(r.rows[0].suggestedShopId, null);
});

test("一致なしは候補なし", () => {
  const r = summarize(
    [linkSeller({ id: "A", shop_name: "どこにもないSHOP" })],
    [source("7494573593353880665", "6FARM")],
  );
  assert.equal(r.counts.none, 1);
});

test("1つのshop_idを複数sellerへ自動確定しない", () => {
  const r = summarize(
    [
      linkSeller({ id: "A", seller_name: "会社A", shop_name: "共通SHOP" }),
      linkSeller({ id: "B", seller_name: "会社B", shop_name: "共通SHOP" }),
    ],
    [source("7494573593353880665", "共通SHOP")],
  );
  // 両方が確定候補になっても、適用時の検証で必ず片方が弾かれる
  const assignments = r.rows
    .filter((x) => x.suggestedShopId)
    .map((x) => ({ sellerId: x.sellerId, shopId: x.suggestedShopId }));
  const check = S.validateShopIdAssignments(
    [linkSeller({ id: "A" }), linkSeller({ id: "B" })],
    assignments,
  );
  assert.ok(check.accepted.length <= 1, "同じshop_idが複数sellerへ保存されうる");
});

test("1sellerに複数候補がある場合は自動確定しない", () => {
  const r = summarize(
    [linkSeller({ id: "A", shop_name: "同名SHOP" })],
    [source("7494000000000000001", "同名SHOP"), source("7494000000000000002", "同名SHOP")],
  );
  assert.equal(r.counts.confident, 0);
  assert.equal(r.counts.review, 1);
});

/* ===================== 手動 Shop ID ===================== */

test("正常な Shop ID を保存できる", () => {
  const r = S.validateShopIdAssignments([linkSeller({ id: "A" })], [
    { sellerId: "A", shopId: "7494573593353880665" },
  ]);
  assert.deepEqual(r.accepted, [{ sellerId: "A", shopId: "7494573593353880665" }]);
});

test("英数字の shop_code を拒否する", () => {
  const r = S.validateShopIdAssignments([linkSeller({ id: "A" })], [
    { sellerId: "A", shopId: "JPJPLCJLLL4C" },
  ]);
  assert.equal(r.accepted.length, 0);
  assert.match(r.rejected[0].reason, /Shop ID の形式/);
});

test("重複 Shop ID を拒否する", () => {
  const r = S.validateShopIdAssignments(
    [linkSeller({ id: "A" }), linkSeller({ id: "B", seller_name: "先客", shop_id: "7494573593353880665" })],
    [{ sellerId: "A", shopId: "7494573593353880665" }],
  );
  assert.equal(r.accepted.length, 0);
});

test("既存 shop_id の上書きを拒否する", () => {
  const r = S.validateShopIdAssignments(
    [linkSeller({ id: "A", shop_id: "7494000000000000001" })],
    [{ sellerId: "A", shopId: "7494000000000000002" }],
  );
  assert.equal(r.accepted.length, 0);
  assert.match(r.rejected[0].reason, /既に Shop ID/);
});

test("手動設定は共有の検証を通している（別実装していない）", () => {
  const src = fs.readFileSync(path.join(root, "app/actions/seller-bulk.ts"), "utf8");
  const start = src.indexOf("export async function setSellerShopIdManuallyAction");
  assert.ok(start > 0, "手動設定アクションが無い");
  const body = src.slice(start);

  assert.ok(body.includes("applyShopIdLinkBulk("), "共有の適用処理を使っていない");
  assert.ok(
    !/\.from\(\s*["']sellers["']\s*\)[\s\S]{0,200}?\.update\(/.test(body),
    "手動設定が検証を通さず直接updateしている",
  );
});

test("手動設定でも shop_id 以外の列を書かない", () => {
  const src = fs.readFileSync(path.join(root, "lib/sellers/apply-seller-bulk.ts"), "utf8");
  assert.ok(/\.update\(\{ shop_id: a\.shopId \}\)/.test(src), "shop_id以外を書いている可能性");
  assert.ok(/\.is\("shop_id", null\)/.test(src), "NULL条件が外れている");
});
