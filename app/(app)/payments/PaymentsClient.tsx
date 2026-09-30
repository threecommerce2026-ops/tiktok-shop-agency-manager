"use client";

import Link from "next/link";
import {
  EARLIEST_CUTOFF_MONTH,
  MAX_REFERRAL_PAYMENT_CUTOFF_MONTH,
  formatCutoffLabel,
} from "@/lib/payments/cutoff-month";
import { useActionState, useMemo, useState } from "react";

import {
  approvePaymentBatchesBulkAction,
  clearReferralPaymentHoldAction,
  createPaymentBatchAction,
  exportPaymentCsvAction,
  fetchReferralMonthSettlementsAction,
  fetchReferrerGapSummaryAction,
  fetchReferrerRewardDetailAction,
  fetchTapCreatorOverviewAction,
  finalizeReferralMonthAction,
  unfinalizeReferralMonthAction,
  setReferralPaymentHoldAction,
  type BulkApproveResult,
  type PaymentActionResult,
  type PaymentCsvActionResult,
  type ReferralHoldActionResult,
  type ReferralMonthSettlementRow,
  type ReferralSettlementActionResult,
} from "@/app/actions/payments";
import type { ReferrerRewardDetail } from "@/lib/db/payment-queries";
import type {
  TapCreatorOverview,
  ReferrerGapSummary,
  TapCreatorRow,
} from "@/lib/db/tap-creator-queries";
import { BankStateBadge, PayeeBankForm } from "@/components/payments/PayeeBankForm";
import type {
  PayeeCreatorBreakdown,
  PaymentBatchSummary,
  PaymentOverview,
  PaymentUnpaidRow,
} from "@/lib/db/payment-queries";
import {
  PAYEE_KIND_LABEL,
  PAYMENT_HOLD_REASON_HINT,
  PAYMENT_HOLD_REASON_LABEL,
  type PayeeKind,
} from "@/lib/payments/payable";
import {
  isStatementIssuableStatus,
  statementZipFileName,
} from "@/lib/payments/agency-statement";
import { StatementDownloadButton } from "@/components/payments/StatementDownloadButton";
import {
  PAYMENT_BATCH_STATUS_LABEL,
  isOpenPaymentBatchStatus,
  type PaymentBatchStatus,
} from "@/lib/payments/payment-status";

/*
  支払管理の一覧。

  ■ 二重表示しない
  payment_batch_id が付いた明細は未払残高から外れているので、
  「未払い」と「支払予定中」が同じ金額で二重に見えることはない。
  占有中の金額は別カラム（支払予定中）で出す。

  ■ 口座番号
  サーバーから来るのはマスク済みの形だけ。全文はこの画面に存在しない。
*/

const th =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";
const td = "whitespace-nowrap px-3 py-2 text-xs";

const yen = (value: number | null | undefined) =>
  value == null ? "—" : `¥${Math.round(value).toLocaleString("ja-JP")}`;

/*
  一括承認の対象。

  下書きの代理店明細だけを選ばせる。承認済み以降と紹介者明細は対象外。
  ここは画面の絞り込みで、実際の判定はサーバーアクションと RPC が行う。
*/
function isBulkApprovable(batch: PaymentBatchSummary): boolean {
  return batch.status === "draft" && batch.payeeKind === "agency";
}

/** 件数などの整数表示（金額と混ぜないため別関数にする） */
const int = (value: number) => Number(value).toLocaleString("ja-JP");

const TABS = [
  { key: "all", label: "すべて" },
  { key: "agency", label: "代理店" },
  { key: "referrer", label: "紹介者" },
  { key: "hold", label: "振込保留" },
  { key: "history", label: "支払履歴" },
  { key: "tap", label: "TAP実績" },
  { key: "seller", label: "セラー請求" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const BATCH_STATUS_CLASS: Record<PaymentBatchStatus, string> = {
  draft: "border-white/[0.1] bg-white/[0.04] text-zinc-300",
  approved: "border-cyan-400/25 bg-cyan-400/10 text-cyan-200",
  processing: "border-indigo-400/25 bg-indigo-400/10 text-indigo-200",
  paid: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  failed: "border-red-400/25 bg-red-400/10 text-red-200",
  cancelled: "border-zinc-500/25 bg-zinc-500/10 text-zinc-400",
};

const SELLER_STATUS_LABEL: Record<string, string> = {
  draft: "下書き",
  issued: "発行済み",
  paid: "入金済み",
  cancelled: "取消",
};

function BatchStatusBadge({ status }: { status: PaymentBatchStatus }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${BATCH_STATUS_CLASS[status]}`}
    >
      {PAYMENT_BATCH_STATUS_LABEL[status]}
    </span>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "strong" | "muted";
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-4 ${
        tone === "strong"
          ? "border-[var(--accent-cyan)]/30 bg-[var(--accent-cyan)]/[0.06]"
          : tone === "muted"
            ? "border-white/[0.06] bg-surface-1/40"
            : "border-white/[0.08] bg-surface-1"
      }`}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className="mt-2 font-mono text-xl font-bold text-zinc-50">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-zinc-500">{hint}</p> : null}
    </div>
  );
}

