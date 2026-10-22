# ADR 0007 - Rotated password roles instead of IAM database authentication

**Status:** accepted

## Context

Each component should connect with the least privilege it needs, credentials should rotate, and
rotation must not need a restart.

## Options

| Option | Against |
|---|---|
| IAM database authentication | Tokens are minted per connection and RDS limits IAM-authenticated new connections per second; every pool reconnect becomes a signing call; still needs database roles for the grants |
| RDS Proxy | An extra always-on cost and another component for a modest connection count (functions are few, reserved concurrency is set) |
| **Secrets Manager password roles, rotated** | A pool must survive a rotation |

## Decision

- Three roles: `audit_owner` (DDL, migrations only), `audit_writer` (INSERT + SELECT), `audit_reader`
  (SELECT). Each has its own secret, encrypted with the customer-managed key and rotated every 30
  days (single-user rotation - each role changes its own password, so grants never need re-applying).
- Clients fetch the secret lazily and cache it. On an authentication error (`28P01` / `28000`) they
  drop the cached secret and the pool and retry once - a rotation is absorbed without a restart.
- TLS is mandatory (`rds.force_ssl = 1`) and clients verify the server against the RDS CA bundle.
- An EventBridge rule on CloudTrail alarms when anything other than the migration or rotation
  function reads the owner secret.

## Consequences

- No per-connection signing; normal pooling works.
- Revisit RDS Proxy if many concurrent Lambda instances start to exhaust connections.
