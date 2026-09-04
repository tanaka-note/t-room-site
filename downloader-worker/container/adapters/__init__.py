"""Narrow site adapters that still use the shared SSRF-safe network client."""

from .image_share import AdapterError, ImageShareAdapter


ADAPTERS = [ImageShareAdapter()]

__all__ = ["ADAPTERS", "AdapterError", "ImageShareAdapter"]
