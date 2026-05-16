"use client";

import type { CreatorPaidOrderSummary, OrderListRow } from "@/lib/db/orders-queries";
import { formatYen } from "@/lib/revenue/calc";
import Link from "next/link";
import { useMemo, useState } from "react";

type Props = {
  isAdmin: boolean;
  orders: OrderListRow[];
  summaries: CreatorPaidOrderSummary[];
  loadError: string | null;
};

const ALL_FILTER = "all";

function matchesSearch(order: OrderListRow, query: string) {
  if (!query.trim()) return true;
  const normalized = query.trim().toLowerCase();
  return (
    order.tiktok_order_id.toLowerCase().includes(normalized) ||
    (order.creator_name ?? "").toLowerCase().includes(normalized) ||
    order.creator_tiktok_id.toLowerCase().includes(normalized) ||
    (order.product_name ?? "").toLowerCase().includes(normalized)
  );
}

function isPaidPayment(order: OrderListRow) {
  return order.is_paid;
}

function OrderStatusBadges({ order }: { order: OrderListRow }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {order.is_paid ? (
        <span className="inline-flex whitespace-nowrap rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-200">
          決済済み
        </span>
      ) : null}
      {order.is_cancelled ? (
        <span className="inline-flex whitespace-nowrap rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-200">
          キャンセル
        </span>
      ) : null}
      {order.is_refunded ? (
        <span className="inline-flex whitespace-nowrap rounded-full border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-[11px] text-orange-200">
          返品
        </span>
      ) : null}
      {order.is_commission_target || order.reward_eligible ? (
        <span className="inline-flex whitespace-nowrap rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-200">
          報酬対象
        </span>
      ) : (
        <span className="inline-flex whitespace-nowrap rounded-full border border-zinc-500/30 bg-zinc-500/10 px-2 py-0.5 text-[11px] text-zinc-300">
          報酬対象外
        </span>
      )}
    </div>
  );
}

