"use client";

import {
  deleteTikTokApiConnectionAction,
  saveTikTokApiConnectionAction,
  type SaveTikTokApiConnectionResult,
} from "@/app/actions/tiktok-api-connections";
import type { TikTokApiConnectionRow } from "@/lib/db/tiktok-api-connection-queries";
import { useActionState, useState, useTransition } from "react";

type Props = {
  connections: TikTokApiConnectionRow[];
};

const inputClass =
  "mt-1.5 w-full rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40";

const labelClass =
  "text-[11px] font-medium uppercase tracking-wider text-zinc-500";

function toDateTimeLocalValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP");
}

function ConnectionFields({
  connection,
  fieldPrefix,
}: {
  connection?: TikTokApiConnectionRow;
  fieldPrefix: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className={labelClass} htmlFor={`${fieldPrefix}-app-key`}>
          app_key
        </label>
        <input
          id={`${fieldPrefix}-app-key`}
          name="app_key"
          defaultValue={connection?.app_key ?? ""}
          required
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor={`${fieldPrefix}-app-secret`}>
          app_secret
        </label>
        <input
          id={`${fieldPrefix}-app-secret`}
          name="app_secret"
          type="password"
          defaultValue={connection?.app_secret ?? ""}
          required
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor={`${fieldPrefix}-access-token`}>
          access_token
        </label>
        <input
          id={`${fieldPrefix}-access-token`}
          name="access_token"
          type="password"
          defaultValue={connection?.access_token ?? ""}
          required
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor={`${fieldPrefix}-refresh-token`}>
          refresh_token
        </label>
        <input
          id={`${fieldPrefix}-refresh-token`}
          name="refresh_token"
          type="password"
          defaultValue={connection?.refresh_token ?? ""}
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor={`${fieldPrefix}-shop-cipher`}>
          shop_cipher
        </label>
        <input
          id={`${fieldPrefix}-shop-cipher`}
          name="shop_cipher"
          defaultValue={connection?.shop_cipher ?? ""}
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor={`${fieldPrefix}-shop-id`}>
          shop_id
        </label>
        <input
          id={`${fieldPrefix}-shop-id`}
          name="shop_id"
          defaultValue={connection?.shop_id ?? ""}
          required
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor={`${fieldPrefix}-token-expired`}>
          token_expired_at
        </label>
        <input
          id={`${fieldPrefix}-token-expired`}
          name="token_expired_at"
          type="datetime-local"
          defaultValue={toDateTimeLocalValue(connection?.token_expired_at ?? null)}
          className={inputClass}
        />
      </div>
      <label className="flex min-h-[44px] items-center gap-2 rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2 text-sm text-zinc-300 sm:col-span-2">
        <input
          type="checkbox"
          name="is_active"
          defaultChecked={connection?.is_active ?? true}
        />
        有効な接続として扱う
      </label>
    </div>
  );
}

function ConnectionForm({
  connection,
}: {
  connection?: TikTokApiConnectionRow;
}) {
  const [state, formAction, isPending] = useActionState(
    saveTikTokApiConnectionAction,
    null as SaveTikTokApiConnectionResult | null,
  );
  const fieldPrefix = connection?.id ?? "new";

  return (
    <form
      action={formAction}
      className="space-y-4 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5"
    >
      {connection ? (
        <input type="hidden" name="connection_id" value={connection.id} />
      ) : null}

      <ConnectionHeader connection={connection} />
      <ConnectionFields connection={connection} fieldPrefix={fieldPrefix} />

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
        {isPending ? "保存中…" : connection ? "接続設定を更新" : "接続設定を追加"}
      </button>
    </form>
  );
}

function ConnectionHeader({
  connection,
}: {
  connection?: TikTokApiConnectionRow;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-zinc-100">
        {connection ? `ショップ ${connection.shop_id}` : "新規 API 接続"}
      </h2>
      <p className="mt-1 text-xs text-zinc-500">
        {connection
          ? `最終同期: ${formatTimestamp(connection.last_synced_at)}`
          : "TikTok Shop API の認証情報を登録します"}
      </p>
    </div>
  );
}

function ConnectionCard({ connection }: { connection: TikTokApiConnectionRow }) {
  const [isPending, startTransition] = useTransition();
  const [deleteMessage, setDeleteMessage] =
    useState<SaveTikTokApiConnectionResult | null>(null);

  return (
    <section className="space-y-3">
      <ConnectionForm connection={connection} />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            startTransition(async () => {
              const result = await deleteTikTokApiConnectionAction(connection.id);
              setDeleteMessage(result);
            });
          }}
          className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-200 disabled:opacity-50"
        >
          {isPending ? "削除中…" : "この接続を削除"}
        </button>
        {deleteMessage?.ok ? (
          <p className="text-sm text-emerald-300">{deleteMessage.message}</p>
        ) : null}
        {deleteMessage && !deleteMessage.ok ? (
          <p className="text-sm text-red-300">{deleteMessage.error}</p>
        ) : null}
      </div>
    </section>
  );
}

export function ApiConnectionsClient({ connections }: Props) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-white/[0.06] bg-surface-1/40 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">TikTokショップ接続</h2>
            <p className="mt-1 text-xs text-zinc-500">
              OAuth 認証で access_token / refresh_token と shop 情報を取得し、接続設定へ保存します。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href="/api/tiktok/auth"
              className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-[var(--accent-cyan)]/30 bg-[var(--accent-cyan)]/10 px-4 py-2 text-sm font-semibold text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/15"
            >
              TikTokショップ接続
            </a>
            <a
              href="/admin/api-connections?oauth_debug=1"
              className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-white/[0.08] px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-white/[0.04]"
            >
              認証情報デバッグ
            </a>
          </div>
        </div>
      </div>
      <ConnectionForm />
      {connections.length === 0 ? (
        <p className="rounded-xl border border-white/[0.06] bg-surface-1/40 px-4 py-6 text-center text-sm text-zinc-500">
          登録済みの API 接続はまだありません。
        </p>
      ) : (
        <div className="space-y-6">
          {connections.map((connection) => (
            <ConnectionCard key={connection.id} connection={connection} />
          ))}
        </div>
      )}
    </div>
  );
}
