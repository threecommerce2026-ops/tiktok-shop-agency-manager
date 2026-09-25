/*
  自社（THREE.inc）の判定。

  ■ 判定の唯一の正は agencies.is_in_house（DBフラグ）
  以前は代理店名の文字列比較で判定していたが、名称変更や代理店統合で
  壊れて自社が外部代理店として支払対象に入る危険があったため、
  紹介者側（referrers.is_in_house）と同じくフラグに統一した。

  THREE_INC_AGENCY_NAME は画面の表示・説明文にだけ使う。判定には使わない。
*/

/** 表示用の自社名。判定には使わないこと */
export const THREE_INC_AGENCY_NAME = "THREE.inc";

export type InHouseAgencyFields = {
  is_in_house?: boolean | null;
};

/** 自社の代理店か（DBフラグが唯一の根拠） */
export function isInHouseAgencyRecord(
  agency: InHouseAgencyFields | null | undefined,
): boolean {
  return agency?.is_in_house === true;
}

/** 自社代理店の id 集合を作る */
export function collectInHouseAgencyIds(
  agencies: Array<{ id: string; is_in_house?: boolean | null }>,
): Set<string> {
  const ids = new Set<string>();
  for (const agency of agencies) {
    if (isInHouseAgencyRecord(agency)) ids.add(agency.id);
  }
  return ids;
}

export function normalizeAgencyName(name: string | null | undefined): string {
  return String(name ?? "").trim().toLowerCase();
}

/** 自社所属のクリエイターか */
export function isInHouseCreator(params: {
  agencyId: string | null;
  agencyIsInHouse?: boolean | null;
}): boolean {
  if (!params.agencyId) return false;
  return params.agencyIsInHouse === true;
}
