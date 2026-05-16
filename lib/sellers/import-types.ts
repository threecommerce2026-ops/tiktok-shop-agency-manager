/** 1行分（クライアント解析 → サーバー preview / execute に渡す） */
export type SellerImportSourceRow = {
  source_created_at: string | null;
  seller_name: string;
  shop_name: string;
  contact_person: string | null;
  contact_phone: string | null;
  contact_email: string | null;
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
};

export type SellerImportPreviewResult =
  | {
      ok: true;
      rows: SellerImportPreviewRow[];
      counts: { total: number; new: number; update: number; error: number };
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
};
