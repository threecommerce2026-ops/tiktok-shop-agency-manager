-- =============================================================================
-- クリエイターの旧ユーザー名（改名）の対応表
-- =============================================================================
-- 非破壊方針:
--   ・既存テーブル / 既存カラム / 既存関数は一切変更しない
--   ・追加するのは CREATE TABLE / CREATE INDEX / CREATE POLICY / GRANT のみ
--   ・affiliate_order_lines の既存 16,874 行には触れない
--
-- 背景:
--   affiliate_order_lines.source_row_key は
--     注文ID | SKU ID | 商品ID | クリエイターのユーザー名 |
--     コンテンツID | Invitation ID | 要因のタイプ | 成果報酬のタイプ
--   で構成される。TikTok 側でユーザー名が変わると、同じ注文明細でも
--   キーが変わり UPSERT が効かず、新規行として二重に入る。
--
--   本番実績: kanyatoyselect_jp → kanyaselect_jp の改名により
--   2026-07 の 153 明細が二重登録された
--   （GMV 432,138円 / 成果報酬ベース 473,871円 / エージェンシー収益 29,170円）。
--
--   TikTok のエクスポートには改名で変わらない安定IDが存在しない
--   （「クリエイターのタグID」列は全 16,874 行で空）。
--   そのため「どの名前が同一人物か」は人間が判断して記録するしかない。
--
-- このテーブルの役割:
--   Excel 解析後・source_row_key 生成前に
--     旧名（alias） → 正式名（canonical）
--   へ寄せることで、改名があっても同じキーになるようにする。
--
-- 重要:
--   ・source_row_key の生成ルール自体は変更しない
--     （lib/orders/affiliate-order-source-key.ts は無変更）
--   ・既存行の source_row_key は書き換えない
--   ・代理店報酬 / 紹介者報酬の計算式には一切関与しない
--   ・誤登録すると「別人の注文を同一人物として統合」してしまう。
--     登録は管理者のみ。UI 側でも警告を出すこと。
-- =============================================================================

create table if not exists public.creator_tiktok_aliases (
  -- 旧ユーザー名。normalizeTiktokId 済み（trim / 小文字 / 先頭 @ 除去）で保存する
  alias_tiktok_id text primary key,

  -- 寄せ先の正式ユーザー名。こちらも normalizeTiktokId 済み
  canonical_tiktok_id text not null,

  note text,

  -- profiles / auth.users への FK は張らない。
  -- 既存の referrer_code_aliases と同じ方針（利用者が削除されても履歴を残す）。
  created_by uuid,
  created_by_email text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 空文字・空白のみを禁止
  constraint creator_tiktok_aliases_alias_not_blank
    check (length(btrim(alias_tiktok_id)) > 0),
  constraint creator_tiktok_aliases_canonical_not_blank
    check (length(btrim(canonical_tiktok_id)) > 0),

  -- 自分自身への別名は意味がないので禁止
  constraint creator_tiktok_aliases_no_self_alias
    check (alias_tiktok_id <> canonical_tiktok_id),

  -- normalizeTiktokId 済みであることを DB でも担保する
  -- （小文字・前後空白なし・先頭 @ なし）
  constraint creator_tiktok_aliases_alias_normalized
    check (alias_tiktok_id = lower(btrim(alias_tiktok_id)) and alias_tiktok_id !~ '^@'),
  constraint creator_tiktok_aliases_canonical_normalized
    check (canonical_tiktok_id = lower(btrim(canonical_tiktok_id)) and canonical_tiktok_id !~ '^@')
);

comment on table public.creator_tiktok_aliases is
  'クリエイターの旧ユーザー名 → 正式ユーザー名。Excel取込時に source_row_key 生成前へ適用し、改名による注文明細の二重登録を防ぐ。';
comment on column public.creator_tiktok_aliases.alias_tiktok_id is
  '旧ユーザー名（normalizeTiktokId 済み）。主キーなので同じ旧名を二重登録できない。';
comment on column public.creator_tiktok_aliases.canonical_tiktok_id is
  '寄せ先の正式ユーザー名。ここが別名として登録されている場合は連鎖して解決する。';

-- 連鎖（A→B→C）の解決と循環検出のために canonical 側からも引けるようにする
create index if not exists creator_tiktok_aliases_canonical_idx
  on public.creator_tiktok_aliases (canonical_tiktok_id);

-- -----------------------------------------------------------------------------
-- RLS（親管理者のみ）
-- -----------------------------------------------------------------------------
-- 別名の誤登録は「別人の注文の統合」に直結するため、代理店ユーザーからは
-- 参照も変更もできないようにする。
alter table public.creator_tiktok_aliases enable row level security;

drop policy if exists "creator_tiktok_aliases_admin_all" on public.creator_tiktok_aliases;

create policy "creator_tiktok_aliases_admin_all"
  on public.creator_tiktok_aliases for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

grant select, insert, update, delete on public.creator_tiktok_aliases to authenticated;
grant all on public.creator_tiktok_aliases to service_role;
