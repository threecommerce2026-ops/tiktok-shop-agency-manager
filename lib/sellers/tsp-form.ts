/*
  TSP登録フォーム（TikTok SHOP PARTNER 登録フォーム）の解釈。単一ソース。

  実運用中のExcelフォーマットを変えずに取り込むための変換をここに集約する。

  ■ 実ファイルで確認した distinct 値（62行）
    契約書     : 締結完了 34 / 送付済み 27 / 空 1
    TSP連携    : 済み 23 / 空 39
    販売       : 開始 16 / 準備中 18 / 空 28
    初期費用   : "20万" 2 / 空 60
    支払い     : 未 1 / 空 61
    備考(末尾) : 辞退 2 / 連携未 1 / TAP連携のみ 1 / 空 58

  値は今後増えうるため boolean 化せず、原文のまま保存する。
  判定が必要なもの（辞退 / TAP連携のみ）だけをここで解釈する。
*/

/** 備考欄で「辞退」と判断する値 */
const DECLINED_NOTES = ["辞退"];

/** 備考欄で「TAP連携のみ（TSP請求対象外）」と判断する値 */
const TAP_ONLY_NOTES = ["TAP連携のみ"];

export type TspFormFields = {
  /** 契約書（締結完了 / 送付済み など） */
  contract_status: string | null;
  /** TSP連携（済み など） */
  tsp_link_status: string | null;
  /** 販売（開始 / 準備中 など） */
  sales_status: string | null;
  /** 初期費用（20万 など。自由文） */
  initial_fee_note: string | null;
  /** 支払い（未 など） */
  payment_status_note: string | null;
  /** 備考（辞退 / 連携未 / TAP連携のみ など） */
  form_note: string | null;
};

function normalize(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).normalize("NFKC").trim();
  return text.length > 0 ? text : null;
}

/** 辞退したセラーか */
export function isDeclinedSeller(fields: Pick<TspFormFields, "form_note">): boolean {
  const note = normalize(fields.form_note);
  return note != null && DECLINED_NOTES.includes(note);
}

/** TAP連携のみのセラーか（TSP請求の対象外） */
export function isTapOnlySeller(fields: Pick<TspFormFields, "form_note">): boolean {
  const note = normalize(fields.form_note);
  return note != null && TAP_ONLY_NOTES.includes(note);
}

/**
 * TSP請求の対象か。
 *
 * 辞退・TAP連携のみ は対象外。それ以外は対象とする。
 * 契約書や販売の進捗では判定しない（請求できるかは契約料率の有無で決まるため）。
 */
export function resolveTspBillingEligible(
  fields: Pick<TspFormFields, "form_note">,
): boolean {
  return !isDeclinedSeller(fields) && !isTapOnlySeller(fields);
}

/**
 * 取込時に設定する status。
 *
 * 辞退なら stopped。それ以外は呼び出し側の既定（新規は pending）に任せる。
 * 既存セラーの status を勝手に書き換えないため、null を返した場合は変更しない。
 */
export function resolveImportStatus(
  fields: Pick<TspFormFields, "form_note">,
): "stopped" | null {
  return isDeclinedSeller(fields) ? "stopped" : null;
}

/*
  創建時間のパース。

  実ファイルの形式は1種類だけだった。
    "2026年04月03日14時14分46秒"  （61行）
    空                            （1行）

  この形式と ISO 形式、Excel のシリアル値だけを受け付ける。
  それ以外は推測で変換せず null を返し、呼び出し側で要確認として扱う。
*/
const JP_DATETIME =
  /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2})時(\d{1,2})分(?:(\d{1,2})秒)?)?$/;

export type ParsedFormDate = {
  /** ISO 文字列。解釈できなければ null */
  iso: string | null;
  /** 値はあるが解釈できなかった（要確認） */
  unparsable: boolean;
};

export function parseFormCreatedAt(value: unknown): ParsedFormDate {
  if (value == null || String(value).trim() === "") {
    return { iso: null, unparsable: false };
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { iso: null, unparsable: true }
      : { iso: value.toISOString(), unparsable: false };
  }

  // Excel シリアル値（1899-12-30 起点）
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 20000 && value < 120000) {
      const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
      if (!Number.isNaN(date.getTime())) {
        return { iso: date.toISOString(), unparsable: false };
      }
    }
    return { iso: null, unparsable: true };
  }

  const text = String(value).normalize("NFKC").trim();

  const jp = JP_DATETIME.exec(text);
  if (jp) {
    const [, y, mo, d, h, mi, s] = jp;
    /*
      フォームの時刻は日本時間。UTC へ変換して保存する。
      ローカルタイムゾーン依存にしないため、JST(+9) を明示的に引く。
    */
    const utcMs = Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h ?? 0) - 9,
      Number(mi ?? 0),
      Number(s ?? 0),
    );
    const date = new Date(utcMs);
    return Number.isNaN(date.getTime())
      ? { iso: null, unparsable: true }
      : { iso: date.toISOString(), unparsable: false };
  }

  // ISO など標準的な形式
  const iso = new Date(text);
  if (!Number.isNaN(iso.getTime())) {
    return { iso: iso.toISOString(), unparsable: false };
  }

  // 推測で日付を作らない
  return { iso: null, unparsable: true };
}
