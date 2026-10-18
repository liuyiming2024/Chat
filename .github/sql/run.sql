/* 查站点真实状态（只读，无凭据） */
select site_ready() as ready,
       (gate_hash is not null) as has_gate,
       coalesce(gate_disabled,false) as gate_off,
       site_name, allow_register
from site where id = true;
select id, nick, role, status from users order by created_at;
