/*
  source_row_key 共通化の回帰検証（READ ONLY / 本番DBへ書き込まない）。

  取込をチャンク方式へ変えるにあたり、キー生成をパーサーから
  lib/orders/affiliate-order-source-key.ts へ切り出した。
  出力が1文字でも変わると、既存行と突き合わせできず
  再取込がすべて新規INSERTになる（＝二重計上）。

  そこで本番の全行について、
    DBに入っている source_row_key
    と
    共通関数で作り直したキー
  が完全一致することを確かめる。

  実行: node --env-file=.env.local scripts/verify-affiliate-order-source-key.mjs
*/
import { createRequire } from "node:module";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, { alias: { "@": root }, interopDefault: true, fsCache: false });

const keyMod = await jiti.import(path.join(root, "lib/orders/affiliate-order-source-key.ts"));
const paged = await jiti.import(path.join(root, "lib/db/paged-select.ts"));

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const COLUMNS =
  "id, source_row_key, order_id, sku_id, product_id, creator_tiktok_id, content_id, factor_type, commission_type, raw_row_json";

const result = await paged.fetchAllFrom(supabase, "affiliate_order_lines", COLUMNS);

if (result.error) {
  console.error("読み取りに失敗しました:", result.error);
  process.exit(1);
}

let matched = 0;
const mismatches = [];

for (const row of result.data) {
  // Invitation ID は列ではなく raw_row_json にのみ存在する
  const invitationId = row.raw_row_json?.["Invitation ID"] ?? null;

  const rebuilt = keyMod.buildAffiliateOrderSourceRowKey({
    orderId: row.order_id,
    skuId: row.sku_id,
    productId: row.product_id,
    creatorTiktokId: row.creator_tiktok_id,
    contentId: row.content_id,
    invitationId,
    factorType: row.factor_type,
    commissionType: row.commission_type,
  });

  if (rebuilt === row.source_row_key) {
    matched += 1;
  } else if (mismatches.length < 10) {
    mismatches.push({ id: row.id, db: row.source_row_key, rebuilt });
  }
}

const total = result.data.length;
const failed = total - matched;

console.log("=== source_row_key 共通化の回帰検証（READ ONLY）===");
console.log(`  対象行数 : ${total.toLocaleString("ja-JP")}`);
console.log(`  一致     : ${matched.toLocaleString("ja-JP")}`);
console.log(`  不一致   : ${failed.toLocaleString("ja-JP")}`);

if (mismatches.length > 0) {
  console.log("\n  不一致の例:");
  for (const m of mismatches) {
    console.log(`    id=${m.id}`);
    console.log(`      DB   : ${m.db}`);
    console.log(`      再生成: ${m.rebuilt}`);
  }
}

console.log(
  `\n判定: ${failed === 0 ? "完全一致 ✓（既存行と突き合わせできる）" : "不一致あり ✗"}`,
);

process.exit(failed === 0 ? 0 : 1);
