#!/bin/bash
# dv-stage4c: fix Host header for FC upstream in /verify and /health locations.
# FC routes by Host; stage3 blocks pass Host $host (jiangruansoft.com) -> 404 DomainRouteNotFound.
# Set Host to the fcapp.run host inside those two blocks only. Backup + nginx -t gate + rollback.
set -u
FC_HOST='damei-verify-xeyaxclalx.cn-hongkong.fcapp.run'
CONF='/etc/nginx/sites-available/default'
TS=$(date +%Y%m%d%H%M%S)
BAK="${CONF}.bak-stage4c-${TS}"

echo '== blocks before =='
awk '/location \/verify \{/,/^\s*\}/' "$CONF"
echo '---'
awk '/location \/health \{/,/^\s*\}/' "$CONF"

cp "$CONF" "$BAK" || { echo 'BACKUP-FAILED, abort'; exit 1; }
echo "backup: ${BAK}"

for p in verify health; do
  if awk "/location \\/${p} \\{/,/^\\s*\\}/" "$CONF" | grep -q 'proxy_set_header Host'; then
    sed -i "/location \/${p} {/,/}/ s|proxy_set_header Host [^;]*;|proxy_set_header Host ${FC_HOST};|" "$CONF"
    echo "${p}: Host header replaced"
  else
    sed -i "/proxy_pass https:\/\/${FC_HOST}\/${p};/a\\            proxy_set_header Host ${FC_HOST};" "$CONF"
    echo "${p}: Host header inserted"
  fi
done

echo '== blocks after =='
awk '/location \/verify \{/,/^\s*\}/' "$CONF"
echo '---'
awk '/location \/health \{/,/^\s*\}/' "$CONF"

if ! nginx -t; then
  echo 'NGINX-T-FAILED, rolling back'
  cp "$BAK" "$CONF"
  nginx -t && systemctl reload nginx
  exit 1
fi
systemctl reload nginx
echo 'nginx reloaded'
sleep 1

echo '== public checks =='
curl -sS -m 40 -w '\nPUBLIC-HEALTH HTTP=%{http_code} total=%{time_total}s\n' https://jiangruansoft.com/health
curl -sS -m 60 -w '\nPUBLIC-VERIFY-FAKE HTTP=%{http_code} total=%{time_total}s\n' -X POST https://jiangruansoft.com/verify -H 'Content-Type: application/json' -d '{"productId":"damei_pro","purchaseToken":"fake-token-stage4c-check"}'
echo 'STAGE4C-DONE'
