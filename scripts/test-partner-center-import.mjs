import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, { alias: { "@": root }, interopDefault: true, fsCache: false });

const P = await jiti.import(path.join(root, "lib/shop-performance/partner-center-payload.ts"));

/** コメントを除いた実コードだけを見る（説明文の言及に反応させない） */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const ROUTE_RAW = fs.readFileSync(path.join(root, "app/api/partner-center-sync/route.ts"), "utf8");
const ROUTE = codeOnly(ROUTE_RAW);
const CLIENT = fs.readFileSync(
  path.join(root, "app/admin/partner-center-import/PartnerCenterImportClient.tsx"),
  "utf8",
);
const PAGE = fs.readFileSync(path.join(root, "app/admin/partner-center-import/page.tsx"), "utf8");

const shop = (o) => ({
  shop_id: o.shop_id,
  shop_name: o.shop_name ?? "テストSHOP",
  revenue: o.revenue ?? 0,
  shop_ranking: o.shop_ranking ?? null,
  revenue_percentage: o.revenue_percentage ?? null,
});

/* ===================== 取込の検証 ===================== */

test("正常なJSONを解析できる（配列形式・{shops} 形式の両方）", () => {
  const arr = [shop({ shop_id: "7494573593353880665", shop_name: "6FARM" })];
  assert.deepEqual(P.extractPartnerShops(arr), arr);
  assert.deepEqual(P.extractPartnerShops({ shops: arr }), arr);
  assert.equal(P.extractPartnerShops({ foo: 1 }), null);
  assert.equal(P.extractPartnerShops("abc"), null);
});

test("revenue のネスト形 { amount } を解釈できる", () => {
  assert.equal(P.toPartnerRevenue({ amount: "1,234,567" }), 1234567);
  assert.equal(P.toPartnerRevenue("73,483,751円"), 73483751);
  assert.equal(P.toPartnerRevenue(100), 100);
  assert.equal(P.toPartnerRevenue(null), 0);
});

test("shop_id 形式チェックが通る（正常）", () => {
  const v = P.validatePartnerCenterShops([
    shop({ shop_id: "7494573593353880665", shop_name: "6FARM", revenue: 100 }),
  ]);
  assert.equal(v.counts.valid, 1);
  assert.equal(v.issues.length, 0);
  assert.equal(v.rows[0].shopId, "7494573593353880665");
  assert.equal(v.rows[0].revenue, 100);
});

test("英数字 shop_code を拒否する", () => {
  const v = P.validatePartnerCenterShops([shop({ shop_id: "JPJPLCJLLL4C" })]);
  assert.equal(v.counts.valid, 0);
  assert.equal(v.counts.invalidShopId, 1);
  assert.equal(v.issues[0].kind, "invalid_shop_id");
  assert.match(v.issues[0].message, /1件目/);
});

test("空 shop_id を拒否する", () => {
  for (const id of ["", "   ", null, undefined]) {
    const v = P.validatePartnerCenterShops([shop({ shop_id: id })]);
    assert.equal(v.counts.invalidShopId, 1, `shop_id=${JSON.stringify(id)} が通っている`);
  }
});

test("数字以外・桁数不正を拒否する", () => {
  for (const id of ["123", "abc123", "74945735933538806651234567890", "7494-5735-9335"]) {
    const v = P.validatePartnerCenterShops([shop({ shop_id: id })]);
    assert.equal(v.counts.valid, 0, `${id} が通っている`);
  }
});

test("shop_name が空なら拒否する", () => {
  const v = P.validatePartnerCenterShops([
    shop({ shop_id: "7494573593353880665", shop_name: "  " }),
  ]);
  assert.equal(v.counts.missingShopName, 1);
  assert.equal(v.counts.valid, 0);
});

test("重複 shop_id を検出し、どちらも取り込まない", () => {
  const v = P.validatePartnerCenterShops([
    shop({ shop_id: "7494573593353880665", shop_name: "A" }),
    shop({ shop_id: "7494573593353880665", shop_name: "B" }),
  ]);
  assert.equal(v.counts.duplicateShopId, 2);
  assert.equal(v.counts.valid, 0, "重複時に片方を勝手に採用しない");
});

test("不正データの件数が正しく集計される", () => {
  const v = P.validatePartnerCenterShops([
    shop({ shop_id: "7494573593353880665", shop_name: "正常" }),
    shop({ shop_id: "JPJPLCJLLL4C", shop_name: "不正ID" }),
    shop({ shop_id: "7494000000000000002", shop_name: "" }),
  ]);
  assert.equal(v.counts.total, 3);
  assert.equal(v.counts.valid, 1);
  assert.equal(v.counts.invalidShopId, 1);
  assert.equal(v.counts.missingShopName, 1);
});

