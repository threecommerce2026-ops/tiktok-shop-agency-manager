/*
  agencies.id を参照しているテーブルの定義（単一ソース）。

  実スキーマの外部キー制約から確認した全 12 カラム / 11 テーブル。
  推測ではなく information_schema.table_constraints で検証済み。

    affiliate_order_lines.agency_id                      (SET NULL)
    agency_payouts.agency_id                             (CASCADE)
    agency_reward_items.agency_id                        (CASCADE)
    creator_assignment_logs.from_agency_id               (SET NULL)
    creator_assignment_logs.to_agency_id                 (SET NULL)
    creator_monthly_agency_assignment_logs.from_agency_id(SET NULL)
    creator_monthly_agency_assignment_logs.to_agency_id  (SET NULL)
    creator_monthly_agency_assignments.agency_id         (SET NULL)
    creators.agency_id                                   (SET NULL)
    csv_import_logs.agency_id                            (RESTRICT)
    orders.agency_id                                     (SET NULL)
    profiles.agency_id                                   (RESTRICT)

  ■ 物理削除の危険性
  agency_payouts と agency_reward_items は ON DELETE CASCADE のため、
  代理店を削除すると報酬明細と支払レコードが道連れで消える。
  そのため参照が1件でもある代理店は物理削除を禁止する。
*/

export type AgencyReferenceKind =
  /** 統合時に agency_id を付け替える */
  | "reassign"
  /** 履歴なので統合時も当時の値を残す（付け替えない） */
  | "history";

export type AgencyReferenceTable = {
  table: string;
  column: string;
  label: string;
  kind: AgencyReferenceKind;
  /** 削除時の外部キー動作 */
  onDelete: "cascade" | "set null" | "restrict";
  /** 統合の付け替え対象にするか */
  reassignOnMerge: boolean;
};

export const AGENCY_REFERENCE_TABLES: readonly AgencyReferenceTable[] = [
  {
    table: "creators",
    column: "agency_id",
    label: "現在所属クリエイター",
    kind: "reassign",
    onDelete: "set null",
    reassignOnMerge: true,
  },
  {
    table: "creator_monthly_agency_assignments",
    column: "agency_id",
    label: "月別確定所属",
    kind: "reassign",
    onDelete: "set null",
    reassignOnMerge: true,
  },
  {
    table: "agency_reward_items",
    column: "agency_id",
    label: "代理店報酬明細",
    kind: "reassign",
    onDelete: "cascade",
    reassignOnMerge: true,
  },
  {
    table: "agency_payouts",
    column: "agency_id",
    label: "代理店支払レコード",
    kind: "reassign",
    onDelete: "cascade",
    reassignOnMerge: true,
  },
  {
    table: "profiles",
    column: "agency_id",
    label: "ログインユーザー",
    kind: "reassign",
    onDelete: "restrict",
    reassignOnMerge: true,
  },
  {
    table: "affiliate_order_lines",
    column: "agency_id",
    label: "注文明細（取込時の代理店）",
    kind: "reassign",
    onDelete: "set null",
    reassignOnMerge: true,
  },
  {
    table: "orders",
    column: "agency_id",
    label: "注文（旧テーブル）",
    kind: "reassign",
    onDelete: "set null",
    reassignOnMerge: true,
  },
  {
    table: "csv_import_logs",
    column: "agency_id",
    label: "CSV取込履歴",
    kind: "history",
    onDelete: "restrict",
    reassignOnMerge: true,
  },
  {
    table: "creator_assignment_logs",
    column: "from_agency_id",
    label: "振り分け履歴（変更前）",
    kind: "history",
    onDelete: "set null",
    reassignOnMerge: false,
  },
  {
    table: "creator_assignment_logs",
    column: "to_agency_id",
    label: "振り分け履歴（変更後）",
    kind: "history",
    onDelete: "set null",
    reassignOnMerge: false,
  },
  {
    table: "creator_monthly_agency_assignment_logs",
    column: "from_agency_id",
    label: "月別所属履歴（変更前）",
    kind: "history",
    onDelete: "set null",
    reassignOnMerge: false,
  },
  {
    table: "creator_monthly_agency_assignment_logs",
    column: "to_agency_id",
    label: "月別所属履歴（変更後）",
    kind: "history",
    onDelete: "set null",
    reassignOnMerge: false,
  },
] as const;

/** 統合時に agency_id を付け替える対象 */
export const AGENCY_MERGE_TABLES = AGENCY_REFERENCE_TABLES.filter(
  (ref) => ref.reassignOnMerge,
);

export function referenceKey(ref: AgencyReferenceTable): string {
  return `${ref.table}.${ref.column}`;
}
