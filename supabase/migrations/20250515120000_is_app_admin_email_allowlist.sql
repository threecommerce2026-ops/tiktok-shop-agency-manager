-- is_app_admin: email allowlist for RLS (keep in sync with lib/db/admin-email-allowlist.ts)
create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  )
  or lower(coalesce(
    (select trim(u.email::text) from auth.users u where u.id = auth.uid()),
    ''
  )) in (
    'duffy.hat@gmail.com'
  );
$$;

comment on function public.is_app_admin() is
  'profiles.role=admin または許可メール（auth.users.email）で親管理者判定';
