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

# JSON form because the source filename contains spaces — the shell form would
# read it as two arguments and fail with "requires at least two arguments".
#
# `index.html`, not the original filename: that is what the stock config serves,
# and it also means the URL is `/` rather than `/Converse360%20Website.html`.
#
# Of the three exports in this directory this is the only self-contained one.
# The two `*.dc.html` files reference `./support.js`, which is not in the repo,
# so serving either would render a blank page. Keep that in mind if a designer
# hands over a new export: check for external references before swapping it in.
COPY ["apps/site/Converse360 Website.html", "/usr/share/nginx/html/index.html"]

# Privacy Policy and Terms of Service.
#
# These are NOT part of the bundle, on purpose. The bundle is regenerated
# wholesale by a design tool on every site change, so anything living inside it
# is one re-export away from disappearing — and these two URLs are pasted into
# the Meta App Dashboard, where a 404 costs an App Review cycle. Separate files
# survive a re-export untouched.
COPY apps/site/privacy.html /usr/share/nginx/html/privacy.html
COPY apps/site/terms.html /usr/share/nginx/html/terms.html

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
  '  # It has to come before the /index.html fallback, otherwise the bundle' \
  '  # would swallow both URLs and every legal page would render the homepage.' \
  '  location / { try_files $uri $uri.html $uri/ /index.html; }' \
  '}' \
  > /etc/nginx/conf.d/default.conf

EXPOSE 80

# nginx:alpine's own entrypoint/CMD handles startup; no override needed.
