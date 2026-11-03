# physical-web capture service (optional server-assisted path).
# Build context = repo root:  docker build -f deploy/evo/Dockerfile -t physical-web-capture .
FROM mcr.microsoft.com/playwright/python:v1.49.0-noble
WORKDIR /app
RUN pip install --no-cache-dir "playwright==1.49.0"
COPY server.py /app/server.py
COPY lib /app/lib
COPY web /app/web
ENV PW_ALLOW="https://pekelman.com/,https://www.pekelman.com/" PW_CACHE=/cache PORT=8008
VOLUME ["/cache"]
EXPOSE 8008
CMD ["python3", "server.py"]
