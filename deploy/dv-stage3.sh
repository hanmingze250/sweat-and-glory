#!/bin/bash
# dv-stage3.sh - add /verify and /health reverse-proxy locations to the
# jiangruansoft.com nginx server block (443). Safe: backs up first, restores
# on any failure, only reloads after nginx -t passes.
set -u
CAND=$(grep -rl "jiangruansoft.com" /etc/nginx/sites-enabled /etc/nginx/sites-available /etc/nginx/conf.d /etc/nginx/nginx.conf 2>/dev/null)
echo "candidates:"
echo "$CAND"
N=$(printf "%s\n" "$CAND" | grep -c .)
if [ "$N" != "1" ]; then echo "STAGE3-ABORT: expected exactly 1 config file"; exit 1; fi
CONF=$(printf "%s\n" "$CAND" | head -1)
echo "target config: $CONF"
if grep -q "location = /verify" "$CONF"; then
  echo "already configured, just reload"
  nginx -t && systemctl reload nginx
  echo STAGE3-DONE
  exit 0
fi
cp "$CONF" "$CONF.bak-dv"
python3 - "$CONF" <<'PYEOF'
import sys
path = sys.argv[1]
src = open(path).read()
block = """    # Damei Play purchase verification (damei-verify.service on 127.0.0.1:8377)
    location = /verify {
        limit_except POST { deny all; }
        client_max_body_size 16k;
        proxy_pass http://127.0.0.1:8377/verify;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
    }

    location = /health {
        limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:8377/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_read_timeout 10s;
        access_log off;
    }
"""
lines = src.split("\n")
i443 = None
for i, ln in enumerate(lines):
    if "listen" in ln and "443" in ln:
        i443 = i
        break
if i443 is None:
    print("STAGE3-ABORT: no listen 443 line found")
    sys.exit(1)
target = None
for i in range(i443, len(lines)):
    if "server_name" in lines[i] and "jiangruansoft.com" in lines[i]:
        target = i
        break
if target is None:
    print("STAGE3-ABORT: server_name jiangruansoft.com not found after listen 443")
    sys.exit(1)
out = lines[:target + 1] + [block] + lines[target + 1:]
open(path, "w").write("\n".join(out))
print("inserted locations into", path)
PYEOF
if [ $? -ne 0 ]; then cp "$CONF.bak-dv" "$CONF"; echo "STAGE3-ABORT: insert failed, config restored"; exit 1; fi
if ! nginx -t; then cp "$CONF.bak-dv" "$CONF"; echo "STAGE3-ABORT: nginx -t failed, config restored"; exit 1; fi
systemctl reload nginx
echo STAGE3-DONE
