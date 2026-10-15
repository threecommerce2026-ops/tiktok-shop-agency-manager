"use client";

import { Fragment, useActionState, useState } from "react";

import {
  saveCreatorBankAccountAction,
  setCreatorLendingTermAction,
  syncCreatorLendingRewardsAction,
  type LendingActionResult,
} from "@/app/actions/creator-lending-rewards";
import type {
  CreatorBankAccountStatus,
  LendingCreatorRow,
  LendingMonthlyRow,
  LendingMonthPaymentState,
  LendingSummary,
} from "@/lib/db/creator-lending-queries";
import {
  BANK_ACCOUNT_STATE_LABEL,
  type BankAccountState,
} from "@/lib/payments/bank-account";
import { formatYen, formatYenPrecise } from "@/lib/revenue/calc";

/*
  端末貸し出し報酬タブ。

  受取人はクリエイター本人。代理店マスタは使わない。
  この画面は保存済みの creator_lending_reward_items を表示するだけで、
  金額の計算はしない（計算は lib/creators/lending-reward-engine.ts）。

  口座情報は下4桁しか表示しない。編集フォームは入力専用で、
  既存の口座番号を初期値として画面に出さない。
*/

const thBase =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";

const td = "whitespace-nowrap px-3 py-2.5 text-xs";

const inputClass =
  "min-h-[38px] w-full rounded-lg border border-white/[0.08] bg-surface-2/60 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-white/20 focus:outline-none";

const labelClass = "text-[11px] font-medium text-zinc-500";

const buttonClass =
  "min-h-[38px] rounded-lg border border-white/[0.1] bg-white/[0.06] px-4 py-2 text-xs font-semibold text-zinc-100 transition hover:bg-white/[0.1] disabled:opacity-50";

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
        {label}
      </p>
      <p className="mt-2 font-mono text-xl font-bold tracking-tight text-zinc-50">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-zinc-600">{hint}</p> : null}
    </div>
  );
}

function ResultBanner({ state }: { state: LendingActionResult | null }) {
  if (!state) return null;
  return (
    <p
      className={`rounded-lg border px-3 py-2 text-xs ${
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

/*
  月行の状態。

  未有効化  この月が端末貸し出しの対象として有効化されていない（報酬0円）
  対象外    有効化以外の理由で報酬を作れない（所属・AK・返金など）
  未計上    有効化済みだが再集計がまだ
  支払中    支払明細に組み入れ済み（claim 済み・振込前）
  未払い    支払予定はあるが未払い
  支払済    振込完了
*/
function MonthStateBadge({ row }: { row: LendingMonthlyRow }) {
  /* 計上が1件も無い月は、まず「なぜ無いのか」を出す */
  if (row.itemCount === 0) {
    const { label, className } =
      row.exclusionReason === "inactive_terms"
        ? {
            label: "未有効化",
            className: "border-amber-400/25 bg-amber-400/10 text-amber-200",
          }
        : row.exclusionReason != null
          ? { label: "対象外", className: "border-red-400/25 bg-red-400/10 text-red-200" }
          : {
              label: "未計上",
              className: "border-white/[0.08] bg-white/[0.03] text-zinc-500",
            };
    return (
      <span
        className={`rounded-full border px-2 py-0.5 text-[11px] ${className}`}
        title={row.exclusionLabel ?? "再集計すると計上されます"}
      >
        {label}
      </span>
    );
  }

  /*
    状態は明細（is_paid）と支払明細の占有だけから決める。
    支払予定テーブルの累積スナップショットは参照しない（M-3）。
  */
  const { label, className } = MONTH_STATE_STYLE[row.paymentState];

  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${className}`}>{label}</span>
  );
}

const BANK_STATE_CLASS: Record<BankAccountState, string> = {
  registered: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  incomplete: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  missing: "border-red-400/25 bg-red-400/10 text-red-200",
};

const MONTH_STATE_STYLE: Record<
  LendingMonthPaymentState,
  { label: string; className: string }
