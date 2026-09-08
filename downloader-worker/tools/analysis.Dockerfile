# Narrow code-only release: inherit the verified production engine, rules,
# signed databases and runtime. No freshclam, pip or OS dependency changes.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY resolver.py main_video.py server.py /app/
COPY tests/test_main_video.py /app/tests/test_main_video.py
