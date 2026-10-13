---
name: lens-payments
description: Payments and billing review lens (VTC spec 5.3). Use when a task touches charges, refunds, subscriptions, invoices, payment-provider webhooks, prices or stock that money depends on; check the diff against these rules and cite the rule id.
---

# Payments and billing lens

Applies to: payment flows, billing, subscriptions, provider webhooks, prices, orders.

- **PAY-1** Card data never reaches the server: collection uses the provider's hosted fields or
  SDK tokenisation.
- **PAY-2** Every money-moving call carries an idempotency key derived from the business operation
  (order and attempt), not a random value per HTTP call.
- **PAY-3** Fulfilment happens on the provider's verified webhook, never on the customer's return
  to a success page.
- **PAY-4** Webhooks: the signature and timestamp are verified; the event is stored durably before
  acknowledgement; processing is deduplicated by event id and safe to replay.
- **PAY-5** Amounts are integers in minor units with an ISO 4217 currency; zero-decimal and
  three-decimal currencies are handled; never floating point.
- **PAY-6** Every provider state is modelled: requires action (3-D Secure), processing, failed,
  partially refunded, disputed; none is logged and ignored.
- **PAY-7** Orders are never deleted; cancellations and refunds are new records. Stock and limits
  are decremented atomically so concurrent checkouts cannot oversell.
- **PAY-8** Test and live credentials and endpoints are separated by configuration; no live
  identifier appears in code or tests.
- **PAY-9** Tests cover the provider's failure catalogue (decline, insufficient funds, challenge,
  dispute), not only the success case.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE):
engineering-payments-billing-engineer.md, engineering-wordpress-shopping-cart.md and
engineering-drupal-shopping-cart.md (money, webhook and order rules only).
