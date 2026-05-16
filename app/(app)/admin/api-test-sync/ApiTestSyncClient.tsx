"use client";

import {
  tiktokApiTestSyncAction,
  type TikTokApiTestSyncResult,
} from "@/app/actions/tiktok-api-test-sync";
import type { TikTokApiConnectionOption } from "@/lib/db/tiktok-api-connection-queries";
import { useActionState } from "react";

type Props = {
  connections: TikTokApiConnectionOption[];
};

const textareaClass =
  "mt-1.5 min-h-[280px] w-full rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-3 font-mono text-xs text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40";

const selectClass =
  "mt-1.5 w-full rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40";

export function ApiTestSyncClient({ connections }: Props) {
  const [state, formAction, isPending] = useActionState(
    tiktokApiTestSyncAction,
    null as TikTokApiTestSyncResult | null,
  );

  return (
    <form
      action={formAction}
      className="space-y-4 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5"
    >
      <div>
        <label
          className="text-[11px] font-medium uppercase tracking-wider text-zinc-500"
          htmlFor="api-test-connection"
        >
          接続先ショップ
        </label>
        <select
          id="api-test-connection"
          name="connection_id"
          className={selectClass}
          defaultValue=""
        >
          <option value="">未選択（last_synced_at は更新しません）</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.shop_id}
              {connection.shop_cipher ? ` / ${connection.shop_cipher}` : ""}
              {connection.is_active ? " / 有効" : ""}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label
          className="text-[11px] font-medium uppercase tracking-wider text-zinc-500"
          htmlFor="api-test-json"
        >
          Order API レスポンス JSON
        </label>
        <textarea
          id="api-test-json"
          name="payload_json"
          required
          placeholder='{"orders":[{"order_id":"...","creator_tiktok_id":"...","payment_status":"paid"}]}'
          className={textareaClass}
        />
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          `orders` 配列、または注文オブジェクトの配列に対応します。`order_id` と
          `creator_tiktok_id` が必須です。存在しないクリエイターは未振り分けで自動作成され、
          決済済みかつキャンセル/返品なしの注文のみ `is_commission_target = true` になります。
        </p>
      </div>

      {state?.ok ? (
        <p className="text-sm text-emerald-300">{state.message}</p>
      ) : null}
      {state && !state.ok ? (
        <p className="text-sm text-red-300">{state.error}</p>
      ) : null}

      <button
        type="submit"
        disabled={isPending}
        className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/80 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50"
      >
        {isPending ? "同期中…" : "テスト同期"}
      </button>
    </form>
  );
}
