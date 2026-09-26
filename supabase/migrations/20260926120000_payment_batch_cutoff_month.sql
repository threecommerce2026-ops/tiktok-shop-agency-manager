/*
  支払明細に「締め対象月」を持たせる。

  ■ なぜ必要か
  これまで支払明細の対象上限は period_end_month だったが、この列は
  「呼び出し側が渡した範囲の終端」であり、画面では未払い明細の実データから
  導出していた。そのため代理店ごとに値が変わり、
  「この支払明細は何月末締めだったのか」を後から一意に判定できなかった。
  実際、締めたつもりの無い月まで claim される状態になっていた。

  cutoff_month は「何月末で締めたか」という業務上の意図そのものを保存する。

  ■ 既存データを壊さない
  nullable で追加 → 既存行があれば period_end_month から backfill →
  NOT NULL 化、の順で進める。既存の status / claim / is_paid には触れない。

  ■ cutoff_month >= period_end_month
  締め月より後の明細が支払明細へ入っていないことを構造的に保証する。
  新しい claim では両者は常に一致する（period_end_month = cutoff_month）。
*/

-- 1. nullable で追加
alter table public.payment_batches
  add column if not exists cutoff_month text;

comment on column public.payment_batches.cutoff_month is
  '締め対象月（YYYY-MM）。この月までの未払い明細だけを組み入れたことを表す。';

-- 2. 既存行があれば period_end_month から埋める（無ければ0件）
update public.payment_batches
   set cutoff_month = period_end_month
 where cutoff_month is null;

-- 3. NOT NULL 化
alter table public.payment_batches
  alter column cutoff_month set not null;

-- 4/5. 形式と「締め月より後を含まない」ことの保証
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.payment_batches'::regclass
       and conname = 'payment_batches_cutoff_month_check'
  ) then
    alter table public.payment_batches
      add constraint payment_batches_cutoff_month_check
      check (
        cutoff_month ~ '^\d{4}-\d{2}$'
        and cutoff_month >= period_end_month
      );
  end if;
end $$;

-- 6. 締め月での抽出用
create index if not exists payment_batches_cutoff_month_idx
  on public.payment_batches(cutoff_month);
