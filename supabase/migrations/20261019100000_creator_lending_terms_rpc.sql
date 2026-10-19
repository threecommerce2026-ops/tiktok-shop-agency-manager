-- =============================================================================
-- 端末貸し出しの分配条件を、監査ログと同一トランザクションで保存する RPC
-- =============================================================================
/*
  ■ 直す問題
  これまで分配条件の保存はアプリ層で2回の書き込みに分かれていた。

      ① creator_lending_terms へ upsert
      ② creator_lending_term_logs へ insert（失敗しても警告だけ）

  supabase-js は PostgREST 越しなので ① と ② をまたぐトランザクションを
  張れない。そのため ② が失敗すると「有効化されているのに、誰がいつ
  有効化したか分からない人月」が残る。一括有効化では17回繰り返すので、
  数件だけ履歴が欠落した状態も起こり得た。

  ■ 解決
  ① と ② を1つの関数の中で行う。関数呼び出しは1トランザクションなので、
  terms と logs は必ず同時に成立する。複数件を1回の呼び出しで渡すため、
  途中で例外が出れば全件ロールバックされる（部分適用が起きない）。

  既存の支払RPC（claim_payment_batch_items など）が
  log_payment_batch_action を同一関数内で呼ぶのと同じ方式。

  ■ SECURITY DEFINER にする理由
  creator_lending_terms / _term_logs は 20261010140000 で
  authenticated から書き込み権を剥奪してある（口座情報を扱う系のため）。
  SECURITY INVOKER にすると authenticated から書けないので、
  DEFINER にして関数の中で auth.uid() と is_app_admin() を検査する。
  支払RPCと同じ形。search_path も固定する。

  ■ EXECUTE 権限
  authenticated だけに渡す。anon / service_role / public には渡さない
  （既定で PUBLIC に付くので明示的に revoke する）。

  ■ 再実行で増やさない
  分配率と有効化が変更前と同じ人月は、upsert もログ追記もしない
  （unchanged として数える）。同じ操作を繰り返しても terms の
  updated_at すら動かない。

  ■ DB 側でも再検証する（fail-closed）
  画面やアプリの判定を信用せず、次を関数内で確かめて、1件でも
  該当したら例外を投げて全件ロールバックする。

      ・クリエイターが存在するか
      ・対象月の形式が正しいか
      ・呼び出し側が指定した対象期間に収まっているか
      ・その人月に報酬の原資（注文明細）または既存の明細があるか
      ・その人月に支払済み / 支払明細に占有済みの明細が無いか

  ■ 対象期間は引数で受ける
  初期精算（2026-02〜2026-07）のような一度きりの範囲をこの関数へ
  焼き込まない。範囲は呼び出し側（lib/creators/lending-term-bulk-draft.ts の
  INITIAL_LENDING_SETTLEMENT）が持ち、関数は渡された範囲を強制するだけ。

  ■ 変更しないもの
  所属（creator_monthly_agency_assignments）、管理区分、AK、
  代理店報酬（agency_reward_items）、紹介者報酬（referral_reward_items）、
  支払明細（payment_batches）には一切触れない。

  ■ DML は 0 件
*/

