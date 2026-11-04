# Optional capture service for the server-assisted path (pixel-perfect captures of any URL).
# Not needed for the client-only default.  Build from the repo root:
#   docker build -f deploy/docker/Dockerfile -t physical-web-capture .
FROM mcr.microsoft.com/playwright/python:v1.49.0-noble
WORKDIR /app
RUN pip install --no-cache-dir "playwright==1.49.0"
COPY server.py /app/server.py
COPY lib /app/lib
COPY web /app/web
# Restrict what the service will capture (comma-separated URL prefixes) and cache results.
ENV PW_ALLOW="https://example.com/" PW_CACHE=/cache PW_BIND=0.0.0.0 PORT=8008
VOLUME ["/cache"]
EXPOSE 8008
CMD ["python3", "server.py"]
