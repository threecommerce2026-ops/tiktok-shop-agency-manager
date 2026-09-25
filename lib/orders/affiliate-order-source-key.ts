/*
  affiliate_order_lines.source_row_key の生成（単一ソース）。

  ■ ここが唯一の定義
  ブラウザ側の解析とサーバー側の再検証で同じキーを作る必要があるため、
  パーサーから切り出した。中身は従来の実装をそのまま移しただけで、
  結合順・区切り文字・null の扱いは1文字も変えていない。

    [注文ID, SKU ID, 商品ID, クリエイターのユーザー名,
     コンテンツID, Invitation ID, 要因のタイプ, 成果報酬のタイプ].join("|")

  ■ なぜ識別子だけで作るか
  金額・支払状態を含めないことで、同じ明細が後日 別の状態で再出力されても
  キーが変わらない。UNIQUE(source_row_key) + UPSERT により
  「同じExcelを何度入れても増えない / 最新状態へ更新される」が成立する。

  ■ 変更禁止
  この関数の出力を変えると、既存 16,618 行と突き合わせできなくなり、
  再取込がすべて新規INSERTになる（＝二重計上）。
*/

export type AffiliateOrderSourceKeyParts = {
  orderId: string;
  skuId: string | null;
  productId: string | null;
  creatorTiktokId: string;
  contentId: string | null;
  invitationId: string | null;
  factorType: string | null;
  commissionType: string | null;
};

/** 旧実装は text() で trim 済みの文字列を渡していた。null は "" と同値 */
function keyPart(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export function buildAffiliateOrderSourceRowKey(
  parts: AffiliateOrderSourceKeyParts,
): string {
  return [
    keyPart(parts.orderId),
    keyPart(parts.skuId),
    keyPart(parts.productId),
    keyPart(parts.creatorTiktokId),
    keyPart(parts.contentId),
    keyPart(parts.invitationId),
    keyPart(parts.factorType),
    keyPart(parts.commissionType),
  ].join("|");
}
