# Chapter & Co.

Chapter & Co. is a demo bookstore with a Neon Postgres catalog and persistent
shopping carts. Checkout is a **simulation only**: it never requests card
details or charges money.

## Catalog and bookstore features

The catalog contains 16 published books. ISBNs and cover images are sourced
from Open Library; if a cover is unavailable, the storefront generates a
matching illustrated fallback. The seed script removes the eight retired
fictional demo titles and their cart lines, while leaving other database
records untouched.

The storefront includes genre filters, search, price/title sorting, a local
favorites list, and a “Surprise me” pick. Cart lines, demo stock, and catalog
records are stored in Neon. Each seed run upserts these listings without
deleting other database records beyond those retired demo titles.

The linked Vercel project already has a Neon database connected. To seed a
specific environment, load that environment's `DATABASE_URL` and run:

```powershell
node --env-file=.env.preview.local scripts/seed-catalog.js
```

Change the env file to use the Development connection when seeding locally.
Do not use Production credentials for demo data. The seed script creates
`bookstore_books`, `bookstore_carts`, and `bookstore_cart_items`.

## Simulated checkout and EmailJS

The checkout can simulate success or failure. EmailJS sends a clearly marked
notification to the email entered at checkout and copies the fixed store inbox.
No payment is attempted and no money is collected.

Set **To Email** to `{{customer_email}}` and **Cc** to the store notification
address in the EmailJS template. The template uses `{{order_id}}`,
`{{customer_name}}`, `{{customer_email}}`, `{{payment_status}}`,
`{{order_items}}`, `{{order_total}}`, `{{currency}}`, and `{{payment_note}}`.
Add `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`, and
`EMAILJS_PRIVATE_KEY` to Vercel Preview environment variables. Keep the private
key server-side; never expose it in browser code.

After sending, customers are advised to check their spam or junk folder if the
notification isn't visible. The free EmailJS plan has limits; see its
[pricing](https://www.emailjs.com/pricing/). Keep Preview protected and never
use the simulated checkout as a real payment system.

## Run locally

1. Copy `.env.example` to `.env`, or pull Development variables with
   `vercel env pull .env.local --yes`.
2. Keep `.env`, `.env.local`, and all database/API credentials private.
3. Install dependencies with `npm install`.
4. Seed Development data with `npm run db:seed`.
5. Run `npm.cmd start` on Windows (or `npm start` elsewhere), then open
   <http://localhost:8765>.

## Tests

Run `npm.cmd test` on Windows (or `npm test` elsewhere) to test catalog reads,
cart operations, EmailJS simulation validation and error handling, and API
responses without making external requests.
