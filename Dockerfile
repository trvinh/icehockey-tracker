# Hockey Log: static PWA + sync API. Python standard library only, no pip installs.
FROM python:3.12-alpine
RUN adduser -D -u 1000 app && mkdir -p /data && chown app /data
WORKDIR /app
COPY server/server.py server/server.py
# Only the web app files are served (see .dockerignore for what stays out of the image).
COPY index.html app.js style.css sw.js manifest.webmanifest web/
COPY icons web/icons
COPY vendor web/vendor
ENV HOCKEY_DB=/data/hockey.db HOCKEY_WEB_DIR=/app/web HOCKEY_HOST=0.0.0.0 HOCKEY_PORT=8090 PYTHONUNBUFFERED=1
USER app
EXPOSE 8090
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8090/api/health || exit 1
CMD ["python", "server/server.py"]
