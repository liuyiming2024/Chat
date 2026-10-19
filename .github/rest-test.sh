SB='https://pimryrsxkwyafmponegp.supabase.co'
KEY='sb_publishable_jPrK6j5l9NGbnLKcytTegg_di1njO8t'
echo "--- 1. site_ready（前端 probe 调的就是它）---"
curl -s --max-time 20 -X POST "$SB/rest/v1/rpc/site_ready" -H "apikey: $KEY" -H "Content-Type: application/json" -d '{}' -w "\nHTTP=%{http_code}\n"
echo "--- 2. state_get 未登录（前端 pull 第一步）---"
curl -s --max-time 20 -X POST "$SB/rest/v1/rpc/state_get" -H "apikey: $KEY" -H "Content-Type: application/json" -d '{}' -w "\nHTTP=%{http_code}\n" | head -c 600
echo ""
echo "--- 3. gate_check 空密码（无门模式应直接发会话）---"
curl -s --max-time 20 -X POST "$SB/rest/v1/rpc/gate_check" -H "apikey: $KEY" -H "Content-Type: application/json" -d '{"p":""}' -w "\nHTTP=%{http_code}\n" | head -c 400
