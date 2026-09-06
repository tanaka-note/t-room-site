ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER 0:0
# Only a disposable candidate is changed. Never edit the running image/database.
# Fetch signed CVD archives afresh; do not relabel mtimes or extend validity.
ARG REFRESH_ID
RUN test -n "${REFRESH_ID}" \
    && cp /usr/local/share/base-ca-certificates.crt /work/ca-certificates.crt \
    && rm -f /var/lib/clamav/main.cvd /var/lib/clamav/main.cld \
      /var/lib/clamav/daily.cvd /var/lib/clamav/daily.cld \
      /var/lib/clamav/bytecode.cvd /var/lib/clamav/bytecode.cld \
    && /usr/local/bin/freshclam --config-file=/etc/clamav/freshclam.conf --stdout \
    && /usr/local/bin/sigtool --info /var/lib/clamav/main.cvd \
    && /usr/local/bin/sigtool --info /var/lib/clamav/daily.cvd \
    && /usr/local/bin/sigtool --info /var/lib/clamav/bytecode.cvd \
    && rm /work/ca-certificates.crt
USER 10001:10001
