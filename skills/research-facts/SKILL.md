---
name: research-facts
description: How a VTC role cites facts and marks unsourced claims (spec §8.2; spine AD-22) - fact_lookup to find recorded facts, fact_propose to record a new one with its source and locator, citing `fact` evidence, and writing `UNVERIFIED:` for anything no fact supports. Load before writing any version, licence, support window, vulnerability or price claim.
---

# Citing facts

Sources: written for VTC (spec §8.2; spine AD-22).

Versions, licences, support windows (end of life), vulnerabilities and prices come only from
facts the engine recorded, never from memory. The engine keeps them as rows, each with a status
it decided by checking the source: `verified`, `unverified`, `stale`, `conflicting` or `waived`.
You can read rows and propose new ones; you never write the facts file yourself.

## Finding a fact: `fact_lookup`

- By id: `{ "ids": ["f-0123456789abcdef"] }`, for facts your task pack or the research brief
  already cites.
- By subject: `{ "subject": "npm:react@19.0.0", "predicate": "license" }`; leave out
  `predicate` to get every fact about the subject.

Subjects name the thing precisely: `npm:<name>@<version>`, `pypi:<name>@<version>`,
`<product>@<release>` for a runtime or OS release (`nodejs@22`), `github:<owner>/<repo>`.
Predicates are short: `license`, `latest_version`, `eol_date`, `advisories`, `price`.

Use a fact only when its `status` is `verified`. A `stale`, `conflicting` or `unverified` fact
is a claim still to settle: cite it, and say what its status is.

## Recording a fact: `fact_propose`

When a source you fetched (the research-fetch skill) states something your output relies on,
propose it:

```json
{
  "subject": "nodejs@22",
  "predicate": "eol_date",
  "value": "<the value exactly as the source gives it>",
  "source": {
    "request": { "fetcher": "eol", "product": "nodejs", "release": "22" },
    "locator": { "kind": "json_pointer", "pointer": "/<path>/<to>/<field>" }
  }
}
```

(The value and pointer are placeholders: read both from the fetched source.)

- `locator` says where the value sits in the cached source:
  - `json_pointer` for JSON sources (`eol`, `depsdev`, `osv`, `registry`, `github`): an RFC 6901
    pointer that must resolve to exactly the value (a string, number, boolean or null), not to
    an object;
  - `quote` for pages (`web`, `rss`, `youtube`): `{ "kind": "quote", "text": "…" }`, a verbatim
    span of the page that contains the value's text. Copy it exactly, without the `│ ` prefix of
    the datamarked text and without changing whitespace or punctuation.
- `source: null` records a claim nobody could source; it stays `unverified`. Prefer saying
  `UNVERIFIED:` in your output over proposing such a row.
- `pinned_version`: the version the claim holds for, when it differs from the subject's.

The engine fetches or reads the cached source, checks the locator and returns the row with its
status. A row that comes back `unverified` means your locator did not resolve: fix the locator
from the source text, or treat the claim as unverified.

## Citing in your output

- In your role result, cite a fact as evidence `{ "type": "fact", "ref": "<fact id>" }`; in a
  document, put the fact id next to the claim: "Node.js 22 is supported until … [f-0123456789abcdef]".
- Anything you cannot back with a verified fact is written `UNVERIFIED: <claim>`, with the
  colon, so the engine finds it. Never drop the tag to make a document read better.

## What happens at G2

Before G2 the engine lists every fact that is unverified, stale or conflicting, every
`UNVERIFIED:` tag, and every version, licence, vulnerability or end-of-life claim in the research
and architecture documents that cites no fact. The human must waive each one with a reason, or
the gate does not pass. So an uncited claim costs the human time; a cited, verified one does not.
