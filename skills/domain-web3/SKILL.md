---
name: domain-web3
description: "Web3 and smart contracts domain pack (VTC spec 5.2a). Load when the repository or the specification shows smart contracts (*.sol or *.vy files, Foundry or Hardhat configuration); adds the domain's rules to the Engineer and the reviewers. Cite rule ids in findings."
---

# Web3 and smart contracts domain pack

Load when: smart contracts (*.sol or *.vy files, Foundry or Hardhat configuration).

## Rules

- **WEB3-1** Checks, effects, interactions: update state before any external call; guard re-
  entrancy on every function that calls out.
- **WEB3-2** Authorisation uses the direct caller, never the transaction origin.
- **WEB3-3** Send value with a low-level call and check its result; never assume an external
  contract's return value.
- **WEB3-4** Build on audited libraries for tokens, access control and upgrades; no custom
  cryptography.
- **WEB3-5** No loops over arrays that users can grow; unbounded iteration is a denial of service.
- **WEB3-6** Integer narrowing casts are checked; arithmetic outside checked contexts is
  justified.
- **WEB3-7** Upgradeable contracts preserve storage layout; every upgrade path is tested.
- **WEB3-8** Invariant and fuzz tests cover value-moving functions; static analysis passes with no
  new findings.
- **WEB3-9** Deployments to a live network are never part of a task; they are a human step.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-solidity-smart-
contract-engineer.md (its unchecked downcast example fixed), security-blockchain-security-
auditor.md.
