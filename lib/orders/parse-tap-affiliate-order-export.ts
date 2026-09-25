import * as XLSX from "xlsx";
import crypto from "node:crypto";

export type TapAffiliateOrderRow = {
  sourceRowKey: string;
  orderId: string;
  skuId: string | null;
  productId: string | null;
  productName: string | null;

  creatorTikTokId: string | null;
  creatorName: string | null;

  shopName: string | null;
  shopCode: string | null;

  targetMonth: string | null;

  contentType: string | null;
  contentId: string | null;
  invitationId: string | null;
  commissionType: string | null;

  productPrice: number;
  quantity: number;

  commissionGmv: number;
  commissionBase: number;

  partnerEstimatedCommission: number;
  partnerShopAdsEstimatedCommission: number;
  partnerBonusEstimatedCommission: number;

  tapRevenue: number;

  paymentStatus: string | null;
  orderStatus: string | null;
  refundStatus: string | null;

  orderedAt: string | null;
  deliveredAt: string | null;
  paidAt: string | null;

  rawRowJson: Record<string, string>;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function first(
  row: Record<string, string>,
  names: string[],
): string {
  for (const name of names) {
    const value = clean(row[name]);
    if (value !== "") return value;
  }
  return "";
}

function num(value: unknown): number {
  const s = clean(value)
    .replace(/,/g, "")
    .replace(/¥/g, "")
    .replace(/円/g, "")
    .replace(/%/g, "");

  if (!s) return 0;

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parsePartnerCenterDate(value: unknown): string | null {
  const s = clean(value);
  if (!s) return null;

  const m = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/,
  );

  if (!m) return null;

  const [, day, month, year, hour, minute, second] = m;

  // Partner Center日本時間をUTC ISOへ変換
  const utc = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 9,
      Number(minute),
      Number(second),
    ),
  );

  return utc.toISOString();
}

function monthFromDate(value: unknown): string | null {
  const s = clean(value);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;

  const [, , month, year] = m;
  return `${year}-${String(Number(month)).padStart(2, "0")}`;
}

export function getTapFileHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function parseTapAffiliateOrderExport(
  buffer: Buffer,
): TapAffiliateOrderRow[] {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    raw: false,
  });

  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    throw new Error("Excelにシートがありません。");
  }

  const sheet = workbook.Sheets[sheetName];

  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  const result: TapAffiliateOrderRow[] = [];

  for (const source of rawRows) {
    const row: Record<string, string> = {};

    for (const [key, value] of Object.entries(source)) {
      row[clean(key)] = clean(value);
    }

    const orderId = first(row, ["注文ID", "Order ID"]);
    if (!orderId) continue;

    const skuId = first(row, ["SKU ID"]);
    const productId = first(row, ["商品ID", "Product ID"]);
    const creatorTikTokId = first(row, [
      "クリエイターのユーザー名",
      "Creator username",
    ]);
    const contentId = first(row, ["コンテンツID", "Content ID"]);
    const invitationId = first(row, ["Invitation ID"]);
    const commissionType = first(row, [
      "成果報酬のタイプ",
      "Commission type",
    ]);

    /*
      sourceRowKeyには金額・支払い状況を含めない。
      同じ明細が後日更新された場合は同じキーでupsertするため。
    */
    const sourceRowKey = [
      orderId,
      skuId,
      productId,
      creatorTikTokId,
      contentId,
      invitationId,
      commissionType,
    ].join("|");

    const partnerEstimatedCommission = num(
      first(row, [
        "アフィリエイトパートナー推定成果報酬",
        "アフィリエイトパートナーの推定成果報酬",
        "Affiliate partner estimated commission",
      ]),
    );

    const partnerShopAdsEstimatedCommission = num(
      first(row, [
        "アフィリエイトパートナーショップ広告の推定成果報酬",
        "アフィリエイトパートナーショップ広告推定成果報酬",
        "Affiliate partner shop ads estimated commission",
      ]),
    );

    const partnerBonusEstimatedCommission = num(
      first(row, [
        "アフィリエイトパートナーの推定ボーナス成果報酬",
        "アフィリエイトパートナー推定ボーナス成果報酬",
        "Affiliate partner estimated bonus commission",
      ]),
    );

    const tapRevenue =
      partnerEstimatedCommission +
      partnerShopAdsEstimatedCommission +
      partnerBonusEstimatedCommission;

    const orderedAtRaw = first(row, ["作成日時", "Created time"]);

    result.push({
      sourceRowKey,
      orderId,

      skuId: skuId || null,
      productId: productId || null,
      productName:
        first(row, ["商品名", "Product name"]) || null,

      creatorTikTokId: creatorTikTokId || null,
      creatorName: creatorTikTokId || null,

      shopName:
        first(row, ["ショップ名", "Shop name"]) || null,
      shopCode:
        first(row, ["ショップコード", "Shop code"]) || null,

      targetMonth: monthFromDate(orderedAtRaw),

      contentType:
        first(row, ["コンテンツタイプ", "Content type"]) || null,
      contentId: contentId || null,
      invitationId: invitationId || null,
      commissionType: commissionType || null,

      productPrice: num(first(row, ["価格", "Price"])),
      quantity: num(first(row, ["数量", "Quantity"])),

      commissionGmv: num(
        first(row, ["成果報酬GMV", "Commission GMV"]),
      ),

      commissionBase: num(
        first(row, ["成果報酬ベース", "Commission base"]),
      ),

      partnerEstimatedCommission,
      partnerShopAdsEstimatedCommission,
      partnerBonusEstimatedCommission,

      tapRevenue,

      paymentStatus:
        first(row, ["支払い状況", "Payment status"]) || null,

      orderStatus:
        first(row, ["注文の決済状況", "Order payment status"]) || null,

      refundStatus:
        first(row, [
          "すべて返品または返金済み",
          "Fully returned or refunded",
        ]) || null,

      orderedAt: parsePartnerCenterDate(orderedAtRaw),

      deliveredAt: parsePartnerCenterDate(
        first(row, ["注文配達日時", "Order delivered time"]),
      ),

      paidAt: parsePartnerCenterDate(
        first(row, ["支払い日時", "Paid time"]),
      ),

      rawRowJson: row,
    });
  }

  return result;
}
