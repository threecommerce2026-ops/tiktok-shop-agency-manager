import type { SellerMatchSnapshot } from "@/lib/sellers/import-types";

/*
  取込UPDATE時の「空欄で既存の非空値を消さない」ルール。

  同一セラーと判定された後続行に値が入っていない場合、
  その列は patch から取り除き、DBの既存値をそのまま残す。

  ■ このルールを適用する列
  フォームに記入漏れがありうる自由入力列だけ。
  空欄＝「今回の行では情報が無い」であって「空にしたい」ではない。

  ■ 適用しない列とその理由
    raw_import_json        … 常に非空。その行の原本データなので行ごとに上書きする
    import_source          … 常に非空
    source_created_at      … 解釈できた時だけ patch に入る（呼び出し側で制御済み）
    status                 … 辞退のときだけ stopped を入れる（呼び出し側で制御済み）
    is_tsp_billing_eligible… 空欄由来ではなく備考から導出した真偽値。
                             一律に空欄扱いできないため、ここでは触らない。
*/
export const BLANK_PRESERVING_SELLER_FIELDS = [
  "seller_name",
  "shop_name",
  "contact_person",
  "contact_email",
  "contact_phone",
  "contract_status",
  "tsp_link_status",
  "sales_status",
  "initial_fee_note",
  "payment_status_note",
  "form_note",
] as const;

export type BlankPreservingSellerField =
  (typeof BLANK_PRESERVING_SELLER_FIELDS)[number];

/*
  進行方向が決まっているステータス列。値が後退する上書きを拒否する。

  ■ 順序の根拠（実データのdistinct値から確認）
    contract_status … 登録フォーム62行: 「送付済み」27件 / 「締結完了」34件 / 空1件
                      契約書は 送付 → 締結 の順にしか進まないため、
                      締結完了 → 送付済み への後退は取り込まない。

  ■ ここに入れていない列と理由
    sales_status     … 実データは「準備中」18件 /「開始」16件 の2値。
                      準備中 → 開始 の進行に見えるが、業務上
                      「開始 → 準備中（一時停止）」があり得るか未確認のため、
                      順序を勝手に決めずに保留する。
    tsp_link_status  … 実データの非空値は「済み」のみ。比較対象が無いため不要。

  順位表に無い値（新しい選択肢が増えた場合など）は比較せず、
  今までどおり新しい値で上書きする。判断できないものを勝手に拒否しない。
*/
export const SELLER_STATUS_PROGRESSION: Partial<
  Record<BlankPreservingSellerField, Record<string, number>>
> = {
  contract_status: {
    送付済み: 1,
    締結完了: 2,
  },
};

/**
 * 新しい値がステータスを後退させるか。
 * どちらかの値が順位表に無ければ false（＝判断できないので上書きを止めない）。
 */
export function isStatusRegression(
  field: BlankPreservingSellerField,
  existingValue: unknown,
  incomingValue: unknown,
): boolean {
  const ranks = SELLER_STATUS_PROGRESSION[field];
  if (!ranks) return false;

  const before = ranks[String(existingValue ?? "").trim()];
  const after = ranks[String(incomingValue ?? "").trim()];
  if (before === undefined || after === undefined) return false;

  return after < before;
}

/** null / undefined / 空白のみ を「値なし」とみなす */
export function isBlankImportValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

export type SellerUpdateMergeResult = {
  /** 実際にUPDATEへ渡す patch */
  patch: Record<string, unknown>;
  /** 空欄だったため既存値を維持した列 */
  preservedFields: BlankPreservingSellerField[];
  /** 後退を防ぐために既存値を維持したステータス列 */
  blockedRegressions: Array<{
    field: BlankPreservingSellerField;
    existingValue: string;
    rejectedValue: string;
  }>;
};

/**
 * 新しい patch が空欄で、既存に値がある列を patch から取り除く。
 * 新しい値が入っている列は今までどおり上書きする。
 */
export function mergeSellerUpdatePatch(
  existing: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): SellerUpdateMergeResult {
  const merged: Record<string, unknown> = { ...patch };
  const preservedFields: BlankPreservingSellerField[] = [];
  const blockedRegressions: SellerUpdateMergeResult["blockedRegressions"] = [];

  if (!existing) return { patch: merged, preservedFields, blockedRegressions };

  for (const field of BLANK_PRESERVING_SELLER_FIELDS) {
    if (!(field in merged)) continue;

    // 空欄で既存の非空値を消さない
    if (isBlankImportValue(merged[field])) {
      if (isBlankImportValue(existing[field])) continue;
      delete merged[field];
      preservedFields.push(field);
      continue;
    }

    // ステータスを後退させない
    if (isStatusRegression(field, existing[field], merged[field])) {
      blockedRegressions.push({
        field,
        existingValue: String(existing[field]).trim(),
        rejectedValue: String(merged[field]).trim(),
      });
      delete merged[field];
    }
  }

  return { patch: merged, preservedFields, blockedRegressions };
}

/** プレビュー用: 同一セラー判定された2行で、非空の値が食い違う列 */
export type SellerImportConflict = {
  field: BlankPreservingSellerField;
  existingValue: string;
  incomingValue: string;
};

export function collectSellerImportConflicts(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
): SellerImportConflict[] {
  if (!existing) return [];

  const out: SellerImportConflict[] = [];
  for (const field of BLANK_PRESERVING_SELLER_FIELDS) {
    if (!(field in incoming)) continue;

    const a = existing[field];
    const b = incoming[field];
    if (isBlankImportValue(a) || isBlankImportValue(b)) continue;
    if (String(a).trim() === String(b).trim()) continue;
    // 後退が拒否される列は上書きされないので、失われる値ではない
    if (isStatusRegression(field, a, b)) continue;

    out.push({
      field,
      existingValue: String(a).trim(),
      incomingValue: String(b).trim(),
    });
  }
  return out;
}

/** 画面表示用の列名 */
export const SELLER_FIELD_LABEL_JA: Record<BlankPreservingSellerField, string> = {
  seller_name: "会社名",
  shop_name: "SHOP名",
  contact_person: "担当者",
  contact_email: "メールアドレス",
  contact_phone: "電話番号",
  contract_status: "契約書",
  tsp_link_status: "TSP連携",
  sales_status: "販売",
  initial_fee_note: "初期費用",
  payment_status_note: "支払い",
  form_note: "備考",
};

/** 重複判定に使う最小スナップショットを、上書き判定用の全列付きに拡張した型 */
export type SellerImportSnapshotRow = SellerMatchSnapshot & Record<string, unknown>;