create or replace function public.set_creator_lending_terms(
  p_entries jsonb,
  p_from_month text default null,
  p_to_month text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_user_id    uuid;
  v_user_email text;
  v_entry      jsonb;
  v_index      int := 0;
  v_creator_id uuid;
  v_month      text;
  v_rate       numeric;
  v_is_active  boolean;
  v_note       text;
  v_from_rate  numeric;
  v_from_active boolean;
  v_found      boolean;
  v_applied    int := 0;
  v_unchanged  int := 0;
  v_log_count  int := 0;
begin
  -- ① 管理者であることを DB 側で確かめる --------------------------------------
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'ログインが必要です。' using errcode = '28000';
  end if;

  if not public.is_app_admin() then
    raise exception '管理者権限が必要です。' using errcode = '42501';
  end if;

  -- ② 入力の形 ---------------------------------------------------------------
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception '対象の指定が不正です。' using errcode = '22023';
  end if;

  if jsonb_array_length(p_entries) = 0 then
    raise exception '対象の人月が指定されていません。' using errcode = '22023';
  end if;

  /* 操作ミスで大量に流さないための上限。初期精算は17件 */
  if jsonb_array_length(p_entries) > 200 then
    raise exception '一度に指定できるのは 200 件までです（指定 % 件）。',
      jsonb_array_length(p_entries) using errcode = '22023';
  end if;

  if p_from_month is not null and p_from_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception '対象期間の開始月が不正です。' using errcode = '22023';
  end if;

  if p_to_month is not null and p_to_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception '対象期間の終了月が不正です。' using errcode = '22023';
  end if;

  if p_from_month is not null and p_to_month is not null and p_from_month > p_to_month then
    raise exception '対象期間の開始月が終了月より後になっています。' using errcode = '22023';
  end if;

  v_user_email := coalesce(
    auth.jwt() ->> 'email',
    (select u.email from auth.users u where u.id = v_user_id)
  );

  -- ③ 1件ずつ検証して保存（例外が出たら全件ロールバック） ---------------------
  for v_entry in select value from jsonb_array_elements(p_entries) loop
    v_index := v_index + 1;

    if jsonb_typeof(v_entry) <> 'object' then
      raise exception '%件目の指定が不正です。', v_index using errcode = '22023';
    end if;

    begin
      v_creator_id := (v_entry ->> 'creator_id')::uuid;
    exception when others then
      raise exception '%件目のクリエイターIDが不正です。', v_index using errcode = '22023';
    end;

    v_month := v_entry ->> 'target_month';

    if v_month is null or v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
      raise exception '%件目の対象月が不正です（例: 2026-07）。', v_index using errcode = '22023';
    end if;

    /* 呼び出し側が指定した対象期間を DB 側でも強制する */
    if p_from_month is not null and v_month < p_from_month then
      raise exception '対象期間外の月が含まれています（% は % より前）。',
        v_month, p_from_month using errcode = '22023';
    end if;

    if p_to_month is not null and v_month > p_to_month then
      raise exception '対象期間外の月が含まれています（% は % より後）。',
        v_month, p_to_month using errcode = '22023';
    end if;

    if not exists (select 1 from public.creators c where c.id = v_creator_id) then
      raise exception '%件目のクリエイターが見つかりません。', v_index using errcode = '22023';
    end if;

    /* 分配率。null は「既定率を使う」の意味。既定値をここで埋めない */
    if (v_entry -> 'split_rate') is null or jsonb_typeof(v_entry -> 'split_rate') = 'null' then
      v_rate := null;
    else
      begin
        v_rate := (v_entry ->> 'split_rate')::numeric;
      exception when others then
        raise exception '%件目の分配率が数値ではありません。', v_index using errcode = '22023';
      end;

      if v_rate <= 0 or v_rate > 1 then
        raise exception
          '%件目の分配率は 0 より大きく 1 以下で指定してください（80%% なら 0.8）。指定値: %',
          v_index, v_rate using errcode = '22023';
      end if;
    end if;

    if jsonb_typeof(v_entry -> 'is_active') = 'boolean' then
      v_is_active := (v_entry ->> 'is_active')::boolean;
    else
      v_is_active := true;
    end if;

    v_note := nullif(btrim(coalesce(v_entry ->> 'note', '')), '');

    if v_note is not null and length(v_note) > 500 then
      raise exception '%件目の備考が長すぎます（500文字以内）。', v_index using errcode = '22023';
    end if;

    /*
      報酬の原資があるか。
      注文明細も既存の本人明細も無い人月を有効化しても計上するものが無く、
      設定だけが残る。画面側でも候補から外しているが DB 側でも拒否する。
    */
    if not exists (
      select 1 from public.affiliate_order_lines o
       where o.creator_id = v_creator_id and o.target_month = v_month
    ) and not exists (
      select 1 from public.creator_lending_reward_items i
       where i.creator_id = v_creator_id and i.target_month = v_month
    ) then
      raise exception
        '% の % には計上できる注文明細がありません。',
        v_month, v_creator_id using errcode = '22023';
    end if;

    /* 支払済み・支払明細に占有済みの人月は設定を動かさない */
    if exists (
      select 1 from public.creator_lending_reward_items i
       where i.creator_id = v_creator_id
         and i.target_month = v_month
         and (i.is_paid or i.payout_id is not null or i.payment_batch_id is not null)
    ) then
      raise exception
        '% の % は支払済み（または支払明細に占有済み）のため変更できません。',
        v_month, v_creator_id using errcode = '22023';
    end if;

    /*
      人月ごとに勧告ロックを取る。

      select ... for update は「存在する行」しかロックできないので、
      その人月の行がまだ無い状態で2セッションが同時に入ると、
      両方が「変更前は無い」と判断して両方が書き込む。
      terms は unique 制約で1行に収まるが、監査ログが2行積まれる
      （実測: 同時実行で activate が2行できた）。

      勧告ロックは行の有無に関係なく効くので、読み取りから書き込みまでを
      人月単位で直列化できる。トランザクション終了で自動的に解放される。
      キーが衝突しても無関係な人月が待つだけで、正しさは損なわれない。
    */
    perform pg_advisory_xact_lock(
      hashtextextended('creator_lending_terms:' || v_creator_id::text || '|' || v_month, 0)
    );

    -- 変更前の値を読む（同じトランザクション内で行を固定する） ----------------
    select t.split_rate, t.is_active
      into v_from_rate, v_from_active
      from public.creator_lending_terms t
     where t.creator_id = v_creator_id
       and t.target_month = v_month
     for update;

    v_found := found;

    /*
      同じ設定の再実行。
      terms も logs も触らない（updated_at も動かさない）。
    */
    if v_found
       and v_from_rate is not distinct from v_rate
       and v_from_active is not distinct from v_is_active then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    insert into public.creator_lending_terms (
      creator_id, target_month, split_rate, is_active, note,
      created_by, created_by_email, created_at, updated_at
    )
    values (
      v_creator_id, v_month, v_rate, v_is_active, v_note,
      v_user_id, v_user_email, now(), now()
    )
    on conflict (creator_id, target_month) do update set
      split_rate       = excluded.split_rate,
      is_active        = excluded.is_active,
      note             = excluded.note,
      created_by       = excluded.created_by,
      created_by_email = excluded.created_by_email,
      updated_at       = now();

    v_applied := v_applied + 1;

    /*
      監査ログ。率の変更と有効化の変更は別の出来事なので、
      両方動いたら2行残す。アプリ層の実装と同じ条件。
    */
    if v_from_rate is distinct from v_rate then
      insert into public.creator_lending_term_logs (
        creator_id, target_month, action,
        from_split_rate, to_split_rate, note, changed_by, changed_by_email
      )
      values (
        v_creator_id, v_month,
        case when v_rate is null then 'reset_rate' else 'set_rate' end,
        v_from_rate, v_rate, v_note, v_user_id, v_user_email
      );
      v_log_count := v_log_count + 1;
    end if;

    if (not v_found) or (v_from_active is distinct from v_is_active) then
      insert into public.creator_lending_term_logs (
        creator_id, target_month, action,
        from_is_active, to_is_active, note, changed_by, changed_by_email
      )
      values (
        v_creator_id, v_month,
        case when v_is_active then 'activate' else 'deactivate' end,
        v_from_active, v_is_active, v_note, v_user_id, v_user_email
      );
      v_log_count := v_log_count + 1;
    end if;
  end loop;

  /* 実際に保存できた件数を返す（書こうとした件数ではない） */
  return jsonb_build_object(
    'entry_count', jsonb_array_length(p_entries),
    'applied',     v_applied,
    'unchanged',   v_unchanged,
    'log_count',   v_log_count
  );
end;
$fn$;

comment on function public.set_creator_lending_terms(jsonb, text, text) is
  '端末貸し出しの分配条件（本人×対象月）を監査ログと同一トランザクションで保存する。複数件を1回で受け、1件でも検証に失敗したら全件ロールバックする。管理者のみ（auth.uid() と is_app_admin() を関数内で検査）。分配率 null は既定率を使う意味で、既定値はここで埋めない。対象期間は引数で受け取り、関数には焼き込まない。実際に保存できた件数と監査ログ行数を返す。';

/* 既定で PUBLIC に付く EXECUTE を外し、authenticated だけに渡す */
revoke all on function public.set_creator_lending_terms(jsonb, text, text) from public;
revoke all on function public.set_creator_lending_terms(jsonb, text, text) from anon;
revoke all on function public.set_creator_lending_terms(jsonb, text, text) from service_role;
grant execute on function public.set_creator_lending_terms(jsonb, text, text) to authenticated;
