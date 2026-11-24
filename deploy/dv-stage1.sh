#!/bin/bash
set -x
ls /var/www/html
ss -tlnp | grep 8377 || echo PORT8377-FREE
grep -rn "server_name" /etc/nginx | head -20
curl -sI -m 8 https://cdn.jsdelivr.net/ | head -1
curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource.sh
bash /tmp/nodesource.sh
apt-get install -y nodejs
node --version
echo STAGE1-DONE
