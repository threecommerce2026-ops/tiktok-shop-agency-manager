-- =============================================================================
-- Repair action for invalid inactive referral relations
-- 有効期間を持たない無効 relation の修復を監査ログへ残せるようにする
-- =============================================================================
/*
  ■ なぜ必要か
  紹介者を付け替えると linkCreatorToReferrer が旧関係を無効化し、
  end_month に「新しい開始月の前月」を記録する。
  旧関係と新関係の start_month が同じ月だと、end_month が
  start_month より前になり、自己矛盾した行が残る。

  実例（2026-10-03 監査）: odebu888 の「-」関係が
    start_month = 2026-05 / end_month = 2026-04 / is_active = false
  になっていた。buildReferralPeriods はこの行を「同月に始まる後続」
  として扱うため、本来正しい（株）3 の関係まで
  reason=superseded として潰され、2026-05〜06 の紹介者が
  解決されなくなっていた（紹介報酬 62.20円が未発生）。

  ■ 何を直すのか
  この種の行の end_month を null へ戻す。
  is_active = false かつ end_month = null は、既に
  referral-period.ts の isUsableForPeriod が「誤登録」として
  期間計算から除外する形なので、新しい概念は増えない。
  start_month は変えない（履歴の捏造になる）。行も消さない。

  ■ このマイグレーションがやること
  修復操作を creator_referral_logs に記録できるよう、
  action の CHECK 制約へ 'repair_invalid_inactive_relation' を加える。
  既存の 4 種類はそのまま残す。
*/

alter table public.creator_referral_logs
  drop constraint if exists creator_referral_logs_action_check;

alter table public.creator_referral_logs
  add constraint creator_referral_logs_action_check
  check (
    action in (
      'create',
      'reassign',
      'change_start_month',
      'unlink',
      /*
        有効期間を持たない無効 relation（end_month < start_month）の
        end_month を null へ戻した操作。
        紹介者そのものは変えないので referrer_id は変更前と同じ値が入る。
      */
      'repair_invalid_inactive_relation'
    )
  );

comment on column public.creator_referral_logs.action is
  'create=新規紐付け / reassign=別の紹介者へ変更 / change_start_month=開始月の修正 / unlink=紹介者を外す / repair_invalid_inactive_relation=有効期間を持たない無効relationのend_month修復';
