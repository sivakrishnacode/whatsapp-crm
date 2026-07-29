# The marketing site: one self-contained HTML file on its own port.
#
# WHY A CONTAINER RATHER THAN A PATH ON THE HOST
#   So the host proxy has one uniform job — three hostnames, three ports — and
#   nothing on the box needs a filesystem web root, ownership fixes, or a sync
#   step on every site change. `docker compose up -d --build site` is the deploy.
#
# nginx:alpine is used with NO custom config on purpose: its stock image already
# serves /usr/share/nginx/html/index.html on :80, so copying the file to that
# name is the entire setup. Adding a config file here would be one more thing to
# keep correct for no gain.
FROM nginx:1.27-alpine

# `index.html`, not the original filename: that is what the stock config serves,
# and it also means the URL is `/` rather than `/Converse360-site.html`.
COPY apps/site/Converse360-site.html /usr/share/nginx/html/index.html

# The page is a single self-unpacking bundle, so every path has to resolve to it
# or a deep link 404s. Written here rather than as a mounted config file to keep
# the image self-contained.
RUN printf '%s\n' \
  'server {' \
  '  listen 80;' \
  '  root /usr/share/nginx/html;' \
  '  index index.html;' \
  '  # The HTML *is* the app, so a stale cached copy is a stale site with no' \
  '  # way for a visitor to bust it. Assets, if any are added later, are' \
  '  # matched separately and may cache hard.' \
  '  location = /index.html { add_header Cache-Control "public, max-age=0, must-revalidate"; }' \
  '  location ~* \\.(?:css|js|woff2?|png|jpe?g|svg|webp|ico)$ {' \
  '    expires 30d;' \
  '    add_header Cache-Control "public, immutable";' \
  '    access_log off;' \
  '  }' \
  '  location / { try_files $uri $uri/ /index.html; }' \
  '}' \
  > /etc/nginx/conf.d/default.conf

EXPOSE 80

# nginx:alpine's own entrypoint/CMD handles startup; no override needed.
