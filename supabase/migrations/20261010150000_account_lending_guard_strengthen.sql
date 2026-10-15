-- =============================================================================
-- 代理店報酬への誤計上を止めるガードを元の強さへ戻す
-- =============================================================================
/*
  ■ 直す問題（M-2）
  本番適用済みの旧ガード（20261009130000）は、
  「対象月の区分がアカウント貸し出しなのに通常の代理店報酬として保存しようとした」
  ケースを拒否していた。つまり AP100% の誤計上を DB で止めていた。

    旧ガードの実測（本番の現在の定義）:
      ERROR: 対象月（2026-07）の区分がアカウント貸出のため、
             通常の代理店報酬として保存できません

  20261010110000 でこの関数を「agency_reward_items に account_lending を
  入れさせない」検知へ差し替えたが、その結果
  「区分が貸出の人月に、通常報酬（reward_kind='agency'）として AP100% を保存する」
  経路が DB では止まらなくなった。防御がアプリ側
  （lib/agency/agency-reward-engine.ts が null を返す）だけになっている。

  本人受取が確定した今、貸出の人月に代理店報酬の明細ができることは
  設計上ありえない。多層防御として DB 側でも止める。

  ■ 検査する3つ（1つでも該当したら拒否）
    ① reward_kind = 'account_lending'
         → 端末貸し出し報酬は creator_lending_reward_items で管理する
    ② lending_split_rate が null ではない
         → 代理店報酬の明細に貸出の分配率は入らない
    ③ 対象月の確定区分が account_lending
         → 自社所属なら本人受取（creator_lending_reward_items）
           外部代理店所属でも AP100% は渡さない（本人の原資のため）

  ③ の区分は creator_monthly_account_management_types（月別確定）を優先し、
  無ければ creators.account_management_type を見る。
  解決のしかたは lib/creators/monthly-account-management-type.ts と同じ。

  ■ 既存の書き込みを壊さないこと（確認済み）
  本番 READ ONLY で確認した事実:
    ・区分が account_lending の人月（14件）に対応する agency_reward_items: 0 件
    ・agency_reward_items の reward_kind は全 2,124 行が 'agency'
    ・lending_split_rate が入った行: 0 件
  つまり ③ で拒否される既存行は存在しない。

  通常のクリエイター（standard / self_operated）の明細は従来どおり保存できる。
  金額・種類・分配率・支払先が動かない UPDATE（支払処理）は検査しない。

  ■ 既存 migration は改変しない
  20261009130000 / 20261010110000 のファイルはそのまま残す。
  この差分 migration が同じ関数を再定義する（トリガ名も変えない）。

  ■ 適用順序
  20261010110000 より後。単独でも、同一トランザクションでも流せる。
  何度流しても結果は同じ。

  ■ DML は 0 件
*/

create or replace function public.guard_account_lending_reward_kind()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_monthly_type   text;
  v_current_type   text;
  v_effective_type text;
  v_agency_in_house boolean := false;
begin
  /*
    金額・種類・分配率・受取先が動かない更新は検査しない。
    既存の支払処理（claim / complete / release / 年間支払）はここを通る。
  */
  if tg_op = 'UPDATE'
     and old.reward_amount      is not distinct from new.reward_amount
     and old.reward_kind        is not distinct from new.reward_kind
     and old.lending_split_rate is not distinct from new.lending_split_rate
     and old.agency_id          is not distinct from new.agency_id
     and old.creator_id         is not distinct from new.creator_id
     and old.target_month       is not distinct from new.target_month then
    return new;
  end if;

  -- ① 端末貸し出し報酬は代理店報酬の明細に入れない -------------------------
  if coalesce(new.reward_kind, 'agency') = 'account_lending' then
    raise exception
      '端末貸し出し報酬は代理店報酬の明細に保存できません。creator_lending_reward_items（本人受取）で管理してください'
      using errcode = '22023';
  end if;

  -- ② 貸出の分配率も入れない -----------------------------------------------
  if new.lending_split_rate is not null then
    raise exception
      '代理店報酬の明細に端末貸し出しの分配率は保存できません（対象月 %）',
      new.target_month
      using errcode = '22023';
  end if;

  -- ③ 区分が貸出の人月に通常報酬（AP100%）を作らせない ---------------------
  select m.account_management_type
    into v_monthly_type
    from public.creator_monthly_account_management_types m
   where m.creator_id = new.creator_id
     and m.target_month = new.target_month;

  select c.account_management_type
    into v_current_type
    from public.creators c
   where c.id = new.creator_id;

  /* 月別確定があればそれが正。無ければ現在値（既存の優先順位と同じ） */
  v_effective_type := coalesce(
    nullif(btrim(v_monthly_type), ''),
    nullif(btrim(v_current_type), ''),
    'standard'
  );

  if v_effective_type = 'account_lending' then
    /* 自社所属かどうかでメッセージを分ける（原因が分かるように） */
    select coalesce(a.is_in_house, false)
      into v_agency_in_house
      from public.creator_monthly_agency_assignments ma
      left join public.agencies a on a.id = ma.agency_id
     where ma.creator_id = new.creator_id
       and ma.target_month = new.target_month;

    if coalesce(v_agency_in_house, false) then
      raise exception
        '対象月（%）の管理区分がアカウント貸し出しで所属が自社です。代理店報酬としては保存できません。本人受取（creator_lending_reward_items）で管理してください',
        new.target_month
        using errcode = '22023';
    end if;

    raise exception
      '対象月（%）の管理区分がアカウント貸し出しです。AP は本人への分配の原資なので、代理店報酬としては保存できません',
      new.target_month
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

comment on function public.guard_account_lending_reward_kind() is
  '代理店報酬の明細に、端末貸し出し報酬（reward_kind=account_lending / 分配率あり）と、区分がアカウント貸し出しの人月の通常報酬（AP100%）を入れさせない。本人受取の報酬は creator_lending_reward_items で管理する。金額・種類・分配率・支払先・受取対象が動かない更新は検査しない。';

/* トリガ名は 20261009130000 で作ったものを引き続き使う（関数だけ差し替わる） */
drop trigger if exists agency_reward_items_account_lending_guard on public.agency_reward_items;
create trigger agency_reward_items_account_lending_guard
  before insert or update on public.agency_reward_items
  for each row
  execute function public.guard_account_lending_reward_kind();
