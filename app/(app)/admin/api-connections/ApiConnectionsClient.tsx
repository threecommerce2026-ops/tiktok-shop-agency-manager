"use client";

import {
  deleteTikTokApiConnectionAction,
  saveTikTokApiConnectionAction,
  type SaveTikTokApiConnectionResult,
} from "@/app/actions/tiktok-api-connections";
import type { TikTokApiConnectionSummary } from "@/lib/db/tiktok-api-connection-queries";
import {
  connectionStatusLabel,
  isCredentialDebugEnabled,
  resolveConnectionStatus,
  secretPresenceLabel,
} from "@/lib/tiktok/secret-display";
import { useActionState, useState, useTransition } from "react";

type Props = {
  connections: TikTokApiConnectionSummary[];
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

function SecretBadge({ present }: { present: boolean }) {
  return (
    <span
      className={
        present
          ? "rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-200"
          : "rounded-full border border-zinc-600/40 bg-zinc-600/10 px-2 py-0.5 text-[10px] font-medium text-zinc-400"
      }
    >
      {secretPresenceLabel(present)}
    </span>
  );
}

function SecretField({
  fieldPrefix,
  name,
  label,
  present,
  isNew,
}: {
  fieldPrefix: string;
  name: "app_secret" | "access_token" | "refresh_token";
  label: string;
  present: boolean;
  isNew: boolean;
}) {
  const id = `${fieldPrefix}-${name}`;
  return (
    <div>
      <div className="flex items-center gap-2">
        <label className={labelClass} htmlFor={id}>
          {label}
        </label>
        {isNew ? null : <SecretBadge present={present} />}
      </div>
      <input
        id={id}
        name={name}
        type="password"
        autoComplete="new-password"
        defaultValue=""
        required={isNew && name !== "refresh_token"}
        placeholder={
          isNew ? "値を入力" : "変更する場合のみ入力（空欄なら現在の値を維持）"
        }
        className={inputClass}
      />
    </div>
  );
}

function ConnectionFields({
  connection,
  fieldPrefix,
}: {
  connection?: TikTokApiConnectionSummary;
  fieldPrefix: string;
}) {
  const isNew = !connection;
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
      <SecretField
        fieldPrefix={fieldPrefix}
        name="app_secret"
        label="app_secret"
        present={connection?.has_app_secret ?? false}
        isNew={isNew}
      />
      <SecretField
        fieldPrefix={fieldPrefix}
        name="access_token"
        label="access_token"
        present={connection?.has_access_token ?? false}
        isNew={isNew}
      />
      <SecretField
        fieldPrefix={fieldPrefix}
        name="refresh_token"
        label="refresh_token"
        present={connection?.has_refresh_token ?? false}
        isNew={isNew}
      />
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
  connection?: TikTokApiConnectionSummary;
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

function ConnectionStatusBadge({
  connection,
}: {
  connection: TikTokApiConnectionSummary;
}) {
  const status = resolveConnectionStatus({
    hasAccessToken: connection.has_access_token,
    tokenExpiredAt: connection.token_expired_at,
  });
  const className =
    status === "connected"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
      : status === "token_expired"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
        : "border-zinc-600/40 bg-zinc-600/10 text-zinc-400";

  return (
    <span
      className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${className}`}
    >
      {connectionStatusLabel(status)}
    </span>
  );
}

function ConnectionHeader({
  connection,
}: {
  connection?: TikTokApiConnectionSummary;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-zinc-100">
          {connection ? `ショップ ${connection.shop_id}` : "新規 API 接続"}
        </h2>
        {connection ? <ConnectionStatusBadge connection={connection} /> : null}
        {connection ? (
          <span
            className={
              connection.is_active
                ? "rounded-full border border-white/[0.08] px-2 py-0.5 text-[10px] text-zinc-300"
                : "rounded-full border border-white/[0.08] px-2 py-0.5 text-[10px] text-zinc-500"
            }
          >
            {connection.is_active ? "同期対象" : "同期対象外"}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        {connection
          ? `トークン期限: ${formatTimestamp(connection.token_expired_at)} / 最終同期: ${formatTimestamp(connection.last_synced_at)}`
          : "TikTok Shop API の認証情報を登録します"}
      </p>
      {connection ? (
        <p className="mt-1 text-[11px] text-zinc-600">
          秘密情報は表示されません。設定状況のみ表示しています。
        </p>
      ) : null}
    </div>
  );
}

function ConnectionCard({
  connection,
}: {
  connection: TikTokApiConnectionSummary;
}) {
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
            {isCredentialDebugEnabled() ? (
              <a
                href="/admin/api-connections?oauth_debug=1"
                className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-white/[0.08] px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-white/[0.04]"
              >
                認証情報デバッグ（開発環境のみ）
              </a>
            ) : null}
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
