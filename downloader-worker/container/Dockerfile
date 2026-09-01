FROM python:3.13.7-slim-bookworm

ARG DENO_VERSION=2.9.5
ARG DENO_SHA256=8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH="/opt/deno/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates chromium clamav clamav-freshclam ffmpeg file tini unzip wget \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/deno/bin \
    && wget -q "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" -O /tmp/deno.zip \
    && echo "${DENO_SHA256}  /tmp/deno.zip" | sha256sum -c - \
    && unzip -q /tmp/deno.zip -d /opt/deno/bin \
    && rm /tmp/deno.zip \
    && freshclam --stdout

RUN python -m pip install --no-cache-dir \
      "yt-dlp[default]==2026.8.19"

RUN groupadd --system --gid 10001 downloader \
    && useradd --system --uid 10001 --gid downloader --home-dir /nonexistent --shell /usr/sbin/nologin downloader \
    && mkdir -p /app /work \
    && chown -R downloader:downloader /app /work /var/lib/clamav

WORKDIR /app
COPY --chown=downloader:downloader . /app

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "server.py"]
