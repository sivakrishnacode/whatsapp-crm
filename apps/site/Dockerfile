# The marketing site: a self-contained HTML bundle plus two legal pages, on
# its own port.
#
# WHY A CONTAINER RATHER THAN A PATH ON THE HOST
#   So the host proxy has one uniform job — three hostnames, three ports — and
#   nothing on the box needs a filesystem web root, ownership fixes, or a sync
#   step on every site change. `docker compose up -d --build site` is the deploy.
#
# nginx:alpine is used with a minimal custom config: the stock image serves
# /usr/share/nginx/html/index.html on :80, and all we add on top is extension-
# less routing so /privacy and /terms resolve to their .html files.
FROM nginx:1.27-alpine

# Static marketing homepage — fully crawlable by Google's renderer without
# JavaScript. This is what serves / (converse360.in/).
#
# The original Framer bundle ("Converse360 Website.html") is kept in the repo
# for reference but is no longer served as index.html because the bundler
# replaces document.documentElement at runtime, which means Google's JS renderer
# sees the bundle content rather than any static wrapper we add — making it
# impossible to inject stable, crawlable content into the bundle's HTML shell.
COPY apps/site/index.html /usr/share/nginx/html/index.html

# Privacy Policy and Terms of Service.
#
# These are NOT part of the bundle, on purpose. The bundle is regenerated
# wholesale by a design tool on every site change, so anything living inside it
# is one re-export away from disappearing — and these two URLs are pasted into
# the Meta App Dashboard, where a 404 costs an App Review cycle. Separate files
# survive a re-export untouched.
COPY apps/site/privacy.html /usr/share/nginx/html/privacy.html
COPY apps/site/terms.html /usr/share/nginx/html/terms.html

# Must be a real file for the same reason as the legal pages: the catch-all
# below used to answer /robots.txt with the homepage and a 200, so crawlers
# received HTML where directives were expected.
COPY apps/site/robots.txt /usr/share/nginx/html/robots.txt

# Written here rather than as a mounted config file to keep the image
# self-contained.
RUN printf '%s\n' \
  'server {' \
  '  listen 80;' \
  '  root /usr/share/nginx/html;' \
  '  index index.html;' \
  '  # The HTML *is* the app, so a stale cached copy is a stale site with no' \
  '  # way for a visitor to bust it. Same reasoning for the legal pages, which' \
  '  # additionally must never serve a superseded version to a reviewer.' \
  '  location = /index.html { add_header Cache-Control "public, max-age=0, must-revalidate"; }' \
  '  location = /privacy.html { add_header Cache-Control "public, max-age=0, must-revalidate"; }' \
  '  location = /terms.html { add_header Cache-Control "public, max-age=0, must-revalidate"; }' \
  '  location ~* \\.(?:css|js|woff2?|png|jpe?g|svg|webp|ico)$ {' \
  '    expires 30d;' \
  '    add_header Cache-Control "public, immutable";' \
  '    access_log off;' \
  '  }' \
  '  # $uri.html is what makes /privacy and /terms work without the extension.' \
  '  #' \
  '  # The fallback is =404, NOT /index.html. This is a static site, not an SPA:' \
  '  # falling back to the homepage meant every wrong URL answered 200 with the' \
  '  # marketing page, so nothing here could ever 404 and /robots.txt served' \
  '  # HTML. "/" itself still resolves via $uri/ plus the index directive.' \
  '  location / { try_files $uri $uri.html $uri/ =404; }' \
  '}' \
  > /etc/nginx/conf.d/default.conf

EXPOSE 80

# nginx:alpine's own entrypoint/CMD handles startup; no override needed.
