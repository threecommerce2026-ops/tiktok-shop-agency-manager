/*
  TAP-only へ切り替えた場合の紹介者報酬を、Production から算出する（READ ONLY）。

  ■ 本番DBへ一切書き込まない
  SELECT のみ。referral_reward_items の INSERT / UPDATE / DELETE は行わない。
  支払明細の作成・claim・承認も行わない。

  ■ 紹介報酬の算定基礎（2026-09-29 確定）
  THREE COMMERCE の取り分 = Excel W列「アフィリエイトパートナー推定成果報酬」
  ＋ X列「アフィリエイトパートナーショップ広告の推定成果報酬」。
  commission_base（成果報酬GMVベース）ではない。ボーナスも含めない。
  式は referral-reward-engine.ts の referralBaseAmount が唯一の入口で、
  ここで組み立て直さない（本番と食い違う）。

  ■ アプリと同じ判定を使う
  対象行の条件は lib/referrals/tap-referral-source.ts、
  金額は lib/referrals/referral-reward-engine.ts、
  「対象月に有効だった紹介関係」は lib/referrals/referral-period.ts を
  そのまま呼ぶ。
  （上限の適用は同期処理側が行うため、ここでは生成前の額を出す）
  dry-run のために別の計算式を書かない（書くと本番と食い違う）。

  ■ 紹介関係は対象月で引く（is_active では絞らない）
  新しい紹介関係が始まったら旧関係は「次の start_month の前月」までとする
  （2026-09-27 EMI承認）。現在 is_active=false でも、対象月当時に有効
  だった関係なら報酬は発生する。この判定は本番の同期処理と同じ
  buildReferralPeriods / resolveReferralForMonth を使う。

  ■ 確定額ではない
  Production の TAP は 2026-01〜04 が0行で、全量が入っていない。
  ここで出る金額は「現在入っている TAP だけで計算した場合」の値。

  実行:
    node --env-file=.env.local scripts/dry-run-tap-referral-rewards.mjs [cutoff]
*/
import { createRequire } from "node:module";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, {
  alias: { "@": root },
  interopDefault: true,
  fsCache: false,
});

const paged = await jiti.import(path.join(root, "lib/db/paged-select.ts"));
const tapSrc = await jiti.import(path.join(root, "lib/referrals/tap-referral-source.ts"));
const engine = await jiti.import(path.join(root, "lib/referrals/referral-reward-engine.ts"));
const period = await jiti.import(path.join(root, "lib/referrals/referral-period.ts"));

const CUTOFF = process.argv[2] ?? "2026-07";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const yen = (n) =>
  "¥" + n.toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = (n) => n.toLocaleString("ja-JP");

console.log("=== TAP-only 紹介者報酬 dry-run（READ ONLY）===");
console.log(`  締め対象月: ${CUTOFF}`);
console.log("");

// -----------------------------------------------------------------------------
// 読み取り
// -----------------------------------------------------------------------------
const tapResult = await paged.fetchAllFrom(
  supabase,
  "tap_affiliate_order_lines",
  "source_row_key, order_id, product_id, creator_id, creator_tiktok_id, target_month, commission_base, partner_estimated_commission, partner_shop_ads_estimated_commission, payment_status, order_status, refund_status",
  (q) => q,
);
if (tapResult.error) {
  console.error("読み取りに失敗しました:", tapResult.error);
  process.exit(2);
}

const refResult = await paged.fetchAllFrom(
  supabase,
  "referral_reward_items",
  "target_month, creator_id, referrer_id, base_amount, reward_amount, adjusted_reward_amount, is_paid, payout_id, payment_batch_id",
  (q) => q,
);
if (refResult.error) {
  console.error("読み取りに失敗しました:", refResult.error);
  process.exit(2);
}

const { data: creators } = await supabase
  .from("creators")
  .select("id, creator_name, tiktok_id, account_management_type, referred_by_referrer_id");
/*
  紹介関係は全世代を読む。is_active で絞ると過去月の報酬が消える。
*/
const { data: links } = await supabase
  .from("creator_referrals")
  .select(period.REFERRAL_RELATION_COLUMNS)
  .order("created_at", { ascending: true });
const { data: referrers } = await supabase
  .from("referrers")
  .select("id, name, referrer_name, is_in_house");

const creatorById = new Map(creators.map((c) => [c.id, c]));
const referrerById = new Map(referrers.map((r) => [r.id, r]));

