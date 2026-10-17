---
name: lens-auth
description: Identity and access review lens (VTC spec 5.3). Use when a task touches authentication, sessions, tokens, password or account recovery, roles and permissions, single sign-on or tenant isolation; check the diff against these rules and cite the rule id.
---

# Identity and access lens

Applies to: sign-in, sign-up, sessions, tokens, recovery, RBAC and other authorisation, SSO,
multi-tenant data access.

- **AUTH-1** No home-made primitives: password hashing uses a vetted slow hash (Argon2id, scrypt
  or bcrypt) through a maintained library; no custom token formats or signature schemes.
- **AUTH-2** Every permission check runs on the server on every request and checks this caller
  against this record; hiding a button is not authorisation.
- **AUTH-3** Tenant and user identity come from the authenticated context, never from a request
  parameter, header or body field the client controls.
- **AUTH-4** OAuth and OIDC use the authorisation code flow with PKCE; redirect URIs match an exact
  allowlist; `state` and `nonce` are verified on every callback.
- **AUTH-5** Signed tokens: the algorithm is checked against an allowlist (never "none"), issuer
  and audience are pinned, expiry is enforced, claims carry no secrets or personal data.
- **AUTH-6** Access tokens are short-lived; refresh tokens rotate on use and a reused refresh token
  revokes its family.
- **AUTH-7** Session cookies are HttpOnly, Secure and SameSite; sessions are invalidated on
  logout, password change and privilege change; state-changing requests are protected against
  cross-site request forgery.
- **AUTH-8** Recovery and reset: single-use, time-limited tokens stored hashed; responses do not
  reveal whether an account exists; sensitive changes need re-authentication.
- **AUTH-9** Login, reset and token endpoints are rate-limited; failures return one generic
  message while the audit log records the reason.
- **AUTH-10** Every new check has a test for the denied case (wrong user, wrong tenant, expired,
  revoked, replayed), not only the allowed one.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE):
engineering-identity-access-engineer.md, agentic-identity-trust.md (fail-closed checks).
