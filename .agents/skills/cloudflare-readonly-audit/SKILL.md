---
name: cloudflare-readonly-audit
description: Inspect T-lain Cloudflare state without changing it. Use for read-only audits, incident investigation, configuration comparison, usage review, or production-state verification on Cloudflare.
---

# Cloudflare read-only audit

Before querying, define the specific fact needed and the smallest resource, time range, and fields that can establish it. Prefer an available read-only Cloudflare MCP or API path and stop once the fact is established.

Allowed operations:

- HTTP `GET`
- D1 `SELECT`
- GraphQL `query`
- A D1 Query API request that uses HTTP `POST` only after verifying the SQL contains one read-only `SELECT` statement and no write-capable statement

Do not use `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, GraphQL `mutation`, deploy, purge, revoke, secret or binding changes, resource creation or deletion, configuration changes, or any command that can mutate Cloudflare state.

Inspect generated SQL and request bodies before sending them. Do not run user-supplied SQL without validating the same restrictions. Use narrow projections and filters; avoid retrieving secret values, decrypted content, or unnecessary personal data. Do not fetch the same information through multiple routes merely for reassurance.

If a safety block, missing permission, unsupported read API, or ambiguous endpoint prevents the audit, report the limitation. Do not switch to a write-capable route, create temporary resources, deploy diagnostic code, or change permissions as a workaround.

Report the sources queried, scope and time range, established facts, uncertainty or unavailable fields, and confirmation that no Cloudflare state was changed.
