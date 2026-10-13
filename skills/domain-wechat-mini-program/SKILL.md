---
name: domain-wechat-mini-program
description: "WeChat Mini Programs domain pack (VTC spec 5.2a). Load when the repository or the specification shows a WeChat Mini Program (app.json with pages, *.wxml and *.wxss files, project.config.json); adds the domain's rules to the Engineer and the reviewers. Cite rule ids in findings."
---

# WeChat Mini Programs domain pack

Load when: a WeChat Mini Program (app.json with pages, *.wxml and *.wxss files,
project.config.json).

## Rules

- **WX-1** Every request goes to a registered domain over HTTPS.
- **WX-2** The main package stays within the platform's size limit; split features into
  subpackages.
- **WX-3** Ask for user authorisation before accessing protected data, following the platform's
  privacy rules.
- **WX-4** No DOM manipulation; update views through data binding with small, infrequent updates.
- **WX-5** Handle the App, Page and Component lifecycles explicitly.
- **WX-6** Payment success is confirmed on the server from the payment platform's notification,
  never from the client callback alone.
- **WX-7** Session keys and secrets stay on the server; the client holds only its own session
  token.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-wechat-mini-
program-developer.md (its client-trusted payment callback fixed).
