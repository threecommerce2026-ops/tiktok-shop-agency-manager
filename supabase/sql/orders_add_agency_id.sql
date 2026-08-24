-- orders.agency_id 追加（既存環境向け）
-- Supabase SQL Editor に貼り付けて実行

alter table public.orders
  add column if not exists agency_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_agency_id_fkey'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_agency_id_fkey
      foreign key (agency_id)
      references public.agencies (id)
      on delete set null;
  end if;
end;
$$;

create index if not exists orders_agency_id_idx
  on public.orders (agency_id);

create index if not exists orders_agency_month_idx
  on public.orders (agency_id, target_month);

create or replace function public.sync_orders_agency_id_from_creator()
returns trigger
language plpgsql
as $$
begin
  if new.creator_id is not null then
    select c.agency_id
    into new.agency_id
    from public.creators c
    where c.id = new.creator_id;
  end if;

  return new;
end;
$$;

update public.orders o
set agency_id = c.agency_id
from public.creators c
where o.creator_id = c.id
  and o.agency_id is distinct from c.agency_id;

drop trigger if exists orders_sync_agency_id_from_creator on public.orders;
create trigger orders_sync_agency_id_from_creator
  before insert or update of creator_id on public.orders
  for each row
  execute function public.sync_orders_agency_id_from_creator();

drop policy if exists "orders_select_admin_or_agency" on public.orders;
create policy "orders_select_admin_or_agency"
  on public.orders for select
  using (
    public.is_app_admin()
    or agency_id in (
      select p.agency_id
      from public.profiles p
      where p.id = auth.uid()
        and p.agency_id is not null
    )
  );
