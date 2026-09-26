/*
  支払明細の内訳表示を実装した Query で、Production の既存 batch を
  READ ONLY 検証する。

  ■ 本番DBへ一切書き込まない
  fetchPaymentBatchDetail を呼ぶだけ。承認・CSV・paid化は行わない。

  実行:
    node --env-file=.env.local scripts/verify-batch-breakdown.mjs
*/
import { createRequire } from "node:module";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, { alias: { "@": root }, interopDefault: true, fsCache: false });

const q = await jiti.import(path.join(root, "lib/db/payment-queries.ts"));

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const yen = (n) => `¥${n.toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (n) => Math.round(n * 100) / 100;
const pad = (str, w) => {
  const width = [...String(str)].reduce((n, c) => n + (/[^\x00-\xff]/.test(c) ? 2 : 1), 0);
  return String(str) + " ".repeat(Math.max(0, w - width));
};

const EXPECT = {
  "LUMN": [2582.0, 51591.35, 54173.35],
  "BUZZ L!VE": [8392.0, 199.5, 8591.5],
  "ZUNii": [7754.0, 0, 7754.0],
  "RevReel": [7090.0, 0, 7090.0],
  "ピクノア": [5722.0, 0, 5722.0],
  "WoW LIVE": [621.0, 2639.55, 3260.55],
  "MaLIVE": [394.0, 2081.6, 2475.6],
  "VALO": [148.0, 368.8, 516.8],
  "株式会社ハイライト": [152.0, 0, 152.0],
};

const { data: batches, error } = await s
  .from("payment_batches")
  .select("id, agency_id, cutoff_month, payment_amount")
  .order("payment_amount", { ascending: false });
if (error) { console.error(error); process.exit(1); }

const { data: agencies } = await s.from("agencies").select("id, name");
const nameById = new Map((agencies ?? []).map((a) => [a.id, a.name]));

let ng = 0;
console.log("=== PHASE 14. 既存9batch 回帰確認（READ ONLY）===\n");
console.log(pad("代理店", 22), pad("締め", 10), pad("代理店分配報酬", 18), pad("紹介制度報酬", 18), pad("振込予定額", 16), "creator 紹介者 判定");
console.log("-".repeat(118));

let totalAgency = 0, totalReferral = 0, totalPay = 0;

for (const b of batches) {
  const name = nameById.get(b.agency_id) ?? "(不明)";
  const d = await q.fetchPaymentBatchDetail(s, b.id);
  if (d.error) { console.error(name, d.error); ng += 1; continue; }

  const [eAg, eRf, eTotal] = EXPECT[name] ?? [null, null, null];
  const ag = round2(d.agencyRewardAmount);
  const rf = round2(d.referralRewardAmount);
  const total = round2(ag + rf);

  const ok =
    ag === eAg && rf === eRf && total === eTotal &&
    total === round2(d.batch.paymentAmount) && d.totalsMatchBatch;
  if (!ok) ng += 1;

  totalAgency = round2(totalAgency + ag);
  totalReferral = round2(totalReferral + rf);
  totalPay = round2(totalPay + round2(d.batch.paymentAmount));

  console.log(
    pad(name, 22), pad(d.batch.cutoffMonth, 10),
    pad(yen(ag), 18), pad(yen(rf), 18), pad(yen(total), 16),
    pad(d.agencyBreakdown.creators.length, 7),
    pad(new Set(d.referralBreakdown.creators.map((c) => c.referrerName)).size, 6),
    ok ? "OK" : "★不一致★",
  );
}

console.log("-".repeat(118));
console.log(pad("合計", 22), pad("", 10), pad(yen(totalAgency), 18), pad(yen(totalReferral), 18), pad(yen(totalPay), 16));
console.log("\n期待合計: 代理店分配 ¥32,855.00 / 紹介制度 ¥56,880.80 / 振込予定 ¥89,735.80");
console.log("判定:", totalAgency === 32855.0 && totalReferral === 56880.8 && totalPay === 89735.8 ? "一致 ✓" : "★不一致★");

// ---- LUMN の creator別 → 月別 ------------------------------------------
const lumn = batches.find((b) => nameById.get(b.agency_id) === "LUMN");
const d = await q.fetchPaymentBatchDetail(s, lumn.id);

console.log("\n=== LUMN 代理店分配報酬（creator別 → 月別）===");
for (const c of d.agencyBreakdown.creators) {
  console.log(`  ${c.creatorName} / ${c.tiktokId} / ${c.periodStartMonth}〜${c.periodEndMonth} / 明細 ${c.itemCount} 件`);
  console.log(`    GMV(参考) ${yen(c.gmv)} / 分配計算基準額 ${yen(c.baseAmount)} / 代理店分配額 ${yen(c.rewardAmount)}`);
  for (const m of c.months) {
    console.log(`      ${m.targetMonth}  GMV(参考) ${pad(yen(m.gmv),16)} 分配計算基準額 ${pad(yen(m.baseAmount),14)} 分配率 ${m.ratePct}%  分配額 ${yen(m.rewardAmount)}`);
  }
}

console.log("\n=== LUMN 紹介制度報酬（紹介者×creator別 → 月別）===");
for (const c of d.referralBreakdown.creators) {
  console.log(`  紹介者 ${c.referrerName} → ${c.creatorName} / ${c.tiktokId} / ${c.periodStartMonth}〜${c.periodEndMonth} / 明細 ${c.itemCount} 件`);
  console.log(`    GMV(参考) ${yen(c.gmv)} / 紹介計算基準額 ${yen(c.baseAmount)} / 紹介制度報酬 ${yen(c.rewardAmount)}`);
  for (const m of c.months) {
    console.log(`      ${m.targetMonth}  GMV(参考) ${pad(yen(m.gmv),16)} 紹介計算基準額 ${pad(yen(m.baseAmount),14)} 紹介率 ${m.ratePct}%  紹介制度報酬 ${yen(m.rewardAmount)}`);
  }
}

console.log("\n=== 最終合計 ===");
console.log("  代理店分配報酬 ", yen(round2(d.agencyRewardAmount)));
console.log("＋ 紹介制度報酬 ", yen(round2(d.referralRewardAmount)));
console.log("＝ 振込予定額   ", yen(round2(d.agencyRewardAmount + d.referralRewardAmount)));
console.log("  batch記録額   ", yen(round2(d.batch.paymentAmount)), d.totalsMatchBatch ? "（一致 ✓）" : "（★不一致★）");

process.exit(ng === 0 ? 0 : 1);
