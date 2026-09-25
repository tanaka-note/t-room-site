# T-lain Downloader 2 Worker

Owner-only UI and Passkey handoff for the local Downloader 2 path. This Worker is not a media data plane and must remain free of R2, D1, Queue, Container, Durable Object, media fetch/proxy, and Cloud ffmpeg bindings.

Use `pnpm run check`, `pnpm test`, and `pnpm run deploy:dry`. Do not deploy until the Downloader 2 service migration, Security binding, extension, and Companion have been reviewed together.