function Banner({
  state,
}: {
  state: { ok: true; message: string } | { ok: false; error: string } | null;
}) {
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

/*
  紹介報酬の「今回は支払わない」を切り替える。

  発生データ（referral_reward_items）は消さない。reward_amount も変えない。
  対象・安全条件（支払済み・占有中には付けない）は RPC が持つので、
  ここでは押せるかどうかの見た目だけを決める。

  支払対象として選ぶ操作は既存の「支払明細を作成」がそのまま兼ねる。
  3つ目の状態カラムを増やさないため、保存するのは保留だけにしている。
*/
/*
  紹介報酬の内訳（支払明細を作る前）。

  紹介者 → creator → 対象月 → THREE報酬（W+X）→ 率 → 報酬 まで追える。
  支払明細の詳細と同じ型（PaymentRewardBreakdown）を使うので、
  claim の前後で見え方が変わらない。
  全件を一覧へ常時載せると重いので、開いた紹介者だけ取り寄せる。
*/
function ReferralBreakdown({
  referrerId,
  cutoffMonth,
  startMonth,
}: {
  referrerId: string;
  cutoffMonth: string;
  startMonth: string;
}) {
  const [detail, setDetail] = useState<ReferrerRewardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    const result = await fetchReferrerRewardDetailAction({
      referrerId,
      cutoffMonth,
      startMonth,
    });
    setLoading(false);
    if (result.ok) setDetail(result.detail);
    else setError(result.error);
  };

  if (!detail) {
    return (
      <div className="mt-2">
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-[11px] font-medium text-[var(--accent-cyan)] hover:underline disabled:opacity-50"
        >
          {loading ? "読み込み中…" : "内訳を見る"}
        </button>
        {error ? (
          <p className="mt-1 text-[11px] leading-relaxed text-red-300">{error}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-white/[0.08] bg-black/20 p-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-400">
        <span>
          発生額{" "}
          <span className="font-mono text-zinc-200">{yen(detail.grossAmount)}</span>
        </span>
        <span>
          支払可能{" "}
          <span className="font-mono text-emerald-300">
            {yen(detail.claimableAmount)}
          </span>
        </span>
        {detail.manualHoldAmount > 0 ? (
          <span>
            今回は支払わない{" "}
            <span className="font-mono text-amber-200">
              {yen(detail.manualHoldAmount)}
            </span>
          </span>
        ) : null}
        {detail.claimedAmount > 0 ? (
          <span>
            支払予定中{" "}
            <span className="font-mono text-indigo-200">
              {yen(detail.claimedAmount)}
            </span>
          </span>
        ) : null}
        {detail.paidAmount > 0 ? (
          <span>
            支払済{" "}
            <span className="font-mono text-zinc-300">{yen(detail.paidAmount)}</span>
          </span>
        ) : null}
      </div>

      <div className="max-h-72 overflow-y-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-left text-zinc-500">
              <th className="px-1.5 py-1 font-medium">クリエイター</th>
              <th className="px-1.5 py-1 font-medium">対象月</th>
              {/* 紹介報酬の基礎は THREE の取り分（W+X）。成果報酬ベースではない */}
              <th className="px-1.5 py-1 text-right font-medium">THREE報酬</th>
              <th className="px-1.5 py-1 text-right font-medium">率</th>
              <th className="px-1.5 py-1 text-right font-medium">報酬額</th>
              <th className="px-1.5 py-1 text-right font-medium">明細</th>
            </tr>
          </thead>
          <tbody>
            {detail.breakdown.creators.map((creator) =>
              creator.months.map((month, index) => (
                <tr
                  key={`${creator.creatorId}:${month.targetMonth}`}
                  className="border-t border-white/[0.05]"
                >
                  <td className="px-1.5 py-1 text-zinc-300">
                    {index === 0 ? creator.tiktokId || creator.creatorName : ""}
                  </td>
                  <td className="px-1.5 py-1 font-mono text-zinc-400">
                    {month.targetMonth}
                  </td>
                  <td className="px-1.5 py-1 text-right font-mono text-zinc-400">
                    {yen(month.baseAmount)}
                  </td>
                  <td className="px-1.5 py-1 text-right font-mono text-zinc-400">
                    {month.hasMixedRate ? "複数" : `${month.ratePct}%`}
                  </td>
                  <td className="px-1.5 py-1 text-right font-mono text-zinc-200">
                    {yen(month.rewardAmount)}
                  </td>
                  <td className="px-1.5 py-1 text-right font-mono text-zinc-500">
                    {month.itemCount}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        onClick={() => setDetail(null)}
        className="text-[11px] text-zinc-400 hover:underline"
      >
        閉じる
      </button>
    </div>
  );
}

/*
  紹介元アカウント（どのクリエイターから発生した紹介報酬か）。

  EMI が「支払う / 今回は支払わない」を判断するには、紹介者名だけでは
  足りず、元になったクリエイターと金額が要る。

  金額は行の発生額と同じ集合から作っているので、ここの合計は必ず
  発生額と一致する。1紹介者あたり最大5件なので原則すべて出し、
  多い場合だけ折りたたむ（上位3件 + 残りは開いて見る）。

  注文や月別まで追うときは「内訳を見る」を使う。
*/
const VISIBLE_CREATOR_COUNT = 3;

/*
  紹介者報酬の月次確定。

  claim_payment_batch_items は「開始月から締め月までのすべての月が
  finalized」を要求する。明細が 0 件の月も対象なので、
  0件・0円の月もここから確定できるようにする（黙って飛ばさない）。

  ■ 押す前に中身を見せる
  月だけを見せて押させると、誤った月を確定しても気づけない。
  件数と金額を確認ダイアログへ必ず出す。

  ■ 解除はサーバー側でも守る
  支払処理へ進んだ月は戻せない。ここでボタンを disabled にするのは
  見た目の話で、実際の歯止めは unfinalize_referral_month が持つ。
*/
const SETTLEMENT_STATUS_LABEL: Record<string, string> = {
  unfinalized: "未確定",
  ready: "確定準備",
  finalized: "確定済み",
};

function SettlementStatusBadge({ status }: { status: string }) {
  const cls =
    status === "finalized"
      ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
      : "border-white/[0.1] bg-white/[0.04] text-zinc-400";

  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] ${cls}`}>
      {SETTLEMENT_STATUS_LABEL[status] ?? status}
    </span>
  );
}

function ReferralSettlementSection({
  onReviewReferrers,
}: {
  /* 「TAP実績で確認する」を押したときに親がタブを切り替える */
  onReviewReferrers: () => void;
}) {
  const [rows, setRows] = useState<ReferralMonthSettlementRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const [result, setResult] = useState<ReferralSettlementActionResult | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [gap, setGap] = useState<ReferrerGapSummary | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    /*
      確定状況と、紹介者の入力漏れを一緒に取る。
      入力漏れの方は件数と金額だけを返す軽い経路なので、
      TAP実績の一覧（2万件超）は読まない。
    */
    const [listed, gapResult] = await Promise.all([
      fetchReferralMonthSettlementsAction(),
      fetchReferrerGapSummaryAction(),
    ]);
    setLoading(false);
    if (listed.ok) setRows(listed.rows);
    else setError(listed.error);
    setGap(gapResult.ok ? gapResult.summary : null);
  };

  /*
    操作したら必ず一覧を取り直す。確定済みの月に古い状態が残ると、
    二重に押せてしまったように見える。
  */
  const run = async (
    action: (
      prev: ReferralSettlementActionResult | null,
      formData: FormData,
    ) => Promise<ReferralSettlementActionResult>,
    targetMonth: string,
  ) => {
    setPending(targetMonth);
    setResult(null);

    const formData = new FormData();
    formData.set("targetMonth", targetMonth);

    const actionResult = await action(null, formData);
    setResult(actionResult);
    setConfirming(null);
    setPending(null);

    if (actionResult.ok) await load();
  };

  return (
    <section className="space-y-3 rounded-xl border border-white/[0.08] bg-surface-1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">紹介報酬の月次確定</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
            紹介者へ支払うには、開始月から締め月までの
            <span className="font-semibold text-zinc-300">すべての月</span>
            が確定済みである必要があります。報酬が 0 件の月も確定が必要です。
            確定しても報酬額は変わりません。
            <br />
            支払対象にできるのは{" "}
            <span className="font-semibold text-zinc-300">
              {MAX_REFERRAL_PAYMENT_CUTOFF_MONTH} 末締め
            </span>
            までです。それより後の月は TAP の全量取込が済んでいないため、
            確定しても支払には進めません。
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="min-h-[32px] shrink-0 rounded-lg border border-white/[0.12] px-3 text-xs text-zinc-300 hover:bg-white/[0.06] disabled:opacity-50"
        >
          {loading ? "読み込み中…" : rows ? "再読み込み" : "確定状況を表示"}
        </button>
      </div>

      {error ? (
        <p className="text-[11px] leading-relaxed text-red-300">{error}</p>
      ) : null}
      {result ? (
        <p
          className={`text-[11px] leading-relaxed ${
            result.ok ? "text-emerald-300" : "text-red-300"
          }`}
        >
          {result.ok ? result.message : result.error}
        </p>
      ) : null}

      {/*
        紹介者の入力漏れ警告。

        確定してしまうと、あとで紹介者を登録したときに確定済みの月の
        金額が変わる。確定の直前にここで気づけるようにする。
        検出するだけで、紹介者の登録も報酬の生成もここでは行わない。
      */}
      {gap && gap.creatorCount > 0 ? (
        <div className="rounded-lg border border-red-400/25 bg-red-400/5 p-3">
          <p className="text-xs font-semibold text-red-200">
            ⚠ 紹介者の確認が必要です
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-red-100/90">
            TAP報酬が発生している紹介報酬の対象区分のクリエイターのうち、紹介者が未設定のものが{" "}
            <span className="font-mono font-semibold">{int(gap.creatorCount)} 名</span>{" "}
            います。
            <br />
            紹介報酬の算定元：
            <span className="font-mono">{yen(gap.referralBaseAmount)}</span>
            {" / "}
            紹介報酬換算：
            <span className="font-mono">{yen(gap.estimatedReferralReward)}</span>
            <br />
            月次確定の前にご確認ください。
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
            確認対象：{gap.endMonth} まで ／ 支払可能な締め月：
            {gap.paymentCutoffMonth} まで
            <br />
            確認範囲は月次確定の対象月に合わせています。支払の上限とは別で、
            {gap.paymentCutoffMonth} より後の月は支払対象になりません。
          </p>
          {gap.months.length > 0 ? (
            <div className="mt-2 overflow-x-auto">
              <table className="min-w-[420px] border-collapse text-[11px]">
                <thead>
                  <tr className="text-left text-red-200/70">
                    <th className="px-2 py-1 font-medium">対象月</th>
                    <th className="px-2 py-1 text-right font-medium">未設定</th>
                    <th className="px-2 py-1 text-right font-medium">算定元</th>
                    <th className="px-2 py-1 text-right font-medium">紹介報酬換算</th>
                  </tr>
                </thead>
                <tbody>
                  {gap.months.map((month) => (
                    <tr key={month.targetMonth} className="text-red-100/90">
                      <td className="px-2 py-1 font-mono">{month.targetMonth}</td>
                      <td className="px-2 py-1 text-right font-mono">
                        {int(month.creatorCount)} 名
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {yen(month.referralBaseAmount)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {yen(month.estimatedReferralReward)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <button
            type="button"
            onClick={onReviewReferrers}
            className="mt-2 rounded-lg border border-red-400/30 px-3 py-1 text-[11px] text-red-100 hover:bg-red-400/10"
          >
            TAP実績で確認する
          </button>
        </div>
      ) : null}

      {rows ? (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="min-w-[860px] w-full border-collapse text-[11px]">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="px-2 py-1.5 font-medium">対象月</th>
                <th className="px-2 py-1.5 font-medium">状態</th>
                <th className="px-2 py-1.5 text-right font-medium">紹介報酬件数</th>
                <th className="px-2 py-1.5 text-right font-medium">紹介報酬額</th>
                <th className="px-2 py-1.5 font-medium">確定日時</th>
                <th className="px-2 py-1.5 font-medium">確定者</th>
                <th className="px-2 py-1.5 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const locked = row.claimedItemCount > 0 || row.paidItemCount > 0;
                return (
                  <tr key={row.targetMonth} className="border-t border-zinc-800/70 align-top">
                    <td className="px-2 py-1.5 font-mono text-zinc-200">
                      {row.targetMonth}
                      {/*
                        支払上限より後の月。確定はできるが支払には進めない。
                        TAP の全量取込が済んでいないので、いま確定すると
                        暫定値を確定させることになる。
                      */}
                      {row.targetMonth > MAX_REFERRAL_PAYMENT_CUTOFF_MONTH ? (
                        <span className="mt-0.5 block w-fit rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">
                          TAP未確定・支払対象外
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5">
                      <SettlementStatusBadge status={row.status} />
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-300">
                      {int(row.rewardItemCount)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-200">
                      {yen(row.rewardAmount)}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-zinc-400">
                      {row.finalizedAt ? row.finalizedAt.slice(0, 19).replace("T", " ") : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-zinc-400">
                      {row.finalizedByEmail ?? (row.finalizedBy ? "（不明）" : "—")}
                    </td>
                    <td className="px-2 py-1.5 whitespace-normal">
                      {row.status === "finalized" ? (
                        locked ? (
                          <span
                            className="text-zinc-600"
                            title="支払明細に組み入れ済み / 支払済みの明細があるため解除できません"
                          >
                            解除不可（支払処理済み）
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={pending === row.targetMonth}
                            onClick={() =>
                              run(unfinalizeReferralMonthAction, row.targetMonth)
                            }
                            className="rounded-lg border border-white/[0.12] px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/[0.06] disabled:opacity-50"
                          >
                            {pending === row.targetMonth ? "解除中…" : "確定を解除"}
                          </button>
                        )
                      ) : confirming === row.targetMonth ? (
                        <div className="space-y-1.5 rounded-lg border border-amber-400/25 bg-amber-400/5 p-2">
                          <p className="leading-relaxed text-amber-100">
                            {row.targetMonth} の紹介報酬を確定します。
                            <br />
                            確定後、この月は支払処理の対象にできます。
                            <br />
                            件数：<span className="font-mono">{int(row.rewardItemCount)}件</span>
                            <br />
                            紹介報酬：<span className="font-mono">{yen(row.rewardAmount)}</span>
                            <br />
                            よろしいですか？
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={pending === row.targetMonth}
                              onClick={() =>
                                run(finalizeReferralMonthAction, row.targetMonth)
                              }
                              className="rounded-lg bg-[var(--accent-cyan)] px-2.5 py-0.5 text-[11px] font-semibold text-black disabled:opacity-50"
                            >
                              {pending === row.targetMonth ? "確定中…" : "確定する"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirming(null)}
                              className="rounded-lg border border-white/[0.12] px-2.5 py-0.5 text-[11px] text-zinc-300 hover:bg-white/[0.06]"
                            >
                              やめる
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirming(row.targetMonth)}
                          className="rounded-lg border border-white/[0.12] px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/[0.06]"
                        >
                          確定する
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/*
  TAP実績タブ。

  ■ 支払画面ではない
  TAP のクリエイター成果報酬は TikTok 側でクリエイター本人へ発生するもので、
  THREE から振り込む仕組みは現在無い。支払・保留・claim の操作は置かない。
  代理店支払・紹介者支払とは意味が違うので、同じ表に混ぜない。

  ■ 4つの金額は別物。合算列を作らない
  基礎額・THREE の取り分・クリエイターの取り分・紹介者への報酬は
  それぞれ計算根拠が違う。足した数字は意味を持たないので出さない。

  ■ 開いたときだけ取り寄せる
  TAP は 22,000 行あり、/payments の初期表示に載せると
  代理店・紹介者タブまで遅くなる。畳んだ 143 行だけを受け取る。
*/
const TAP_AGENCY_FILTERS = [
  { key: "all", label: "所属: すべて" },
  { key: "in_house", label: "所属: 自社運営" },
  { key: "external", label: "所属: 外部代理店" },
  { key: "unconfirmed", label: "所属: 未確認" },
] as const;

/*
  紹介者の絞り込み。

  「-」と「未設定」は別項目にする。「-」は管理者が正式に設定した
  有効な紹介者で、未設定（関係そのものが無い）とは意味が違う。
  ここで同じ選択肢にまとめると入力漏れを見つけられなくなる。
*/
const TAP_REFERRER_FILTERS = [
  { key: "all", label: "紹介者: すべて" },
  { key: "assigned", label: "紹介者: 設定済み" },
  { key: "dash_referrer", label: "紹介者: 「-」設定済み" },
  { key: "none", label: "紹介者: 未設定" },
  { key: "review", label: "紹介者: 要確認" },
] as const;

/** 紹介者の状態の表示。未設定と「-」を取り違えないようにする */
function tapReferrerBadge(state: TapCreatorRow["referrerState"]): {
  label: string;
  className: string;
} {
  switch (state) {
    case "assigned":
      return {
        label: "設定済み",
        className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
      };
    case "dash_referrer":
      return {
        label: "「-」設定済み",
        className: "border-white/[0.14] bg-white/[0.05] text-zinc-300",
      };
    case "out_of_period":
      return {
        label: "期間外・要確認",
        className: "border-amber-400/30 bg-amber-400/10 text-amber-200",
      };
    case "conflict":
      return {
        label: "relation異常・要確認",
        className: "border-red-400/30 bg-red-400/10 text-red-200",
      };
    default:
      return {
        label: "要確認",
        className: "border-red-400/30 bg-red-400/10 text-red-200",
      };
  }
}

/** 要確認（未設定・期間外・異常）か */
function tapNeedsReview(state: TapCreatorRow["referrerState"]): boolean {
  return state === "none" || state === "out_of_period" || state === "conflict";
}

const TAP_SORTS = [
  { key: "commissionBase", label: "成果報酬ベース順" },
  { key: "tapRevenue", label: "THREE報酬順" },
  { key: "creatorEstimatedCommission", label: "クリエイター報酬順" },
  { key: "referralRewardAmount", label: "紹介報酬順" },
  { key: "referralBaseAmount", label: "紹介報酬の算定元順" },
] as const;

type TapSortKey = (typeof TAP_SORTS)[number]["key"];

function tapAgencyBadge(row: TapCreatorRow): string {
  if (row.agencyState === "in_house") {
    return "border-emerald-400/25 bg-emerald-400/10 text-emerald-300";
  }
  if (row.agencyState === "external") {
    return "border-cyan-400/25 bg-cyan-400/10 text-cyan-200";
  }
  return "border-white/[0.1] bg-white/[0.04] text-zinc-400";
}

function TapPerformanceTab({
  initialReferrerFilter = "all",
}: {
  /* 月次確定の警告から来たときに「未設定だけ」を初期選択する */
  initialReferrerFilter?: (typeof TAP_REFERRER_FILTERS)[number]["key"];
}) {
  const [overview, setOverview] = useState<TapCreatorOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [agencyFilter, setAgencyFilter] =
    useState<(typeof TAP_AGENCY_FILTERS)[number]["key"]>("all");
  const [referrerFilter, setReferrerFilter] =
    useState<(typeof TAP_REFERRER_FILTERS)[number]["key"]>(initialReferrerFilter);
  const [sortKey, setSortKey] = useState<TapSortKey>("commissionBase");

  /*
    取り寄せは操作を起点にする。effect の中で state を書くと
    描画のたびに走る余地が残るため、既存の「内訳を見る」と同じ形にする。
  */
  const load = async () => {
    setLoading(true);
    setError(null);
    const result = await fetchTapCreatorOverviewAction();
    setLoading(false);
    if (result.ok) setOverview(result.overview);
    else setError(result.error);
  };

  const rows = useMemo(() => {
    if (!overview) return [];
    const keyword = search.trim().toLowerCase();

    return overview.rows
      .filter((row) => {
        if (keyword && !row.tiktokId.toLowerCase().includes(keyword)) return false;
        if (agencyFilter === "in_house" && row.agencyState !== "in_house") return false;
        if (agencyFilter === "external" && row.agencyState !== "external") return false;
        if (
          agencyFilter === "unconfirmed" &&
          row.agencyState !== "unconfirmed" &&
          row.agencyState !== "partially_unconfirmed"
        ) {
          return false;
        }
        if (referrerFilter === "review" && !tapNeedsReview(row.referrerState)) {
          return false;
        }
        if (
          referrerFilter !== "all" &&
          referrerFilter !== "review" &&
          row.referrerState !== referrerFilter
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b[sortKey] - a[sortKey] || a.tiktokId.localeCompare(b.tiktokId, "ja"));
  }, [overview, search, agencyFilter, referrerFilter, sortKey]);

  if (!overview) {
    return (
      <section className="space-y-3 rounded-xl border border-white/[0.08] bg-surface-1 p-4">
        <h2 className="text-sm font-semibold text-zinc-100">TAP実績</h2>
        <p className="text-[11px] leading-relaxed text-zinc-400">
          TAPで成果が発生したクリエイターを、紹介者の有無に関係なくすべて表示します。
          確認用の画面で、支払操作はありません。
          明細が2万件を超えるため、必要なときだけ集計します。
        </p>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="min-h-[36px] rounded-lg bg-[var(--accent-cyan)] px-4 text-xs font-semibold text-black disabled:opacity-50"
        >
          {loading ? "集計中…" : "TAP実績を表示"}
        </button>
        {error ? (
          <p className="text-[11px] leading-relaxed text-red-300">{error}</p>
        ) : null}
      </section>
    );
  }

  const { totals } = overview;

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-white/[0.08] bg-surface-1 p-4">
        <h2 className="text-sm font-semibold text-zinc-100">
          TAP実績（{overview.startMonth}〜{overview.endMonth}）
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
          TAPで成果が発生したクリエイターを、紹介者の有無に関係なくすべて表示します。
          <span className="font-semibold text-zinc-300">
            この画面は確認用で、支払操作はありません。
          </span>
        </p>
        <dl className="mt-3 grid gap-2 text-[11px] leading-relaxed text-zinc-400 sm:grid-cols-2">
          <div>
            <dt className="font-semibold text-zinc-300">成果報酬ベース</dt>
            <dd>各報酬率を計算する基礎金額。誰かへの支払額ではありません。</dd>
          </div>
          <div>
            <dt className="font-semibold text-zinc-300">THREE報酬</dt>
            <dd>TAPからTHREE COMMERCEへ発生する推定成果報酬です。</dd>
          </div>
          <div>
            <dt className="font-semibold text-zinc-300">クリエイター報酬</dt>
            <dd>TikTok側でクリエイター本人へ発生する推定成果報酬です。</dd>
          </div>
          <div>
            <dt className="font-semibold text-zinc-300">紹介報酬</dt>
            <dd>
              THREEの紹介制度により紹介者へ発生した報酬です。左の
              <span className="font-semibold text-zinc-300">THREE報酬</span>
              に対する5%で、成果報酬ベースからは計算しません
              （ボーナスも含めません）。
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-[11px] leading-relaxed text-amber-200/80">
          4つの金額はそれぞれ計算根拠が違うため、合算した数字は出していません。
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi label="対象クリエイター" value={`${int(totals.creatorCount)} 名`} />
        <Kpi label="対象明細" value={`${int(totals.eligibleItemCount)} 件`} />
        <Kpi label="成果報酬ベース" value={yen(totals.commissionBase)} hint="計算の基礎額" />
        <Kpi label="THREE報酬" value={yen(totals.tapRevenue)} hint="THREE COMMERCE の取り分" />
        <Kpi
          label="クリエイター報酬"
          value={yen(totals.creatorEstimatedCommission)}
          hint="クリエイター本人の取り分"
        />
        <Kpi
          label="紹介報酬"
          value={yen(totals.referralRewardAmount)}
          hint="紹介者への報酬（社内ルール）"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Kpi label="紹介者 設定済み" value={`${int(totals.referrerAssignedCount)} 名`} />
        <Kpi
          label="紹介者「-」"
          value={`${int(totals.referrerDashCount)} 名`}
          hint="正式に設定された紹介者"
        />
        <Kpi
          label="紹介者 未設定"
          value={`${int(totals.referrerNoneCount)} 名`}
          hint="有効な紹介関係なし"
        />
        <Kpi
          label="要確認"
          value={`${int(totals.referrerReviewCount)} 名`}
          hint="未設定・期間外・relation異常"
        />
        <Kpi
          label="紹介者の入力漏れ"
          value={`${int(totals.missingReferrerCreatorCount)} 名`}
          hint="紹介報酬の対象区分のみ"
        />
      </div>

      {totals.missingReferrerCreatorCount > 0 ? (
        <div className="rounded-xl border border-red-400/25 bg-red-400/5 p-4">
          <p className="text-xs font-semibold text-red-200">
            ⚠ 紹介者の確認が必要です
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-red-100/90">
            TAP報酬が発生している
            <span className="font-semibold">紹介報酬の対象区分</span>
            のクリエイターのうち、紹介者が未設定のものが{" "}
            <span className="font-mono font-semibold">
              {int(totals.missingReferrerCreatorCount)} 名
            </span>{" "}
            います。
            <br />
            紹介報酬の算定元：
            <span className="font-mono">{yen(totals.missingReferrerBaseAmount)}</span>
            {" / "}
            紹介報酬換算：
            <span className="font-mono">
              {yen(totals.missingReferrerEstimatedReward)}
            </span>
            <br />
            月次確定の前にご確認ください。紹介者はここでは登録されません。
          </p>
          <button
            type="button"
            onClick={() => setReferrerFilter("none")}
            className="mt-2 rounded-lg border border-red-400/30 px-3 py-1 text-[11px] text-red-100 hover:bg-red-400/10"
          >
            紹介者未設定だけを表示
          </button>
        </div>
      ) : null}

      {totals.referrerNoneCount > totals.missingReferrerCreatorCount ? (
        <p className="text-[11px] leading-relaxed text-zinc-500">
          紹介者未設定 {int(totals.referrerNoneCount)} 名のうち{" "}
          {int(totals.referrerNoneCount - totals.missingReferrerCreatorCount)}{" "}
          名は self_operated / account_lending
          などの区分で、区分により紹介報酬の対象外です。入力漏れの警告には含めていません。
        </p>
      ) : null}

      {totals.creatorCommissionMissingCount > 0 ? (
        <p className="text-[11px] leading-relaxed text-zinc-500">
          クリエイター報酬がTAPデータに記録されていない明細が{" "}
          {int(totals.creatorCommissionMissingCount)} 件あります（料率が未設定の明細）。
          その分は 0 円として集計しています。
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="TikTok ID を検索"
          className="min-h-[36px] w-56 rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100 outline-none focus:border-[var(--accent-cyan)]"
        />
        <select
          value={agencyFilter}
          onChange={(event) =>
            setAgencyFilter(event.target.value as typeof agencyFilter)
          }
          className="min-h-[36px] rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100"
        >
          {TAP_AGENCY_FILTERS.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
        <select
          value={referrerFilter}
          onChange={(event) =>
            setReferrerFilter(event.target.value as typeof referrerFilter)
          }
          className="min-h-[36px] rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100"
        >
          {TAP_REFERRER_FILTERS.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
        <select
          value={sortKey}
          onChange={(event) => setSortKey(event.target.value as TapSortKey)}
          className="min-h-[36px] rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100"
        >
          {TAP_SORTS.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-zinc-500">
          {int(rows.length)} / {int(overview.rows.length)} 名
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
        <table className="min-w-[1180px] w-full border-collapse">
          <thead>
            <tr>
              <th className={th}>TikTok ID</th>
              <th className={th}>区分</th>
              <th className={th}>所属</th>
              <th className={th}>紹介者</th>
              <th className={th}>対象期間</th>
              <th className={`${th} text-right`}>対象件数</th>
              <th className={`${th} text-right`}>成果報酬ベース</th>
              <th className={`${th} text-right`}>THREE報酬</th>
              <th className={`${th} text-right`}>クリエイター報酬</th>
              <th className={`${th} text-right`}>紹介報酬の算定元</th>
              <th className={`${th} text-right`}>想定紹介報酬5%</th>
              <th className={`${th} text-right`}>紹介報酬（実績）</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-4 py-10 text-center text-sm text-zinc-500">
                  該当するクリエイターがいません。
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.creatorId} className="border-b border-zinc-800/70 align-top">
                  <td className={`${td} whitespace-normal`}>
                    <span className="font-mono text-zinc-100">
                      {row.tiktokId || row.creatorName || row.creatorId.slice(0, 8)}
                    </span>
                    {row.creatorName && row.creatorName !== row.tiktokId ? (
                      <span className="block text-[10px] text-zinc-500">
                        {row.creatorName}
                      </span>
                    ) : null}
                    {row.referrerAssignmentState ? (
                      <span className="block text-[10px] text-zinc-600">
                        確認状態: {row.referrerAssignmentState}
                      </span>
                    ) : null}
                  </td>
                  <td className={`${td} whitespace-normal text-zinc-400`}>
                    {row.accountManagementType ?? "-"}
                  </td>
                  <td className={`${td} whitespace-normal`}>
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] ${tapAgencyBadge(row)}`}
                    >
                      {row.agencyLabel}
                    </span>
                  </td>
                  <td className={`${td} whitespace-normal`}>
                    <div className="flex flex-col gap-0.5">
                      {row.referrerState === "none" ? (
                        <span className="font-semibold text-red-200">未設定</span>
                      ) : (
                        <span className="text-zinc-200">{row.referrerName}</span>
                      )}
                      <span
                        className={`inline-flex w-fit rounded-full border px-2 py-0.5 text-[10px] ${
                          tapReferrerBadge(row.referrerState).className
                        }`}
                      >
                        {tapReferrerBadge(row.referrerState).label}
                      </span>
                      {row.referrerState === "out_of_period" ? (
                        <span className="text-[10px] text-amber-200">
                          {row.referralPeriodLabel}
                        </span>
                      ) : null}
                      {row.referrerState === "none" && !row.referralEligibleType ? (
                        <span className="text-[10px] text-zinc-500">
                          {row.accountManagementType}（紹介報酬の対象外）
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className={`${td} font-mono text-zinc-300`}>
                    {row.firstTargetMonth === row.lastTargetMonth
                      ? row.firstTargetMonth
                      : `${row.firstTargetMonth}〜${row.lastTargetMonth}`}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {int(row.eligibleItemCount)}
                  </td>
                  <td className={`${td} text-right font-mono font-semibold text-zinc-100`}>
                    {yen(row.commissionBase)}
                  </td>
                  <td className={`${td} text-right font-mono text-cyan-200`}>
                    {yen(row.tapRevenue)}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-300`}>
                    {yen(row.creatorEstimatedCommission)}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-200`}>
                    {yen(row.referralBaseAmount)}
                  </td>
                  <td className={`${td} text-right font-mono`}>
                    {/*
                      想定額。まだ報酬が生成されていない場合に
                      どれだけの規模かを示すためのもので、確定額ではない。
                    */}
                    {row.referralEligibleType ? (
                      <span
                        className={
                          row.referrerState === "none" ? "text-red-200" : "text-zinc-400"
                        }
                      >
                        {yen(row.estimatedReferralReward)}
                      </span>
                    ) : (
                      <span className="text-zinc-600">対象外</span>
                    )}
                  </td>
                  <td className={`${td} text-right font-mono text-emerald-300`}>
                    {row.referralRewardAmount > 0 ? yen(row.referralRewardAmount) : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] leading-relaxed text-zinc-500">
        紹介者がいないクリエイターにも紹介報酬は発生しません（0円）。この画面から
        紹介報酬を新しく作ることはありません。紹介者の支払は「紹介者」タブ、
        代理店の支払は「代理店」タブで行います。
      </p>
    </section>
  );
}

function ReferralCreators({ creators }: { creators: PayeeCreatorBreakdown[] }) {
  const [expanded, setExpanded] = useState(false);

  if (creators.length === 0) {
    return (
      <p className="mt-2 text-[11px] text-zinc-500">
        紹介元アカウントがありません。
      </p>
    );
  }

  const hidden = creators.length - VISIBLE_CREATOR_COUNT;
  const shown = expanded ? creators : creators.slice(0, VISIBLE_CREATOR_COUNT);

  return (
    <div className="mt-2 max-w-md">
      <p className="text-[11px] font-medium text-zinc-500">紹介元アカウント</p>
      <ul className="mt-1 space-y-0.5">
        {shown.map((creator) => (
          <li
            key={creator.creatorId}
            className="flex items-baseline justify-between gap-3 text-[11px]"
          >
            {/* creator_name があっても TikTok ID を必ず出す（突き合わせに使う） */}
            <span className="truncate font-mono text-zinc-300">
              {creator.tiktokId || creator.creatorName || creator.creatorId.slice(0, 8)}
            </span>
            <span className="shrink-0 font-mono text-zinc-200">
              {yen(creator.rewardAmount)}
              <span className="ml-1 text-zinc-600">({creator.itemCount})</span>
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-[11px] text-[var(--accent-cyan)] hover:underline"
        >
          {expanded ? "折りたたむ" : `他 ${hidden} 件を表示`}
        </button>
      ) : null}
    </div>
  );
}

function ReferralHoldControls({
  row,
  cutoffMonth,
}: {
  row: PaymentUnpaidRow;
  cutoffMonth: string;
}) {
  const [setState, setHold, setPending] = useActionState<
    ReferralHoldActionResult | null,
    FormData
  >(setReferralPaymentHoldAction, null);
  const [clearState, clearHold, clearPending] = useActionState<
    ReferralHoldActionResult | null,
    FormData
  >(clearReferralPaymentHoldAction, null);

  const result = setState ?? clearState;
  const startMonth = row.periodStartMonth ?? EARLIEST_CUTOFF_MONTH;

  return (
    <div className="mt-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {row.unpaidAmount > 0 ? (
          <form action={setHold}>
            <input type="hidden" name="referrerId" value={row.payeeId} />
            <input type="hidden" name="cutoffMonth" value={cutoffMonth} />
            <input type="hidden" name="startMonth" value={startMonth} />
            <button
              type="submit"
              disabled={setPending}
              className="min-h-[28px] rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 text-[11px] font-medium text-amber-200 hover:bg-amber-400/20 disabled:opacity-50"
            >
              {setPending ? "設定中…" : "今回は支払わない"}
            </button>
          </form>
        ) : null}

        {row.manualHoldAmount > 0 ? (
          <form action={clearHold}>
            <input type="hidden" name="referrerId" value={row.payeeId} />
            <input type="hidden" name="cutoffMonth" value={cutoffMonth} />
            <input type="hidden" name="startMonth" value={startMonth} />
            <button
              type="submit"
              disabled={clearPending}
              className="min-h-[28px] rounded-lg border border-white/[0.12] px-2.5 text-[11px] font-medium text-zinc-300 hover:bg-white/[0.06] disabled:opacity-50"
            >
              {clearPending ? "解除中…" : "保留を解除"}
            </button>
          </form>
        ) : null}
      </div>

      {result ? (
        <p
          className={`text-[11px] leading-relaxed ${
            result.ok ? "text-emerald-300" : "text-red-300"
          }`}
        >
          {result.ok ? result.message : result.error}
        </p>
      ) : null}
    </div>
  );
}

function HoldReasons({ row }: { row: PaymentUnpaidRow }) {
  if (row.holdReasons.length === 0) return <span className="text-zinc-500">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {row.holdReasons.map((reason) => (
        <span
          key={reason}
          title={PAYMENT_HOLD_REASON_HINT[reason]}
          className="whitespace-nowrap rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-200"
        >
          {PAYMENT_HOLD_REASON_LABEL[reason]}
        </span>
      ))}
    </div>
  );
}

function downloadCsv(fileName: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function PaymentsClient({
  overview,
  cutoffMonth,
  cutoffOptions,
  cutoffError,
  allTimeUnpaidAmount,
}: {
  overview: PaymentOverview;
  /** 締め対象月。画面の数字と支払明細の中身はすべてこの月まで */
  cutoffMonth: string;
  cutoffOptions: string[];
  cutoffError: string | null;
  /** 参考表示専用。支払判断には使わない */
  allTimeUnpaidAmount: number;
}) {
  const [tab, setTab] = useState<TabKey>("all");
  /* 月次確定の警告から TAP実績へ渡す初期フィルタ */
  const [tapReferrerFilter, setTapReferrerFilter] =
    useState<(typeof TAP_REFERRER_FILTERS)[number]["key"]>("all");
  const [search, setSearch] = useState("");
  const [bankFilter, setBankFilter] = useState<"all" | "registered" | "not_ready">("all");
  const [payableOnly, setPayableOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  /*
    一括承認。選択と確認ダイアログの状態はこの画面だけで持つ。
    承認の判定はサーバーアクションと RPC が必ずやり直す。
  */
  const [approveSelected, setApproveSelected] = useState<Set<string>>(new Set());
  const [confirmingApprove, setConfirmingApprove] = useState(false);

  const [bulkApproveState, bulkApproveAction, bulkApprovePending] = useActionState(
    async (prev: BulkApproveResult | null, formData: FormData) => {
      const result = await approvePaymentBatchesBulkAction(prev, formData);
      if (result.ok) {
        setApproveSelected(new Set());
        setConfirmingApprove(false);
      }
      return result;
    },
    null as BulkApproveResult | null,
  );

  const [createState, createAction, createPending] = useActionState(
    createPaymentBatchAction,
    null as PaymentActionResult | null,
  );
  const [csvState, csvAction, csvPending] = useActionState(
    async (prev: PaymentCsvActionResult | null, formData: FormData) => {
      const result = await exportPaymentCsvAction(prev, formData);
      if (result.ok) downloadCsv(result.fileName, result.content);
      return result;
    },
    null as PaymentCsvActionResult | null,
  );

  const unpaidRows = useMemo(() => {
    const keyword = search.trim().toLowerCase();

    return overview.rows.filter((row) => {
      if (row.unpaidAmount <= 0 && row.claimedAmount <= 0) return false;
      if (tab === "agency" && row.payeeKind !== "agency") return false;
      if (tab === "referrer" && row.payeeKind !== "referrer") return false;
      if (tab === "hold" && !(row.unpaidAmount > 0 && row.holdReasons.length > 0)) {
        return false;
      }
      if (payableOnly && !row.isPayable) return false;
      if (bankFilter === "registered" && row.bank.state !== "registered") return false;
      if (bankFilter === "not_ready" && row.bank.state === "registered") return false;
      if (keyword && !row.payeeName.toLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [overview.rows, tab, search, payableOnly, bankFilter]);

  const openBatches = overview.batches.filter((batch) =>
    isOpenPaymentBatchStatus(batch.status),
  );

  const approvableBatches = openBatches.filter(isBulkApprovable);
  const approveTargets = approvableBatches.filter((batch) =>
    approveSelected.has(batch.id),
  );
  const approveAmount =
    Math.round(
      approveTargets.reduce((total, batch) => total + batch.paymentAmount, 0) * 100,
    ) / 100;
  const approveCutoffs = [...new Set(approveTargets.map((batch) => batch.cutoffMonth))];

  const toggleApprove = (batchId: string) => {
    setApproveSelected((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
    setConfirmingApprove(false);
  };
  const historyBatches = overview.batches.filter(
    (batch) => !isOpenPaymentBatchStatus(batch.status),
  );

  const exportableIds = openBatches
    .filter((batch) => batch.status === "approved" || batch.status === "processing")
    .map((batch) => batch.id);

  /*
    代理店へ渡す支払明細書。承認済み以降の代理店明細だけが対象。
    実際の出力対象は帳票側でもう一度確かめる（ここは導線の出し分けだけ）。
  */
  const statementBatches = overview.batches.filter(
    (batch) =>
      batch.payeeKind === "agency" &&
      batch.cutoffMonth === cutoffMonth &&
      isStatementIssuableStatus(batch.status),
  );

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedRows = unpaidRows.filter(
    (row) => row.isPayable && selected.has(`${row.payeeKind}:${row.payeeId}`),
  );

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          支払管理
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
          代理店・紹介者への振込を、支払明細の作成 → 承認 → 振込CSV → 振込完了登録
          の順で管理します。
          <span className="font-semibold text-zinc-300">
            「振込完了」を登録するまで報酬明細は支払済みになりません。
          </span>
        </p>
      </div>

      {/*
        締め対象月。画面の数字も、作られる支払明細の中身も、すべてこの月まで。
        サーバー側（Server Action と RPC）でも同じ月で検証するため、
        ここを変えずに古い画面から実行しても締め月より後は claim されない。
      */}
      <form
        method="get"
        className="flex flex-wrap items-end gap-3 rounded-xl border border-[var(--accent-cyan)]/25 bg-[var(--accent-cyan)]/[0.06] px-4 py-3"
      >
        <label className="text-[11px] font-medium text-zinc-300">
          締め対象月
          <select
            name="cutoff"
            defaultValue={cutoffMonth}
            className="mt-1 block min-h-[38px] rounded-lg border border-white/[0.12] bg-surface-1 px-3 text-sm text-zinc-100"
          >
            {cutoffOptions.map((month) => (
              <option key={month} value={month}>
                {formatCutoffLabel(month)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="min-h-[38px] rounded-lg bg-[var(--accent-cyan)] px-4 text-sm font-semibold text-black"
        >
          この月で締める
        </button>
        <p className="text-[11px] leading-relaxed text-zinc-400">
          {formatCutoffLabel(cutoffMonth)}までの未払いだけを表示・支払います。
          <br />
          これより後の月は一覧にも今回支払額にも含まれません。
        </p>
      </form>

      {cutoffError ? (
        <p
          className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
          role="alert"
        >
          {cutoffError}
          <br />
          <span className="text-[11px]">
            安全側の既定（{formatCutoffLabel(cutoffMonth)}）で表示しています。
            締め対象月を選び直してください。
          </span>
        </p>
      ) : null}

      {overview.error ? (
        <p className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {overview.error}
        </p>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi
          label={`締め対象（${formatCutoffLabel(cutoffMonth)}まで）`}
          value={yen(overview.totals.agencyUnpaidAmount)}
          hint="代理店分配報酬のみ。この画面の支払判断はすべてこの金額が基準です"
          tone="strong"
        />
        <Kpi
          label="今回支払予定総額"
          value={yen(overview.totals.scheduledAmount)}
          hint={`支払明細 ${overview.totals.scheduledBatchCount} 件（未振込）`}
          tone="strong"
        />
        <Kpi
          label="代理店分配報酬 未払"
          value={yen(overview.totals.agencyUnpaidAmount)}
          hint="代理店へ支払うのはこの金額だけです"
        />
        <Kpi
          label="紹介報酬 支払可能"
          value={yen(overview.totals.referrerUnpaidAmount)}
          hint="紹介者本人へ支払います。代理店の支払額には含まれません"
        />
        <Kpi
          label="紹介報酬 今回は支払わない"
          value={yen(overview.totals.referrerManualHoldAmount)}
          hint="管理者が保留にした分。発生記録は残っています"
          tone="muted"
        />
        <Kpi
          label="振込保留"
          value={yen(overview.totals.holdAmount)}
          hint={`${overview.totals.holdCount} 件`}
        />
        <Kpi
          label="支払先数"
          value={`${overview.totals.payeeCount} 件`}
          hint="いま支払明細を作れる支払先"
        />
        <Kpi
          label="全期間 未払残高"
          value={yen(allTimeUnpaidAmount)}
          hint={`参考。締め対象より後の未払いを含みます（差 ${yen(
            Math.round(
              (allTimeUnpaidAmount -
                overview.totals.agencyUnpaidAmount -
                overview.totals.referrerUnpaidAmount) *
                100,
            ) / 100,
          )}）`}
          tone="muted"
        />
        <Kpi
          label="セラー未入金"
          value={yen(overview.totals.sellerUnpaidAmount)}
          hint={`発行済み ${overview.totals.sellerUnpaidCount} 件・支払総額には含みません`}
          tone="muted"
        />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/payments/bulk?cutoff=${cutoffMonth}`}
          className="min-h-[40px] rounded-lg border border-white/[0.1] px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-white/[0.06]"
        >
          過去未払いを一括精算
        </Link>
        <Link
          href="/revenue?tab=agency"
          className="min-h-[40px] rounded-lg border border-white/[0.1] px-4 py-2 text-sm font-medium text-zinc-400 hover:bg-white/[0.06]"
        >
          代理店報酬の再集計
        </Link>
        <Link
          href="/revenue?tab=referral"
          className="min-h-[40px] rounded-lg border border-white/[0.1] px-4 py-2 text-sm font-medium text-zinc-400 hover:bg-white/[0.06]"
        >
          紹介者報酬の再集計
        </Link>
      </div>

      <nav
        className="flex gap-1 overflow-x-auto rounded-xl border border-white/[0.06] bg-surface-1/50 p-1"
        aria-label="支払管理タブ"
      >
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            aria-current={item.key === tab ? "page" : undefined}
            className={`min-h-[40px] flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-center text-sm transition ${
              item.key === tab
                ? "bg-white/[0.1] font-semibold text-zinc-50"
                : "font-medium text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100"
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <Banner state={createState} />
      {bulkApproveState ? (
        <p
          className={`whitespace-pre-line rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
            bulkApproveState.ok
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/25 bg-red-500/10 text-red-200"
          }`}
          role="status"
        >
          {bulkApproveState.ok
            ? `${bulkApproveState.message}（合計 ${yen(bulkApproveState.approvedAmount)}）`
            : bulkApproveState.error}
        </p>
      ) : null}
      <Banner
        state={
          csvState == null
            ? null
            : csvState.ok
              ? {
                  ok: true,
                  message: `振込CSVを出力しました（${csvState.batchCount} 件 / 合計 ${yen(csvState.totalAmount)}）。`,
                }
              : csvState
        }
      />

      {tab === "history" ? (
        <BatchTable
          title="支払履歴"
          batches={historyBatches}
          emptyMessage="まだ確定した支払明細はありません。"
        />
      ) : tab === "seller" ? (
        <SellerInvoiceTable overview={overview} />
      ) : tab === "tap" ? (
        <TapPerformanceTab
          key={tapReferrerFilter}
          initialReferrerFilter={tapReferrerFilter}
        />
      ) : (
        <>
          {openBatches.length > 0 ? (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-zinc-200">
                  進行中の支払明細（{openBatches.length}）
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                {statementBatches.length > 0 ? (
                  <>
                    {/*
                      代理店ごとに独立したPDFを作り、1つのZIPで渡す。
                      各代理店へ自社分だけを送るため、まとめた1つのPDFにはしない。
                    */}
                    <StatementDownloadButton
                      href={`/api/statements/agency?cutoff=${cutoffMonth}`}
                      label={`代理店別PDFを一括ダウンロード（${statementBatches.length}件）`}
                      pendingLabel="PDFを作成中…"
                      fallbackFileName={statementZipFileName(cutoffMonth)}
                    />
                    <Link
                      href={`/statements/agency?cutoff=${cutoffMonth}`}
                      target="_blank"
                      rel="noopener"
                      className="inline-flex min-h-[36px] items-center rounded-lg border border-white/[0.1] px-3 text-xs font-medium text-zinc-200 hover:bg-white/[0.06]"
                    >
                      支払明細書をまとめて表示（{statementBatches.length}件）
                    </Link>
                  </>
                ) : null}
                {exportableIds.length > 0 ? (
                  <form action={csvAction}>
                    {exportableIds.map((id) => (
                      <input key={id} type="hidden" name="batch_id" value={id} />
                    ))}
                    <button
                      type="submit"
                      disabled={csvPending}
                      className="min-h-[36px] rounded-lg border border-white/[0.1] px-3 text-xs font-medium text-zinc-200 hover:bg-white/[0.06] disabled:opacity-50"
                    >
                      {csvPending
                        ? "出力中…"
                        : `承認済みをまとめて振込CSV出力（${exportableIds.length}件）`}
                    </button>
                  </form>
                ) : null}
                </div>
              </div>
              {/*
                一括承認。選べるのは下書きの代理店明細だけ。
                押した瞬間には承認せず、必ず確認を挟む。
              */}
              {approvableBatches.length > 0 ? (
                <div className="space-y-2 rounded-xl border border-white/[0.08] bg-surface-1/50 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setApproveSelected(new Set(approvableBatches.map((b) => b.id)));
                        setConfirmingApprove(false);
                      }}
                      className="min-h-[32px] rounded-lg border border-white/[0.12] px-3 text-[11px] font-medium text-zinc-300 hover:bg-white/[0.06]"
                    >
                      下書きをすべて選択（{approvableBatches.length}）
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setApproveSelected(new Set());
                        setConfirmingApprove(false);
                      }}
                      className="min-h-[32px] rounded-lg border border-white/[0.12] px-3 text-[11px] text-zinc-400 hover:bg-white/[0.06]"
                    >
                      選択を解除
                    </button>
                    <span className="text-[11px] text-zinc-400">
                      選択中{" "}
                      <span className="font-semibold text-zinc-200">
                        {approveTargets.length} 件 / {yen(approveAmount)}
                      </span>
                      {approveCutoffs.length === 1 ? (
                        <span className="ml-2 text-zinc-500">
                          {formatCutoffLabel(approveCutoffs[0])}締め
                        </span>
                      ) : null}
                    </span>
                    {!confirmingApprove ? (
                      <button
                        type="button"
                        disabled={approveTargets.length === 0}
                        onClick={() => setConfirmingApprove(true)}
                        className="min-h-[36px] rounded-lg bg-[var(--accent-cyan)] px-4 text-xs font-semibold text-black disabled:opacity-40"
                      >
                        選択した支払明細を一括承認
                      </button>
                    ) : null}
                  </div>

                  {approveCutoffs.length > 1 ? (
                    <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
                      締め対象月が異なる支払明細は同時に承認できません（
                      {approveCutoffs.map(formatCutoffLabel).join(" / ")}）。
                      どちらかだけを選び直してください。
                    </p>
                  ) : null}

                  {confirmingApprove && approveTargets.length > 0 ? (
                    <div className="space-y-3 rounded-xl border border-[var(--accent-cyan)]/30 bg-[var(--accent-cyan)]/[0.06] px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold text-zinc-100">
                          支払明細を一括承認します
                        </p>
                        <p className="mt-1 font-mono text-lg font-bold text-zinc-50">
                          {approveTargets.length} 件 / 合計 {yen(approveAmount)}
                        </p>
                        {approveCutoffs.length === 1 ? (
                          <p className="mt-0.5 text-[11px] text-zinc-400">
                            締め対象：{formatCutoffLabel(approveCutoffs[0])}
                          </p>
                        ) : null}
                      </div>

                      <p className="text-[11px] leading-relaxed text-zinc-300">
                        承認すると各支払明細に
                        <span className="font-semibold text-zinc-100">
                          現在登録されている振込先情報が固定されます。
                        </span>
                        承認後に代理店マスターの振込先を変更しても、この支払明細の
                        振込先は変更されません。
                        <br />
                        承認しても支払済みにはなりません。実際の振込は振込CSVを出力して
                        銀行で行い、そのあと「振込完了」を登録します。
                      </p>

                      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/60">
                        <table className="min-w-[520px] w-full border-collapse">
                          <thead>
                            <tr>
                              <th className={th}>代理店</th>
                              <th className={`${th} text-right`}>金額</th>
                              <th className={th}>振込先状態</th>
                            </tr>
                          </thead>
                          <tbody>
                            {approveTargets.map((batch) => (
                              <tr key={batch.id} className="border-b border-zinc-800/70">
                                <td className={`${td} font-medium text-zinc-100`}>
                                  {batch.payeeName}
                                </td>
                                <td className={`${td} text-right font-mono text-zinc-100`}>
                                  {yen(batch.paymentAmount)}
                                </td>
                                <td className={`${td} text-zinc-400`}>
                                  {batch.bank ? (
                                    <BankStateBadge state={batch.bank.state} />
                                  ) : (
                                    "振込先登録済（承認時に固定）"
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <form action={bulkApproveAction}>
                          {approveTargets.map((batch) => (
                            <input
                              key={batch.id}
                              type="hidden"
                              name="batch_id"
                              value={batch.id}
                            />
                          ))}
                          <button
                            type="submit"
                            disabled={bulkApprovePending || approveCutoffs.length > 1}
                            className="min-h-[40px] rounded-lg bg-[var(--accent-cyan)] px-5 text-sm font-semibold text-black disabled:opacity-50"
                          >
                            {bulkApprovePending
                              ? "承認中…"
                              : `${approveTargets.length} 件を承認して振込先を固定`}
                          </button>
                        </form>
                        <button
                          type="button"
                          disabled={bulkApprovePending}
                          onClick={() => setConfirmingApprove(false)}
                          className="min-h-[40px] rounded-lg border border-white/[0.12] px-4 text-sm text-zinc-300 hover:bg-white/[0.06] disabled:opacity-50"
                        >
                          戻る
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <BatchTable
                title=""
                batches={openBatches}
                emptyMessage="進行中の支払明細はありません。"
                selectable
                selected={approveSelected}
                onToggle={toggleApprove}
              />
            </section>
          ) : null}

          {/*
            紹介者タブでだけ月次確定を出す。代理店の支払はこの確定を
            前提にしていないので、他タブに置くと関係が誤解される。
          */}
          {tab === "referrer" ? (
            <ReferralSettlementSection
              onReviewReferrers={() => {
                setTapReferrerFilter("none");
                setTab("tap");
              }}
            />
          ) : null}

          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="支払先を検索"
                className="min-h-[36px] w-56 rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100 outline-none focus:border-[var(--accent-cyan)]"
              />
              <select
                value={bankFilter}
                onChange={(event) =>
                  setBankFilter(event.target.value as typeof bankFilter)
                }
                className="min-h-[36px] rounded-lg border border-white/[0.1] bg-surface-1 px-3 text-xs text-zinc-100"
              >
                <option value="all">振込先: すべて</option>
                <option value="registered">振込先: 登録済</option>
                <option value="not_ready">振込先: 未登録 / 不備</option>
              </select>
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={payableOnly}
                  onChange={(event) => setPayableOnly(event.target.checked)}
                />
                支払可能のみ
              </label>
              <span className="text-[11px] text-zinc-500">
                選択 {selectedRows.length} 件
              </span>
            </div>

            <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
              <table className="min-w-[1280px] w-full border-collapse">
                <thead>
                  <tr>
                    <th className={th}></th>
                    <th className={th}>種別</th>
                    <th className={th}>支払先</th>
                    <th className={th}>対象期間</th>
                    <th className={`${th} text-right`}>発生額</th>
                    <th className={`${th} text-right`}>過去支払済</th>
                    <th className={`${th} text-right`}>支払予定中</th>
                    <th className={`${th} text-right`}>代理店分配報酬</th>
                    <th className={`${th} text-right`}>今回は支払わない</th>
                    <th className={`${th} text-right`}>未払残高</th>
                    <th className={`${th} text-right`}>今回支払額</th>
                    <th className={th}>振込先状態</th>
                    <th className={th}>ステータス</th>
                    <th className={th}>明細</th>
                  </tr>
                </thead>
                <tbody>
                  {unpaidRows.length === 0 ? (
                    <tr>
                      <td colSpan={14} className="px-4 py-10 text-center text-sm text-zinc-500">
                        該当する支払先がありません。
                      </td>
                    </tr>
                  ) : (
                    unpaidRows.map((row) => {
                      const key = `${row.payeeKind}:${row.payeeId}`;
                      return (
                        <tr key={key} className="border-b border-zinc-800/70 align-top">
                          <td className={td}>
                            <input
                              type="checkbox"
                              disabled={!row.isPayable}
                              checked={selected.has(key)}
                              onChange={() => toggle(key)}
                              aria-label={`${row.payeeName} を選択`}
                            />
                          </td>
                          <td className={`${td} text-zinc-400`}>
                            {PAYEE_KIND_LABEL[row.payeeKind]}
                          </td>
                          <td className={`${td} whitespace-normal`}>
                            <div className="font-medium text-zinc-100">{row.payeeName}</div>
                            {/*
                              紹介者も独立した支払先。振込先は本人名義で登録する。
                              代理店に所属していても紹介報酬は本人へ支払うため、
                              所属を理由に一覧から外さない（参考情報として出すだけ）。
                            */}
                            <div className="mt-2 max-w-md">
                              <PayeeBankForm
                                payeeKind={row.payeeKind}
                                payeeId={row.payeeId}
                                payeeName={row.payeeName}
                                bank={row.bank}
                              />
                            </div>
                            {row.payeeKind === "referrer" ? (
                              <>
                                <ReferralCreators creators={row.creators} />
                                <ReferralHoldControls
                                  row={row}
                                  cutoffMonth={cutoffMonth}
                                />
                                <ReferralBreakdown
                                  referrerId={row.payeeId}
                                  cutoffMonth={cutoffMonth}
                                  startMonth={
                                    row.periodStartMonth ?? EARLIEST_CUTOFF_MONTH
                                  }
                                />
                              </>
                            ) : null}
                          </td>
                          <td className={`${td} font-mono text-zinc-300`}>
                            {row.periodStartMonth
                              ? row.periodStartMonth === row.periodEndMonth
                                ? row.periodStartMonth
                                : `${row.periodStartMonth}〜${row.periodEndMonth}`
                              : "—"}
                          </td>
                          <td className={`${td} text-right font-mono text-zinc-400`}>
                            {yen(row.grossAmount)}
                          </td>
                          <td className={`${td} text-right font-mono text-zinc-400`}>
                            {yen(row.paidAmount)}
                          </td>
                          <td className={`${td} text-right font-mono text-indigo-200`}>
                            {row.claimedAmount > 0 ? yen(row.claimedAmount) : "—"}
                          </td>
                          {/* 代理店へ支払うのは代理店分配報酬だけ */}
                          <td className={`${td} text-right font-mono text-zinc-300`}>
                            {row.agencyRewardAmount > 0 ? yen(row.agencyRewardAmount) : "—"}
                          </td>
                          {/*
                            「今回は支払わない」分。発生額には含まれるが
                            未払残高（支払対象）からは外れている。
                          */}
                          <td className={`${td} text-right font-mono text-amber-200`}>
                            {row.manualHoldAmount > 0 ? (
                              <span title={`${row.manualHoldItemCount} 件`}>
                                {yen(row.manualHoldAmount)}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className={`${td} text-right font-mono font-semibold text-zinc-100`}>
                            {yen(row.unpaidAmount)}
                          </td>
                          <td className={`${td} text-right`}>
                            {row.isPayable ? (
                              <form action={createAction} className="inline-flex flex-col items-end gap-1">
                                <input type="hidden" name="payee_kind" value={row.payeeKind} />
                                <input type="hidden" name="payee_id" value={row.payeeId} />
                                {/*
                                  上限は締め対象月に固定する。
                                  未払い明細の最終月（データ由来）を送ると
                                  代理店ごとに締め月がばらついてしまう。
                                */}
                                <input
                                  type="hidden"
                                  name="cutoff_month"
                                  value={cutoffMonth}
                                />
                                <input
                                  type="hidden"
                                  name="start_month"
                                  value={row.periodStartMonth ?? EARLIEST_CUTOFF_MONTH}
                                />
                                <span className="font-mono font-semibold text-emerald-300">
                                  {yen(row.unpaidAmount)}
                                </span>
                                <button
                                  type="submit"
                                  disabled={createPending}
                                  className="min-h-[32px] rounded-lg bg-[var(--accent-cyan)] px-3 text-[11px] font-semibold text-black disabled:opacity-50"
                                >
                                  支払明細を作成
                                </button>
                              </form>
                            ) : (
                              <span className="text-zinc-500">—</span>
                            )}
                          </td>
                          <td className={`${td} whitespace-normal`}>
                            <HoldReasons row={row} />
                          </td>
                          <td className={`${td} whitespace-normal`}>
                            {row.openBatches.length === 0 ? (
                              <span className="text-zinc-500">未払い</span>
                            ) : (
                              <div className="flex flex-col gap-1">
                                {row.openBatches.map((batch) => (
                                  <BatchStatusBadge key={batch.id} status={batch.status} />
                                ))}
                              </div>
                            )}
                          </td>
                          <td className={td}>
                            {row.openBatches.length > 0 ? (
                              <div className="flex flex-col gap-1">
                                {row.openBatches.map((batch) => (
                                  <Link
                                    key={batch.id}
                                    href={`/payments/${batch.id}`}
                                    className="text-[11px] font-medium text-[var(--accent-cyan)] hover:underline"
                                  >
                                    支払明細を開く
                                  </Link>
                                ))}
                              </div>
                            ) : (
                              <span className="text-[11px] text-zinc-600">
                                {row.itemCount} 件
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] leading-relaxed text-zinc-500">
              「未払残高」は、支払明細に組み入れていない明細だけの合計です。
              支払明細を作成すると、その分は「支払予定中」へ移り、未払残高から外れます。
              代理店へ支払うのは
              <span className="font-semibold text-zinc-300">代理店分配報酬だけ</span>
              で、紹介報酬は
              <span className="font-semibold text-zinc-300">紹介者本人</span>
              へ支払います。両者を合算しません。
              「今回は支払わない」にした分は発生記録を残したまま支払対象から外れます
              （解除すれば戻ります）。
              対象は締め対象月（{formatCutoffLabel(cutoffMonth)}）までの未払いだけです。
              紹介報酬は {MAX_REFERRAL_PAYMENT_CUTOFF_MONTH} 末締めまでが上限です
              （それ以降は TAP の全量取込が未了）。
              二重に支払対象へ現れることはありません。
            </p>
          </section>
        </>
      )}
    </div>
  );
}

/*
  支払明細の一覧。

  ■ 選択できるのは下書きの代理店明細だけ
  承認・振込中・支払済み・失敗・取消は選択させない。
  選択の可否を画面で絞るが、実際の判定はサーバーとRPCで必ずやり直す。
*/
function BatchTable({
  title,
  batches,
  emptyMessage,
  selectable = false,
  selected,
  onToggle,
}: {
  title: string;
  batches: PaymentBatchSummary[];
  emptyMessage: string;
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (batchId: string) => void;
}) {
  const canSelect = selectable && selected != null && onToggle != null;

  return (
    <section className="space-y-2">
      {title ? <h2 className="text-sm font-semibold text-zinc-200">{title}</h2> : null}
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
        <table className="min-w-[960px] w-full border-collapse">
          <thead>
            <tr>
              {canSelect ? <th className={th}></th> : null}
              <th className={th}>種別</th>
              <th className={th}>支払先</th>
              <th className={th}>締め対象</th>
              <th className={th}>対象期間</th>
              <th className={`${th} text-right`}>明細数</th>
              <th className={`${th} text-right`}>振込額</th>
              <th className={th}>ステータス</th>
              <th className={th}>振込日</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {batches.length === 0 ? (
              <tr>
                <td
                  colSpan={canSelect ? 10 : 9}
                  className="px-4 py-10 text-center text-sm text-zinc-500"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              batches.map((batch) => (
                <tr key={batch.id} className="border-b border-zinc-800/70">
                  {canSelect ? (
                    <td className={td}>
                      <input
                        type="checkbox"
                        disabled={!isBulkApprovable(batch)}
                        checked={selected.has(batch.id)}
                        onChange={() => onToggle(batch.id)}
                        aria-label={`${batch.payeeName} の支払明細を選択`}
                      />
                    </td>
                  ) : null}
                  <td className={`${td} text-zinc-400`}>
                    {PAYEE_KIND_LABEL[batch.payeeKind as PayeeKind]}
                  </td>
                  <td className={`${td} font-medium text-zinc-100`}>{batch.payeeName}</td>
                  <td className={`${td} font-mono text-zinc-300`}>
                    {formatCutoffLabel(batch.cutoffMonth)}
                  </td>
                  <td className={`${td} font-mono text-zinc-400`}>
                    {batch.periodStartMonth === batch.periodEndMonth
                      ? batch.periodStartMonth
                      : `${batch.periodStartMonth}〜${batch.periodEndMonth}`}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {batch.itemCount.toLocaleString("ja-JP")}
                  </td>
                  <td className={`${td} text-right font-mono font-semibold text-zinc-100`}>
                    {yen(batch.paymentAmount)}
                  </td>
                  <td className={td}>
                    <BatchStatusBadge status={batch.status} />
                  </td>
                  <td className={`${td} font-mono text-zinc-400`}>{batch.paidOn ?? "—"}</td>
                  <td className={td}>
                    <Link
                      href={`/payments/${batch.id}`}
                      className="text-[11px] font-medium text-[var(--accent-cyan)] hover:underline"
                    >
                      開く
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SellerInvoiceTable({ overview }: { overview: PaymentOverview }) {
  return (
    <section className="space-y-3">
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-[11px] leading-relaxed text-amber-100">
        セラー請求は
        <span className="font-semibold">「セラー → THREE COMMERCE」への入金</span>
        です。代理店・紹介者への銀行振込とはお金の向きが逆なので、
        支払予定総額には含めていません。
        この画面は読み取り専用です。請求書の作成・発行・入金登録は
        <Link href="/admin/seller-billing" className="ml-1 font-semibold text-amber-200 underline">
          セラー請求画面
        </Link>
        で行ってください。
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
        <table className="min-w-[1080px] w-full border-collapse">
          <thead>
            <tr>
              <th className={th}>請求書番号</th>
              <th className={th}>セラー</th>
              <th className={th}>対象月</th>
              <th className={`${th} text-right`}>請求対象GMV</th>
              <th className={`${th} text-right`}>TSP料率</th>
              <th className={`${th} text-right`}>請求額（税込）</th>
              <th className={th}>状態</th>
              <th className={th}>支払期限</th>
              <th className={th}>入金日</th>
            </tr>
          </thead>
          <tbody>
            {overview.sellerInvoices.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-sm text-zinc-500">
                  請求書がまだありません。
                </td>
              </tr>
            ) : (
              overview.sellerInvoices.map((invoice) => (
                <tr key={invoice.invoiceId} className="border-b border-zinc-800/70">
                  <td className={`${td} font-mono text-zinc-300`}>
                    {invoice.invoiceNumber ?? "—"}
                  </td>
                  <td className={`${td} font-medium text-zinc-100`}>{invoice.sellerName}</td>
                  <td className={`${td} font-mono text-zinc-300`}>{invoice.targetMonth}</td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {yen(invoice.billingGmvAmount)}
                  </td>
                  <td className={`${td} text-right font-mono text-zinc-400`}>
                    {invoice.tspRate}%
                  </td>
                  <td className={`${td} text-right font-mono font-semibold text-zinc-100`}>
                    {yen(invoice.invoiceAmount)}
                  </td>
                  <td className={`${td} text-zinc-300`}>
                    {SELLER_STATUS_LABEL[invoice.status] ?? invoice.status}
                  </td>
                  <td className={`${td} font-mono text-zinc-400`}>{invoice.dueDate ?? "—"}</td>
                  <td className={`${td} font-mono text-zinc-400`}>
                    {invoice.paidAt ? invoice.paidAt.slice(0, 10) : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
