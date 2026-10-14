# Security NFRs from OWASP ASVS

Paraphrased from and linked to the OWASP Application Security Verification Standard
(owasp.org/www-project-application-security-verification-standard). ASVS chapters
and requirement ids differ between versions: cite requirement ids from the ASVS version the
project pins, and treat which version that is as a fact (cite it or mark it UNVERIFIED).

## Choose the level

| Level | When                                                                                  |
| ----- | ------------------------------------------------------------------------------------- |
| 1     | Low-risk applications; the minimum for anything on the internet                       |
| 2     | Applications handling personal data or business transactions: the default for VTC     |
| 3     | Critical applications: high-value transactions, health or safety data, critical infra |

Depth L (§8.3: PII, payments, regulated data) means level 2 at least; record the level as a
decision.

## Architecture-level requirements to settle in the spine

These are the requirement areas that shape the architecture. Implementation-level checks belong
to the lens reviewers and the gates.

- **Secure design:** every trust boundary is named in the C4 level 2 diagram; data crossing one
  is validated on the receiving side; one component decides authorisation.
- **Authentication:** where identities come from (an identity provider, local accounts), how
  sessions or tokens are issued, rotated and revoked; MFA where the level requires it.
- **Session management:** server-side invalidation on logout and password change; token
  lifetimes stated.
- **Access control:** deny by default; authorisation enforced on the server for every request;
  object-level checks (no access by guessing an id).
- **Validation and encoding:** a single validation layer at each boundary; output encoding by
  the framework, not by hand.
- **Cryptography:** keys in a managed key store; no home-made cryptography; TLS for every network
  hop that leaves a trust boundary.
- **Data protection:** classify data (public, internal, personal, sensitive); state what is
  encrypted at rest, retained for how long, and deleted how.
- **Logging and errors:** security events logged without secrets or personal data; errors to
  users carry no internals.
- **Communication:** TLS everywhere outside the process; certificate management named.
- **Configuration and supply chain:** dependencies pinned and scanned; build pipeline and
  secrets separated per environment.
- **APIs and files:** rate limits, size limits, content-type checks on uploads.

## Turning a requirement into a decision

Example: "access control is enforced on the server for every request". Binds: every HTTP
handler; Prevents: an unprotected endpoint; Rule: each route declares its policy, and a route
without one is refused at start-up; Check: a test that enumerates routes and fails on a missing
policy (blocking).

## Threat model handoff

The Security role writes the threat model in design mode. The architecture names the trust
boundaries and the data classes so that the threat model and the spine use the same names.
