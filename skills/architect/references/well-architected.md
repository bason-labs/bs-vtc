# Well-Architected pillars: a blind-spot check

Paraphrased from and linked to the AWS Well-Architected Framework
(docs.aws.amazon.com/wellarchitected), the Azure Well-Architected Framework
(learn.microsoft.com/azure/well-architected) and the Google Cloud Architecture Framework
(cloud.google.com/architecture/framework). The pillars overlap across the three; this merges
them. Use it after the candidates exist, to find what none of them addresses.

## Pillars and the questions to ask of each candidate

**Operational excellence**

- How is it deployed: one command, in a pipeline, reproducibly? How long is a rollback?
- What is observed: structured logs, metrics per driving scenario, traces across boundaries?
- Who runs it, and what runbook exists for the three most likely incidents?
- Is infrastructure defined as code, reviewed like code?

**Security**

- Identity: who authenticates whom, and where is authorisation decided (one place)?
- Data: what is encrypted in transit and at rest; who holds the keys?
- Detection: are security-relevant events logged and alerted?
- Blast radius: what can an attacker reach after compromising one component?
- Supply chain: how are dependencies pinned, scanned and updated?

**Reliability**

- Failure modes: for each dependency, what happens when it is slow, down or wrong?
- Recovery: backups, restore tested, RTO and RPO met?
- Limits: quotas, connection pools, queue depths; what happens at the limit?
- Change: are deployments gradual, with automatic rollback on a failed health check?

**Performance efficiency**

- Is the latency budget split across the call path, and does each hop fit?
- Where is caching, and how is it invalidated?
- What is the scaling unit, and is state kept out of it?
- Has the driving scenario's load been measured, or only estimated?

**Cost optimisation**

- What does it cost per month at expected load, and at ten times that?
- Which cost grows with users, which with data, which is fixed?
- Is anything provisioned for a peak that rarely comes?
- What does each innovation token cost to learn and operate?

**Sustainability** (AWS)

- Is capacity matched to demand (scale to zero where idle)?
- Is data retained only as long as needed?

## How to use the result

For each pillar, write one line per candidate: covered, partially covered (say what is missing)
or not applicable (say why). A gap that a driving scenario depends on becomes a decision (AD-n)
or an explicit assumption; any other gap goes into the risks list. Do not add a component only to
fill a pillar: the pillar is a question, not a requirement.
