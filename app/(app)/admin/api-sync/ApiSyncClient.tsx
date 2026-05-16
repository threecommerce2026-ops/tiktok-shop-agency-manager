"use client";

import { tiktokApiSyncAction, type TikTokApiSyncResult } from "@/app/actions/tiktok-api-sync";
import type { TikTokApiConnectionRow } from "@/lib/db/tiktok-api-connection-queries";
import Link from "next/link";
import { useState, useTransition } from "react";

type Props = {
  connections: TikTokApiConnectionRow[];
};

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP");
}

export function ApiSyncClient({ connections }: Props) {
  const [message, setMessage] = useState<TikTokApiSyncResult | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SyncSummary connections={connections} />
          <button
            type="button"
            disabled={isPending || connections.length === 0}
            onClick={() => {
              startTransition(async () => {
                const result = await tiktokApiSyncAction();
                setMessage(result);
              });
            }}
            className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/80 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50"
          >
            {isPending ? "同期中…" : "本番 API 同期を実行"}
          </button>
        </div>

        {connections.length === 0 ? (
          <p className="mt-4 text-sm text-amber-200">
            有効な API 接続がありません。
            <Link href="/admin/api-connections" className="ml-1 text-[var(--accent-cyan)] hover:underline">
              API 設定
            </Link>
            で接続を登録し、`is_active` を有効にしてください。
          </p>
        ) : null}

        {message?.ok ? (
          <p className="mt-4 text-sm text-emerald-300">{message.message}</p>
        ) : null}
        {message && !message.ok ? (
          <p className="mt-4 text-sm text-red-300">{message.error}</p>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-200">同期対象の接続</h2>
        {connections.length === 0 ? (
          <p className="rounded-xl border border-white/[0.06] bg-surface-1/40 px-4 py-6 text-center text-sm text-zinc-500">
            同期対象の接続はありません。
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {connections.map((connection) => (
              <li
                key={connection.id}
                className="rounded-xl border border-white/[0.07] bg-surface-1/50 p-3.5"
              >
                <p className="font-semibold text-zinc-100">{connection.shop_id}</p>
                <p className="mt-0.5 font-mono text-xs text-zinc-500">
                  {connection.shop_cipher ?? "shop_cipher 未設定"}
                </p>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-[10px] text-zinc-600">状態</dt>
                    <dd className="text-zinc-300">
                      {connection.is_active ? "有効" : "無効"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-zinc-600">最終同期</dt>
                    <dd className="font-mono text-xs text-zinc-300">
                      {formatTimestamp(connection.last_synced_at)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SyncSummary({ connections }: Props) {
  return (
    <div>
      <p className="text-sm text-zinc-300">
        有効な接続:{" "}
        <span className="font-mono text-zinc-100">{connections.length}</span> 件
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        `TIKTOK_SHOP_ORDERS_API_URL` と接続トークンを使って Order API から注文を取得します。
      </p>
    </div>
  );
}