/*
  紹介関係は creator_referrals（期間つき）だけを採用する。
  実効期間の決め方は本番と同じ共通helperに任せる。
*/
const referralIndex = period.buildReferralPeriods(links);

if (referralIndex.unresolved.length > 0) {
  console.log("【0】期間を決められず対象外にした紹介関係（推測しない）");
  for (const item of referralIndex.unresolved) {
    const c = creatorById.get(item.creatorId);
    const r = referrerById.get(item.referrerId);
    console.log(
      `  ${(c?.tiktok_id ?? item.creatorId).padEnd(24)} 紹介者=${(r?.referrer_name || r?.name || item.referrerId).padEnd(14)} start=${item.startMonth ?? "(なし)"}  ${period.UNRESOLVED_REFERRAL_LABEL[item.reason]}`,
    );
  }
  console.log("");
}

// -----------------------------------------------------------------------------
// 月別
// -----------------------------------------------------------------------------
const tapRows = tapResult.data.filter((r) => r.target_month && r.target_month <= CUTOFF);
const months = [...new Set(tapResult.data.map((r) => r.target_month))].filter(Boolean).sort();

console.log("【1】TAP の月別（現在 Production に入っている分）");
console.log("月        総行数   有効行   対象外   紹介関係あり  紹介者数  THREE報酬(W+X)      報酬額");
const monthTotals = [];
const candidates = [];
const unknownCreators = new Map();
const conflicts = [];

for (const month of months) {
  const rows = tapResult.data.filter((r) => r.target_month === month);
  let eligible = 0;
  let excluded = 0;
  let linked = 0;
  let base = 0;
  let reward = 0;
  const referrerSet = new Set();

  for (const row of rows) {
    if (!tapSrc.isTapReferralSourceLine(row)) {
      excluded += 1;
      continue;
    }
    eligible += 1;

    const creator = creatorById.get(row.creator_id);
    if (!creator) {
      const key = row.creator_tiktok_id ?? row.creator_id;
      unknownCreators.set(key, (unknownCreators.get(key) ?? 0) + 1);
      continue;
    }

    const resolution = period.resolveReferralForMonth(
      referralIndex.byCreator.get(row.creator_id),
      month,
    );

    /*
      対象月に2件以上該当＝期間が重なっている異常データ。
      黙って1件選ぶと本番と結果がずれるため、集計せず記録して中断材料にする。
    */
    if (resolution.conflicts.length > 0) {
      conflicts.push({
        creatorId: row.creator_id,
        month,
        periods: resolution.conflicts,
      });
      continue;
    }

    const link = resolution.period;
    if (!link) continue;

    const computed = engine.computeReferralReward(
      row,
      {
        creatorId: row.creator_id,
        referrerId: link.referrerId,
        accountManagementType: creator.account_management_type,
      },
      link.referralRate,
    );
    if (!computed) continue;

    linked += 1;
    base += computed.baseAmount;
    reward += computed.rewardAmount;
    referrerSet.add(link.referrerId);
    candidates.push({
      ...computed,
      month,
      creatorId: row.creator_id,
      referrerId: link.referrerId,
      /* end_month を後続関係から復元した関係から生まれた分か */
      restored: link.endMonthRestored,
    });
  }

  monthTotals.push({ month, rows: rows.length, eligible, excluded, linked, base, reward });
  console.log(
    `${month}  ${String(rows.length).padStart(7)}  ${String(eligible).padStart(7)}  ${String(excluded).padStart(7)}  ${String(linked).padStart(12)}  ${String(referrerSet.size).padStart(8)}  ${yen(base).padStart(17)}  ${yen(reward).padStart(14)}`,
  );
}

const totalReward = candidates
  .filter((c) => c.month <= CUTOFF)
  .reduce((a, c) => a + c.rewardAmount, 0);
const totalBase = candidates
  .filter((c) => c.month <= CUTOFF)
  .reduce((a, c) => a + c.baseAmount, 0);
console.log("-".repeat(104));
console.log(
  `${CUTOFF}まで  ${String(tapRows.length).padStart(7)}  ${"".padStart(7)}  ${"".padStart(7)}  ${String(candidates.filter((c) => c.month <= CUTOFF).length).padStart(12)}  ${"".padStart(8)}  ${yen(totalBase).padStart(17)}  ${yen(totalReward).padStart(14)}`,
);
console.log("");