function OrderCard({ order }: { order: OrderListRow }) {
  return (
    <li className="rounded-xl border border-white/[0.07] bg-surface-1/50 p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-xs text-zinc-500">{order.tiktok_order_id}</p>
          <p className="mt-1 text-sm font-semibold text-zinc-100">
            {order.creator_name ?? "—"}
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            代理店: {order.agency_name ?? "未振り分け"}
          </p>
          <p className="mt-0.5 break-all font-mono text-xs text-zinc-500">
            {order.creator_tiktok_id}
          </p>
        </div>
        <OrderStatusBadges order={order} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2.5 text-sm">
        <div>
          <dt className="text-[10px] text-zinc-600">商品名</dt>
          <dd className="break-words text-zinc-200">{order.product_name ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-zinc-600">所属代理店</dt>
          <dd className="break-words text-zinc-300">{order.agency_name ?? "未振り分け"}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-zinc-600">注文金額</dt>
          <dd className="font-mono text-zinc-200">{formatYen(order.order_amount)}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-zinc-600">報酬ベース</dt>
          <dd className="font-mono text-[var(--accent-cyan)]">
            {formatYen(order.reward_base)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] text-zinc-600">支払い状況</dt>
          <dd className="break-words text-zinc-300">{order.payment_status ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-zinc-600">注文ステータス</dt>
          <dd className="break-words text-zinc-300">{order.order_status ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-zinc-600">配送ステータス</dt>
          <dd className="break-words text-zinc-300">{order.shipping_status ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-zinc-600">キャンセル</dt>
          <dd className="break-words text-zinc-300">{order.cancellation_status ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-zinc-600">返品</dt>
          <dd className="break-words text-zinc-300">{order.return_status ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-zinc-600">対象月</dt>
          <dd className="font-mono text-zinc-300">{order.target_month}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-[10px] text-zinc-600">報酬見込み</dt>
          <dd className="font-mono font-semibold text-gradient-brand">
            {formatYen(order.reward_amount)}
          </dd>
        </div>
      </dl>
    </li>
  );
}

export function OrdersListClient({
  isAdmin,
  orders,
  summaries,
  loadError,
}: Props) {
  const [search, setSearch] = useState("");
  const [orderStatusFilter, setOrderStatusFilter] = useState(ALL_FILTER);
  const [paidOnly, setPaidOnly] = useState(false);
  const [rewardEligibleOnly, setRewardEligibleOnly] = useState(false);

  const orderStatuses = useMemo(() => {
    const values = new Set<string>();
    for (const order of orders) {
      if (order.order_status) values.add(order.order_status);
    }
    return [...values].sort();
  }, [orders]);

  const filteredOrders = useMemo(() => {
    return orders.filter((order) => {
      if (!matchesSearch(order, search)) return false;
      if (orderStatusFilter !== ALL_FILTER && order.order_status !== orderStatusFilter) {
        return false;
      }
      if (paidOnly && !isPaidPayment(order)) return false;
      if (rewardEligibleOnly && !order.reward_eligible) return false;
      return true;
    });
  }, [orderStatusFilter, orders, paidOnly, rewardEligibleOnly, search]);

  const rewardEligibleTotal = useMemo(
    () => filteredOrders.reduce((sum, order) => sum + order.reward_amount, 0),
    [filteredOrders],
  );

  return (
    <div className="space-y-4">
      {loadError ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {loadError}
        </div>
      ) : null}

      {isAdmin ? (
        <AdminSyncLink />
      ) : null}

      <section className="space-y-3 rounded-2xl border border-white/[0.06] bg-surface-1/40 p-3 sm:p-4">
        <div>
          <label
            className="text-[11px] font-medium uppercase tracking-wider text-zinc-500"
            htmlFor="orders-search"
          >
            検索
          </label>
          <input
            id="orders-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="注文ID / クリエイター名 / TikTok ID / 商品名"
            className="mt-1.5 w-full rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label
              className="text-[11px] font-medium uppercase tracking-wider text-zinc-500"
              htmlFor="orders-status-filter"
            >
              注文ステータス
            </label>
            <select
              id="orders-status-filter"
              value={orderStatusFilter}
              onChange={(event) => setOrderStatusFilter(event.target.value)}
              className="mt-1.5 w-full rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-[var(--accent-cyan)]/40"
            >
              <option value={ALL_FILTER}>すべて</option>
              {orderStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>

          <label className="flex min-h-[44px] items-center gap-2 rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={paidOnly}
              onChange={(event) => setPaidOnly(event.target.checked)}
            />
            決済済みのみ
          </label>

          <label className="flex min-h-[44px] items-center gap-2 rounded-xl border border-white/[0.08] bg-surface-0 px-3 py-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={rewardEligibleOnly}
              onChange={(event) => setRewardEligibleOnly(event.target.checked)}
            />
            報酬対象のみ
          </label>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-white/[0.06] bg-surface-1/40 px-4 py-3 text-sm text-zinc-400">
          表示件数:{" "}
          <span className="font-mono text-zinc-200">{filteredOrders.length}</span> /{" "}
          {orders.length}
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-surface-1/40 px-4 py-3 text-sm text-zinc-400">
          報酬対象合計:{" "}
          <span className="font-mono font-semibold text-gradient-brand">
            {formatYen(rewardEligibleTotal)}
          </span>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-200">
          クリエイター別の決済済み売上集計
        </h2>
        {summaries.length === 0 ? (
          <p className="rounded-xl border border-white/[0.06] bg-surface-1/40 px-4 py-6 text-center text-sm text-zinc-500">
            集計対象の決済済み注文はありません。
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {summaries.map((summary) => (
              <li
                key={summary.creator_id}
                className="rounded-xl border border-white/[0.07] bg-surface-1/50 p-3.5"
              >
                <p className="font-semibold text-zinc-100">{summary.creator_name}</p>
                <p className="mt-0.5 font-mono text-xs text-zinc-500">
                  {summary.tiktok_id}
                </p>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-[10px] text-zinc-600">決済済み売上</dt>
                    <dd className="font-mono text-zinc-200">
                      {formatYen(summary.paid_sales_month)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-zinc-600">報酬対象収益</dt>
                    <dd className="font-mono text-[var(--accent-cyan)]">
                      {formatYen(summary.reward_profit_month)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-zinc-600">注文件数</dt>
                    <dd className="font-mono text-zinc-300">{summary.order_count_month}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-zinc-600">報酬見込み</dt>
                    <dd className="font-mono font-semibold text-gradient-brand">
                      {formatYen(summary.reward_amount_month)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      {filteredOrders.length === 0 ? (
        <p className="rounded-xl border border-white/[0.06] bg-surface-1/40 px-4 py-8 text-center text-sm text-zinc-500">
          条件に一致する注文はありません。
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {filteredOrders.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AdminSyncLink() {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-surface-1/40 p-3 sm:p-4">
      <p className="text-sm text-zinc-400">
        TikTok Shop から注文を取り込むには本番 API 同期画面を利用してください。
      </p>
      <Link
        href="/admin/api-sync"
        className="mt-3 inline-flex min-h-[40px] items-center justify-center rounded-lg bg-gradient-to-r from-[var(--accent-cyan)]/90 to-[var(--accent-magenta)]/80 px-4 py-2 text-sm font-semibold text-zinc-950"
      >
        本番 API 同期へ
      </Link>
    </div>
  );
}
