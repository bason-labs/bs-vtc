# Role prompt changes

This file records every change to the editable section of a role prompt
(`roles/<role>/prompt.md`, the part after `<!-- vtc:editable -->`). VTC writes the entries; nobody
edits them by hand.

When a Lookback replay finds that a proposed editable section does better than the current one
(verdict `improve`), VTC opens a pull request to this repository. The pull request changes that
one section and adds an entry here. The change takes effect for everyone when a human merges the
pull request, and ships in the next VTC release. VTC never merges these pull requests itself.

Each entry has a heading that names the role, the date and the new prompt version. It then gives:

- **Hypothesis:** what the change should improve, and which scorecard metric should show it.
- **Trace ids:** the recorded dispatches that led to the proposal. They are ids only; no project
  code, path or name appears here.
- **Diff:** the change to the editable section, as a unified diff.
- **Evaluation:** how the change was tested. For a replay, this is the replay result: trials per
  arm, the A/A flip rate, the sign test, the token change and the verdict. When no replay was
  possible (for example, for a new role), the entry says `needs-eval`, and the pull request has
  only evidence and carries the `needs-eval` label.

Newer entries come first, directly below the next line.

<!-- vtc:changelog-entries -->
