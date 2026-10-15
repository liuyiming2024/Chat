select p.proname from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname similar to '(msg|state|room|user|media|site|sys|acl|invite|session|profile|journal)%'
 order by p.proname;
