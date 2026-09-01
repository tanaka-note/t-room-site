"""Site-specific resolver adapters.

Adapters are deliberately empty in the initial release. A future adapter must
return metadata only during analysis and must use the shared SSRF-safe network
client instead of opening sockets directly.
"""

ADAPTERS = []
