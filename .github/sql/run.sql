/* 用站长号登录，发一批覆盖各功能的验证消息（真实落库） */
do $outer$
declare v_uid uuid; v_tok text; r json; okb boolean; m1 uuid; m2 uuid; mlast uuid;
begin
  select user_login('liuyiming2024','***REMOVED***') into r;
  if not (r->>'ok')::boolean then
    raise notice '登录失败：%', r->>'err'; return;
  end if;
  v_tok := r->>'token';
  raise notice '① 登录成功，token 长度 = %', length(v_tok);
  perform set_config('request.headers', json_build_object('x-session', v_tok)::text, true);
  raise notice '② cur_user() = %', cur_user();

  -- 1 纯文本
  select msg_send('public','text','【验证】这是一条纯文本消息。') into r;
  m1 := (r->>'id')::uuid;

  -- 2 Markdown 综合
  select msg_send('public','text','# 一级标题
## 二级标题
**粗体** *斜体* ~~删除线~~
- 列表项一
- 列表项二
> 引用一行
`行内代码`
[链接](https://liuyiming2024.github.io)') into r;
  m2 := (r->>'id')::uuid;

  -- 3 表格
  select msg_send('public','text','| 功能 | 状态 |
|---|---|
| Markdown | ✓ |
| 公式 | ✓ |
| 代码高亮 | ✓ |') into r;

  -- 4 行内公式
  select msg_send('public','text','质能方程 $E=mc^2$ —— 行内公式验证') into r;

  -- 5 块级公式
  select msg_send('public','text','$$
\frac{a}{b} + \sqrt{x^2 + y^2}
$$') into r;

  -- 6 代码块 js
  select msg_send('public','text','```js
function hello(name) {
  // 注释
  const s = "字符串";
  return `${s} + ${name}`;
}
```') into r;

  -- 7 代码块 python
  select msg_send('public','text','```python
def fib(n):
    """数字 123"""
    return n if n < 2 else fib(n-1) + fib(n-2)
```') into r;

  -- 8 长消息（验证省略/展开）
  select msg_send('public','text', repeat('这是一条长消息，用于验证长文本的省略与展开。', 20)) into r;

  -- 9 @提及
  select msg_send('public','text','@liuyiming2024 这是一条 @ 提及验证') into r;

  -- 10 回复第 1 条
  select msg_send('public','text','【验证】这是一条回复消息。', null, '', 0, m1) into r;

  raise notice '③ 已发 10 条，当前消息数 = %', (select count(*) from messages);

  -- 编辑：改第 1 条
  select msg_edit(m1, '【验证】这条被编辑过了 —— 原文是纯文本消息。') into okb;
  raise notice '   编辑返回 = %', okb;
  raise notice '④ 编辑后 edited_at = %',
    (select edited_at is not null from messages where id = m1);

  -- 撤回：先发一条再撤
  select msg_send('public','text','【验证】这条马上会被撤回。') into r;
  mlast := (r->>'id')::uuid;
  select msg_delete(mlast) into okb;
  raise notice '   撤回返回 = %', okb;
  raise notice '⑤ 撤回后 deleted = %（逻辑删除）',
    (select deleted from messages where id = mlast);
  raise notice '⑥ 撤回后 body 长度 = %（已清空）',
    (select length(body) from messages where id = mlast);

  raise notice '⑦ 最终消息数 = %（含 1 条已撤回）',
    (select count(*) from messages);
  raise notice '⑧ rev 最大值 = %', (select max(rev) from messages);
end $outer$;