// -----------------------------------------------------------------------------
// 復元された紹介関係の分
// -----------------------------------------------------------------------------
/*
  end_month が未記録で、後続関係の開始月から実効終了月を導出した関係から
  生まれた報酬。旧方式（is_active の最新1件のみ）では消えていた分にあたる。
  隠さず必ず出す。
*/
const inRange = candidates.filter((c) => c.month <= CUTOFF);
const restored = inRange.filter((c) => c.restored);

console.log("【1-b】復元された紹介関係から生成された分（旧方式では消えていた分）");
console.log(
  `  件数: ${int(restored.length)} / ${int(inRange.length)} 件   報酬: ${yen(restored.reduce((a, c) => a + c.rewardAmount, 0))}`,
);
console.log(`  復元した紹介関係: ${int(referralIndex.restoredCount)} 件`);

if (restored.length > 0) {
  const byPair = new Map();
  for (const c of restored) {
    const key = `${c.creatorId}|${c.month}|${c.referrerId}`;
    const cur = byPair.get(key) ?? {
      creatorId: c.creatorId,
      month: c.month,
      referrerId: c.referrerId,
      items: 0,
      base: 0,
      reward: 0,
    };
    cur.items += 1;
    cur.base += c.baseAmount;
    cur.reward += c.rewardAmount;
    byPair.set(key, cur);
  }
  console.log("");
  console.log("  creator                  月       当時の紹介者    行数   base            報酬");
  for (const row of [...byPair.values()].sort((a, b) => b.reward - a.reward)) {
    const c = creatorById.get(row.creatorId);
    const r = referrerById.get(row.referrerId);
    console.log(
      `  ${(c?.tiktok_id ?? row.creatorId).slice(0, 23).padEnd(24)} ${row.month}  ${(r?.referrer_name || r?.name || "(不明)").slice(0, 13).padEnd(14)} ${String(row.items).padStart(5)}  ${yen(row.base).padStart(14)}  ${yen(row.reward).padStart(12)}`,
    );
  }
}
console.log("");

if (conflicts.length > 0) {
  console.log("【1-c】★ 有効期間が重なる紹介関係（本番はここで中断する）");
  for (const item of conflicts) {
    const c = creatorById.get(item.creatorId);
    console.log(
      `  ${(c?.tiktok_id ?? item.creatorId).padEnd(24)} ${item.month}  該当 ${item.periods.length} 件`,
    );
    for (const p of item.periods) {
      const r = referrerById.get(p.referrerId);
      console.log(
        `      紹介者=${(r?.referrer_name || r?.name || p.referrerId).padEnd(14)} ${p.startMonth}〜${p.endMonth ?? "(継続)"}`,
      );
    }
  }
  console.log("");
} else {
  console.log("【1-c】有効期間が重なる紹介関係: なし");
  console.log("");
}

// -----------------------------------------------------------------------------
// 紹介者別
// -----------------------------------------------------------------------------
console.log("【2】TAP-only の紹介者別（締め月まで）");
const byReferrer = new Map();
for (const c of candidates) {
  if (c.month > CUTOFF) continue;
  if (!byReferrer.has(c.referrerId)) byReferrer.set(c.referrerId, []);
  byReferrer.get(c.referrerId).push(c);
}

const referrerRows = [...byReferrer.entries()]
  .map(([rid, items]) => {
    const r = referrerById.get(rid);
    return {
      rid,
      name: r?.referrer_name || r?.name || "(不明)",
      inHouse: r?.is_in_house === true,
      items: items.length,
      creators: new Set(items.map((i) => i.creatorId)).size,
      months: [...new Set(items.map((i) => i.month))].sort(),
      base: items.reduce((a, i) => a + i.baseAmount, 0),
      reward: items.reduce((a, i) => a + i.rewardAmount, 0),
      rates: [...new Set(items.map((i) => i.rewardRate))],
    };
  })
  .sort((a, b) => b.reward - a.reward);

console.log("紹介者              件数  creator  対象月                 率      THREE報酬(W+X)     報酬額");
for (const r of referrerRows) {
  console.log(
    `${r.name.slice(0, 17).padEnd(18)} ${String(r.items).padStart(5)} ${String(r.creators).padStart(8)}  ${r.months.map((m) => m.slice(5)).join(",").padEnd(20)} ${r.rates.join(",").padEnd(6)} ${yen(r.base).padStart(16)} ${yen(r.reward).padStart(14)}${r.inHouse ? " [自社]" : ""}`,
  );
}
console.log("");

