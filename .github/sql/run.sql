select 'users有rev' as item, count(*)::text as n from users where rev is not null
union all select 'users总行', count(*)::text from users
union all select 'rooms有rev', count(*)::text from rooms where rev is not null
union all select 'rooms总行', count(*)::text from rooms;

-- state_delta 里 users/rooms 是否真的带 rev（这才是前端能不能拿到的关键）
select
  (state_delta(0)->'users'->0)  ? 'rev' as users带rev,
  (state_delta(0)->'rooms'->0)  ? 'rev' as rooms带rev,
  (state_delta(0)->'users'->0)->>'rev' as users_rev值,
  (state_delta(0)->'rooms'->0)->>'rev' as rooms_rev值;
