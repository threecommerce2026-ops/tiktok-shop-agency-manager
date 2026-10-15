-- =============================================================================
-- 端末貸し出し報酬テーブルの権限を最小化する
-- =============================================================================
/*
  ■ 直す問題
  本番には public スキーマの既定権限が設定されている。

    pg_default_acl: postgres / public / r /
      anon=Dxtm/postgres  authenticated=Dxtm/postgres  service_role=Dxtm/postgres
      （D = TRUNCATE, x = REFERENCES, t = TRIGGER, m = MAINTAIN）

  このため postgres で public にテーブルを作ると、明示的な grant とは別に
  anon / authenticated へ TRUNCATE・REFERENCES・TRIGGER が自動で付く。
  既存テーブルも実際にそうなっている（本番 READ ONLY で確認）。

    agency_reward_items | authenticated | REFERENCES,SELECT,TRIGGER,TRUNCATE
    agency_reward_items | anon          | REFERENCES,TRIGGER,TRUNCATE

  RLS は TRUNCATE を制御しない。「管理者のみ」のポリシーを書いても
  TRUNCATE は素通りするため、20261010100000 で作る4テーブルは
  作成した時点で「誰でも全件削除できる」状態になる。

  本番と同じ既定権限を再現した隔離DBで実測した結果（修正前）:

    creator_lending_reward_items | authenticated | REFERENCES,SELECT,TRIGGER,TRUNCATE
    creator_lending_term_logs    | authenticated | INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE
    → set role authenticated; truncate creator_lending_reward_items, ... ;
      TRUNCATE TABLE （支払済みの明細も含めて全件消えた）
    → DELETE は permission denied（権限が無い）。TRUNCATE だけが通る

  creator_bank_accounts は 20261010100000 自身が revoke all しているため
  この穴が無い（同じ隔離DBで permission denied を確認）。
  残り4テーブルを同じ水準に揃える。

  ■ 考え方は C-6（20261008110000_protect_audit_logs.sql）と同じ
  消す正規の経路が1つも無いのに権限だけ残っている穴を外す。
  C-6 は監査ログ 11 テーブルを対象にした。ここではその考え方を
  今回追加する報酬・支払予定・分配条件・監査ログの4テーブルへ適用する。

  ■ 壊さないことの確認
  この4テーブルを削除・切り詰める正規経路は存在しない。
    ・アプリから service_role 以外で書き込む経路: 0 件
      （書き込みは app/actions/creator-lending-rewards.ts と
        lib/creators/sync-lending-rewards.ts が getSupabaseAdmin() で行う。
        service_role の権限はこの migration では触らない）
    ・DB 関数内の truncate: 0 件
    ・migration 内の truncate: 0 件
  画面の読み取りは service role（管理者判定済み）で行うため、
  authenticated の SELECT を外しても止まらない。ここでは安全側に
  SELECT だけを残す（既存の agency_reward_items と同じ水準）。

  ■ creator_lending_term_logs の INSERT を外す理由
  20261010100000 は authenticated へ INSERT を付与しているが、
  監査ログを書くのは service_role のみ（Server Action）なので不要。
  RLS で止まるとしても、不要な権限は残さない。

  ■ 適用のしかた
  20261010100000 と同一トランザクションで適用するのが望ましい。
  別トランザクションにすると、作成から revoke までの間だけ
  TRUNCATE が付いた状態が残る。

      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
        -c "set lock_timeout='5s'; set statement_timeout='60s';" \
        -f 20261010100000_creator_lending_reward_tables.sql \
        -f 20261010140000_creator_lending_privilege_lock.sql

  単独でも流せる（テーブルが無い環境では何もしない）。
  何度流しても結果は同じ。

  ■ 既定権限そのものは変更しない
  alter default privileges を書き換えると、今後 public に作られる
  すべてのテーブルの権限が変わる。影響範囲が今回の目的を超えるため
  触らない。テーブル単位で外す。

  ■ DML は 0 件
*/

do $$
declare
  v_table text;
  /* SELECT を残すテーブル（画面・集計の読み取り） */
  v_readable constant text[] := array[
    'creator_lending_terms',
    'creator_lending_reward_items',
    'creator_lending_payouts',
    'creator_lending_term_logs'
  ];
begin
  foreach v_table in array v_readable loop
    /* 存在しないテーブルは飛ばす（環境差で落とさない） */
    if exists (
      select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = v_table and c.relkind = 'r'
    ) then
      /*
        既定権限で付いた TRUNCATE / REFERENCES / TRIGGER / MAINTAIN と、
        万一付いていた書き込み権限をまとめて外す。
        revoke all なので、版によって有無が変わる権限（MAINTAIN は
        PostgreSQL 17 で追加）も個別に書かずに外せる。
      */
      execute format(
        'revoke all on public.%I from authenticated, anon',
        v_table
      );

      /* 読み取りだけ戻す */
      execute format(
        'grant select on public.%I to authenticated',
        v_table
      );

      /* 書き込みは service_role のみ（20261010100000 の grant all を維持） */
      execute format(
        'grant all on public.%I to service_role',
        v_table
      );
    end if;
  end loop;
end $$;

/*
  口座テーブルは 20261010100000 で既に revoke all 済みだが、
  この migration だけを流した環境でも同じ状態になるよう明示する。
  SELECT も渡さない（口座は service role でしか読まない）。
*/
do $$
begin
  if exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'creator_bank_accounts' and c.relkind = 'r'
  ) then
    revoke all on public.creator_bank_accounts from authenticated, anon;
    grant all on public.creator_bank_accounts to service_role;
  end if;
end $$;

/*
  テーブルの説明に権限の意図も書いておく（後から見て分かるように）。
  テーブルが無い環境では何もしない（単独適用でも落ちないようにする）。
*/
do $$
declare
  v_comments constant text[][] := array[
    array['creator_lending_reward_items',
      '端末貸し出し報酬の明細（受取人はクリエイター本人）。AP × split_rate が本人報酬、残りが自社取り分。source_row_key で一意なので再集計しても二重計上しない。authenticated は SELECT のみ（TRUNCATE / DELETE は外してある）。'],
    array['creator_lending_payouts',
      '端末貸し出し報酬の支払予定（本人×対象月）。target_month + creator_id で一意なので再計算しても二重計上しない。authenticated は SELECT のみ（TRUNCATE / DELETE は外してある）。'],
    array['creator_lending_terms',
      '端末貸し出し報酬の分配条件（本人×対象月）。split_rate が null なら既定 80%。is_active=false または行が無い月は報酬を作らない。区分・所属・AK はここには複製せず、それぞれの正データを読む。authenticated は SELECT のみ。'],
    array['creator_lending_term_logs',
      '端末貸し出しの分配条件の変更履歴（監査用）。追記専用で、書き込むのは service_role のみ。authenticated は SELECT のみ（INSERT / DELETE / TRUNCATE は外してある）。'],
    array['creator_bank_accounts',
      'クリエイター本人の振込先。端末貸し出し報酬の支払に使う。authenticated / anon には SELECT も渡さない（読み書きは service_role のみ）。']
  ];
  v_row text[];
begin
  foreach v_row slice 1 in array v_comments loop
    if exists (
      select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = v_row[1] and c.relkind = 'r'
    ) then
      execute format('comment on table public.%I is %L', v_row[1], v_row[2]);
    end if;
  end loop;
end $$;
