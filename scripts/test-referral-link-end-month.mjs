/*
  紹介者を切り替えたとき、旧紹介関係に end_month を記録するかのテスト。

  DBへは接続せず、Supabase クライアントの呼び出しを記録するスタブで確かめる。
  実行: node --test scripts/test-referral-link-end-month.mjs

  ■ なぜ記録するのか
  記録しないと「いつまで有効だったか」がどこにも残らない。
  過去月の紹介報酬は referral-period.ts が後続関係の開始月から
  実効終了月を復元しているが、復元に頼らず済むのが本来の形。

  ■ 推測はしない
  新しい紹介者が決まっていない（紹介者なしにする）場合は境界が無いので
  end_month を書かない。無効化した日から決めると DB に無い事実を作る。
*/
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = process.cwd();
const jiti = createJiti(root, {
  alias: { "@": root },
  interopDefault: true,
  fsCache: false,
});

const link = await jiti.import(path.join(root, "lib/referrals/link-creator-referrer.ts"));

const CREATOR = "creator-1";
const NEW_REFERRER = "referrer-new";

/**
 * Supabase クライアントの最小スタブ。
 * creator_referrals への update だけを記録し、他は成功を返す。
 */
function stubSupabase({ existingReferralId = null } = {}) {
  const calls = [];

  function table(name) {
    const state = { name, payload: null, filters: [] };

    const chain = {
      update(payload) {
        state.op = "update";
        state.payload = payload;
        return chain;
      },
      insert(payload) {
        state.op = "insert";
        state.payload = payload;
        calls.push({ ...state });
        return Promise.resolve({ error: null });
      },
      select() {
        state.op = "select";
        return chain;
      },
      eq(column, value) {
        state.filters.push(["eq", column, value]);
        return chain;
      },
      neq(column, value) {
        state.filters.push(["neq", column, value]);
        return chain;
      },
      order() {
        return chain;
      },
      limit() {
        return chain;
      },
      maybeSingle() {
        return Promise.resolve({
          data: existingReferralId ? { id: existingReferralId } : null,
          error: null,
        });
      },
      /* update は await された時点で確定する */
      then(resolve, reject) {
        calls.push({ ...state });
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };

    return chain;
  }

  return { from: table, calls };
}

/** creator_referrals を無効化した update 呼び出しを取り出す */
function deactivationCall(calls) {
  return calls.find(
    (call) =>
      call.name === "creator_referrals" &&
      call.op === "update" &&
      call.payload?.is_active === false,
  );
}

test("紹介者を切り替えると旧関係に end_month（新開始月の前月）を記録する", async () => {
  const supabase = stubSupabase();

  const result = await link.linkCreatorToReferrer(supabase, {
    creatorId: CREATOR,
    referrerId: NEW_REFERRER,
    startMonth: "2026-09",
  });

  assert.deepEqual(result, { ok: true });

  const call = deactivationCall(supabase.calls);
  assert.ok(call, "旧関係を無効化する update が無い");
  assert.equal(call.payload.end_month, "2026-08", "end_month が前月でない");
  assert.equal(call.payload.is_active, false);

  // 切り替え先の関係は無効化の対象から外す
  assert.ok(
    call.filters.some(([op, col, val]) => op === "neq" && col === "referrer_id" && val === NEW_REFERRER),
    "新しい紹介者の行まで無効化しようとしている",
  );
});

test("年をまたぐ切り替え（2027-01 開始 → 旧は 2026-12 まで）", async () => {
  const supabase = stubSupabase();

  await link.linkCreatorToReferrer(supabase, {
    creatorId: CREATOR,
    referrerId: NEW_REFERRER,
    startMonth: "2027-01",
  });

  assert.equal(deactivationCall(supabase.calls).payload.end_month, "2026-12");
});

test("紹介者なしにする場合は end_month を書かない（推測しない）", async () => {
  const supabase = stubSupabase();

  const result = await link.linkCreatorToReferrer(supabase, {
    creatorId: CREATOR,
    referrerId: null,
  });

  assert.deepEqual(result, { ok: true });

  const call = deactivationCall(supabase.calls);
  assert.ok(call, "無効化の update が無い");
  assert.equal(
    Object.prototype.hasOwnProperty.call(call.payload, "end_month"),
    false,
    "境界が無いのに end_month を書いている",
  );
});

test("既存関係を再有効化する場合も旧関係に end_month を記録する", async () => {
  const supabase = stubSupabase({ existingReferralId: "existing-row" });

  await link.linkCreatorToReferrer(supabase, {
    creatorId: CREATOR,
    referrerId: NEW_REFERRER,
    startMonth: "2026-09",
  });

  assert.equal(deactivationCall(supabase.calls).payload.end_month, "2026-08");

  // 再有効化側は start_month をそのまま持ち、is_active=true に戻る
  const reactivate = supabase.calls.find(
    (call) =>
      call.name === "creator_referrals" &&
      call.op === "update" &&
      call.payload?.is_active === true,
  );
  assert.ok(reactivate, "既存行の再有効化が無い");
  assert.equal(reactivate.payload.start_month, "2026-09");
});

test("既存の過去 relation へ backfill する経路は無い", async () => {
  /*
    今回入れたのは「今後の切り替え時に記録する」だけ。
    既存57件へ一括で書き込む処理を足していないことを確かめる。
  */
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    path.join(root, "lib/referrals/link-creator-referrer.ts"),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // 無効化は「その creator の有効な関係」だけを対象にしている
  assert.ok(
    /\.eq\("creator_id",\s*creatorId\)/.test(code),
    "creator_id で絞っていない（他クリエイターへ波及する）",
  );
  assert.ok(
    /\.eq\("is_active",\s*true\)/.test(code),
    "is_active=true で絞っていない（過去の無効関係まで書き換える）",
  );
});