> = {
  paid: { label: "支払済", className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" },
  partial: { label: "一部支払", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" },
  in_batch: { label: "支払中", className: "border-sky-400/25 bg-sky-400/10 text-sky-300" },
  unpaid: { label: "未払い", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" },
  none: { label: "未計上", className: "border-white/[0.08] bg-white/[0.03] text-zinc-500" },
};

function formatRate(rate: number | null): string {
  if (rate == null) return "混在";
  return `${(rate * 100).toLocaleString("ja-JP", { maximumFractionDigits: 2 })}%`;
}

/** 本人×月の明細（展開したときだけ描画する） */
function CreatorDetail({
  row,
  bank,
  defaultMonth,
}: {
  row: LendingCreatorRow;
  bank: CreatorBankAccountStatus | null;
  defaultMonth: string;
}) {
  const [termState, termAction, termPending] = useActionState(
    setCreatorLendingTermAction,
    null,
  );
  const [bankState, bankAction, bankPending] = useActionState(
    saveCreatorBankAccountAction,
    null,
  );
  const [showBankForm, setShowBankForm] = useState(false);

  return (
    <tr className="border-b border-zinc-900 bg-surface-2/30">
      <td colSpan={10} className="px-3 py-4">
        <div className="space-y-4">
          {/* 月別の内訳 */}
          <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
            <table className="w-full min-w-[720px] border-collapse">
              <thead>
                <tr>
                  <th className={thBase}>対象月</th>
                  <th className={thBase}>明細</th>
                  <th className={`${thBase} text-right`}>AP</th>
                  <th className={`${thBase} text-right`}>適用分配率</th>
                  <th className={`${thBase} text-right`}>本人報酬</th>
                  <th className={`${thBase} text-right`}>自社取り分</th>
                  <th className={`${thBase} text-right`}>未払い</th>
                  <th className={thBase}>状態</th>
                  <th className={thBase}>理由 / 未計上</th>
                </tr>
              </thead>
              <tbody>
                {row.monthlyRows.map((month) => (
                  <tr key={month.targetMonth} className="border-b border-zinc-900/80">
                    <td className={`${td} font-mono text-zinc-300`}>{month.targetMonth}</td>
                    <td className={`${td} text-zinc-500`}>{month.itemCount} 件</td>
                    <td className={`${td} text-right font-mono text-zinc-300`}>
                      {formatYenPrecise(month.agencyRevenue)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {month.itemCount > 0 ? (
                        formatRate(month.splitRate)
                      ) : (
                        /* 計上前は「いま設定されている率」を予定として出す */
                        <span
                          className="text-zinc-500"
                          title="まだ計上されていないため、設定値を表示しています"
                        >
                          {month.effectiveSplitRate == null
                            ? "設定不正"
                            : `${formatRate(month.effectiveSplitRate)} 予定`}
                        </span>
                      )}
                    </td>
                    <td className={`${td} text-right font-mono font-semibold text-zinc-50`}>
                      {formatYenPrecise(month.rewardAmount)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {formatYenPrecise(month.selfShareAmount)}
                    </td>
                    <td className={`${td} text-right font-mono text-amber-200`}>
                      {formatYenPrecise(month.unpaidAmount)}
                    </td>
                    <td className={td}>
                      <MonthStateBadge row={month} />
                    </td>
                    {/* 計上されていない理由と、その対象になっている AP */}
                    <td className="whitespace-normal px-3 py-2.5 text-[11px] text-zinc-500">
                      {month.exclusionLabel ? (
                        <span className="text-amber-200">
                          {month.exclusionLabel}
                          {month.pendingLineCount > 0
                            ? `（${month.pendingLineCount} 明細 / AP ${formatYenPrecise(
                                month.pendingAgencyRevenue,
                              )}）`
                            : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 分配率の個別設定 */}
          <form action={termAction} className="rounded-xl border border-white/[0.06] p-4">
            <input type="hidden" name="creator_id" value={row.creatorId} />
            <p className="text-xs font-semibold text-zinc-300">分配率の設定（本人×対象月）</p>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
              空欄にすると既定の 80% が適用されます。0 より大きく 1 以下の小数で入力してください（80%
              なら 0.8）。設定しただけでは金額は変わりません。対象月を再集計すると反映されます。
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <label className="space-y-1">
                <span className={labelClass}>対象月</span>
                <input
                  type="month"
                  name="target_month"
                  defaultValue={defaultMonth}
                  required
                  className={inputClass}
                />
              </label>
              <label className="space-y-1">
                <span className={labelClass}>分配率（空欄=既定80%）</span>
                <input
                  type="text"
                  name="split_rate"
                  inputMode="decimal"
                  placeholder="0.8"
                  className={inputClass}
                />
              </label>
              <label className="space-y-1">
                <span className={labelClass}>この月を対象にする</span>
                <select name="is_active" defaultValue="true" className={inputClass}>
                  <option value="true">有効</option>
                  <option value="false">無効（報酬を作らない）</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className={labelClass}>備考</span>
                <input type="text" name="note" maxLength={500} className={inputClass} />
              </label>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button type="submit" disabled={termPending} className={buttonClass}>
                {termPending ? "保存中..." : "分配率を保存"}
              </button>
              <ResultBanner state={termState} />
            </div>
          </form>

          {/* 振込先（管理者のみ・下4桁のみ表示） */}
          <div className="rounded-xl border border-white/[0.06] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-zinc-300">振込先</p>
                <p className="mt-1 text-[11px] text-zinc-600">
                  {bank?.registered
                    ? `${BANK_ACCOUNT_STATE_LABEL[row.bankState]}: ${bank.bankName ?? "—"} / ${
                        bank.bankBranchName ?? "—"
                      } / ${bank.bankAccountHolder ?? "—"} / 口座番号 ****${
                        bank.accountNumberTail ?? ""
                      }`
                    : "未登録です。登録するまで支払明細を作成できません。"}
                </p>
                {row.bankState !== "registered" ? (
                  <p className="mt-1 text-[11px] text-amber-200">
                    振込に必要な項目（銀行名 / 銀行コード / 支店名 / 支店コード / 口座種別 /
                    口座番号 / 口座名義）がすべて揃うまで支払明細を作成できません。
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setShowBankForm((value) => !value)}
                className={buttonClass}
              >
                {showBankForm ? "閉じる" : bank?.registered ? "振込先を変更" : "振込先を登録"}
              </button>
            </div>

            {showBankForm ? (
              <form action={bankAction} className="mt-3 space-y-3">
                <input type="hidden" name="creator_id" value={row.creatorId} />
                {/*
                  既存の口座番号を初期値に入れない。
                  画面に全桁を出さないため、変更時は全項目を再入力する。
                */}
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="space-y-1">
                    <span className={labelClass}>銀行名</span>
                    <input type="text" name="bank_name" required maxLength={100} className={inputClass} />
                  </label>
                  <label className="space-y-1">
                    <span className={labelClass}>銀行コード（4桁・必須）</span>
                    <input
                      type="text"
                      name="bank_code"
                      required
                      inputMode="numeric"
                      pattern="\\d{4}"
                      className={inputClass}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className={labelClass}>支店名</span>
                    <input
                      type="text"
                      name="bank_branch_name"
                      required
                      maxLength={100}
                      className={inputClass}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className={labelClass}>支店コード（3桁・必須）</span>
                    <input
                      type="text"
                      name="bank_branch_code"
                      required
                      inputMode="numeric"
                      pattern="\\d{3}"
                      className={inputClass}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className={labelClass}>口座種別</span>
                    <select name="bank_account_type" defaultValue="普通" className={inputClass}>
                      <option value="普通">普通</option>
                      <option value="当座">当座</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className={labelClass}>口座番号（数字のみ）</span>
                    <input
                      type="text"
                      name="bank_account_number"
                      required
                      inputMode="numeric"
                      autoComplete="off"
                      className={inputClass}
                    />
                  </label>
                  <label className="space-y-1 sm:col-span-2">
                    <span className={labelClass}>口座名義</span>
                    <input
                      type="text"
                      name="bank_account_holder"
                      required
                      maxLength={100}
                      className={inputClass}
                    />
                  </label>
                </div>
                <div className="flex items-center gap-3">
                  <button type="submit" disabled={bankPending} className={buttonClass}>
                    {bankPending ? "保存中..." : "振込先を保存"}
                  </button>
                  <ResultBanner state={bankState} />
                </div>
                {bank?.updatedAt ? (
                  <p className="text-[11px] text-zinc-600">
                    最終更新 {new Date(bank.updatedAt).toLocaleString("ja-JP")}
                    {bank.updatedByEmail ? `（${bank.updatedByEmail}）` : ""}
                  </p>
                ) : null}
              </form>
            ) : null}
          </div>
        </div>
      </td>
    </tr>
  );
}

export function LendingRewardTabClient({
  summary,
  bankStatuses,
  bankError,
  defaultMonth,
  year,
}: {
  summary: LendingSummary;
  bankStatuses: CreatorBankAccountStatus[];
  bankError: string | null;
  defaultMonth: string;
  year: string;
}) {
  const [syncState, syncAction, syncPending] = useActionState(
    syncCreatorLendingRewardsAction,
    null,
  );
  const [openCreatorId, setOpenCreatorId] = useState<string | null>(null);

  const bankByCreator = new Map(bankStatuses.map((item) => [item.creatorId, item]));

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-white/[0.06] bg-surface-1/40 p-4 text-xs leading-relaxed text-zinc-500">
        <p className="font-semibold text-zinc-300">端末貸し出し報酬（受取人はクリエイター本人）</p>
        <p className="mt-2">
          管理区分が「アカウント貸し出し」かつ 所属が自社（THREE.inc）かつ AK（エージェンシー分配率）が
          100% のクリエイターが対象です。AP「エージェンシーの収益総額」を原資に、
          <span className="text-zinc-300">本人へ AP × 分配率（既定 80%）</span>、
          <span className="text-zinc-300">THREE.inc へ AP − 本人報酬</span> を計上します。
        </p>
        <p className="mt-2">
          所属と AK は変更しません。紹介者報酬5%の対象外です。支払先はクリエイター本人で、
          代理店マスタへの登録は行いません。支払いは
          <span className="text-zinc-300">支払管理（受取種別「クリエイター」）</span>で処理します。
        </p>
      </div>

      {/*
        migration 未適用の案内（M-5）。
        生の DB エラー（relation ... does not exist）を出さず、
        何を適用すればよいかを示す。
      */}
      {summary.tableMissing ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-100">
          <span className="font-semibold">端末貸し出し報酬のテーブルが未作成です。</span>
          <br />
          supabase/migrations/20261010100000_creator_lending_reward_tables.sql
          から順に適用してください。適用までこのタブの一覧と支払候補は表示されません
          （既存の代理店報酬・紹介者報酬には影響しません）。
        </div>
      ) : null}

      {summary.error ? (
        <p className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {summary.error}
        </p>
      ) : null}

      {/*
        未計上の人月がある場合の手順案内。
        初回は全員が未有効化なので、ここから何をすればよいかが分かるようにする。
      */}
      {summary.totals.pendingMonthCount > 0 ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-100">
          <span className="font-semibold">
            未計上の人月が {summary.totals.pendingMonthCount} 件あります（AP{" "}
            {formatYenPrecise(summary.totals.pendingAgencyRevenue)}）。
          </span>
          <br />
          対象のクリエイターの行を開き、対象月の分配率を保存して有効化してから「報酬を再集計」を実行してください。
          理由が「有効化されていません」以外の場合は、その理由を解消しないと計上されません。
        </div>
      ) : null}
      {bankError ? (
        <p className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          振込先の読み込みに失敗しました: {bankError}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="対象クリエイター"
          value={`${summary.totals.creatorCount} 名`}
          hint={`計上済み ${summary.totals.activatedCreatorCount} 名 / 明細 ${summary.totals.itemCount.toLocaleString(
            "ja-JP",
          )} 件`}
        />
        <Kpi
          label="AP 合計"
          value={formatYen(summary.totals.agencyRevenue)}
          hint={`${year} 年の対象明細`}
        />
        <Kpi
          label="本人報酬"
          value={formatYenPrecise(summary.totals.rewardAmount)}
          hint={`既定分配率 ${Math.round(summary.defaultSplitRate * 100)}%`}
        />
        <Kpi
          label="自社取り分"
          value={formatYenPrecise(summary.totals.selfShareAmount)}
          hint={`未払い ${formatYenPrecise(summary.totals.unpaidAmount)}`}
        />
        <Kpi
          label="未計上 AP"
          value={formatYenPrecise(summary.totals.pendingAgencyRevenue)}
          hint={`${summary.totals.pendingMonthCount} 人月が未計上（有効化と再集計で計上されます）`}
        />
      </div>

      {/* 再集計 */}
      <form
        action={syncAction}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-white/[0.06] bg-surface-1/40 p-4"
      >
        <input type="hidden" name="year" value={year} />
        <label className="space-y-1">
          <span className={labelClass}>対象月</span>
          <input
            type="month"
            name="target_month"
            defaultValue={defaultMonth}
            className={inputClass}
          />
        </label>
        <label className="space-y-1">
          <span className={labelClass}>範囲</span>
          <select name="scope" defaultValue="month" className={inputClass}>
            <option value="month">指定した月だけ</option>
            <option value="year">{year} 年の全月</option>
          </select>
        </label>
        <button type="submit" disabled={syncPending} className={buttonClass}>
          {syncPending ? "再集計中..." : "報酬を再集計"}
        </button>
        <ResultBanner state={syncState} />
      </form>

      {/* 対象クリエイター一覧 */}
      <div className="overflow-x-auto rounded-2xl border border-white/[0.07]">
        <table className="w-full min-w-[960px] border-collapse">
          <thead>
            <tr>
              <th className={thBase}>クリエイター</th>
              <th className={thBase}>所属</th>
              <th className={thBase}>有効化</th>
              <th className={`${thBase} text-right`}>計上月数</th>
              <th className={`${thBase} text-right`}>明細</th>
              <th className={`${thBase} text-right`}>AP</th>
              <th className={`${thBase} text-right`}>本人報酬</th>
              <th className={`${thBase} text-right`}>自社取り分</th>
              <th className={`${thBase} text-right`}>未払い</th>
              <th className={`${thBase} text-right`}>未計上 AP</th>
              <th className={thBase}>振込先</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-xs text-zinc-500">
                  {year} 年に管理区分が「アカウント貸し出し」の注文明細がありません。
                  クリエイター管理で対象月の管理区分を設定してください。
                </td>
              </tr>
            ) : null}

            {summary.rows.map((row) => {
              const open = openCreatorId === row.creatorId;
              const bank = bankByCreator.get(row.creatorId) ?? null;

              return (
                <Fragment key={row.creatorId}>
                  <tr
                    className="cursor-pointer border-b border-zinc-900 transition hover:bg-white/[0.02]"
                    onClick={() => setOpenCreatorId(open ? null : row.creatorId)}
                  >
                    <td className={td}>
                      <span className="font-semibold text-zinc-100">{row.creatorName}</span>
                      {row.tiktokId ? (
                        <span className="ml-2 font-mono text-[11px] text-zinc-600">
                          @{row.tiktokId}
                        </span>
                      ) : null}
                      <span className="ml-2 text-[11px] text-zinc-600">
                        {open ? "▲" : "▼"}
                      </span>
                    </td>
                    <td className={`${td} text-zinc-400`}>{row.inHouseAgencyName ?? "—"}</td>
                    <td className={td}>
                      {row.isActivated ? (
                        <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-300">
                          有効
                        </span>
                      ) : (
                        <span
                          className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-200"
                          title="行を開いて対象月の分配率を保存すると有効化されます"
                        >
                          未有効化
                        </span>
                      )}
                    </td>
                    <td className={`${td} text-right text-zinc-400`}>{row.monthCount}</td>
                    <td className={`${td} text-right text-zinc-400`}>{row.itemCount}</td>
                    <td className={`${td} text-right font-mono text-zinc-300`}>
                      {formatYenPrecise(row.agencyRevenue)}
                    </td>
                    <td className={`${td} text-right font-mono font-semibold text-zinc-50`}>
                      {formatYenPrecise(row.rewardAmount)}
                    </td>
                    <td className={`${td} text-right font-mono text-zinc-400`}>
                      {formatYenPrecise(row.selfShareAmount)}
                    </td>
                    <td className={`${td} text-right font-mono text-amber-200`}>
                      {formatYenPrecise(row.unpaidAmount)}
                    </td>
                    {/* 有効化すれば計上される見込みの AP */}
                    <td className={`${td} text-right font-mono text-zinc-500`}>
                      {row.pendingAgencyRevenue > 0 ? (
                        <span title={`未計上の月 ${row.pendingMonthCount} か月`}>
                          {formatYenPrecise(row.pendingAgencyRevenue)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    {/*
                      振込先の状態は支払系と同じ判定（registered / incomplete / missing）。
                      「不備」は銀行コード・支店コードが欠けている状態で、
                      支払明細を作れない（M-1）。
                    */}
                    <td className={td}>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${
                          BANK_STATE_CLASS[row.bankState]
                        }`}
                        title={
                          row.bankState === "registered"
                            ? "振込に必要な項目がすべて揃っています"
                            : "支払明細を作成できません。行を開いて振込先を登録してください"
                        }
                      >
                        {BANK_ACCOUNT_STATE_LABEL[row.bankState]}
                      </span>
                    </td>
                  </tr>

                  {open ? (
                    <CreatorDetail row={row} bank={bank} defaultMonth={defaultMonth} />
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 分配率の設定状況 */}
      {summary.terms.length > 0 ? (
        <div className="overflow-x-auto rounded-2xl border border-white/[0.07]">
          <table className="w-full min-w-[720px] border-collapse">
            <caption className="px-3 py-3 text-left text-xs font-semibold text-zinc-300">
              分配率の設定（{year} 年）
            </caption>
            <thead>
              <tr>
                <th className={thBase}>クリエイター</th>
                <th className={thBase}>対象月</th>
                <th className={`${thBase} text-right`}>設定値</th>
                <th className={`${thBase} text-right`}>適用率</th>
                <th className={thBase}>有効</th>
                <th className={thBase}>備考</th>
              </tr>
            </thead>
            <tbody>
              {summary.terms.map((term) => (
                <tr
                  key={`${term.creatorId}-${term.targetMonth}`}
                  className="border-b border-zinc-900"
                >
                  <td className={td}>
                    <span className="text-zinc-200">{term.creatorName}</span>
                    {term.tiktokId ? (
                      <span className="ml-2 font-mono text-[11px] text-zinc-600">
                        @{term.tiktokId}
                      </span>
                    ) : null}
                  </td>
                  <td className={`${td} font-mono text-zinc-300`}>{term.targetMonth}</td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {term.splitRate == null ? "既定" : formatRate(term.splitRate)}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-200`}>
                    {formatRate(term.effectiveSplitRate)}
                  </td>
                  <td className={td}>
                    {term.isActive ? (
                      <span className="text-emerald-300">有効</span>
                    ) : (
                      <span className="text-zinc-500">無効</span>
                    )}
                  </td>
                  <td className={`${td} text-zinc-500`}>{term.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* 対象外の理由 */}
      {summary.exclusions.length > 0 ? (
        <div className="overflow-x-auto rounded-2xl border border-white/[0.07]">
          <table className="w-full min-w-[720px] border-collapse">
            <caption className="px-3 py-3 text-left text-xs font-semibold text-zinc-300">
              報酬が作られなかった理由（{year} 年・管理区分がアカウント貸し出しの月のみ）
            </caption>
            <thead>
              <tr>
                <th className={thBase}>クリエイター</th>
                <th className={thBase}>対象月</th>
                <th className={thBase}>理由</th>
                <th className={`${thBase} text-right`}>明細</th>
                <th className={`${thBase} text-right`}>AP</th>
              </tr>
            </thead>
            <tbody>
              {summary.exclusions.map((row) => (
                <tr
                  key={`${row.creatorId}-${row.targetMonth}-${row.reason}`}
                  className="border-b border-zinc-900"
                >
                  <td className={td}>
                    <span className="text-zinc-200">{row.creatorName}</span>
                    {row.tiktokId ? (
                      <span className="ml-2 font-mono text-[11px] text-zinc-600">
                        @{row.tiktokId}
                      </span>
                    ) : null}
                  </td>
                  <td className={`${td} font-mono text-zinc-300`}>{row.targetMonth}</td>
                  <td className="px-3 py-2.5 text-xs text-amber-200">{row.reasonLabel}</td>
                  <td className={`${td} text-right text-zinc-400`}>{row.lineCount}</td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {formatYenPrecise(row.agencyRevenue)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
