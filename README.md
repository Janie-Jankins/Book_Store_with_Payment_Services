# Chapter & Co.

The storefront reads its product catalog, prices, availability, shopping cart,
and checkout URL from Shopify. Product and cart requests use Shopify's
Storefront GraphQL API; checkout and payment are completed on Shopify's hosted
checkout.

## Shopify setup

The Vercel Shopify sandbox is connected to the project's Preview and
Development environments. Add products, variants, prices, images, and inventory
to the Shopify store before expecting books to appear in the storefront. Books
are grouped using Shopify's product type, with the first product tag as a
fallback category. The storefront uses the product vendor as the author.

The current sandbox catalog is empty. The storefront intentionally shows an
empty-catalog message instead of the previous demo books until real Shopify
products are added.

Shopify sandboxes are for testing and cannot take live payments. When the store
is ready for customers, claim or connect a real Shopify store in the Vercel
Marketplace, verify its payment provider and checkout settings in Shopify, and
connect that resource to the Production environment before deploying.

## Run locally

1. Copy `.env.example` to `.env`, or run `vercel env pull .env.local --yes`
   from the linked project to get the Shopify Development credentials.
2. Keep Shopify access tokens private; do not commit `.env` or `.env.local`.
3. Run `npm.cmd start` on Windows (or `npm start` elsewhere), then open
   <http://localhost:8765>.

The app fetches books from Shopify at `/api/products`. Cart IDs are stored in
an HTTP-only, secure-in-production cookie. Shopify calculates cart totals,
shipping, taxes, and checkout; the browser never submits prices.

## Tests

Run `npm.cmd test` on Windows (or `npm test` elsewhere) to test Shopify product
queries, cart operations, cookie handling, input validation, and error
responses without making external requests.
