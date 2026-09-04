FROM python:3.13.7-slim-bookworm AS yara-builder

ARG YARA_VERSION=4.5.8
ARG YARA_SOURCE_SHA256=c322414975ff6f701149856613afdcd92a7e6939c284c798ae3c85618197efaa

RUN apt-get update && apt-get install -y --no-install-recommends \
      autoconf automake bison build-essential ca-certificates flex libjansson-dev libssl-dev libtool pkg-config wget \
    && rm -rf /var/lib/apt/lists/* \
    && wget -q "https://github.com/VirusTotal/yara/archive/refs/tags/v${YARA_VERSION}.tar.gz" -O /tmp/yara.tar.gz \
    && echo "${YARA_SOURCE_SHA256}  /tmp/yara.tar.gz" | sha256sum -c - \
    && mkdir -p /tmp/yara-src \
    && tar -xzf /tmp/yara.tar.gz --strip-components=1 -C /tmp/yara-src \
    && cd /tmp/yara-src \
    && ./bootstrap.sh \
    && ./configure --prefix=/opt/yara --disable-cuckoo --disable-magic \
    && make -j2 \
    && make install

FROM python:3.13.7-slim-bookworm

ARG DENO_VERSION=2.9.5
ARG DENO_SHA256=8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530
ARG CLAMAV_VERSION=1.4.6
ARG CLAMAV_DEB_SHA256=d3ee9e401974855a1edc1761b1425417d126de618d5f0c91cd51209f69f6fcc2

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    CLAMAV_MAX_DEFINITION_AGE_SECONDS=604800 \
    CLAMAV_SCAN_TIMEOUT_SECONDS=600 \
    CLAMAV_DATABASE_DIR=/var/lib/clamav \
    YARA_RULES_FILE=/app/yara-rules/compiled.yarc \
    YARA_RULES_SHA256_FILE=/app/yara-rules/compiled.yarc.sha256 \
    YARA_SCAN_TIMEOUT_SECONDS=180 \
    PATH="/opt/yara/bin:/opt/deno/bin:${PATH}" \
    LD_LIBRARY_PATH="/opt/yara/lib"

COPY --from=yara-builder /opt/yara /opt/yara

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates chromium clamav clamav-freshclam ffmpeg file tini unzip wget \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/deno/bin \
    && wget -q "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" -O /tmp/deno.zip \
    && echo "${DENO_SHA256}  /tmp/deno.zip" | sha256sum -c - \
    && unzip -q /tmp/deno.zip -d /opt/deno/bin \
    && rm /tmp/deno.zip \
    && wget -q "https://github.com/Cisco-Talos/clamav/releases/download/clamav-${CLAMAV_VERSION}/clamav-${CLAMAV_VERSION}.linux.x86_64.deb" -O /tmp/clamav.deb \
    && echo "${CLAMAV_DEB_SHA256}  /tmp/clamav.deb" | sha256sum -c - \
    && dpkg -i /tmp/clamav.deb \
    && rm /tmp/clamav.deb

# Wrangler passes this deliberately rotated value as a build argument. Updating
# it invalidates only the definition layer, so scheduled rebuilds cannot reuse a
# previously cached freshclam result while the large OS dependency layer remains
# cacheable. Definitions are never updated at container startup.
ARG CLAMAV_DEFINITION_REFRESH=unset
RUN test "${CLAMAV_DEFINITION_REFRESH}" != "unset" \
    && printf 'ClamAV definition refresh: %s\n' "${CLAMAV_DEFINITION_REFRESH}" \
    && /usr/local/bin/freshclam --config-file=/etc/clamav/freshclam.conf --stdout \
    && /usr/local/bin/clamscan --database=/var/lib/clamav --version \
    && /usr/local/bin/sigtool --info /var/lib/clamav/main.cvd \
    && /usr/local/bin/sigtool --info /var/lib/clamav/daily.cvd \
    && /usr/local/bin/sigtool --info /var/lib/clamav/bytecode.cvd

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
RUN echo "3f72f78730662a2975f5965059d6064e78eaaa990a7bddf3a471b862927c11ea  /app/yara-rules/sources/gen_xored_pe.yar" \
      | sha256sum -c - \
    && echo "fdb4b31835ba5193c1be53fb40aadebfb47218d2e9518eb97298647bb83b4312  /app/yara-rules/sources/generic_exe2hex_payload.yar" \
      | sha256sum -c - \
    && find /app/yara-rules/sources -type f -name '*.yar' -print0 \
      | sort -z \
      | xargs -0 cat > /tmp/tlain-downloader-rules.yar \
    && /opt/yara/bin/yarac /tmp/tlain-downloader-rules.yar /app/yara-rules/compiled.yarc \
    && sha256sum /app/yara-rules/compiled.yarc > /app/yara-rules/compiled.yarc.sha256 \
    && /opt/yara/bin/yara -C -w -a 10 -l 1 /app/yara-rules/compiled.yarc /dev/null \
    && rm /tmp/tlain-downloader-rules.yar \
    && chmod 0555 /app/entrypoint.sh

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["python", "server.py"]
