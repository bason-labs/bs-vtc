---
name: domain-realtime
description: "Realtime and collaboration domain pack (VTC spec 5.2a). Load when the repository or the specification shows realtime transport, presence, collaborative editing or offline sync (WebSocket or SSE servers, CRDT or OT libraries); adds the domain's rules to the Engineer and the reviewers. Cite rule ids in findings."
---

# Realtime and collaboration domain pack

Load when: realtime transport, presence, collaborative editing or offline sync (WebSocket or SSE
servers, CRDT or OT libraries).

## Rules

- **RT-1** Design the reconnect first: clients resume from the last acknowledged sequence number.
- **RT-2** Every operation is idempotent, keyed by a client-generated id.
- **RT-3** The server owns ordering (sequence numbers or logical clocks); client wall clocks order
  nothing.
- **RT-4** Choose the convergence model per data type: CRDT or OT for text, server-arbitrated
  last-writer-wins for simple fields.
- **RT-5** Presence is ephemeral and separate from the durable operation log.
- **RT-6** Bound every queue; coalesce or drop-then-resync slow consumers instead of buffering
  without limit.
- **RT-7** Deploys drain connections and clients reconnect with jittered backoff.
- **RT-8** Tests cover hostile networks: dropped sockets mid-operation, stale operations replayed
  after hours offline, concurrent edits of the same range.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-realtime-
collaboration-engineer.md.
