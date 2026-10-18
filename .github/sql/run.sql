create or replace function draft_limits() returns json
language sql immutable as $$
  select json_build_object(
    'maxBody',   8000,    -- 单条正文上限（字符）
    'maxName',   200,     -- 文件名上限
    'maxPending', 2000,   -- 未整理条目上限，超了拒绝新增
    'perMinute',   30,    -- 同一来源每分钟上限
    /* Q-Chat-S-141：全站合计上限。p_source 由调用者自填，
       换一个就是新桶，所以必须有一道不看 source 的闸门。
       100/分钟：对正常低频写入绰绰有余，又能挡住脚本灌。 */
    'perMinuteGlobal', 100
  );
$$;

create or replace function draft_add(
  p_body      text,
  p_kind      text default 'text',
  p_file_name text default null,
  p_file_path text default null,
  p_file_size bigint default null,
  p_source    text default ''
) returns json
language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_id uuid; lim json; n int; recent int; v_recent_all int;
begin
  lim := draft_limits();

  if p_body is null or p_body = '' then
    raise exception '内容是空的，没什么可存';
  end if;

  if length(p_body) > (lim->>'maxBody')::int then
    raise exception '单条内容太长（上限 % 字，这条 % 字），请拆分后再发',
      (lim->>'maxBody')::int, length(p_body);
  end if;

  if p_file_name is not null and length(p_file_name) > (lim->>'maxName')::int then
    raise exception '文件名太长（上限 % 字）', (lim->>'maxName')::int;
  end if;

  /* 总量闸门：先整理再继续丢，不然队列无限增长 */
  select count(*) into n from drafts where deleted_at is null;
  if n >= (lim->>'maxPending')::int then
    raise exception '草稿箱已满（% 条未整理），请先整理或清理再添加',
      (lim->>'maxPending')::int;
  end if;

  /* 频率闸门 A：按 p_source 计。空 source 归为同一组（'anon'）。
     ⚠ 不做这个的话，无密钥入口等于可以被无限调用。 */
  select count(*) into recent from drafts
   where deleted_at is null
     and created_at > now() - interval '1 minute'
     and coalesce(nullif(source,''),'anon') = coalesce(nullif(p_source,''),'anon');
  if recent >= (lim->>'perMinute')::int then
    raise exception '这个来源发得太快了（每分钟上限 % 条），稍后再试',
      (lim->>'perMinute')::int;
  end if;

  /* ★★ Q-Chat-S-141：频率闸门 B —— **全局**，不看 source。

     外部报告点破的：p_source 是**调用者自己传的**，
     换一个字符串就是一个新桶，30 次/分钟等于形同虚设 ——
     想要多快就多快，只要每次换个 source。

     这不是"限流不够严"，而是**限流键选错了**：
     用一个调用方可任意伪造的值做限流键，等于没有限流。
     （同 draft_add 之外还有别处吗？凡是把客户端传来的标识
       当限流键的地方都有这个问题。）

     ★ 所以这里必须叠加一道**与 source 无关**的全局闸门：
       不管你换多少个来源，1 分钟内全站新增超过上限就拒。
       闸门 A 负责"单个来源别太吵"，闸门 B 负责"总量别失控"。

     ⚠ 阈值为什么是 100 而不是 30：
       这是全站合计，多个正常来源会叠加。定 30 会把正常的多来源
       使用一起挡掉 —— **挡得太狠，先被挡住的是自己人**。
       100/分钟对"往草稿箱丢东西"这种低频动作绰绰有余。 */
  select count(*) into v_recent_all from drafts
   where deleted_at is null
     and created_at > now() - interval '1 minute';
  if v_recent_all >= (lim->>'perMinuteGlobal')::int then
    raise exception '草稿箱接收过于频繁（全站每分钟上限 % 条），稍后再试',
      (lim->>'perMinuteGlobal')::int;
  end if;

  insert into drafts (kind, body, file_name, file_path, file_size, source)
  values (coalesce(p_kind,'text'), p_body, p_file_name, p_file_path, p_file_size, p_source)
  returning id into v_id;

  /* ⚠ 返回服务端时间 —— 调用方要用它来确认"我这条排在哪"，
     而客户端自己的钟可能是错的。 */
  return json_build_object('ok', true, 'id', v_id,
    'createdAt', (select created_at from drafts where id = v_id));
end;
$$;

create or replace function draft_clear(p_token text, p_confirm text default '')
returns json language plpgsql volatile security definer
set search_path = public, extensions, pg_temp as $$
declare n int;
begin
  perform api_check(p_token, true);
  perform api_touch(p_token);
  if p_confirm is distinct from 'CLEAR-ALL' then
    raise exception '清空整个草稿箱需要显式确认：第二参数传 CLEAR-ALL';
  end if;
  with d as (
    update drafts set deleted_at = now() where deleted_at is null returning 1
  ) select count(*) into n from d;
  return json_build_object('ok', true, 'cleared', n);
end;
$$;
