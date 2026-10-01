# Security Policy

## Supported deployment model

Mnemosyne Dashboard is designed as a local read-only dashboard.

Default bind address:

```text
0.0.0.0
```

The dashboard is LAN-reachable by default for convenience. Memory admin/editing remains disabled by default; LAN/non-local admin mode requires password auth before mutation endpoints work. If you expose it beyond a trusted LAN, protect it with network controls, VPN, SSH tunnel, or reverse-proxy authentication.

## Data access

The dashboard opens the SQLite database using read-only URI mode:

```text
file:<db_path>?mode=ro
```

Memory browsing opens SQLite in read-only mode. Optional maintenance endpoints are disabled by default, limited to audited Mnemosyne-style supersede/expire/importance updates, and require password auth before LAN/non-local use.

## Switching databases

The dashboard can switch which Mnemosyne database is active at runtime through `POST /api/databases/select`. This is a state-changing request and is gated by the same authentication as other writes.

To avoid path traversal or arbitrary local-file reads on a LAN-exposed server, the endpoint never accepts a raw client-supplied path. It only accepts a path already present in a server-built allowlist, which is derived from the optional `db_paths` config list, auto-discovered Hermes brain databases, and the currently active database. Each candidate must be an existing file that opens in read-only mode (`mode=ro`); requests for anything outside the allowlist are rejected with HTTP 400. Switching never escapes the discovered set and never opens a database for writing.

## Reporting issues

For public repos, report vulnerabilities privately through GitHub Security Advisories if enabled, or open a minimal issue without sensitive memory/database contents.

Do not paste private Mnemosyne memory content into public issues.
