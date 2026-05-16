-- sellers table + RLS (admin only)
create extension if not exists "pgcrypto";

create or replace function public.set_sellers_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.sellers (
  id uuid primary key default gen_random_uuid(),
  seller_name text not null,
  shop_name text not null default '',
  contact_person text,
  contact_email text,
  contact_phone text,
  category text,
  sample_condition text,
  has_smp boolean not null default false,
  tap_rate numeric(10, 4),
  tsp_rate numeric(10, 4),
  last_meeting_date date,
  last_meeting_note text,
  discount_condition text,
  seller_live_available boolean not null default false,
  status text not null default 'pending',
  memo text,
  source_created_at timestamptz,
  import_source text not null default 'manual',
  raw_import_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sellers_status_check check (status in ('active', 'pending', 'stopped'))
);

comment on table public.sellers is 'TSP として関与するセラー情報（親管理者のみ）';

create index if not exists sellers_status_idx on public.sellers (status);
create index if not exists sellers_category_idx on public.sellers (category);
create index if not exists sellers_created_at_idx on public.sellers (created_at desc);

drop trigger if exists sellers_set_updated_at on public.sellers;
create trigger sellers_set_updated_at
  before update on public.sellers
  for each row
  execute function public.set_sellers_updated_at();

alter table public.sellers enable row level security;

drop policy if exists "sellers_admin_select" on public.sellers;
create policy "sellers_admin_select"
  on public.sellers for select
  using (public.is_app_admin());

drop policy if exists "sellers_admin_insert" on public.sellers;
create policy "sellers_admin_insert"
  on public.sellers for insert
  with check (public.is_app_admin());

drop policy if exists "sellers_admin_update" on public.sellers;
create policy "sellers_admin_update"
  on public.sellers for update
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "sellers_admin_delete" on public.sellers;
create policy "sellers_admin_delete"
  on public.sellers for delete
  using (public.is_app_admin());

grant select, insert, update, delete on public.sellers to authenticated;
