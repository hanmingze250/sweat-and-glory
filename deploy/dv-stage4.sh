#!/bin/bash
# dv-stage4: point Beijing nginx /verify and /health at the HK FC function.
# Guards: FC must be reachable from Beijing first; config backup; nginx -t gate;
# auto-rollback on test failure; verify fcapp.run appears exactly twice after edit.
set -u
FC_HOST='damei-verify-xeyaxclalx.cn-hongkong.fcapp.run'
CONF='/etc/nginx/sites-available/default'
TS=$(date +%Y%m%d%H%M%S)
BAK="${CONF}.bak-stage4-${TS}"

echo '== 1. reachability: Beijing -> FC /health =='
if ! curl -sS -m 20 -o /tmp/fc-health.json -w 'FC-HEALTH HTTP=%{http_code} total=%{time_total}s\n' "https://${FC_HOST}/health"; then
  echo 'FC-UNREACHABLE, abort, nothing changed'
  exit 1
fi
cat /tmp/fc-health.json; echo
grep -q '"status":"ok"' /tmp/fc-health.json || { echo 'FC-HEALTH-BAD, abort'; exit 1; }

echo '== 2. current proxy_pass lines =='
grep -n 'proxy_pass' "$CONF" || true

echo "== 3. backup -> ${BAK} =="
cp "$CONF" "$BAK" || { echo 'BACKUP-FAILED, abort'; exit 1; }

echo '== 4. rewrite proxy_pass to FC =='
# Actual config lines carry a path suffix: proxy_pass http://127.0.0.1:8377/verify; (and /health)
sed -i 's|proxy_pass http://127\.0\.0\.1:8377/verify;|proxy_pass https://'"${FC_HOST}"'/verify;|g; s|proxy_pass http://127\.0\.0\.1:8377/health;|proxy_pass https://'"${FC_HOST}"'/health;|g' "$CONF"
CNT=$(grep -c "${FC_HOST}" "$CONF")
echo "fcapp.run occurrences in config: ${CNT}"
if [ "${CNT}" -lt 2 ]; then
  echo 'REWRITE-INCOMPLETE, rolling back'
  cp "$BAK" "$CONF"
  exit 1
fi
grep -n 'proxy_pass' "$CONF"

echo '== 5. ensure SNI for https upstream =='
if ! grep -q 'proxy_ssl_server_name' "$CONF"; then
  sed -i '/proxy_pass https:\/\/'"${FC_HOST}"';/a\            proxy_ssl_server_name on;' "$CONF"
  echo 'proxy_ssl_server_name on added'
else
  echo 'proxy_ssl_server_name already present'
fi

echo '== 6. nginx -t and reload =='
if ! nginx -t; then
  echo 'NGINX-T-FAILED, rolling back'
  cp "$BAK" "$CONF"
  nginx -t && systemctl reload nginx
  exit 1
fi
systemctl reload nginx
echo 'nginx reloaded'

echo '== 7. public check via jiangruansoft.com (should now be FC) =='
sleep 1
curl -sS -m 40 -D /tmp/h.txt -o /tmp/b.txt -w 'PUBLIC-HEALTH HTTP=%{http_code} total=%{time_total}s\n' https://jiangruansoft.com/health
cat /tmp/b.txt; echo
echo '-- response headers (look for fc markers) --'
grep -i -E 'fc|request-id' /tmp/h.txt || echo '(no fc header markers)'
echo 'STAGE4-DONE'
