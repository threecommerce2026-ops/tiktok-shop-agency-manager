/*
  クリエイターの「確認状態」の単一ソース。

  ■ 何のための状態か
  これまで「まだ確認していない」と「確認した結果いない」がどちらも
  agency_id / referred_by_referrer_id の NULL で表現されていたため区別できず、
  一度確認したクリエイターも毎回「未設定」として一覧に出てしまっていた。

  ■ 実効状態は必ず ID から導出する
  creators.agency_id を書く経路は update_creator_assignment RPC の他にも
  複数ある（紹介リンク経由の登録、TikTok ID からの自動作成など）。
  どこか1つが state 列の更新を忘れても画面と集計が狂わないよう、
  表示・集計に使う状態は保存値ではなくここで導出する。

      ID が NOT NULL              → assigned（保存値が何であっても）
      ID が NULL かつ state='none' → none
      それ以外                     → unconfirmed

  ■ 報酬計算はこの状態を見ない
  代理店報酬・紹介者報酬の判定は従来どおり
  agency_id / creator_monthly_agency_assignments /
  referred_by_referrer_id / creator_referrals だけを見る。
  none も unconfirmed もどちらも「ID が NULL」なので報酬上の扱いは同じ。
  この列は管理画面で「要確認」と「確認済み」を区別するためだけに存在する。
*/

export const ASSIGNMENT_STATES = ["unconfirmed", "none", "assigned"] as const;

export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

export const ASSIGNMENT_STATE_LABEL: Record<AssignmentState, string> = {
  unconfirmed: "未確認",
  none: "なし確認済",
  assigned: "設定済み",
};

export function isAssignmentState(value: unknown): value is AssignmentState {
  return (
    typeof value === "string" &&
    (ASSIGNMENT_STATES as readonly string[]).includes(value)
  );
}

export function normalizeAssignmentState(value: unknown): AssignmentState {
  return isAssignmentState(value) ? value : "unconfirmed";
}

/**
 * 表示・集計に使う実効状態。
 * ID が入っていれば保存値に関係なく assigned として扱う。
 */
export function resolveAssignmentState(
  id: string | null | undefined,
  storedState: unknown,
): AssignmentState {
  if (id) return "assigned";
  return normalizeAssignmentState(storedState) === "none" ? "none" : "unconfirmed";
}

/**
 * 画面の選択値（"", NONE センチネル, 実ID）から
 * 保存すべき { id, state } を決める。
 */
export function assignmentStateForSelection(
  selectedId: string | null,
  explicitNone: boolean,
): { id: string | null; state: AssignmentState } {
  if (selectedId) return { id: selectedId, state: "assigned" };
  return { id: null, state: explicitNone ? "none" : "unconfirmed" };
}
