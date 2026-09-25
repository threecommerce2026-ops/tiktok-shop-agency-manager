/*
  referrers.id を参照している箇所の定義（単一ソース）。

  ■ 調査方法
  推測ではなく、本番スキーマの information_schema から実際の外部キーを列挙して確認した。

    creator_referrals.referrer_id           FK → referrers(id)  ON DELETE CASCADE
    creators.referred_by_referrer_id        FK → referrers(id)  ON DELETE SET NULL
    referral_payouts.referrer_id            FK → referrers(id)  ON DELETE CASCADE
    referral_reward_items.referrer_id       FK → referrers(id)  ON DELETE CASCADE

  外部キーを持たない間接参照も併せて確認した。

    referrers.user_id                       FK → auth.users(id) ON DELETE SET NULL
      … 紹介者ポータルのログインアカウント。統合では引き継がない（後述）
    master_name_change_logs.target_id       FK なし（target_type='referrer' のとき referrer_id）
      … 名称変更の履歴。当時の ID を残す必要があるため付け替えない

  public スキーマ内で列名に referrer を含む uuid 列は上記4つのみで、
  紹介コードを別テーブルへ複製している箇所は存在しない（referrers.referral_code だけ）。

  ■ 物理削除の危険性
  creator_referrals / referral_payouts / referral_reward_items は ON DELETE CASCADE。
  紹介者を削除すると紹介報酬明細と支払レコードが道連れで消える。
  そのため参照が1件でもある紹介者は物理削除を禁止する。
*/

export type ReferrerReferenceKind =
  /** 統合時に referrer_id を付け替える */
  | "reassign"
  /** 履歴なので統合時も当時の値を残す（付け替えない） */
  | "history";

export type ReferrerReferenceTable = {
  table: string;
  column: string;
  label: string;
  kind: ReferrerReferenceKind;
  /** 削除時の外部キー動作 */
  onDelete: "cascade" | "set null" | "restrict" | "none";
  /** 統合の付け替え対象にするか */
  reassignOnMerge: boolean;
};

export const REFERRER_REFERENCE_TABLES: readonly ReferrerReferenceTable[] = [
  {
    table: "creators",
    column: "referred_by_referrer_id",
    label: "紐付けクリエイター（現在値）",
    kind: "reassign",
    onDelete: "set null",
    reassignOnMerge: true,
  },
  {
    table: "creator_referrals",
    column: "referrer_id",
    label: "紹介リンク（料率・期間）",
    kind: "reassign",
    onDelete: "cascade",
    reassignOnMerge: true,
  },
  {
    table: "referral_reward_items",
    column: "referrer_id",
    label: "紹介者報酬明細",
    kind: "reassign",
    onDelete: "cascade",
    reassignOnMerge: true,
  },
  {
    table: "referral_payouts",
    column: "referrer_id",
    label: "紹介者支払レコード",
    kind: "reassign",
    onDelete: "cascade",
    reassignOnMerge: true,
  },
  {
    table: "master_name_change_logs",
    column: "target_id",
    label: "名称変更履歴",
    kind: "history",
    onDelete: "none",
    reassignOnMerge: false,
  },
] as const;

/** 統合時に referrer_id を付け替える対象 */
export const REFERRER_MERGE_TABLES = REFERRER_REFERENCE_TABLES.filter(
  (ref) => ref.reassignOnMerge,
);

/** 物理削除の可否判定に使う（履歴も含めた全参照） */
export const REFERRER_DELETE_BLOCKING_TABLES = REFERRER_REFERENCE_TABLES.filter(
  (ref) => ref.reassignOnMerge,
);

export function referrerReferenceKey(ref: ReferrerReferenceTable): string {
  return `${ref.table}.${ref.column}`;
}

/*
  紹介者名の正規化。重複候補の検出にのみ使う。
  ここで一致しても「同一人物」と断定はしない（同姓同名がありうる）。

  ・NFKC で全角/半角を揃える
  ・空白（半角・全角）と記号を除去する
  ・敬称（さん / 様 / 氏）を末尾から取り除く
  ・旧字体／異体字を新字体へ寄せる（例: 廣瀨→廣瀬、澤﨑→澤崎）
    ※ 読みが同じだけの別漢字（沙 と 紗 など）は寄せない。
      そちらは編集距離1の「似ている名前」として別途拾う。
*/

/** 旧字体・異体字 → 新字体。人名で実際に揺れるものだけを入れる */
const KANJI_VARIANTS: Record<string, string> = {
  "﨑": "崎",
  "瀨": "瀬",
  "邉": "辺",
  "邊": "辺",
  "澤": "沢",
  "濱": "浜",
  "髙": "高",
  "德": "徳",
  "齋": "斉",
  "齊": "斉",
  "栁": "柳",
  "廣": "広",
  "眞": "真",
  "嶋": "島",
  "槗": "橋",
  "舘": "館",
  "曾": "曽",
};

const HONORIFIC_SUFFIX = /(さん|さま|様|氏|君|くん|ちゃん)+$/;

export function normalizeReferrerName(value: string): string {
  const base = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　.,!！?？・･ー\-－_（）()【】[\]"'`]/g, "");

  const folded = [...base].map((char) => KANJI_VARIANTS[char] ?? char).join("");
  return folded.replace(HONORIFIC_SUFFIX, "");
}

/**
 * 2つの文字列の編集距離が 1 以下かどうか。
 * 「望月亮介 / 望月亮佑」「池田卓也 / 池田卓矢」のような1文字違いを拾う。
 * 距離の上限が1なので、途中で2を超えた時点で打ち切れる。
 */
export function isWithinEditDistanceOne(a: string, b: string): boolean {
  if (a === b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;

  let i = 0;
  let j = 0;
  let diff = 0;

  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
      continue;
    }
    diff += 1;
    if (diff > 1) return false;
    if (short.length === long.length) {
      i += 1;
      j += 1;
    } else {
      j += 1;
    }
  }

  return diff + (long.length - j) + (short.length - i) <= 1;
}

/** メールアドレスの正規化（大文字小文字のみ吸収。別名扱いはしない） */
export function normalizeReferrerEmail(value: string | null): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** 電話番号の正規化（数字以外を除去） */
export function normalizeReferrerPhone(value: string | null): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

/** 口座情報の正規化（銀行 / 支店 / 口座番号がすべて揃っている場合のみ） */
export function normalizeReferrerBankKey(row: {
  bankName: string | null;
  bankBranchName: string | null;
  bankAccountNumber: string | null;
}): string | null {
  const bank = (row.bankName ?? "").normalize("NFKC").replace(/\s/g, "");
  const branch = (row.bankBranchName ?? "").normalize("NFKC").replace(/\s/g, "");
  const number = (row.bankAccountNumber ?? "").replace(/\D/g, "");
  if (!bank || !branch || !number) return null;
  return `${bank}/${branch}/${number}`;
}
