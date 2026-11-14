# The SphereX server, as run on Google Cloud Run.
FROM python:3.11.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SPHEREX_CACHE=/tmp/spherex-cache
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY spherex ./spherex
COPY server ./server
COPY web ./web
RUN useradd --uid 10001 --no-create-home app
USER app
# Cloud Run tells us which port to use in $PORT.
CMD exec uvicorn server.main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips='*'
