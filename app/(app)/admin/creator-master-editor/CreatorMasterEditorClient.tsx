"use client";

import { useActionState, useMemo, useState } from "react";

import {
  saveCreatorMasterBulkAction,
  type CreatorMasterBulkResult,
} from "@/app/actions/creator-master-bulk-edit";
import {
  ACCOUNT_MANAGEMENT_TYPE_OPTIONS,
  accountManagementTypeLabel,
} from "@/lib/creators/account-management-type";
import type {
  CreatorMasterEditorData,
  CreatorMasterEditorRow,
} from "@/lib/db/creator-master-editor-queries";
import {
  ASSIGNMENT_STATE_LABEL,
  type AssignmentState,
} from "@/lib/creators/assignment-state";

/*
  クリエイターマスタ一括編集ボード。

  ・一覧を見ながら 代理店 / 紹介者 / 区分 を直接変更する
  ・変更した行には「未保存」バッジ
  ・保存前に変更内容（変更前 → 変更後）を必ず確認させる
  ・保存してもDBの報酬明細・月別確定所属は変更しない
*/

const ALL = "all";
const NONE = "none";

/*
  選択肢の3値。
    ""            … 未確認（まだ確認していない）
    NONE_SELECTED … 確認した結果「代理店なし / 紹介者なし」
    実ID          … 設定済み
  NONE_SELECTED はサーバー側（creator-master-bulk-edit.ts）の
  NONE_SENTINEL と同じ文字列にすること。
*/
const NONE_SELECTED = "__none__";
const PAGE_SIZE = 100;

/*
  ■ 列幅の決め方（重要・再発防止）

  以前は th / td に `min-w-[220px]` のような Tailwind クラスを付けて列幅を確保していたが、
  実画面では「所属代理店」「紹介者」が 60px 程度まで潰れていた。原因は次の2点。

  1. min-width / max-width は display: table-cell に対する挙動が CSS 仕様上「未定義」で、
     主要ブラウザは表の列幅計算でこれを無視する。つまり td の min-w-[220px] は効いていない。
  2. 残る width 指定も table-layout: auto では「希望値」でしかなく、
     whitespace-nowrap な他列（月別所属・報酬・状態など）の要求幅が優先されると
     セレクトのある列から削られていく。

  そのため列幅は colgroup + table-layout: fixed で明示する。
  fixed では colgroup の width が確定値として扱われ、他列の中身に影響されない。
  さらにセレクト自身にも px の width / minWidth を inline style で与え、
  Tailwind のクラス生成やカスケードに依存しない構造にしている。

  テーブル幅は各列の合計（TABLE_TOTAL_WIDTH）。
  画面に収めるために列を縮めることはせず、入り切らない分は横スクロールさせる。
*/
const COLUMN_WIDTHS = {
  select: 56,
  tiktokId: 150,
  creatorName: 200,
  agency: 248,
  referrer: 288,
  accountType: 168,
  officialLine: 110,
  registeredAt: 120,
  monthlyAssignment: 150,
  agencyReward: 120,
  referralReward: 120,
  status: 120,
} as const;

const TABLE_TOTAL_WIDTH = Object.values(COLUMN_WIDTHS).reduce(
  (sum, width) => sum + width,
  0,
);

/**
 * セレクト自身の実寸。
 * td の左右パディング（px-3 = 24px）を差し引いても収まる列幅にしてある。
 */
const SELECT_WIDTHS = {
  agency: 220,
  referrer: 260,
  accountType: 140,
} as const;

/** 左端3列の sticky 位置。列幅から積み上げるのでズレない */
const STICKY_LEFT = {
  select: 0,
  tiktokId: COLUMN_WIDTHS.select,
  creatorName: COLUMN_WIDTHS.select + COLUMN_WIDTHS.tiktokId,
} as const;

/*
  table-layout: fixed では列幅を超えた中身が隣のセルへはみ出すため、
  セルは overflow-hidden + text-ellipsis で切る。
*/
const thBase =
  "sticky top-0 z-10 overflow-hidden text-ellipsis whitespace-nowrap border-b border-zinc-800 bg-zinc-950/95 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400";

const td = "overflow-hidden text-ellipsis whitespace-nowrap px-3 py-2 text-xs";

