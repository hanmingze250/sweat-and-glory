#!/bin/bash
# dv-selftest.sh - post-deploy checks per DEPLOY.md section 7
echo "== 1 local health =="
curl -s http://127.0.0.1:8377/health; echo
echo "== 2 public health =="
curl -s https://jiangruansoft.com/health; echo
echo "== 3 empty body (expect 400 BAD_PRODUCT_ID) =="
curl -s -X POST https://jiangruansoft.com/verify -H 'Content-Type: application/json' -d '{}'; echo
echo "== 4 product not allowed (expect 400 PRODUCT_NOT_ALLOWED) =="
curl -s -X POST https://jiangruansoft.com/verify -H 'Content-Type: application/json' -d '{"productId":"not_a_product","purchaseToken":"whatever"}'; echo
echo "== 5 fake token (expect 200 purchase_not_found; 502 UPSTREAM_AUTH means stop and check grants) =="
curl -s -X POST https://jiangruansoft.com/verify -H 'Content-Type: application/json' -d '{"productId":"damei_pro","purchaseToken":"fake-token-for-deploy-selftest-000000"}'; echo
echo "== 6 site pages (expect index 200 37242 / privacy 200 13554) =="
curl -s -o /dev/null -w 'index %{http_code} %{size_download}\n' https://jiangruansoft.com/
curl -s -o /dev/null -w 'privacy %{http_code} %{size_download}\n' https://jiangruansoft.com/privacy.html
echo SELFTEST-DONE
