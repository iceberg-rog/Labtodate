#!/bin/bash
TUN=$(grep "^BETTER_AUTH_URL=" /opt/lab2date/.env | cut -d= -f2-)
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 "$TUN/" 2>/dev/null)
if [ "$code" != "200" ]; then
  echo "$(date -u) DOWN code=$code" >> /var/log/lab2date-uptime.log
  cd /opt/lab2date && docker compose restart web >/dev/null 2>&1
else
  echo "$(date -u) ok" >> /var/log/lab2date-uptime.log
fi
