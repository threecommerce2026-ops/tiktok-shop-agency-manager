"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import {
  createCreatorAliasAction,
  deleteCreatorAliasAction,
  type CreatorAliasActionResult,
} from "@/app/actions/creator-aliases";
import { findChainedAliases, type CreatorAliasRecord } from "@/lib/orders/creator-alias";

/*
  クリエイター改名の管理画面（親管理者専用）。

  ■ 誤登録の危険を必ず見せる
  別人を同一人物として登録すると、別人の注文が1つの明細に統合される。
  登録・削除の両方で何が起きるかを明示する。

  ■ 変更は「削除 → 再登録」
  既存の別名を直接書き換えると、寄せ先がいつ変わったのか追えなくなる。
  誤統合のリスクが高いので inline 編集は用意しない。
*/

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";
const td = "whitespace-nowrap px-3 py-2 text-xs";

const input =
  "mt-1 w-full rounded-lg border border-white/[0.1] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]";

function Banner({ state }: { state: CreatorAliasActionResult | null }) {
  if (!state) return null;
  return (
    <p
      className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
        state.ok
          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
          : "border-red-500/25 bg-red-500/10 text-red-200"
      }`}
      role="status"
    >
      {state.ok ? state.message : state.error}
    </p>
  );
}

export function CreatorAliasesClient({
  aliases,
  loadError,
  migrationMissing,
}: {
  aliases: CreatorAliasRecord[];
  loadError: string | null;
  migrationMissing: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [createState, createAction, createPending] = useActionState(
    createCreatorAliasAction,
    null as CreatorAliasActionResult | null,
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteCreatorAliasAction,
    null as CreatorAliasActionResult | null,
  );

  const chained = findChainedAliases(aliases);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          クリエイター改名の管理
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
          TikTok のユーザー名が変わると、同じ注文明細でも明細キーが変わり、
          Excel を取り込んだときに
          <span className="font-semibold text-zinc-300">二重登録</span>
          されます。旧名をここに登録しておくと、取込時に正式名へ寄せてから
          キーを作るため二重登録が起きません。
        </p>
        <p className="mt-2 text-xs text-zinc-600">
          取込済みの注文データはこの画面では変更されません。適用されるのは次回以降の取込です。
        </p>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {loadError}
        </div>
      ) : null}

      {migrationMissing ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <p className="font-semibold">別名テーブルが未作成です</p>
          <p className="mt-1 text-[11px]">
            supabase/migrations/20260926100000_creator_tiktok_aliases.sql を適用してください。
            適用するまで別名は登録できず、取込は従来どおりの動作になります。
          </p>
        </div>
      ) : null}

      <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 text-[11px] leading-relaxed text-amber-100">
        <p className="font-semibold">登録前に必ず確認してください</p>
        <p className="mt-1">
          別人のユーザー名を登録すると、
          <span className="font-semibold">別人の注文が同一人物の明細として統合されます。</span>
          同一人物であることを TikTok 側で確認してから登録してください。
          いったん取り込んだ後に気付くと、明細の切り分けが困難になります。
        </p>
      </div>

      <Banner state={createState} />
      <Banner state={deleteState} />

      {/* ---------------- 新規登録 ---------------- */}
      <form
        action={createAction}
        className="space-y-4 rounded-2xl border border-white/[0.08] bg-surface-1/50 p-5 sm:p-6"
      >
        <h2 className="text-sm font-semibold text-zinc-200">別名を登録</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-[11px] font-medium text-zinc-400" htmlFor="alias_tiktok_id">
              旧ユーザー名（改名前）
            </label>
            <input
              id="alias_tiktok_id"
              name="alias_tiktok_id"
              required
              autoComplete="off"
              placeholder="kanyaselect_jp"
              className={input}
            />
            <p className="mt-1 text-[11px] text-zinc-600">
              Excel に出てくる方のユーザー名。前後の空白・大文字・先頭の @ は自動で整えます。
            </p>
          </div>

          <div>
            <label
              className="text-[11px] font-medium text-zinc-400"
              htmlFor="canonical_tiktok_id"
            >
              正式なユーザー名（寄せ先）
            </label>
            <input
              id="canonical_tiktok_id"
              name="canonical_tiktok_id"
              required
              autoComplete="off"
              placeholder="kanyatoyselect_jp"
              className={input}
            />
            <p className="mt-1 text-[11px] text-zinc-600">
              既に取り込み済みの明細で使われている方を指定します。
            </p>
          </div>
        </div>

        <div>
          <label className="text-[11px] font-medium text-zinc-400" htmlFor="note">
            メモ（任意）
          </label>
          <input
            id="note"
            name="note"
            autoComplete="off"
            placeholder="2026-07 のExcelで改名を確認"
            className={input}
          />
        </div>

        <button
          type="submit"
          disabled={createPending || migrationMissing}
          className="min-h-[44px] rounded-lg bg-[var(--accent-cyan)] px-5 text-sm font-semibold text-black disabled:opacity-50"
        >
          {createPending ? "登録中…" : "別名を登録する"}
        </button>
      </form>

      {/* ---------------- 連鎖の注意 ---------------- */}
      {chained.length > 0 ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[11px] leading-relaxed text-amber-100">
          <p className="font-semibold">連鎖している別名があります</p>
          <ul className="mt-2 space-y-1 font-mono">
            {chained.map((item) => (
              <li key={item.alias}>
                {item.alias} → {item.via} → {item.canonical}
              </li>
            ))}
          </ul>
          <p className="mt-2">
            取込時は最終的な寄せ先まで自動でたどります。分かりにくい場合は、
            直接の寄せ先へ登録し直すことを推奨します。
          </p>
        </div>
      ) : null}

      {/* ---------------- 一覧 ---------------- */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-200">
          登録済みの別名（{aliases.length}）
        </h2>

        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
          <table className="min-w-[840px] w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>旧ユーザー名</th>
                <th className={th}>正式なユーザー名</th>
                <th className={th}>メモ</th>
                <th className={th}>登録者</th>
                <th className={th}>登録日時</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {aliases.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-zinc-500">
                    登録されている別名はありません。
                  </td>
                </tr>
              ) : (
                aliases.map((alias) => (
                  <tr key={alias.aliasTiktokId} className="border-b border-zinc-800/70 align-top">
                    <td className={`${td} font-mono text-zinc-100`}>
                      {alias.aliasTiktokId}
                    </td>
                    <td className={`${td} font-mono text-[var(--accent-cyan)]`}>
                      {alias.canonicalTiktokId}
                    </td>
                    <td className={`${td} whitespace-normal text-zinc-400`}>
                      {alias.note ?? "—"}
                    </td>
                    <td className={`${td} text-zinc-500`}>
                      {alias.createdByEmail ?? "—"}
                    </td>
                    <td className={`${td} font-mono text-zinc-500`}>
                      {alias.createdAt ? alias.createdAt.slice(0, 19).replace("T", " ") : "—"}
                    </td>
                    <td className={`${td} whitespace-normal`}>
                      {confirmDelete === alias.aliasTiktokId ? (
                        <form action={deleteAction} className="space-y-2">
                          <input
                            type="hidden"
                            name="alias_tiktok_id"
                            value={alias.aliasTiktokId}
                          />
                          <p className="max-w-xs rounded-lg border border-red-400/25 bg-red-400/10 px-2 py-1.5 text-[11px] leading-relaxed text-red-100">
                            このaliasを削除すると、今後のExcel再取込で同一注文が別明細として
                            登録される可能性があります。
                          </p>
                          <div className="flex gap-2">
                            <button
                              type="submit"
                              disabled={deletePending}
                              className="min-h-[32px] rounded-lg border border-red-400/30 px-3 text-[11px] font-medium text-red-200 hover:bg-red-400/10 disabled:opacity-50"
                            >
                              削除する
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDelete(null)}
                              className="min-h-[32px] rounded-lg border border-white/[0.12] px-3 text-[11px] text-zinc-300 hover:bg-white/[0.06]"
                            >
                              やめる
                            </button>
                          </div>
                        </form>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(alias.aliasTiktokId)}
                          className="min-h-[32px] rounded-lg border border-white/[0.12] px-3 text-[11px] text-zinc-400 hover:bg-white/[0.06]"
                        >
                          削除
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] leading-relaxed text-zinc-500">
          寄せ先を変更したい場合は、いったん削除してから登録し直してください。
          直接の書き換えは、いつ寄せ先が変わったのかを追えなくなるため用意していません。
        </p>
      </section>

      <Link
        href="/admin/affiliate-orders-import"
        className="inline-block text-sm font-medium text-[var(--accent-cyan)] hover:underline"
      >
        → アフィリエイト注文Excel取込へ
      </Link>
    </div>
  );
}