const selectClass =
  "rounded border border-white/[0.08] bg-surface-1 px-2 py-1 text-xs text-zinc-100";

const primarySelectBase =
  "rounded border border-white/[0.08] bg-surface-1 px-2 py-1.5 text-sm text-zinc-100";

/*
  横スクロールしても「誰を編集しているか」が分かるよう、
  左3列（選択 / TikTok ID / クリエイター名）を固定表示する。

  ・sticky セルは背景が透けると下の行が見えてしまうため不透明色を指定する
  ・変更行のハイライト（amber-400/6%）を zinc-950 に重ねた実効色を
    そのまま不透明色として指定し、固定列でも「未保存」が分かるようにする
*/
const thSticky =
  "sticky top-0 z-30 overflow-hidden text-ellipsis whitespace-nowrap border-b border-zinc-800 bg-zinc-950 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400";

const tdSticky =
  "sticky z-20 overflow-hidden text-ellipsis whitespace-nowrap px-3 py-2 text-xs";

/** zinc-950 に amber-400/6% を重ねた実効色（変更行の固定セル用） */
const STICKY_BG_CHANGED = "bg-[#17140d]";
const STICKY_BG_DEFAULT = "bg-zinc-950";

type Draft = {
  agencyId?: string;
  referrerId?: string;
  accountManagementType?: string;
};

type ChangeDetail = {
  row: CreatorMasterEditorRow;
  field: "所属代理店" | "紹介者" | "区分";
  before: string;
  after: string;
};

const MONTHLY_STATE_LABEL: Record<
  CreatorMasterEditorRow["monthlyAssignmentState"],
  string
> = {
  has_monthly: "月別確定あり",
  current_only: "現在所属のみ",
  unset: "未設定",
};

const MONTHLY_STATE_CLASS: Record<
  CreatorMasterEditorRow["monthlyAssignmentState"],
  string
> = {
  has_monthly: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  current_only: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  unset: "border-white/[0.08] bg-white/[0.03] text-zinc-500",
};