// -----------------------------------------------------------------------------
// 既存との差分
// -----------------------------------------------------------------------------
const current = refResult.data.filter((r) => r.target_month <= CUTOFF);
const amountOf = (r) => Number(r.adjusted_reward_amount ?? r.reward_amount ?? 0);

console.log("【3】現在の referral_reward_items との差分（締め月まで）");
console.log(`  現在(affiliate由来): ${int(current.length)} 件 / ${yen(current.reduce((a, r) => a + amountOf(r), 0))}`);
console.log(`  TAP-only 候補      : ${int(candidates.filter((c) => c.month <= CUTOFF).length)} 件 / ${yen(totalReward)}`);
console.log("");

const curByRef = new Map();
for (const r of current) curByRef.set(r.referrer_id, (curByRef.get(r.referrer_id) ?? 0) + amountOf(r));
const newByRef = new Map(referrerRows.map((r) => [r.rid, r.reward]));
const allRefIds = new Set([...curByRef.keys(), ...newByRef.keys()]);

console.log("  紹介者別       現在額            TAP-only額         差額");
for (const rid of allRefIds) {
  const r = referrerById.get(rid);
  const a = curByRef.get(rid) ?? 0;
  const b = newByRef.get(rid) ?? 0;
  console.log(
    `  ${(r?.referrer_name || r?.name || "(不明)").slice(0, 13).padEnd(14)} ${yen(a).padStart(16)} ${yen(b).padStart(17)} ${yen(b - a).padStart(16)}`,
  );
}
console.log("");

const curByMonth = new Map();
for (const r of current) curByMonth.set(r.target_month, (curByMonth.get(r.target_month) ?? 0) + amountOf(r));
const newByMonth = new Map();
for (const c of candidates) {
  if (c.month > CUTOFF) continue;
  newByMonth.set(c.month, (newByMonth.get(c.month) ?? 0) + c.rewardAmount);
}
console.log("  月別           現在額            TAP-only額         差額");
for (const m of [...new Set([...curByMonth.keys(), ...newByMonth.keys()])].sort()) {
  const a = curByMonth.get(m) ?? 0;
  const b = newByMonth.get(m) ?? 0;
  console.log(`  ${m.padEnd(14)} ${yen(a).padStart(16)} ${yen(b).padStart(17)} ${yen(b - a).padStart(16)}`);
}
console.log("");

const curByCreator = new Map();
for (const r of current) curByCreator.set(r.creator_id, (curByCreator.get(r.creator_id) ?? 0) + amountOf(r));
const newByCreator = new Map();
for (const c of candidates) {
  if (c.month > CUTOFF) continue;
  newByCreator.set(c.creatorId, (newByCreator.get(c.creatorId) ?? 0) + c.rewardAmount);
}
const creatorDiff = [...new Set([...curByCreator.keys(), ...newByCreator.keys()])]
  .map((cid) => ({
    cid,
    name: creatorById.get(cid)?.tiktok_id ?? String(cid).slice(0, 8),
    a: curByCreator.get(cid) ?? 0,
    b: newByCreator.get(cid) ?? 0,
  }))
  .sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a));

console.log("  creator別（差額の大きい順 上位20）");
console.log("  creator                  現在額            TAP-only額         差額");
for (const d of creatorDiff.slice(0, 20)) {
  console.log(
    `  ${d.name.slice(0, 23).padEnd(24)} ${yen(d.a).padStart(16)} ${yen(d.b).padStart(17)} ${yen(d.b - d.a).padStart(16)}`,
  );
}
console.log("");

if (unknownCreators.size > 0) {
  console.log("【4】creators に見つからないクリエイター（TAP 側）");
  for (const [k, v] of unknownCreators) console.log(`  ${k}: ${v} 行`);
  console.log("");
} else {
  console.log("【4】creators に見つからないクリエイター: なし");
  console.log("");
}

// -----------------------------------------------------------------------------
console.log("【5】確定できない理由");
const missingMonths = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"].filter(
  (m) => !months.includes(m) || tapResult.data.filter((r) => r.target_month === m).length === 0,
);
console.log(`  TAP が 0 行の月: ${missingMonths.join(", ") || "なし"}`);
console.log("  ★ TAP全量未投入のため、ここに出た金額は確定額ではありません。");
console.log("  ★ 紹介者の支払明細（payment batch）はまだ作成できません。");
console.log("");
console.log("【6】このスクリプトは書き込みを行っていません（SELECT のみ）");