test("shop_id 形式判定は isTikTokShopIdFormat を使っている（重複実装なし）", () => {
  const lib = fs.readFileSync(
    path.join(root, "lib/shop-performance/partner-center-payload.ts"),
    "utf8",
  );
  assert.ok(lib.includes("isTikTokShopIdFormat"), "共有の形式判定を使っていない");
  assert.ok(
    !/\/\^\[0-9\]\{\d+,\d+\}\$\//.test(lib.replace(/\/\*[\s\S]*?\*\//g, "")),
    "形式判定を別実装している",
  );
});

/* ===================== 対象月・期間 ===================== */

test("対象月の検証", () => {
  assert.equal(P.isValidTargetMonth("2026-09"), true);
  assert.equal(P.isValidTargetMonth("2026-13"), false);
  assert.equal(P.isValidTargetMonth("2026-00"), false);
  assert.equal(P.isValidTargetMonth("2026-9"), false);
  assert.equal(P.isValidTargetMonth(""), false);
  assert.equal(P.isValidTargetMonth(null), false);
});

test("対象月から期間を自動算出する（うるう年も正しい）", () => {
  assert.equal(P.defaultPeriodStart("2026-09"), "2026-09-01");
  assert.equal(P.defaultPeriodEnd("2026-09"), "2026-09-30");
  assert.equal(P.defaultPeriodEnd("2026-08"), "2026-08-31");
  assert.equal(P.defaultPeriodEnd("2024-02"), "2024-02-29", "うるう年");
  assert.equal(P.defaultPeriodEnd("2026-02"), "2026-02-28");
});

test("JSON側に期間情報があれば取り出せる", () => {
  const json = { target_month: "2026-09", period_start: "2026-09-01", period_end: "2026-09-20", shops: [] };
  assert.equal(P.extractTargetMonth(json), "2026-09");
  assert.deepEqual(P.extractPeriod(json), {
    periodStart: "2026-09-01",
    periodEnd: "2026-09-20",
  });
  assert.deepEqual(P.extractPeriod({ shops: [] }), { periodStart: null, periodEnd: null });
});

/* ===================== 固定値の撤廃 ===================== */

test("2026-08 固定が残っていない", () => {
  for (const [name, src] of [["route", ROUTE_RAW], ["client", CLIENT], ["page", PAGE]]) {
    assert.ok(!/2026-08/.test(src), `${name} に 2026-08 が残っている`);
    assert.ok(!/2026-08-01|2026-08-25/.test(src), `${name} に期間の固定値が残っている`);
  }
});

test("「28ショップ」固定表示が残っていない", () => {
  assert.ok(!/28ショップ/.test(CLIENT), "件数がハードコードされている");
  assert.ok(
    /counts\.valid\}ショップを取り込む/.test(CLIENT),
    "件数を動的表示していない",
  );
});

/* ===================== 権限 ===================== */

test("API が既存の管理者判定を使っている（agencyユーザー不可）", () => {
  assert.ok(ROUTE.includes("requireAdminApiAccess"), "管理者判定を使っていない");
  assert.ok(!/auth\.getUser\(\)/.test(ROUTE), "独自のログイン判定が残っている");
  assert.ok(
    !/PARTNER_CENTER_SYNC_SECRET|x-partner-sync-secret/.test(ROUTE),
    "共有シークレット経路が残っている",
  );
});

test("画面側も管理者のみ（isAdminRole で判定）", () => {
  assert.ok(PAGE.includes("isAdminRole"), "画面に管理者判定がない");
  assert.ok(PAGE.includes('redirect("/dashboard")'), "非管理者がリダイレクトされない");
});

/* ===================== DBへの影響 ===================== */

