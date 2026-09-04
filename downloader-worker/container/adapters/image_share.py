from __future__ import annotations

import re
from urllib.parse import urlencode, urlsplit


class AdapterError(ValueError):
    pass


class ImageShareAdapter:
    """Resolver for the narrowly scoped cdn.image-share.cc landing page."""

    name = "image-share"
    source_hostname = "cdn.image-share.cc"
    api_hostname = "rwzugqnp.fun800.click"
    _short_link = re.compile(r"^[A-Za-z0-9_-]{1,80}$")

    def matches(self, source_url: str) -> bool:
        return (urlsplit(source_url).hostname or "").lower() == self.source_hostname

    def discovery_url(self, source_url: str) -> str:
        parsed = urlsplit(source_url)
        segments = [segment for segment in parsed.path.split("/") if segment]
        if len(segments) != 1 or not self._short_link.fullmatch(segments[0]):
            raise AdapterError("adapter_source_invalid")
        query = urlencode({"externalLinks": segments[0], "domain": self.source_hostname})
        return f"https://{self.api_hostname}/app-api/flow/land-page/getInfo?{query}"

    def parse(self, payload: object) -> dict:
        root = payload if isinstance(payload, dict) else {}
        if root.get("code") is not None and str(root.get("code")) != "0":
            raise AdapterError("adapter_response_invalid")
        data = root.get("data") if isinstance(root.get("data"), dict) else root
        info = data.get("info") if isinstance(data.get("info"), dict) else {}
        media = info.get("netDiskInfo") if isinstance(info.get("netDiskInfo"), dict) else {}
        candidate = next((media.get(name) for name in ("fileUrl", "originUrl") if isinstance(media.get(name), str) and media.get(name).strip()), "")
        if not candidate:
            raise AdapterError("media_not_found")
        title = next((media.get(name) for name in ("name", "title", "fileName") if isinstance(media.get(name), str) and media.get(name).strip()), "")
        thumbnail = next((media.get(name) for name in ("coverImage", "thumbnail", "previewUrl") if isinstance(media.get(name), str) and media.get(name).strip()), "")
        return {
            "adapter": self.name,
            "url": candidate.strip(),
            "title": title.strip()[:240],
            "thumbnail": thumbnail.strip()[:4096],
        }

