-- ⚠ 上一版报 operator does not exist: json ? unknown
--   `->` 返回的是 json，`?`（判断键是否存在）只有 jsonb 才有。
--   必须显式 ::jsonb。这类错误很容易被误读成"数据没有"，
--   实际是**我的查询语法不对** —— 差点把一个正常功能判成没生效。
select
  (state_delta(0)::jsonb->'users'->0) ? 'rev'  as users带rev,
  (state_delta(0)::jsonb->'rooms'->0) ? 'rev'  as rooms带rev,
  (state_delta(0)::jsonb->'users'->0)->>'rev'  as users_rev值,
  (state_delta(0)::jsonb->'rooms'->0)->>'rev'  as rooms_rev值;
