-- 既存環境向け: sales_imports に commission_base を追加
alter table public.sales_imports
  add column if not exists commission_base numeric(16, 2) not null default 0;

comment on column public.sales_imports.commission_base is 'TikTok Shop パートナーセンター出力の Commission base';
