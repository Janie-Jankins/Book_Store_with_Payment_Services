# Chapter & Co.

The storefront creates Paystack transactions on the Node.js backend and verifies
the transaction with Paystack before confirming an order. Prices are shown and
charged in ZAR, converted from the catalog's USD prices using the fixed rate
`1 USD = 18.50 ZAR`. The server calculates the amount; the browser never sends
prices. Payment details are entered on Paystack's hosted checkout.

## Run locally

1. Copy `.env.example` to `.env`.
2. Set `PAYSTACK_SECRET_KEY` to your Paystack **test secret key**. Keep the key
   private and out of source control.
3. Create a Resend account, verify a sending domain, create an API key, then set
   `RESEND_API_KEY` and `RESEND_FROM_EMAIL` to that key and a sender address on
   the verified domain. Do not use a sender domain you haven't verified.
4. Run `npm.cmd start` on Windows (or `npm start` elsewhere), then open
   <http://localhost:8765>.

The store ships to South Africa, the United States, Canada, the United Kingdom,
and Australia. Shipping is converted from $4.95 below a $40 USD subtotal and is
free at or above $40 USD.

## Webhooks

For local testing, expose the app through a public HTTPS tunnel, then configure
that URL in the Paystack dashboard as a webhook endpoint ending in
`/api/webhooks/paystack`. Paystack signs webhooks with the secret key configured
as `PAYSTACK_SECRET_KEY`; no separate webhook signing secret is used. Successful
and failed payment events are verified with Paystack before an email is sent.
The app also verifies a payment when the customer returns from checkout.

The backend stores payment references and email notification state in
`data/payment-orders.json` to support webhook handling and avoid duplicate
notifications. Keep this file private and use persistent private storage in
production.

Payment status emails are sent by Resend. Verify the sender domain in Resend
before enabling checkout. Resend's idempotency key is used to prevent duplicate
emails when a webhook is retried.

## Tests

Run `npm.cmd test` on Windows (or `npm test` elsewhere) to test order validation,
currency conversion, transaction initialization and verification, and webhook
signature checks without contacting Paystack.
