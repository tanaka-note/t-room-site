#!/bin/sh
set -eu

# Cloudflare creates this CA only when the Container starts. Build a runtime
# bundle as UID 10001 so Python, yt-dlp, ffmpeg, and Chromium can use HTTPS
# interception without granting the application root privileges.
runtime_bundle=/work/ca-certificates.crt
cloudflare_ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
umask 077
if [ -f "$cloudflare_ca" ]; then
  cat /usr/local/share/base-ca-certificates.crt "$cloudflare_ca" > "$runtime_bundle"
else
  cp /usr/local/share/base-ca-certificates.crt "$runtime_bundle"
fi
chmod 0400 "$runtime_bundle"
export SSL_CERT_FILE="$runtime_bundle"
export REQUESTS_CA_BUNDLE="$runtime_bundle"
export CURL_CA_BUNDLE="$runtime_bundle"

exec "$@"
