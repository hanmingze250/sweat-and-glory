#!/bin/bash
set -x
id damei-verify || useradd --system --home /opt/damei-verify --shell /usr/sbin/nologin damei-verify
mkdir -p /opt/damei-verify
cp /root/verify.js /opt/damei-verify/verify.js
md5sum /opt/damei-verify/verify.js
cp /root/service-account.json /opt/damei-verify/service-account.json
wc -c /opt/damei-verify/service-account.json
cp /root/damei-verify.service /etc/systemd/system/damei-verify.service
chown -R damei-verify:damei-verify /opt/damei-verify
chmod 700 /opt/damei-verify
chmod 600 /opt/damei-verify/service-account.json
chmod 644 /opt/damei-verify/verify.js
systemctl daemon-reload
systemctl enable --now damei-verify
sleep 2
systemctl is-active damei-verify
curl -s http://127.0.0.1:8377/health
echo
ss -tlnp | grep 8377
echo STAGE2-DONE
