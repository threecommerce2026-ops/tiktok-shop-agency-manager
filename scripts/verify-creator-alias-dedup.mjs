/*
  クリエイター改名による二重登録の検証と統合 dry-run（READ ONLY）。

  ■ 本番DBへ一切書き込まない
  SELECT のみ。DELETE / UPDATE は行わない。

  ■ 何を確かめるか
  1) 別名を適用したとき、改名後の行が旧名の既存キーと一致するか（153/153）
  2) 統合しても安全か（業務データが完全一致しているか）
  3) 削除候補に報酬明細・支払明細からの参照が無いか

  1列でも業務差分があればその組は削除候補から外し、全体を中止扱いにする。

  実行:
    node --env-file=.env.local scripts/verify-creator-alias-dedup.mjs
    node --env-file=.env.local scripts/verify-creator-alias-dedup.mjs <alias> <canonical>

  既定は本番で確認済みの kanyaselect_jp → kanyatoyselect_jp。
*/
import { createRequire } from "node:module";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, { alias: { "@": root }, interopDefault: true, fsCache: false });

const aliasMod = await jiti.import(path.join(root, "lib/orders/creator-alias.ts"));
const keyMod = await jiti.import(path.join(root, "lib/orders/affiliate-order-source-key.ts"));
const paged = await jiti.import(path.join(root, "lib/db/paged-select.ts"));

const ALIAS_TIKTOK_ID = process.argv[2] ?? "kanyaselect_jp";
const CANONICAL_TIKTOK_ID = process.argv[3] ?? "kanyatoyselect_jp";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

/** 統合の可否を決める業務列。1つでも違えば削除候補から外す */
const BUSINESS_COLUMNS = [
  "target_month",
  "ordered_at",
  "delivered_at",
  "paid_at",
  "seller_id",
  "shop_name",
  "shop_code",
  "product_name",
  "sku",
  "product_price",
  "quantity",
  "order_amount",
  "refund_amount",
  "refund_status",
  "commission_gmv",
  "commission_base",
  "standard_commission_rate",
  "shop_ads_commission_rate",
  "tiktok_bonus_commission_rate",
  "partner_bonus_commission_rate",
  "creator_revenue_before_split",
  "agency_split_rate",
  "agency_revenue_before_tax",
  "agency_revenue",
  "payment_id",
  "payment_status",
  "order_status",
];

const COLUMNS = [
  "id",
  "source_row_key",
  "order_id",
  "sku_id",
  "product_id",
  "content_id",
  "factor_type",
  "commission_type",
  "creator_tiktok_id",
  "creator_id",
  "import_batch_id",
  "created_at",
  "raw_row_json",
  ...BUSINESS_COLUMNS,
].join(", ");

function normalizeValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(Math.round(value * 10000) / 10000);
  const text = String(value).trim();
  // numeric は "1430.00" のような文字列で返るため数値として正規化する
  if (/^-?\d+(\.\d+)?$/.test(text)) return String(Math.round(Number(text) * 10000) / 10000);
  return text;
}

const yen = (n) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const int = (n) => n.toLocaleString("ja-JP");

console.log("=== クリエイター改名の統合 dry-run（READ ONLY）===");
console.log(`  別名   : ${ALIAS_TIKTOK_ID}`);
console.log(`  正式名 : ${CANONICAL_TIKTOK_ID}`);
console.log("");

// -----------------------------------------------------------------------------
// 対象行の取得
// -----------------------------------------------------------------------------
const result = await paged.fetchAllFrom(supabase, "affiliate_order_lines", COLUMNS, (q) =>
  q.in("creator_tiktok_id", [ALIAS_TIKTOK_ID, CANONICAL_TIKTOK_ID]),
);

if (result.error) {
  console.error("読み取りに失敗しました:", result.error);
  process.exit(1);
}

const aliasRows = result.data.filter((r) => r.creator_tiktok_id === ALIAS_TIKTOK_ID);
const canonicalRows = result.data.filter(
  (r) => r.creator_tiktok_id === CANONICAL_TIKTOK_ID,
);

console.log(`【1】対象行`);
console.log(`  別名側（${ALIAS_TIKTOK_ID}）  : ${int(aliasRows.length)} 行`);
console.log(`  正式名側（${CANONICAL_TIKTOK_ID}）: ${int(canonicalRows.length)} 行`);
console.log("");

// -----------------------------------------------------------------------------
// 別名を適用したときのキー一致
// -----------------------------------------------------------------------------
const aliasMap = aliasMod.buildCreatorAliasMap([
  { aliasTiktokId: ALIAS_TIKTOK_ID, canonicalTiktokId: CANONICAL_TIKTOK_ID },
]);

const canonicalByKey = new Map(canonicalRows.map((r) => [r.source_row_key, r]));

let matched = 0;
const unmatched = [];

for (const row of aliasRows) {
  // 取込時と同じ手順: 正式名へ寄せてからキーを作り直す
  const canonicalKey = keyMod.buildAffiliateOrderSourceRowKey({
    orderId: row.order_id,
    skuId: row.sku_id,
    productId: row.product_id,
    creatorTiktokId: aliasMod.resolveCanonicalTiktokId(row.creator_tiktok_id, aliasMap),
    contentId: row.content_id,
    invitationId: row.raw_row_json?.["Invitation ID"] ?? null,
    factorType: row.factor_type,
    commissionType: row.commission_type,
  });

  const twin = canonicalByKey.get(canonicalKey);
  if (twin) {
    matched += 1;
    row.__twin = twin;
    row.__canonicalKey = canonicalKey;
  } else {
    unmatched.push({ id: row.id, order_id: row.order_id, canonicalKey });
  }
}

