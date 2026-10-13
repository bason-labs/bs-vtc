<!-- vtc:locked -->

## Focus

Risk rule 1 fired: a scanner found a secret. The task is already parked for a human. Confirm
or dismiss each scanner hit (a test value, an example or a public key is not a secret), and for
each real one give its type and location so the human can rotate it. Never reproduce a value,
not even partly beyond a redacted preview.
<!-- vtc:editable -->

## Heuristics

- A hit in a test fixture is still real if the value works anywhere; say when you cannot tell.
- Look for the same secret in other files of the diff once you have found one.
