/** 1行分（クライアント解析 → サーバー preview / execute に渡す） */
export type SellerImportSourceRow = {
  source_created_at: string | null;
  seller_name: string;
  shop_name: string;
  /** 同一ショップと確認済みの改称でSHOP名を揃えた場合、その元の表記 */
  shop_name_override_from?: string | null;
  contact_person: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  /** 創建時間が空ではないのに解釈できなかった（要確認） */
  source_created_at_unparsable: boolean;
  /** TSP登録フォームの運用列（原文のまま保持） */
  contract_status: string | null;
  tsp_link_status: string | null;
  sales_status: string | null;
  initial_fee_note: string | null;
  payment_status_note: string | null;
  form_note: string | null;
  /** 備考から導出。辞退・TAP連携のみ は false */
  is_tsp_billing_eligible: boolean;
  /** 辞退なら "stopped"。それ以外は null（既存statusを変えない） */
  import_status: "stopped" | null;
  /** 取込元セルの生データ（行単位で sellers.raw_import_json に保存） */
  raw_import_json: Record<string, unknown>;
};

export type SellerImportPreviewRow = {
  index: number;
  seller_name: string;
  shop_name: string;
  contact_person: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  status: "new" | "update" | "error";
  errorMessage?: string;
  /** 同じファイル内で既出の行と重複している */
  duplicateInFile?: boolean;
  declined?: boolean;
  tapOnly?: boolean;
  /** 創建時間が解釈できないなど、取込はできるが確認したい行 */
  needsReview?: boolean;
  reviewMessage?: string;
  /** 同一セラー判定された行と非空の値が食い違う（どちらを残すか要確認） */
  conflictMessage?: string;
  /** 自動統合はしないが確認したい候補（メール/電話一致、別ショップ等） */
  matchWarning?: string;
  /** ステータス後退を拒否して既存値を維持した列 */
  regressionMessage?: string;
};

export type SellerImportPreviewResultCounts = {
  total: number;
  new: number;
  update: number;
  error: number;
  /** 同じファイル内で重複していた行 */
  duplicateInFile: number;
  declined: number;
  tapOnly: number;
  /** 取込はできるが確認したい行（創建時間を解釈できない等） */
  needsReview: number;
  /** 非空の値が食い違い、どちらを残すか要確認の行 */
  conflict: number;
  /** 自動統合せず警告だけ出した候補の種類別件数 */
  emailOnly: number;
  phoneOnly: number;
  sameCompanyOtherShop: number;
  sameShopOtherCompany: number;
  /** ステータス後退を拒否して既存値を維持した列の延べ件数 */
  blockedRegression: number;
};

export type SellerImportPreviewResult =
  | {
      ok: true;
      rows: SellerImportPreviewRow[];
      counts: SellerImportPreviewResultCounts;
    }
  | { ok: false; error: string };

export type SellerImportExecuteResult =
  | {
      ok: true;
      message: string;
      newCount: number;
      updateCount: number;
      errorCount: number;
      /** 取込自体は成功したが履歴テーブル保存のみ失敗した場合 */
      warning?: string;
    }
  | { ok: false; error: string };

export type SellerMatchSnapshot = {
  id: string;
  seller_name: string;
  shop_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  /** 既存sellerのTikTok Shop ID。取込側にも shop_id がある場合の最優先キー */
  shop_id?: string | null;
};
