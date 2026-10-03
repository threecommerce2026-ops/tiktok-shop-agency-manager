"use client";

import { useMemo, useState, useTransition } from "react";

import {
  confirmCreatorMonthlyAccountTypesAction,
  loadCreatorMonthlyAccountTypeAction,
  resetCreatorMonthlyAccountTypeAction,
  type MonthlyAccountTypeActionResult,
} from "@/app/actions/creator-monthly-account-type";
import {
  ACCOUNT_MANAGEMENT_TYPE_OPTIONS,
  accountManagementTypeLabel,
} from "@/lib/creators/account-management-type";
import {
  ACCOUNT_TYPE_SOURCE_LABEL,
  type AccountManagementTypeSource,
} from "@/lib/creators/monthly-account-management-type";
import {
  buildPlannedTypeChanges,
  eligibilityChangingTypeChanges,
  reconfirmedTypeChanges,
  type MonthlyAccountTypeDraft,
} from "@/lib/creators/monthly-account-type-draft";
import type { CreatorMonthlyAccountTypeData } from "@/lib/db/creator-monthly-account-type-queries";
import { formatYenPrecise } from "@/lib/revenue/calc";

/*
  月別区分の確認・確定パネル。

  ■ 何を書き込むか
  creator_monthly_account_management_types（対象月の確定区分）だけ。
  クリエイターの現在区分（creators.account_management_type）は変更しない。
  紹介者 / 月別所属 / 紹介報酬 / payout は一切触らない。

  ■ 保存経路
  独自の UPDATE は持たない。
    confirmCreatorMonthlyAccountTypesAction
      → lib/creators/confirm-monthly-account-types.ts
      → set_creator_monthly_account_management_type RPC
  支払済みのブロックも履歴
  （creator_monthly_account_management_type_logs）もそちらが持っている。

  ■ 紹介報酬は自動で再計算しない
  区分を確定しても referral_reward_items は変わらない。
  区分変更 → dry-run → 差分確認 → 管理者承認 → sync の順序を保つため、
  ここでは「再集計が必要」と伝えるだけにする。

  ■ 保存後の表示
  クライアント側で数え直さず、必ず DB から読み直す。
*/

const SOURCE_CLASS: Record<AccountManagementTypeSource, string> = {
  monthly: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  current: "border-amber-400/25 bg-amber-400/10 text-amber-200",
};

const thBase =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";

const td = "whitespace-nowrap px-3 py-2 text-xs";

