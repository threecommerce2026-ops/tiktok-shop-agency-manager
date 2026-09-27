/*
  TAP取込を分割送信（チャンク）で行えるようにするための取込履歴の拡張。

  ■ なぜ必要か
  Excel を丸ごと Server Action へ送る方式は、Next.js の Server Action の
  既定上限（1MB）を超えて 400 になる。実測で 1.5MB から失敗した
  （サーバー側ログ: Body exceeded 1 MB limit.）。
  そこでブラウザで解析し、行だけを分割して送る方式へ変える。
  分割送信は途中で失敗し得るため、「どこまで入ったか」を記録する場所がいる。

  ■ 今までの何が足りなかったか
  tap_affiliate_order_import_batches には状態を表す列が無く、
  取込開始時に行を作ってカウントを更新するだけだった。
  途中で失敗すると inserted_count = 0 の行が残り、
  「未完了」と「0件成功」を区別できない。
  さらに file_hash の重複チェックがあるため、失敗したファイルを
  もう一度取り込もうとすると「取込済み」と誤判定されて弾かれる。

  ■ 過剰に作らない
  足すのは「再開に本当に必要なもの」だけ。
    status           … 未完了と完了を見分ける
    chunk_count      … 全部で何回に分けて送るか
    completed_chunk_indexes … どの回が済んだか（番号の配列）
    started_at / completed_at / error_message … 失敗時に追う手がかり

  完了したチャンクを「件数」ではなく「番号の配列」で持つのは、
  同じチャンクを再送したときに二重に数えないため。
  件数だけだと retry のたびに増えてしまう。
*/

alter table public.tap_affiliate_order_import_batches
  add column if not exists status text,
  add column if not exists chunk_count integer,
  add column if not exists completed_chunk_indexes integer[] not null default '{}',
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists error_message text,
  add column if not exists imported_by uuid references auth.users(id) on delete set null;

/*
  既存の1件は取込が終わっている（18,106行が入っている）ので completed にする。
  取込日時をそのまま開始・完了の時刻として使う。
*/
update public.tap_affiliate_order_import_batches
   set status = 'completed',
       started_at = coalesce(started_at, imported_at),
       completed_at = coalesce(completed_at, imported_at),
       chunk_count = coalesce(chunk_count, 1),
       completed_chunk_indexes = case
         when completed_chunk_indexes = '{}' then array[0]
         else completed_chunk_indexes
       end
 where status is null;

alter table public.tap_affiliate_order_import_batches
  alter column status set not null,
  alter column status set default 'processing';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'tap_import_batches_status_check'
  ) then
    alter table public.tap_affiliate_order_import_batches
      add constraint tap_import_batches_status_check
      check (status in ('processing', 'completed', 'failed'));
  end if;
end $$;

/*
  同じファイルを「完了済み」として二重に取り込ませない。
  未完了（processing / failed）の行は残してよい。再開に使うため。
  部分一意索引で、completed のときだけ file_hash の重複を禁じる。
*/
create unique index if not exists tap_import_batches_completed_hash_idx
  on public.tap_affiliate_order_import_batches (file_hash)
  where status = 'completed';

create index if not exists tap_import_batches_status_idx
  on public.tap_affiliate_order_import_batches (status, imported_at desc);

comment on column public.tap_affiliate_order_import_batches.status is
  '取込の状態。processing=送信中 / completed=完了 / failed=失敗。completed のみ再取込を拒否する。';
comment on column public.tap_affiliate_order_import_batches.completed_chunk_indexes is
  '完了したチャンク番号。件数ではなく番号を持つことで、同じチャンクの再送を二重に数えない。';
comment on column public.tap_affiliate_order_import_batches.chunk_count is
  '全部で何回に分けて送るか。finish のときに全数そろったかを確かめる。';

-- -----------------------------------------------------------------------------
-- チャンク完了を記録する（同じ番号を何度送っても1回として扱う）
-- -----------------------------------------------------------------------------
/*
  completed_chunks = completed_chunks + 1 のような数え方はしない。
  再送のたびに増えて、実際より多く完了したことになってしまう。
  番号の集合へ入れるので、何度呼んでも結果が変わらない。
*/
create or replace function public.mark_tap_import_chunk_done(
  p_batch_id uuid,
  p_chunk_index integer
) returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_status text;
  v_count integer;
begin
  if not public.is_app_admin() then
    raise exception 'この操作は親管理者のみ実行できます' using errcode = '42501';
  end if;

  select status into v_status
    from public.tap_affiliate_order_import_batches
   where id = p_batch_id
     for update;

  if not found then
    raise exception '取込セッションが見つかりません' using errcode = '23503';
  end if;

  if v_status = 'completed' then
    raise exception 'この取込は完了済みです' using errcode = '22023';
  end if;

  update public.tap_affiliate_order_import_batches
     set completed_chunk_indexes =
           case
             when p_chunk_index = any(completed_chunk_indexes)
               then completed_chunk_indexes
             else completed_chunk_indexes || p_chunk_index
           end,
         status = 'processing',
         error_message = null
   where id = p_batch_id
  returning array_length(completed_chunk_indexes, 1) into v_count;

  return coalesce(v_count, 0);
end;
$fn$;

revoke all on function public.mark_tap_import_chunk_done(uuid, integer) from public, anon;
grant execute on function public.mark_tap_import_chunk_done(uuid, integer) to authenticated;

comment on function public.mark_tap_import_chunk_done(uuid, integer) is
  'チャンクの完了を記録する。同じ番号を何度渡しても二重に数えない。';
