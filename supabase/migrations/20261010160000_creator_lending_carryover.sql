-- =============================================================================
-- 端末貸し出し報酬の振込端数と繰越
-- =============================================================================
/*
  ■ 直す問題（M-4）
  報酬は AP × 分配率で銭（小数2桁）まで出る。
      例: AP 3,771 × 0.8 = 3,016.80
  振込は1円単位なので、payment_amount に銭が残ると実際には振り込めない。
  四捨五入で埋めると払い過ぎ／払い不足になり、
  「支払った累計」と「計上した報酬の累計」が合わなくなる。

  ■ 決めたこと（アプリ側の単一ソース: lib/payments/creator-lending-rounding.ts）
      振込額   = floor(明細の合計 + 繰越残高)     1円単位
      次回繰越 = 明細の合計 + 繰越残高 − 振込額    0 以上 1 未満

  切り捨てた端数は消さず、本人別の繰越残高として次回の振込に乗せる。
  これで 支払った累計 + 繰越残高 = 計上した報酬の累計 が常に成り立つ。

  ■ 業務ルールとして確定済み（2026-10-12 承認）
  1円未満の端数を本人別の繰越残高として翌月以降へ繰り越す方式は
  正式に承認された。最低振込額 1,000円（2026-10-11 確定）と合わせて、
  「未達の月は振り込まず全額繰越」「振込は1円単位」「端数は繰越」が確定仕様。

  ■ 二重支払い・消失を防ぐしくみ
  繰越の増減は必ず creator_lending_carryover_logs に1行として残す。
      unique (payment_batch_id, action)
  これで「同じ支払明細に対して同じ操作を2回」が DB で弾かれる。
      applied   claim で繰越を取り込み、新しい繰越を確定した
      reverted  取消・失敗で claim 時の残高へ戻した
  balance_before を持つので、取消は「引き算」ではなく
  「claim 前の値へ戻す」で復元できる（誤差が積まない）。

  ■ 報酬明細・支払予定の金額は変えない
  creator_lending_reward_items.reward_amount は銭のまま。
  丸めるのは payment_batches.payment_amount だけ。

  ■ 支払予定テーブルの意味を直す（M-3）
  creator_lending_payouts.total_reward_amount は
  「対象月時点の年初来累積」から「その月の実額」へ変える
  （sync 側の実装も同時に変更済み）。画面と支払候補は
  creator_lending_reward_items を正とする。

  ■ DML は 0 件
*/

-- ① 繰越残高（本人別） --------------------------------------------------------
create table if not exists public.creator_lending_carryovers (
  creator_id uuid primary key references public.creators(id) on delete cascade,
  /* 0 以上 1 未満。1円以上になった分は振込に回る */
  balance numeric not null default 0,
  updated_at timestamptz not null default now(),
  constraint creator_lending_carryovers_balance_range_check
    check (balance >= 0 and balance < 1)
);

comment on table public.creator_lending_carryovers is
  '端末貸し出し報酬の振込端数の繰越残高（本人別）。振込額は1円単位に切り捨て、1円未満をここへ繰り越す。0 以上 1 未満。最低振込額 1,000円に達しない月は振り込まず、未払明細のまま全額を翌月以降へ繰り越す。';
comment on column public.creator_lending_carryovers.balance is
  '次回の振込に乗せる端数。0 以上 1 未満。支払った累計 + この残高 = 計上した報酬の累計。';

alter table public.creator_lending_carryovers enable row level security;

drop policy if exists "creator_lending_carryovers_admin_all" on public.creator_lending_carryovers;
create policy "creator_lending_carryovers_admin_all"
  on public.creator_lending_carryovers for all to public
  using (public.is_app_admin())
  with check (public.is_app_admin());

/* 既定権限で付く TRUNCATE などを外す（20261010140000 と同じ方針） */
revoke all on public.creator_lending_carryovers from authenticated, anon;
grant select on public.creator_lending_carryovers to authenticated;
grant all on public.creator_lending_carryovers to service_role;

-- ② 繰越の移動履歴（冪等性の担保） -------------------------------------------
create table if not exists public.creator_lending_carryover_logs (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  payment_batch_id uuid not null references public.payment_batches(id) on delete cascade,
  action text not null,
  /* claim 時に取り込んだ繰越（= balance_before） */
  carryover_in numeric not null default 0,
  /* claim 後に残した繰越 */
  carryover_out numeric not null default 0,
  /* 明細の合計（銭のまま）と実際の振込額（1円単位） */
  items_amount numeric not null default 0,
  transfer_amount numeric not null default 0,
  balance_before numeric not null default 0,
  balance_after numeric not null default 0,
  created_at timestamptz not null default now(),
  constraint creator_lending_carryover_logs_action_check
    check (action in ('applied', 'reverted')),
  /* 同じ支払明細に同じ操作を2回させない（二重支払い・二重復元の防止） */
  unique (payment_batch_id, action)
);

comment on table public.creator_lending_carryover_logs is
  '端末貸し出し報酬の繰越残高の移動履歴。applied は claim 時の取り込み、reverted は取消・失敗時の復元。unique(payment_batch_id, action) で同じ操作の二重実行を DB が弾く。追記専用。';

create index if not exists creator_lending_carryover_logs_creator_idx
  on public.creator_lending_carryover_logs (creator_id, created_at desc);

alter table public.creator_lending_carryover_logs enable row level security;

drop policy if exists "creator_lending_carryover_logs_admin_all"
  on public.creator_lending_carryover_logs;
create policy "creator_lending_carryover_logs_admin_all"
  on public.creator_lending_carryover_logs for all to public
  using (public.is_app_admin())
  with check (public.is_app_admin());

revoke all on public.creator_lending_carryover_logs from authenticated, anon;
grant select on public.creator_lending_carryover_logs to authenticated;
grant all on public.creator_lending_carryover_logs to service_role;

-- ③ 支払予定テーブルの意味を直す（M-3） --------------------------------------
/*
  列は変えない。意味（年初来累積 → その月の実額）を明示するだけ。
  実装は lib/creators/sync-lending-rewards.ts 側で変更済み。
*/
comment on column public.creator_lending_payouts.total_reward_amount is
  'その対象月に計上された本人報酬の合計（年初来累積ではない）。画面と支払候補の判断は creator_lending_reward_items を正とする。';
comment on column public.creator_lending_payouts.total_self_share_amount is
  'その対象月の THREE.inc 取り分の合計（年初来累積ではない）。';
comment on column public.creator_lending_payouts.status is
  'その対象月の明細がすべて支払済みなら paid、未払いが残れば unpaid。支払処理（complete_payment_batch）は締め月の行を paid にする。';
