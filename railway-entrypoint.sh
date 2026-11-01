#!/bin/sh
set -e
# The image is built once for every deploy, so the site address (canonical URL,
# sitemap, Open Graph) is a placeholder until here. A fresh container starts from
# the image each time, so a changed SITE_URL or domain applies on the next restart.
url="${SITE_URL:-https://${RAILWAY_PUBLIC_DOMAIN:-localhost:$PORT}}"
url="${url%/}"
grep -rlF https://ziwei-site-url.invalid /app/.next /app/server.js 2>/dev/null \
  | xargs -r sed -i "s#https://ziwei-site-url.invalid#${url}#g"
exec node /app/server.js