test("sellers.shop_id を自動UPDATEしない", () => {
  assert.ok(
    !/\.from\(\s*["']sellers["']\s*\)[\s\S]{0,300}?\.update\(/.test(ROUTE),
    "取込が sellers を更新している",
  );
  assert.ok(!/shop_id:\s*row\.shop_id,\s*\n\s*updated_at/.test(ROUTE), "shop_id 補完が残っている");
  assert.equal((ROUTE.match(/\.update\(/g) ?? []).length, 0, "update が存在する");
});

test("shop_performance_imports へだけ書き込む", () => {
  const writes = [...ROUTE.matchAll(/\.from\(\s*["']([a-z_]+)["']\s*\)\s*\n?\s*\.(upsert|insert|update|delete)\(/g)];
  assert.deepEqual(
    [...new Set(writes.map((m) => m[1]))],
    ["shop_performance_imports"],
    "想定外のテーブルへ書き込んでいる",
  );
});

test("seller_shop_aliases / tsp_rate / seller_invoices を変更しない", () => {
  assert.ok(
    !/\.from\(\s*["']seller_shop_aliases["']\s*\)[\s\S]{0,200}?\.(upsert|insert|update|delete)\(/.test(ROUTE),
    "alias を変更している",
  );
  assert.ok(!/tsp_rate/.test(ROUTE), "tsp_rate に触れている");
  assert.ok(!/seller_invoices/.test(ROUTE), "seller_invoices に触れている");
  assert.ok(!/affiliate_order_lines/.test(ROUTE), "affiliate_order_lines に触れている");
});

test("不正データが1件でもあれば取込全体を止める", () => {
  assert.ok(
    /validation\.issues\.length > 0[\s\S]{0,300}?status: 400/.test(ROUTE),
    "不正データがあっても部分的に保存してしまう",
  );
  // 検証は upsert より前に行う
  assert.ok(
    ROUTE.indexOf("validatePartnerCenterShops(") < ROUTE.indexOf(".upsert("),
    "検証より先に保存している",
  );
});

/* ===================== 取込後の候補再計算 ===================== */

test("取込後に既存の候補ロジックで再計算している", () => {
  assert.ok(ROUTE.includes("fetchShopIdLinkSummary("), "候補集計を使っていない");
  assert.ok(ROUTE.includes("diffShopIdLinkSummary("), "差分を取っていない");
  assert.ok(
    !/(state|matchReason)\s*[:=]\s*["'](confident|review|none)["']/.test(ROUTE),
    "候補判定を別実装している",
  );
});

test("取込だけでは seller へ反映されないことが結果に明示される", () => {
  assert.ok(
    /sellers\.shop_id を自動更新していません|sellers\.shop_id を変更しません/.test(CLIENT),
    "自動更新しない旨の表示がない",
  );
  assert.ok(
    CLIENT.includes("/admin/sellers?panel=shop-id"),
    "Shop ID候補確認への導線がない",
  );
});

test("取込画面から seller.shop_id を変更する機能を作っていない", () => {
  assert.ok(
    !/\.from\(\s*["']sellers["']\s*\)/.test(CLIENT),
    "画面が直接 sellers を操作している",
  );
  assert.ok(
    !/setSellerShopIdManuallyAction|applyShopIdLinkBulkAction/.test(CLIENT),
    "取込画面から Shop ID を適用できてしまう",
  );
});

/* ===================== CSV との役割分担 ===================== */

test("ShopList CSV と Partner Center JSON の役割が画面に説明されている", () => {
  assert.ok(/Shop ID は含まれません/.test(CLIENT), "CSVの注意書きがない");
  assert.ok(/Shop ID 付き/.test(CLIENT), "JSONの用途説明がない");
});

/* ===================== Partner Center 実レスポンス形式 ===================== */

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(root, "test-fixtures/partner-center-shop-list.json"), "utf8"),
);

/** fixture を複製して一部だけ差し替える */
function withFixture(mutate) {
  const copy = JSON.parse(JSON.stringify(FIXTURE));
  mutate(copy);
  return copy;
}

test("実レスポンス形式を正常に解析できる", () => {
  const env = P.parsePartnerCenterResponse(FIXTURE);
  assert.ok(env, "解析できていない");
  assert.equal(env.isRealResponse, true);
  assert.equal(env.code, 0);
  assert.equal(env.message, "success");
  assert.equal(env.shops.length, 2);
});

test("data.stats から shop_id / shop_name / revenue.amount / shop_ranking を取得できる", () => {
  const env = P.parsePartnerCenterResponse(FIXTURE);
  const v = P.validatePartnerCenterShops(env.shops);
  assert.equal(v.counts.valid, 2);

  const a = v.rows.find((r) => r.shopId === "7496312938158394157");
  assert.equal(a.shopName, "TEST SHOP A");
  assert.equal(a.revenue, 100000, "revenue.amount を数値化できていない");
  assert.equal(a.shopRanking, 1);

  const b = v.rows.find((r) => r.shopId === "7496219251418106021");
  assert.equal(b.revenue, 50000);
  assert.equal(b.shopRanking, 2);
});

test("data 部分だけを貼り付けても解析できる", () => {
  const env = P.parsePartnerCenterResponse(FIXTURE.data);
  assert.ok(env);
  assert.equal(env.shops.length, 2);
  assert.equal(env.targetMonth, "2026-08");
});

test("time_descriptor から target_month を自動算出できる", () => {
  const env = P.parsePartnerCenterResponse(FIXTURE);
  assert.equal(env.targetMonth, "2026-08");
});

test("2026-08-01 ～ 2026-09-01 → target_month 2026-08 / 期間は月末まで", () => {
  const r = P.resolveTimeDescriptor({
    start: "2026-08-01T00:00:00",
    end: "2026-09-01T00:00:00",
  });
  assert.equal(r.targetMonth, "2026-08");
  assert.equal(r.periodStart, "2026-08-01");
  assert.equal(r.periodEnd, "2026-08-31", "翌月1日の排他境界を1日戻せていない");
});

test("end が対象月内ならそのまま期間末にする", () => {
  const r = P.resolveTimeDescriptor({
    start: "2026-08-01T00:00:00",
    end: "2026-08-25T00:00:00",
  });
  assert.equal(r.periodEnd, "2026-08-25");
});

test("うるう年の月末も正しい", () => {
  const r = P.resolveTimeDescriptor({
    start: "2024-02-01T00:00:00",
    end: "2024-03-01T00:00:00",
  });
  assert.equal(r.targetMonth, "2024-02");
  assert.equal(r.periodEnd, "2024-02-29");
});

test("total = stats.length / has_more = false → 完全データ", () => {
  const env = P.parsePartnerCenterResponse(FIXTURE);
  assert.equal(env.completeness.expectedTotal, 2);
  assert.equal(env.completeness.actualCount, 2);
  assert.equal(env.completeness.hasMore, false);
  assert.equal(env.completeness.isComplete, true);
  assert.equal(env.completeness.reason, null);
});

test("total=29 / stats.length=29 / has_more=false → 完全データ", () => {
  const c = P.resolveCompleteness({ next_pagination: { has_more: false, total: 29 } }, 29);
  assert.equal(c.isComplete, true);
});

test("total=29 / stats.length=10 → 不完全データ", () => {
  const c = P.resolveCompleteness({ next_pagination: { has_more: false, total: 29 } }, 10);
  assert.equal(c.isComplete, false);
  assert.match(c.reason, /29 件.*10 件/);
});

test("has_more=true → 取込不可", () => {
  const c = P.resolveCompleteness({ next_pagination: { has_more: true, total: 29 } }, 29);
  assert.equal(c.isComplete, false);
  assert.match(c.reason, /has_more/);
});

test("stats が total を超える場合は不完全としない", () => {
  const c = P.resolveCompleteness({ next_pagination: { has_more: false, total: 2 } }, 3);
  assert.equal(c.isComplete, true);
});

test("件数情報が無い形式では完全性で弾かない（既存形式との互換）", () => {
  const env = P.parsePartnerCenterResponse({ target_month: "2026-09", shops: [] });
  assert.equal(env.isRealResponse, false);
  assert.equal(env.completeness.isComplete, true);
  assert.equal(env.completeness.expectedTotal, null);
});

test("code が 0 以外ならエラーとして扱う", () => {
  const env = P.parsePartnerCenterResponse(withFixture((f) => {
    f.code = 40001;
    f.message = "invalid session";
  }));
  const err = P.partnerResponseError(env);
  assert.match(err, /40001/);
  assert.equal(P.partnerResponseError(P.parsePartnerCenterResponse(FIXTURE)), null);
});

test("実レスポンス内の不正 Shop ID を拒否する", () => {
  const env = P.parsePartnerCenterResponse(withFixture((f) => {
    f.data.stats[0].shop_id = "JPJPLCJLLL4C";
  }));
  const v = P.validatePartnerCenterShops(env.shops);
  assert.equal(v.counts.invalidShopId, 1);
  assert.equal(v.counts.valid, 1);
});

test("実レスポンス内の shop_name 空を拒否する", () => {
  const env = P.parsePartnerCenterResponse(withFixture((f) => {
    f.data.stats[1].shop_name = "   ";
  }));
  const v = P.validatePartnerCenterShops(env.shops);
  assert.equal(v.counts.missingShopName, 1);
});

test("JSON内の shop_id 重複を検出する", () => {
  const env = P.parsePartnerCenterResponse(withFixture((f) => {
    f.data.stats[1].shop_id = f.data.stats[0].shop_id;
  }));
  const v = P.validatePartnerCenterShops(env.shops);
  assert.equal(v.counts.duplicateShopId, 2);
  assert.equal(v.counts.valid, 0);
});

test("同名ショップに別の Shop ID がある場合を検出する", () => {
  const env = P.parsePartnerCenterResponse(withFixture((f) => {
    f.data.stats[1].shop_name = f.data.stats[0].shop_name;
  }));
  const v = P.validatePartnerCenterShops(env.shops);
  assert.equal(v.counts.conflictingShopName, 2);
  assert.equal(v.counts.valid, 0, "どちらが正か分からないまま取り込まない");
});

test("route が完全性チェックで取込を止める", () => {
  assert.ok(
    /completeness\.isComplete[\s\S]{0,300}?status: 400/.test(ROUTE),
    "不完全データでも取り込んでしまう",
  );
  assert.ok(ROUTE.includes("parsePartnerCenterResponse("), "実レスポンス解析を使っていない");
  assert.ok(ROUTE.includes("partnerResponseError("), "code チェックをしていない");
});

test("画面が不完全データで取込ボタンを無効化する", () => {
  assert.ok(/!isIncomplete/.test(CLIENT), "不完全でも取込できてしまう");
  assert.ok(/disabled=\{!canImport\}/.test(CLIENT), "ボタンの無効化がない");
});

test("プレビュー時点ではDBへ書き込まない（解析は純粋関数のみ）", () => {
  assert.ok(
    !/\.from\(\s*["']/.test(CLIENT) && !/supabase/i.test(codeOnly(CLIENT)),
    "画面が直接DBへアクセスしている",
  );
  const lib = fs.readFileSync(
    path.join(root, "lib/shop-performance/partner-center-payload.ts"),
    "utf8",
  );
  assert.ok(!/supabase|\.from\(/.test(codeOnly(lib)), "検証ロジックがDBへ触れている");
});

/* ===================== 秘密情報 ===================== */

test("Cookie / sessionid / msToken / X-Bogus / _signature 等を保存していない", () => {
  const SECRET_KEYS = [
    "sessionid",
    "sessionid_ss",
    "sid_tt",
    "sid_guard",
    "msToken",
    "odin_tt",
    "ttwid",
    "passport_csrf_token",
    "X-Bogus",
    "_signature",
    "X-Tts-Oec-Bsid",
  ];

  const files = [
    "app/api/partner-center-sync/route.ts",
    "app/admin/partner-center-import/PartnerCenterImportClient.tsx",
    "app/admin/partner-center-import/page.tsx",
    "lib/shop-performance/partner-center-payload.ts",
    "test-fixtures/partner-center-shop-list.json",
  ];

  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), "utf8");

    for (const key of SECRET_KEYS) {
      /*
        説明文としての言及（コメント / fixture の注記）は許可する。
        禁止するのは「実際の値が入っている」形だけ:
          sessionid=xxxx / "msToken": "xxxx" / msToken: "xxxx"
      */
      const valuePattern = new RegExp(
        `["']?${key.replace(/[-_]/g, "[-_]")}["']?\\s*[:=]\\s*["'\`][^"'\`]{6,}`,
        "i",
      );
      assert.ok(!valuePattern.test(src), `${f} に ${key} の値が保存されている`);
    }

    assert.ok(
      !/document\.cookie|headers\.get\(\s*["']cookie/i.test(src),
      `${f} が Cookie を読み書きしている`,
    );
  }
});

test("非公開エンドポイントをサーバーから呼んでいない", () => {
  for (const src of [ROUTE, CLIENT, PAGE]) {
    assert.ok(
      !/insights\/partner\/shop\/list/.test(src),
      "Partner Center の非公開APIを直接呼んでいる",
    );
  }
  assert.ok(!/fetch\(\s*["']https?:\/\//.test(ROUTE), "外部APIを呼んでいる");
});

test("fixture に実在の認証値・長いセッション値が無い", () => {
  const raw = fs.readFileSync(
    path.join(root, "test-fixtures/partner-center-shop-list.json"),
    "utf8",
  );
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(raw), "JWT らしき値がある");
  assert.ok(!/[A-Za-z0-9_-]{60,}/.test(raw), "長いセッション値らしき文字列がある");
  assert.equal(FIXTURE.data.stats.length, 2, "fixture は最小構成にする");
});
