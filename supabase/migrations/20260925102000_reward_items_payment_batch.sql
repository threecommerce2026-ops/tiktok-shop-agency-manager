-- =============================================================================
-- 報酬明細に「どの支払明細に入っているか」を持たせる
-- =============================================================================
-- 非破壊方針:
--   ・既存カラム / 既存関数 / 既存データは一切変更しない
--   ・追加するのは ADD COLUMN と CREATE INDEX のみ
--   ・既定値は null なので、既存 1,549 件 / 609 件はすべて「未占有」のまま
--
-- なぜ単一カラムなのか:
--   中間テーブル（batch_id, kind, item_id）にすると item_id に外部キーを
--   張れず（多態参照）、孤児行の検出をアプリ側で持つことになる。
--   報酬明細1行につきカラム1つなら、
--     「1つの報酬明細は同時に1つの支払明細にしか入れない」
--   が DB 構造そのもので保証される。二重支払い防止の中核。
--
-- 状態の意味:
--   payment_batch_id is null   … 未払いかつ未占有。支払明細の作成対象
--   payment_batch_id is not null and is_paid = false
--                              … draft / approved / processing 中。占有済み
--   is_paid = true             … 振込完了登録済み
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 代理店報酬明細
-- -----------------------------------------------------------------------------
alter table public.agency_reward_items
  add column if not exists payment_batch_id uuid
    references public.payment_batches(id) on delete set null;

comment on column public.agency_reward_items.payment_batch_id is
  '占有中の支払明細。null のときだけ新しい支払明細へ組み入れできる。';

create index if not exists agency_reward_items_payment_batch_idx
  on public.agency_reward_items (payment_batch_id);

-- 未払い抽出（支払明細の作成対象）専用。占有済み・支払済みは入らない
create index if not exists agency_reward_items_claimable_idx
  on public.agency_reward_items (agency_id, target_month)
  where is_reward_target
    and not is_paid
    and payout_id is null
    and payment_batch_id is null;

-- -----------------------------------------------------------------------------
-- 2. 紹介者報酬明細
-- -----------------------------------------------------------------------------
alter table public.referral_reward_items
  add column if not exists payment_batch_id uuid
    references public.payment_batches(id) on delete set null;

comment on column public.referral_reward_items.payment_batch_id is
  '占有中の支払明細。null のときだけ新しい支払明細へ組み入れできる。';

create index if not exists referral_reward_items_payment_batch_idx
  on public.referral_reward_items (payment_batch_id);

create index if not exists referral_reward_items_claimable_idx
  on public.referral_reward_items (referrer_id, target_month)
  where is_reward_target
    and not is_paid
    and payout_id is null
    and payment_batch_id is null;
