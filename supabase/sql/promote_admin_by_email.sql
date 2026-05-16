-- profiles に email 列はありません。auth.users の id で紐付けて role を更新します。
-- Supabase SQL Editor で実行してください。
--
-- 確認用（任意）:
-- select p.id, p.role, p.agency_id, u.email
-- from public.profiles p
-- join auth.users u on u.id = p.id
-- where lower(u.email) = lower('duffy.hat@gmail.com');
--
-- 本プロジェクトには public.admins テーブルはありません。admin は profiles.role = 'admin' と
-- is_app_admin()（+ 一時メール許可 supabase/sql/is_app_admin_email_allowlist.sql）で判定します。

update public.profiles as p
set role = 'admin'
from auth.users as u
where p.id = u.id
  and lower(u.email) = lower('duffy.hat@gmail.com');

-- 確認（任意）
-- select p.id, p.role, p.agency_id, u.email
-- from public.profiles p
-- join auth.users u on u.id = p.id
-- where lower(u.email) = lower('duffy.hat@gmail.com');