console.log(`【2】別名適用後のキー一致`);
console.log(`  一致   : ${int(matched)} / ${int(aliasRows.length)}`);
console.log(`  不一致 : ${int(unmatched.length)}`);
if (unmatched.length > 0) {
  console.log("  不一致の例:");
  for (const u of unmatched.slice(0, 5)) {
    console.log(`    id=${u.id} order=${u.order_id}`);
  }
}
console.log("");

// -----------------------------------------------------------------------------
// 業務データの一致確認
// -----------------------------------------------------------------------------
const deleteCandidates = [];
const conflicts = [];

for (const row of aliasRows) {
  if (!row.__twin) continue;

  const diffs = BUSINESS_COLUMNS.filter(
    (col) => normalizeValue(row[col]) !== normalizeValue(row.__twin[col]),
  );

  if (diffs.length === 0) deleteCandidates.push(row);
  else conflicts.push({ id: row.id, order_id: row.order_id, diffs });
}

console.log(`【3】業務データの一致（${BUSINESS_COLUMNS.length} 列を比較）`);
console.log(`  完全一致（削除候補） : ${int(deleteCandidates.length)}`);
console.log(`  差分あり（除外）     : ${int(conflicts.length)}`);
if (conflicts.length > 0) {
  console.log("  差分の例:");
  for (const c of conflicts.slice(0, 5)) {
    console.log(`    id=${c.id} order=${c.order_id} 差分列=${c.diffs.join(", ")}`);
  }
}
console.log("");

// -----------------------------------------------------------------------------
// 参照の確認（報酬明細 / 支払明細）
// -----------------------------------------------------------------------------
const aliasKeys = aliasRows.map((r) => r.source_row_key);
const aliasCreatorIds = [...new Set(aliasRows.map((r) => r.creator_id).filter(Boolean))];

/*
  source_row_key で .in() を使うと URL が巨大になり 414 になる
  （1キーあたり URL エンコードで約256バイト）。
  短い UUID の creator_id で引き、source_row_key の突き合わせはメモリで行う。
*/
async function countRefsByCreator(table, creatorIds, keySet) {
  if (creatorIds.length === 0) return { byCreator: 0, byKey: 0 };

  const rows = await paged.fetchAllFrom(supabase, table, "id, creator_id, source_row_key", (q) =>
    q.in("creator_id", creatorIds),
  );
  if (rows.error) throw new Error(`${table}: ${rows.error}`);

  return {
    byCreator: rows.data.length,
    byKey: rows.data.filter((r) => keySet.has(r.source_row_key)).length,
  };
}

const aliasKeySet = new Set(aliasKeys);
const agencyRefs = await countRefsByCreator(
  "agency_reward_items",
  aliasCreatorIds,
  aliasKeySet,
);
const referralRefs = await countRefsByCreator(
  "referral_reward_items",
  aliasCreatorIds,
  aliasKeySet,
);

const agencyByKey = agencyRefs.byKey;
const referralByKey = referralRefs.byKey;
const agencyByCreator = agencyRefs.byCreator;
const referralByCreator = referralRefs.byCreator;

const { count: batchCount } = await supabase
  .from("payment_batches")
  .select("id", { count: "exact", head: true });

console.log(`【4】削除候補への参照`);
console.log(`  agency_reward_items（source_row_key） : ${int(agencyByKey)}`);
console.log(`  referral_reward_items（source_row_key）: ${int(referralByKey)}`);
console.log(`  agency_reward_items（creator_id）      : ${int(agencyByCreator)}`);
console.log(`  referral_reward_items（creator_id）    : ${int(referralByCreator)}`);
console.log(`  payment_batches（全体）                : ${int(batchCount ?? 0)}`);
console.log("");

// -----------------------------------------------------------------------------
// 金額への影響
// -----------------------------------------------------------------------------
const sum = (rows, col) =>
  rows.reduce((acc, r) => acc + Number(r[col] ?? 0), 0);

console.log(`【5】統合による金額の変化（削除候補 ${int(deleteCandidates.length)} 行を除いた場合）`);
console.log(`  成果報酬GMV     : -${yen(sum(deleteCandidates, "commission_gmv"))}`);
console.log(`  Commission Base : -${yen(sum(deleteCandidates, "commission_base"))}`);
console.log(`  Agency Revenue  : -${yen(sum(deleteCandidates, "agency_revenue"))}`);
console.log("");

// -----------------------------------------------------------------------------
// 判定
// -----------------------------------------------------------------------------
const refTotal = agencyByKey + referralByKey + agencyByCreator + referralByCreator;
const ok =
  unmatched.length === 0 &&
  conflicts.length === 0 &&
  refTotal === 0 &&
  deleteCandidates.length === aliasRows.length &&
  deleteCandidates.length > 0;

console.log("【6】判定");
console.log(`  キー不一致        : ${unmatched.length}（0 であること）`);
console.log(`  業務差分          : ${conflicts.length}（0 であること）`);
console.log(`  報酬明細からの参照: ${refTotal}（0 であること）`);
console.log(`  削除候補          : ${int(deleteCandidates.length)}`);
console.log("");
console.log(
  ok
    ? "✓ 安全に統合できます（このスクリプトは削除を実行しません）"
    : "✗ 条件を満たしません。統合フェーズへ進まないでください",
);

// 削除候補の id 一覧（次フェーズで使う）
if (ok) {
  console.log("");
  console.log("削除候補の id（先頭5件 / 全件は統合フェーズで再取得すること）:");
  for (const row of deleteCandidates.slice(0, 5)) {
    console.log(`  ${row.id}  order=${row.order_id}`);
  }
}

process.exit(ok ? 0 : 1);
