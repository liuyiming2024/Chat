-- 临时体检（用完即清）：列出线上所有表的列，用于和 schema.sql 的 create table 对比，
-- 找出"表已存在 → if not exists 跳过 → 新增列永远加不上"的那一类缺陷。
select table_name, column_name
from information_schema.columns
where table_schema='public'
order by table_name, ordinal_position;