/** 選択肢に出す代理店。無効代理店は隠すが、現在値だけは選べるように残す */
/*
  新規選択に出すマスタの絞り込み。
  無効化されたマスタは選ばせないが、いま設定されている値だけは残す
  （残さないと選択肢から消えて意図せず「未設定」へ変わってしまう）。
*/
function selectableMasters<T extends { id: string; isActive: boolean }>(
  options: T[],
  currentId: string | null,
): T[] {
  return options.filter((option) => option.isActive || option.id === currentId);
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function CreatorMasterEditorClient({
  data,
}: {
  data: CreatorMasterEditorData;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const [page, setPage] = useState(0);

  const [search, setSearch] = useState("");
  const [agencyFilter, setAgencyFilter] = useState(ALL);
  const [referrerFilter, setReferrerFilter] = useState(ALL);
  /* 確認状態での絞り込み。一度確認した人を未確認リストに戻さないための要 */
  const [agencyStateFilter, setAgencyStateFilter] = useState<string>(ALL);
  const [referrerStateFilter, setReferrerStateFilter] = useState<string>(ALL);
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [monthlyFilter, setMonthlyFilter] = useState(ALL);
  const [agencyRewardFilter, setAgencyRewardFilter] = useState(ALL);
  const [referralRewardFilter, setReferralRewardFilter] = useState(ALL);

  const [bulkAgencyId, setBulkAgencyId] = useState("");
  const [bulkReferrerId, setBulkReferrerId] = useState("");

  const [state, formAction, pending] = useActionState<
    CreatorMasterBulkResult | null,
    FormData
  >(saveCreatorMasterBulkAction, null);

  const agencyName = useMemo(() => {
    const map = new Map<string, string>();
    for (const agency of data.agencies) map.set(agency.id, agency.name);
    return map;
  }, [data.agencies]);

  const referrerLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const referrer of data.referrers) {
      map.set(referrer.id, referrer.code ? `${referrer.name}（${referrer.code}）` : referrer.name);
    }
    return map;
  }, [data.referrers]);

  /*
    選択欄の現在値。
    ID が無くても「なし確認済」なら NONE_SELECTED を出す。
    これで一度確認した人が再び「未確認」に見えることがなくなる。
  */
  function currentSelection(id: string | null, state: AssignmentState): string {
    if (id) return id;
    return state === "none" ? NONE_SELECTED : "";
  }

  /** 変更後の値（未変更なら現在値） */
  function draftAgency(row: CreatorMasterEditorRow): string {
    return drafts[row.id]?.agencyId ?? currentSelection(row.agencyId, row.agencyState);
  }
  function draftReferrer(row: CreatorMasterEditorRow): string {
    return (
      drafts[row.id]?.referrerId ??
      currentSelection(row.referrerId, row.referrerState)
    );
  }

  /** 選択値を画面表示用のラベルにする */
  function selectionLabel(
    value: string,
    nameOf: (id: string) => string | undefined,
    noneLabel: string,
  ): string {
    if (value === NONE_SELECTED) return noneLabel;
    if (value === "") return "未確認";
    return nameOf(value) ?? "?";
  }
  function draftType(row: CreatorMasterEditorRow): string {
    return drafts[row.id]?.accountManagementType ?? row.accountManagementType;
  }

  function updateDraft(rowId: string, patch: Draft) {
    setDrafts((prev) => ({ ...prev, [rowId]: { ...prev[rowId], ...patch } }));
  }

  const changeDetails: ChangeDetail[] = useMemo(() => {
    const details: ChangeDetail[] = [];

    for (const row of data.rows) {
      const draft = drafts[row.id];
      if (!draft) continue;

      const currentAgency = currentSelection(row.agencyId, row.agencyState);
      if (draft.agencyId !== undefined && draft.agencyId !== currentAgency) {
        details.push({
          row,
          field: "所属代理店",
          before: selectionLabel(
            currentAgency,
            (id) => agencyName.get(id),
            "代理店なし",
          ),
          after: selectionLabel(
            draft.agencyId,
            (id) => agencyName.get(id),
            "代理店なし",
          ),
        });
      }

      const currentReferrer = currentSelection(row.referrerId, row.referrerState);
      if (draft.referrerId !== undefined && draft.referrerId !== currentReferrer) {
        details.push({
          row,
          field: "紹介者",
          before: selectionLabel(
            currentReferrer,
            (id) => referrerLabel.get(id),
            "紹介者なし",
          ),
          after: selectionLabel(
            draft.referrerId,
            (id) => referrerLabel.get(id),
            "紹介者なし",
          ),
        });
      }

      if (
        draft.accountManagementType !== undefined &&
        draft.accountManagementType !== row.accountManagementType
      ) {
        details.push({
          row,
          field: "区分",
          before: accountManagementTypeLabel(row.accountManagementType),
          after: accountManagementTypeLabel(draft.accountManagementType),
        });
      }
    }

    return details;
  }, [agencyName, data.rows, drafts, referrerLabel]);

  const changedRowIds = useMemo(
    () => new Set(changeDetails.map((detail) => detail.row.id)),
    [changeDetails],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.rows.filter((row) => {
      if (agencyStateFilter !== ALL && row.agencyState !== agencyStateFilter) {
        return false;
      }
      if (referrerStateFilter !== ALL && row.referrerState !== referrerStateFilter) {
        return false;
      }
      if (agencyFilter !== ALL) {
        if (agencyFilter === NONE ? row.agencyId !== null : row.agencyId !== agencyFilter) {
          return false;
        }
      }
      if (referrerFilter !== ALL) {
        if (
          referrerFilter === NONE
            ? row.referrerId !== null
            : row.referrerId !== referrerFilter
        ) {
          return false;
        }
      }
      if (typeFilter !== ALL && row.accountManagementType !== typeFilter) return false;
      if (monthlyFilter !== ALL && row.monthlyAssignmentState !== monthlyFilter) {
        return false;
      }
      if (agencyRewardFilter !== ALL) {
        if ((agencyRewardFilter === "yes") !== row.hasAgencyReward) return false;
      }
      if (referralRewardFilter !== ALL) {
        if ((referralRewardFilter === "yes") !== row.hasReferralReward) return false;
      }
      if (!q) return true;
      return (
        row.tiktokId.toLowerCase().includes(q) ||
        row.creatorName.toLowerCase().includes(q)
      );
    });
  }, [
    agencyFilter,
    agencyStateFilter,
    referrerStateFilter,
    agencyRewardFilter,
    data.rows,
    monthlyFilter,
    referralRewardFilter,
    referrerFilter,
    search,
    typeFilter,
  ]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  function applyBulkAgency() {
    if (!bulkAgencyId) return;
    // "未確認" は ""、"代理店なし" は NONE_SELECTED、それ以外は代理店ID
    const value = bulkAgencyId === NONE ? "" : bulkAgencyId;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const id of selected) {
        next[id] = { ...next[id], agencyId: value };
      }
      return next;
    });
  }

  function applyBulkReferrer() {
    if (!bulkReferrerId) return;
    // "未確認" は ""、"紹介者なし" は NONE_SELECTED、それ以外は紹介者ID
    const value = bulkReferrerId === NONE ? "" : bulkReferrerId;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const id of selected) {
        next[id] = { ...next[id], referrerId: value };
      }
      return next;
    });
  }

  function toggleSelect(rowId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  const summary = useMemo(
    () => ({
      creators: changedRowIds.size,
      agency: changeDetails.filter((d) => d.field === "所属代理店").length,
      referrer: changeDetails.filter((d) => d.field === "紹介者").length,
      type: changeDetails.filter((d) => d.field === "区分").length,
    }),
    [changeDetails, changedRowIds],
  );

  /** サーバーへ送る変更行（変更のない項目は "-"） */
  const payload = useMemo(() => {
    const byCreator = new Map<string, { agency: string; referrer: string; type: string }>();

    for (const detail of changeDetails) {
      const entry =
        byCreator.get(detail.row.id) ?? { agency: "-", referrer: "-", type: "-" };
      const draft = drafts[detail.row.id] ?? {};

      if (detail.field === "所属代理店") entry.agency = draft.agencyId ?? "";
      if (detail.field === "紹介者") entry.referrer = draft.referrerId ?? "";
      if (detail.field === "区分") entry.type = draft.accountManagementType ?? "";

      byCreator.set(detail.row.id, entry);
    }

    return [...byCreator.entries()].map(
      ([creatorId, entry]) =>
        `${creatorId}|${entry.agency}|${entry.referrer}|${entry.type}`,
    );
  }, [changeDetails, drafts]);

  return (
    <div className="space-y-5">
      {/*
        「未設定」ではなく「未確認」を出す。
        確認した結果なしだった人（なし確認済）は未確認に含めない。
      */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "クリエイター総数", value: data.totals.creatorCount },
          { label: "代理店 未確認", value: data.totals.agencyUnconfirmed },
          { label: "紹介者 未確認", value: data.totals.referrerUnconfirmed },
          { label: "月別確定あり", value: data.totals.monthlyConfirmedCount },
        ].map((kpi) => (
          <div
            key={kpi.label}
            className="rounded-2xl border border-white/[0.07] bg-surface-1/60 p-4"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
              {kpi.label}
            </p>
            <p className="mt-2 font-mono text-xl font-bold text-zinc-50">{kpi.value}</p>
          </div>
        ))}
      </div>

      {state ? (
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
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {[
          {
            title: "代理店",
            unconfirmed: data.totals.agencyUnconfirmed,
            none: data.totals.agencyNone,
            assigned: data.totals.agencyAssigned,
          },
          {
            title: "紹介者",
            unconfirmed: data.totals.referrerUnconfirmed,
            none: data.totals.referrerNone,
            assigned: data.totals.referrerAssigned,
          },
        ].map((group) => (
          <div
            key={group.title}
            className="rounded-xl border border-white/[0.06] bg-surface-1/40 px-4 py-3"
          >
            <p className="text-[11px] font-semibold text-zinc-300">{group.title}</p>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
              <span className="text-amber-200">
                {ASSIGNMENT_STATE_LABEL.unconfirmed}{" "}
                <span className="font-mono text-sm">{group.unconfirmed}</span> 名
              </span>
              <span className="text-zinc-400">
                {ASSIGNMENT_STATE_LABEL.none}{" "}
                <span className="font-mono text-sm">{group.none}</span> 名
              </span>
              <span className="text-emerald-300">
                {ASSIGNMENT_STATE_LABEL.assigned}{" "}
                <span className="font-mono text-sm">{group.assigned}</span> 名
              </span>
            </div>
          </div>
        ))}
      </div>

      <section className="rounded-xl border border-white/[0.06] bg-surface-1/40 p-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="cme-search" className="text-[11px] font-medium text-zinc-500">
              検索
            </label>
            <input
              id="cme-search"
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="TikTok ID / クリエイター名"
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700"
            />
          </div>

          {/* 確認状態の絞り込み。確認済みの人を未確認リストへ戻さないための要 */}
          <div>
            <label
              htmlFor="cme-agency-state"
              className="text-[11px] font-medium text-zinc-500"
            >
              代理店の確認状態
            </label>
            <select
              id="cme-agency-state"
              value={agencyStateFilter}
              onChange={(e) => {
                setAgencyStateFilter(e.target.value);
                setPage(0);
              }}
              className={`mt-1 w-full ${primarySelectBase}`}
            >
              <option value={ALL}>すべて</option>
              <option value="unconfirmed">
                未確認（{data.totals.agencyUnconfirmed}）
              </option>
              <option value="none">
                なし確認済（{data.totals.agencyNone}）
              </option>
              <option value="assigned">
                設定済み（{data.totals.agencyAssigned}）
              </option>
            </select>
          </div>

          <div>
            <label
              htmlFor="cme-referrer-state"
              className="text-[11px] font-medium text-zinc-500"
            >
              紹介者の確認状態
            </label>
            <select
              id="cme-referrer-state"
              value={referrerStateFilter}
              onChange={(e) => {
                setReferrerStateFilter(e.target.value);
                setPage(0);
              }}
              className={`mt-1 w-full ${primarySelectBase}`}
            >
              <option value={ALL}>すべて</option>
              <option value="unconfirmed">
                未確認（{data.totals.referrerUnconfirmed}）
              </option>
              <option value="none">
                なし確認済（{data.totals.referrerNone}）
              </option>
              <option value="assigned">
                設定済み（{data.totals.referrerAssigned}）
              </option>
            </select>
          </div>

          <div>
            <label htmlFor="cme-agency" className="text-[11px] font-medium text-zinc-500">
              代理店
            </label>
            <select
              id="cme-agency"
              value={agencyFilter}
              onChange={(e) => {
                setAgencyFilter(e.target.value);
                setPage(0);
              }}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              <option value={NONE}>代理店未設定</option>
              {data.agencies.map((agency) => (
                <option key={agency.id} value={agency.id}>
                  {agency.name}
                  {agency.isActive ? "" : "（無効）"}（{agency.creatorCount}）
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="cme-referrer" className="text-[11px] font-medium text-zinc-500">
              紹介者
            </label>
            <select
              id="cme-referrer"
              value={referrerFilter}
              onChange={(e) => {
                setReferrerFilter(e.target.value);
                setPage(0);
              }}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              <option value={NONE}>紹介者なし</option>
              {/* 絞り込みは既存データを見るためのものなので無効紹介者も出す */}
              {data.referrers.map((referrer) => (
                <option key={referrer.id} value={referrer.id}>
                  {referrer.name}
                  {referrer.code ? `（${referrer.code}）` : ""}（{referrer.creatorCount}）
                  {referrer.isActive ? "" : "【無効】"}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="cme-type" className="text-[11px] font-medium text-zinc-500">
              区分
            </label>
            <select
              id="cme-type"
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value);
                setPage(0);
              }}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              {ACCOUNT_MANAGEMENT_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="cme-monthly" className="text-[11px] font-medium text-zinc-500">
              月別所属状態
            </label>
            <select
              id="cme-monthly"
              value={monthlyFilter}
              onChange={(e) => {
                setMonthlyFilter(e.target.value);
                setPage(0);
              }}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              <option value="has_monthly">月別確定あり</option>
              <option value="current_only">現在所属のみ</option>
              <option value="unset">未設定</option>
            </select>
          </div>

          <div>
            <label htmlFor="cme-ar" className="text-[11px] font-medium text-zinc-500">
              代理店報酬
            </label>
            <select
              id="cme-ar"
              value={agencyRewardFilter}
              onChange={(e) => {
                setAgencyRewardFilter(e.target.value);
                setPage(0);
              }}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              <option value="yes">発生あり</option>
              <option value="no">発生なし</option>
            </select>
          </div>

          <div>
            <label htmlFor="cme-rr" className="text-[11px] font-medium text-zinc-500">
              紹介者報酬
            </label>
            <select
              id="cme-rr"
              value={referralRewardFilter}
              onChange={(e) => {
                setReferralRewardFilter(e.target.value);
                setPage(0);
              }}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
            >
              <option value={ALL}>すべて</option>
              <option value="yes">発生あり</option>
              <option value="no">発生なし</option>
            </select>
          </div>

          <div className="flex items-end">
            <p className="text-[11px] text-zinc-500">
              表示 <span className="font-mono text-zinc-300">{filtered.length}</span> /{" "}
              {data.rows.length} 名
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-surface-1/40 p-4">
        <p className="text-xs font-semibold text-zinc-300">
          選択した {selected.size} 名へ一括設定
        </p>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label htmlFor="cme-bulk-agency" className="text-[11px] text-zinc-500">
                所属代理店
              </label>
              <select
                id="cme-bulk-agency"
                value={bulkAgencyId}
                onChange={(e) => setBulkAgencyId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
              >
                <option value="">選択してください</option>
                <option value={NONE}>未確認に戻す</option>
                <option value={NONE_SELECTED}>代理店なし（確認済）にする</option>
                {data.agencies
                  .filter((agency) => agency.isActive)
                  .map((agency) => (
                    <option key={agency.id} value={agency.id}>
                      {agency.name}
                    </option>
                  ))}
              </select>
            </div>
            <button
              type="button"
              onClick={applyBulkAgency}
              disabled={selected.size === 0 || !bulkAgencyId}
              className="min-h-[38px] rounded-lg border border-white/[0.1] px-3 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-40"
            >
              反映
            </button>
          </div>

          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label htmlFor="cme-bulk-referrer" className="text-[11px] text-zinc-500">
                紹介者
              </label>
              <select
                id="cme-bulk-referrer"
                value={bulkReferrerId}
                onChange={(e) => setBulkReferrerId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2 text-sm text-zinc-100"
              >
                <option value="">選択してください</option>
                <option value={NONE}>未確認に戻す</option>
                <option value={NONE_SELECTED}>紹介者なし（確認済）にする</option>
                {selectableMasters(data.referrers, null).map((referrer) => (
                  <option key={referrer.id} value={referrer.id}>
                    {referrer.name}
                    {referrer.code ? `（${referrer.code}）` : ""}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={applyBulkReferrer}
              disabled={selected.size === 0 || !bulkReferrerId}
              className="min-h-[38px] rounded-lg border border-white/[0.1] px-3 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-40"
            >
              反映
            </button>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-zinc-600">
          一括設定は画面上の下書きに反映されるだけです。保存するには下部で内容を確認してください。
        </p>
      </section>

      {/* 列幅を優先し、入りきらない場合はテーブルごと横スクロールさせる */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70">
        <div className="max-h-[min(65vh,760px)] overflow-auto">
          <table
            className="w-full border-collapse text-sm"
            style={{ tableLayout: "fixed", minWidth: TABLE_TOTAL_WIDTH }}
          >
            {/* 列幅はここで確定させる。th/td 側の幅指定には依存しない */}
            <colgroup>
              <col style={{ width: COLUMN_WIDTHS.select }} />
              <col style={{ width: COLUMN_WIDTHS.tiktokId }} />
              <col style={{ width: COLUMN_WIDTHS.creatorName }} />
              <col style={{ width: COLUMN_WIDTHS.agency }} />
              <col style={{ width: COLUMN_WIDTHS.referrer }} />
              <col style={{ width: COLUMN_WIDTHS.accountType }} />
              <col style={{ width: COLUMN_WIDTHS.officialLine }} />
              <col style={{ width: COLUMN_WIDTHS.registeredAt }} />
              <col style={{ width: COLUMN_WIDTHS.monthlyAssignment }} />
              <col style={{ width: COLUMN_WIDTHS.agencyReward }} />
              <col style={{ width: COLUMN_WIDTHS.referralReward }} />
              <col style={{ width: COLUMN_WIDTHS.status }} />
            </colgroup>
            <thead>
              <tr>
                <th className={thSticky} style={{ left: STICKY_LEFT.select }}>
                  選択
                </th>
                <th className={thSticky} style={{ left: STICKY_LEFT.tiktokId }}>
                  TikTok ID
                </th>
                <th
                  className={`${thSticky} border-r border-zinc-800`}
                  style={{ left: STICKY_LEFT.creatorName }}
                >
                  クリエイター名
                </th>
                <th className={thBase}>所属代理店</th>
                <th className={thBase}>紹介者</th>
                <th className={thBase}>区分</th>
                <th className={thBase}>公式LINE</th>
                <th className={thBase}>登録日</th>
                <th className={thBase}>月別所属</th>
                <th className={thBase}>代理店報酬</th>
                <th className={thBase}>紹介者報酬</th>
                <th className={thBase}>状態</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => {
                const changed = changedRowIds.has(row.id);
                const stickyBg = changed ? STICKY_BG_CHANGED : STICKY_BG_DEFAULT;
                return (
                  <tr
                    key={row.id}
                    className={`border-b border-zinc-800/70 ${
                      changed ? "bg-amber-400/[0.06]" : ""
                    }`}
                  >
                    <td
                      className={`${tdSticky} ${stickyBg}`}
                      style={{ left: STICKY_LEFT.select }}
                    >
                      <input
                        type="checkbox"
                        aria-label={`${row.tiktokIdLabel} を選択`}
                        checked={selected.has(row.id)}
                        onChange={() => toggleSelect(row.id)}
                      />
                    </td>
                    <td
                      className={`${tdSticky} ${stickyBg} font-mono text-zinc-300`}
                      style={{ left: STICKY_LEFT.tiktokId }}
                      title="TikTok ID は一意キーのため、この画面では変更できません"
                    >
                      {row.tiktokIdLabel}
                    </td>
                    <td
                      className={`${tdSticky} ${stickyBg} border-r border-zinc-800 text-zinc-200`}
                      style={{ left: STICKY_LEFT.creatorName }}
                      title={row.creatorName}
                    >
                      {row.creatorName}
                    </td>

                    <td className={td}>
                      <select
                        aria-label={`${row.tiktokIdLabel} の所属代理店`}
                        title={
                          draftAgency(row)
                            ? agencyName.get(draftAgency(row)) ?? ""
                            : "未設定"
                        }
                        value={draftAgency(row)}
                        onChange={(e) => updateDraft(row.id, { agencyId: e.target.value })}
                        className={primarySelectBase}
                        style={{
                          width: SELECT_WIDTHS.agency,
                          minWidth: SELECT_WIDTHS.agency,
                        }}
                      >
                        <option value="">未確認</option>
                        <option value={NONE_SELECTED}>代理店なし（確認済）</option>
                        {selectableMasters(data.agencies, row.agencyId).map((agency) => (
                          <option key={agency.id} value={agency.id}>
                            {agency.name}
                            {agency.isActive ? "" : "（無効）"}
                          </option>
                        ))}
                      </select>
                    </td>

                    <td className={td}>
                      <select
                        aria-label={`${row.tiktokIdLabel} の紹介者`}
                        title={
                          draftReferrer(row)
                            ? referrerLabel.get(draftReferrer(row)) ?? ""
                            : "紹介者なし"
                        }
                        value={draftReferrer(row)}
                        onChange={(e) =>
                          updateDraft(row.id, { referrerId: e.target.value })
                        }
                        className={primarySelectBase}
                        style={{
                          width: SELECT_WIDTHS.referrer,
                          minWidth: SELECT_WIDTHS.referrer,
                        }}
                      >
                        <option value="">未確認</option>
                        <option value={NONE_SELECTED}>紹介者なし（確認済）</option>
                        {selectableMasters(data.referrers, row.referrerId).map(
                          (referrer) => (
                            <option key={referrer.id} value={referrer.id}>
                              {referrer.name}
                              {referrer.code ? `（${referrer.code}）` : ""}
                              {referrer.isActive ? "" : "（無効）"}
                            </option>
                          ),
                        )}
                      </select>
                    </td>

                    <td className={td}>
                      <select
                        aria-label={`${row.tiktokIdLabel} の区分`}
                        value={draftType(row)}
                        onChange={(e) =>
                          updateDraft(row.id, { accountManagementType: e.target.value })
                        }
                        className={selectClass}
                        style={{
                          width: SELECT_WIDTHS.accountType,
                          minWidth: SELECT_WIDTHS.accountType,
                        }}
                      >
                        {ACCOUNT_MANAGEMENT_TYPE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </td>

                    <td className={`${td} text-zinc-400`}>
                      {row.officialLineRegistered ? "登録済み" : "未登録"}
                    </td>
                    <td className={`${td} font-mono text-zinc-500`}>
                      {formatDate(row.createdAt)}
                    </td>
                    <td className={td}>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${
                          MONTHLY_STATE_CLASS[row.monthlyAssignmentState]
                        }`}
                        title={
                          row.confirmedMonths.length > 0
                            ? `確定済み: ${row.confirmedMonths.join(", ")}`
                            : undefined
                        }
                      >
                        {MONTHLY_STATE_LABEL[row.monthlyAssignmentState]}
                      </span>
                    </td>
                    <td className={`${td} text-zinc-400`}>
                      {row.hasAgencyReward ? "あり" : "—"}
                    </td>
                    <td className={`${td} text-zinc-400`}>
                      {row.hasReferralReward ? "あり" : "—"}
                    </td>
                    <td className={td}>
                      {changed ? (
                        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-200">
                          未保存
                        </span>
                      ) : (
                        <span className="text-[11px] text-zinc-600">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span>
          {safePage + 1} / {pageCount} ページ（{PAGE_SIZE}件／ページ）
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={safePage <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
          >
            前へ
          </button>
          <button
            type="button"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
          >
            次へ
          </button>
        </div>
      </div>

      <section className="sticky bottom-0 space-y-3 rounded-xl border border-cyan-500/20 bg-surface-0/95 p-4 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-zinc-200">
            変更中{" "}
            <span className="font-mono text-lg font-bold text-amber-200">
              {summary.creators}
            </span>{" "}
            件
            <span className="ml-3 text-[11px] text-zinc-500">
              代理店 {summary.agency} / 紹介者 {summary.referrer} / 区分 {summary.type}
            </span>
          </p>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowConfirm((prev) => !prev)}
              disabled={summary.creators === 0}
              className="min-h-[40px] rounded-lg border border-white/[0.1] px-4 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.06] disabled:opacity-40"
            >
              {showConfirm ? "確認を閉じる" : "変更内容を確認"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDrafts({});
                setShowConfirm(false);
              }}
              disabled={summary.creators === 0}
              className="min-h-[40px] rounded-lg border border-white/[0.1] px-4 text-sm text-zinc-400 transition hover:bg-white/[0.06] disabled:opacity-40"
            >
              変更を破棄
            </button>
          </div>
        </div>

        {showConfirm ? (
          <form action={formAction} className="space-y-3">
            {payload.map((value) => (
              <input key={value} type="hidden" name="changes" value={value} />
            ))}

            <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-800">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr>
                    <th className={thBase}>TikTok ID</th>
                    <th className={thBase}>クリエイター</th>
                    <th className={thBase}>変更項目</th>
                    <th className={thBase}>変更前</th>
                    <th className={thBase}>→</th>
                    <th className={thBase}>変更後</th>
                  </tr>
                </thead>
                <tbody>
                  {changeDetails.map((detail) => (
                    <tr
                      key={`${detail.row.id}-${detail.field}`}
                      className="border-b border-zinc-800/60"
                    >
                      <td className={`${td} font-mono text-zinc-300`}>
                        {detail.row.tiktokIdLabel}
                      </td>
                      <td className={`${td} text-zinc-300`}>{detail.row.creatorName}</td>
                      <td className={`${td} text-zinc-200`}>{detail.field}</td>
                      <td className={`${td} text-zinc-500`}>{detail.before}</td>
                      <td className={`${td} text-zinc-600`}>→</td>
                      <td className={`${td} font-medium text-zinc-100`}>{detail.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] leading-relaxed text-zinc-500">
              保存するのはクリエイターマスタ（現在所属・紹介者・区分）だけです。
              月別確定所属と報酬明細（代理店報酬・紹介者報酬）は変更しません。
              報酬へ反映するには、月別所属の確定 → 代理店報酬の再集計 を別途実行してください。
            </p>

            <button
              type="submit"
              disabled={pending || payload.length === 0}
              className="min-h-[40px] rounded-lg bg-white px-5 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-40"
            >
              {pending ? "保存中…" : `${summary.creators} 件の変更を保存`}
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
