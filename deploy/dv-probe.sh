#!/bin/bash
# Google API reachability timing probe (run on the Beijing server)
echo "== oauth2.googleapis.com/token =="
curl -s -o /dev/null -w "http=%{http_code} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total}\n" --max-time 20 https://oauth2.googleapis.com/token
echo "== androidpublisher.googleapis.com =="
curl -s -o /dev/null -w "http=%{http_code} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total}\n" --max-time 20 https://androidpublisher.googleapis.com/
echo "== www.googleapis.com =="
curl -s -o /dev/null -w "http=%{http_code} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total}\n" --max-time 20 https://www.googleapis.com/
echo "== dns oauth2 =="
getent hosts oauth2.googleapis.com || echo "DNS-FAIL oauth2"
echo "PROBE-DONE"
