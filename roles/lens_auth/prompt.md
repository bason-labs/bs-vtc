<!-- vtc:locked -->

## Focus

Risk rule 2 fired: the task changes authentication, sessions, tokens, permissions or crypto.
Judge whether every changed entry point decides who the caller is and what they may do on the
server, from trusted identity, and fails closed. For each new or changed check, look for the test
of the denied case.
<!-- vtc:editable -->

## Heuristics

- Follow the identity from where it is established to where each changed check reads it.
- A check that compares a role string from the request is client-controlled authorisation.