export function AccountTypeSourceBadge({
  source,
}: {
  source: AccountManagementTypeSource;
}) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] ${SOURCE_CLASS[source]}`}
    >
      {ACCOUNT_TYPE_SOURCE_LABEL[source]}
    </span>
  );
}

export function MonthlyAccountTypePanel({
  data: initialData,
  onClose,
  onSaved,
}: {
  data: CreatorMonthlyAccountTypeData;
  onClose?: () => void;
  /** 保存が成功したあと、呼び出し側の集計を DB から読み直させる */
  onSaved?: () => void;
}) {
  const [data, setData] = useState(initialData);
  const [draft, setDraft] = useState<MonthlyAccountTypeDraft>({});
  const [bulkType, setBulkType] = useState("");
  const [stage, setStage] = useState<"edit" | "confirm">("edit");
  const [banner, setBanner] = useState<MonthlyAccountTypeActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const changes = useMemo(
    () => buildPlannedTypeChanges(data.rows, draft),
    [data.rows, draft],
  );
  const reconfirmed = useMemo(() => reconfirmedTypeChanges(changes), [changes]);
  const eligibilityChanging = useMemo(
    () => eligibilityChangingTypeChanges(changes),
    [changes],
  );

  const unconfirmedMonths = data.rows.filter(
    (row) => row.monthlyType === null && !row.hasPaidReward,
  );

  function setMonth(month: string, type: string) {
    setDraft((prev) => ({ ...prev, [month]: type }));
    setStage("edit");
  }

  /** 入力欄を埋めるだけ。DB へは書き込まない */
  function fillUnconfirmed() {
    if (!bulkType) return;
    setDraft((prev) => {
      const next = { ...prev };
      for (const row of unconfirmedMonths) next[row.targetMonth] = bulkType;
      return next;
    });
    setStage("edit");
  }

  /** 保存後・解除後は必ず DB から読み直す（画面だけ更新しない） */
  async function reload() {
    const result = await loadCreatorMonthlyAccountTypeAction(data.creatorId);
    if (result.ok) {
      setData(result.data);
      setDraft({});
      setStage("edit");
    }
    onSaved?.();
  }

  function submit() {
    startTransition(async () => {
      const formData = new FormData();
      for (const change of changes) {
        formData.append(
          "entries",
          `${data.creatorId}|${change.targetMonth}|${change.accountManagementType}`,
        );
      }
      const result = await confirmCreatorMonthlyAccountTypesAction(null, formData);
      setBanner(result);
      if (result.ok) await reload();
    });
  }

  function reset(targetMonth: string) {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("creator_id", data.creatorId);
      formData.set("target_month", targetMonth);
      const result = await resetCreatorMonthlyAccountTypeAction(null, formData);
      setBanner(result);
      if (result.ok) await reload();
    });
  }

  return (
    <div className="space-y-4 rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-zinc-100">
            {data.creatorName}
            <span className="ml-2 font-mono text-xs text-zinc-500">
              {data.tiktokId}
            </span>
          </p>
          <p className="mt-1 text-[11px] text-zinc-500">
            現在区分:{" "}
            <span className="text-zinc-300">
              {accountManagementTypeLabel(data.currentType)}
            </span>
            <span className="ml-2 text-zinc-600">
              ※ このパネルでは現在区分は変更しません
            </span>
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            閉じる
          </button>
        ) : null}
      </div>

      <p className="rounded-lg border border-white/[0.08] bg-surface-0/50 px-3 py-2 text-[11px] leading-relaxed text-zinc-400">
        区分は紹介報酬5%が発生しうるかを決めます（通常のみ対象）。
        区分の変更は過去月へ遡及しません。月別確定がある月は、
        あとから現在区分を変えても動きません。
        未確定の月は現在区分で暫定判定しているため、現在区分を変えると
        その月の判定も変わります。
      </p>

      {data.error ? (
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          {data.error}
        </p>
      ) : null}

      {banner ? (
        <p
          className={`rounded-lg border px-3 py-2 text-xs ${
            banner.ok
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/25 bg-red-500/10 text-red-200"
          }`}
          role="status"
        >
          {banner.ok ? banner.message : banner.error}
        </p>
      ) : null}

      {data.rows.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 py-6 text-center text-xs text-zinc-500">
          対象となる実績月がありません。
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr>
                  <th className={thBase}>対象月</th>
                  <th className={thBase}>いまの区分</th>
                  <th className={thBase}>確定状態</th>
                  <th className={thBase}>紹介報酬</th>
                  <th className={thBase}>この月の区分</th>
                  <th className={`${thBase} text-right`}>算定元(W+X)</th>
                  <th className={`${thBase} text-right`}>報酬実績</th>
                  <th className={thBase}>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const selected = draft[row.targetMonth] ?? "";
                  const willChange =
                    selected !== "" && selected !== row.monthlyType;
                  return (
                    <tr
                      key={row.targetMonth}
                      className={`border-b border-zinc-800/60 ${
                        willChange ? "bg-violet-400/[0.06]" : ""
                      }`}
                    >
                      <td className={`${td} font-mono text-zinc-200`}>
                        {row.targetMonth}
                      </td>
                      <td className={`${td} text-zinc-300`}>
                        {accountManagementTypeLabel(row.effectiveType)}
                      </td>
                      <td className={td}>
                        <AccountTypeSourceBadge source={row.source} />
                      </td>
                      <td className={td}>
                        {row.referralEligible ? (
                          <span className="text-[11px] text-emerald-300">対象</span>
                        ) : (
                          <span className="text-[11px] text-zinc-500">対象外</span>
                        )}
                      </td>
                      <td className={td}>
                        {row.hasPaidReward ? (
                          <span className="text-[11px] text-amber-200/80">
                            支払済のため変更不可
                          </span>
                        ) : (
                          <select
                            aria-label={`${row.targetMonth} の区分`}
                            value={selected}
                            onChange={(e) =>
                              setMonth(row.targetMonth, e.target.value)
                            }
                            className="w-44 rounded-lg border border-white/[0.08] bg-surface-1 px-2 py-1 text-xs text-zinc-100"
                          >
                            <option value="">（変更しない）</option>
                            {ACCOUNT_MANAGEMENT_TYPE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-300`}>
                        {formatYenPrecise(row.referralBase)}
                        <span className="ml-1 text-[10px] text-zinc-600">
                          /{row.lineCount}件
                        </span>
                      </td>
                      <td className={`${td} text-right font-mono text-zinc-300`}>
                        {row.rewardItemCount === 0
                          ? "—"
                          : formatYenPrecise(row.rewardAmount)}
                      </td>
                      <td className={td}>
                        {row.hasPaidReward ? (
                          <span className="text-[11px] text-zinc-600">—</span>
                        ) : row.monthlyType ? (
                          <button
                            type="button"
                            onClick={() => reset(row.targetMonth)}
                            disabled={isPending}
                            className="rounded border border-white/[0.1] px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-white/[0.06] disabled:opacity-50"
                          >
                            確定を解除
                          </button>
                        ) : (
                          <span className="text-[11px] text-zinc-600">未確定</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {unconfirmedMonths.length > 0 ? (
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/[0.08] bg-surface-0/50 p-3">
              <div>
                <label
                  htmlFor={`bulk-type-${data.creatorId}`}
                  className="text-[11px] font-medium text-zinc-500"
                >
                  未確定の {unconfirmedMonths.length} ヶ月をまとめて選ぶ
                </label>
                <select
                  id={`bulk-type-${data.creatorId}`}
                  value={bulkType}
                  onChange={(e) => setBulkType(e.target.value)}
                  className="mt-1 w-52 rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
                >
                  <option value="">選択してください</option>
                  {ACCOUNT_MANAGEMENT_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={fillUnconfirmed}
                disabled={!bulkType}
                className="min-h-[40px] rounded-lg border border-white/[0.14] px-3 text-xs text-zinc-200 transition hover:bg-white/[0.06] disabled:opacity-40"
              >
                未確定月の選択欄を埋める
              </button>
              <p className="text-[11px] text-zinc-600">
                この操作は入力欄を埋めるだけで、まだ保存しません。
              </p>
            </div>
          ) : null}

          <div className="space-y-3 rounded-lg border border-white/[0.08] bg-surface-0/50 p-3">
            {stage === "edit" ? (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setStage("confirm")}
                  disabled={changes.length === 0}
                  className="min-h-[40px] rounded-lg border border-white/[0.18] px-4 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-40"
                >
                  変更内容を確認
                </button>
                <p className="text-[11px] text-zinc-500">
                  {changes.length === 0
                    ? "変更する月がありません。"
                    : `${changes.length} ヶ月を変更します。`}
                </p>
              </div>
            ) : (
              <>
                <p className="text-xs font-semibold text-zinc-100">
                  この内容で月別区分を確定しますか？
                </p>

                <ul className="space-y-1">
                  {changes.map((change) => (
                    <li
                      key={change.targetMonth}
                      className="flex flex-wrap items-center gap-2 text-[11px]"
                    >
                      <span className="font-mono text-zinc-200">
                        {change.targetMonth}
                      </span>
                      <span className="text-zinc-500">
                        {change.previousLabel ??
                          `${accountManagementTypeLabel(change.effectiveType)}（暫定）`}
                      </span>
                      <span className="text-zinc-600">→</span>
                      <span className="font-semibold text-zinc-100">
                        {change.typeLabel}
                      </span>
                      {change.previousType ? (
                        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-amber-200">
                          確定済を変更
                        </span>
                      ) : null}
                      {change.eligibilityChanges ? (
                        <span className="rounded-full border border-red-400/30 bg-red-400/10 px-2 py-0.5 text-red-200">
                          紹介報酬の対象が変わる
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>

                {reconfirmed.length > 0 ? (
                  <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
                    すでに確定済の {reconfirmed.length} ヶ月（
                    {reconfirmed.map((change) => change.targetMonth).join(", ")}
                    ）を別の区分へ付け替えます。
                  </p>
                ) : null}

                {eligibilityChanging.length > 0 ? (
                  <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-100">
                    {eligibilityChanging
                      .map((change) => change.targetMonth)
                      .join(", ")}{" "}
                    は紹介報酬の対象・対象外が切り替わります。
                    確定しても紹介報酬は自動では変わりません。
                    差分を確認したうえで「紹介報酬の再集計」を実行してください。
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={submit}
                    disabled={isPending || changes.length === 0}
                    className="min-h-[40px] rounded-lg bg-white px-4 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-40"
                  >
                    {isPending ? "確定中…" : "この内容で月別区分を確定"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setStage("edit")}
                    disabled={isPending}
                    className="text-xs text-zinc-500 transition hover:text-zinc-300 disabled:opacity-40"
                  >
                    選択に戻る
                  </button>
                </div>
              </>
            )}

            <p className="text-[11px] leading-relaxed text-zinc-600">
              この操作は対象月の区分だけを確定します。現在区分・紹介者・月別所属は
              変更しません。紹介報酬（referral_reward_items）も自動では
              再計算しません。
            </p>
          </div>
        </>
      )}
    </div>
  );
}
