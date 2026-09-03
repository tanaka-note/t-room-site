FROM python:3.13.7-slim-bookworm

ARG DENO_VERSION=2.9.5
ARG DENO_SHA256=8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    CLAMAV_MAX_DEFINITION_AGE_SECONDS=604800 \
    PATH="/opt/deno/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates chromium clamav clamav-freshclam ffmpeg file tini unzip wget \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/deno/bin \
    && wget -q "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" -O /tmp/deno.zip \
    && echo "${DENO_SHA256}  /tmp/deno.zip" | sha256sum -c - \
    && unzip -q /tmp/deno.zip -d /opt/deno/bin \
    && rm /tmp/deno.zip

# Wrangler passes this deliberately rotated value as a build argument. Updating
# it invalidates only the definition layer, so scheduled rebuilds cannot reuse a
# previously cached freshclam result while the large OS dependency layer remains
# cacheable. Definitions are never updated at container startup.
ARG CLAMAV_DEFINITION_REFRESH=unset
RUN test "${CLAMAV_DEFINITION_REFRESH}" != "unset" \
    && printf 'ClamAV definition refresh: %s\n' "${CLAMAV_DEFINITION_REFRESH}" \
    && freshclam --stdout \
    && clamscan --version

RUN python -m pip install --no-cache-dir \
      "yt-dlp[default,curl-cffi]==2026.8.19"

RUN groupadd --system --gid 10001 downloader \
    && useradd --system --uid 10001 --gid downloader --home-dir /nonexistent --shell /usr/sbin/nologin downloader \
    && mkdir -p /app /work \
    && cp /etc/ssl/certs/ca-certificates.crt /usr/local/share/base-ca-certificates.crt \
    && rm /etc/ssl/certs/ca-certificates.crt \
    && ln -s /work/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt \
    && chown -R downloader:downloader /work

WORKDIR /app
COPY . /app
RUN chmod 0555 /app/entrypoint.sh

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["python", "server.py"]
