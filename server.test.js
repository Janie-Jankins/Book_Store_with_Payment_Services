const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("./server");

const quietLogger = { error() {} };
const product = {
  id: "gid://shopify/Product/1",
  title: "Test Book",
  handle: "test-book",
  description: "A test description",
  productType: "Fiction",
  vendor: "Test Author",
  tags: [],
  availableForSale: true,
  priceRange: { minVariantPrice: { amount: "20.00", currencyCode: "ZAR" } },
  featuredImage: null,
  variants: {
    nodes: [{
      id: "gid://shopify/ProductVariant/1",
      title: "Default Title",
      availableForSale: true,
      price: { amount: "20.00", currencyCode: "ZAR" },
    }],
  },
};

function cart(id = "gid://shopify/Cart/test?key=secret") {
  return {
    id,
    checkoutUrl: "https://chapter-co.myshopify.com/checkouts/test",
    totalQuantity: 1,
    cost: {
      subtotalAmount: { amount: "20.00", currencyCode: "ZAR" },
      totalAmount: { amount: "20.00", currencyCode: "ZAR" },
    },
    lines: {
      nodes: [{
        id: "gid://shopify/CartLine/1",
        quantity: 1,
        merchandise: {
          id: "gid://shopify/ProductVariant/1",
          title: "Default Title",
          price: { amount: "20.00", currencyCode: "ZAR" },
          product: { title: "Test Book", handle: "test-book" },
          image: null,
        },
        cost: { totalAmount: { amount: "20.00", currencyCode: "ZAR" } },
      }],
    },
  };
}

async function withServer(options, run) {
  const server = createServer({
    env: {
      SHOPIFY_STORE_DOMAIN: "chapter-co.myshopify.com",
      SHOPIFY_STOREFRONT_ACCESS_TOKEN: "storefront-test-token",
      ...options.env,
    },
    fetchImpl: options.fetchImpl || (async () => new Response(JSON.stringify({ data: {} }))),
    logger: quietLogger,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("serves the storefront from the project root", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /Chapter &amp; Co/);
    assert.match(html, /Our catalog is loading/);
  });
});

test("loads products from Shopify Storefront API using the server-side token", async () => {
  let request;
  await withServer({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        data: { products: { nodes: [product], pageInfo: { hasNextPage: false, endCursor: null } } },
      }));
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/products`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { products: [product] });
    assert.equal(request.url, "https://chapter-co.myshopify.com/api/2026-10/graphql.json");
    assert.equal(request.options.headers["X-Shopify-Storefront-Access-Token"], "storefront-test-token");
    assert.match(JSON.parse(request.options.body).query, /products\(first: \$first, after: \$after\)/);
    assert.deepEqual(JSON.parse(request.options.body).variables, { first: 100, after: null });
  });
});

test("loads every page of the Shopify product catalog", async () => {
  const requests = [];
  const secondProduct = { ...product, id: "gid://shopify/Product/2", title: "Another Book" };
  await withServer({
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      const page = request.variables.after
        ? { nodes: [secondProduct], pageInfo: { hasNextPage: false, endCursor: "cursor-2" } }
        : { nodes: [product], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } };
      return new Response(JSON.stringify({ data: { products: page } }));
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/products`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { products: [product, secondProduct] });
    assert.deepEqual(requests.map((request) => request.variables), [
      { first: 100, after: null },
      { first: 100, after: "cursor-1" },
    ]);
  });
});

test("creates a Shopify cart, adds a product, and stores the cart ID in a secure cookie", async () => {
  const requests = [];
  await withServer({
    env: { VERCEL: "1" },
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      if (request.query.includes("mutation CartCreate")) {
        return new Response(JSON.stringify({ data: { cartCreate: { cart: cart(), userErrors: [] } } }));
      }
      if (request.query.includes("mutation CartLinesAdd")) {
        assert.deepEqual(request.variables, {
          cartId: "gid://shopify/Cart/test?key=secret",
          lines: [{ merchandiseId: product.variants.nodes[0].id, quantity: 1 }],
        });
        return new Response(JSON.stringify({ data: { cartLinesAdd: { cart: cart(), userErrors: [] } } }));
      }
      throw new Error("Unexpected Shopify operation.");
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/cart/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchandiseId: product.variants.nodes[0].id, quantity: 1 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).cart, cart());
    assert.match(response.headers.get("set-cookie"), /HttpOnly/);
    assert.match(response.headers.get("set-cookie"), /SameSite=Lax/);
    assert.match(response.headers.get("set-cookie"), /Secure/);
    assert.equal(requests.length, 2);
  });
});

test("reads a saved Shopify cart using the HttpOnly cart cookie", async () => {
  let requestedVariables;
  await withServer({
    fetchImpl: async (_url, options) => {
      requestedVariables = JSON.parse(options.body).variables;
      return new Response(JSON.stringify({ data: { cart: cart() } }));
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/cart`, {
      headers: { Cookie: "shopifyCartId=gid%3A%2F%2Fshopify%2FCart%2Ftest%3Fkey%3Dsecret" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).cart, cart());
    assert.deepEqual(requestedVariables, { cartId: "gid://shopify/Cart/test?key=secret" });
  });
});

test("rejects invalid cart lines without contacting Shopify", async () => {
  let requestedShopify = false;
  await withServer({
    fetchImpl: async () => {
      requestedShopify = true;
      throw new Error("Shopify should not be called for invalid cart lines.");
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/cart/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchandiseId: "", quantity: 11 }),
    });
    assert.equal(response.status, 400);
    assert.equal(requestedShopify, false);
  });
});

test("returns a clear error when Shopify credentials are missing", async () => {
  await withServer({
    env: { SHOPIFY_STORE_DOMAIN: "", SHOPIFY_STOREFRONT_ACCESS_TOKEN: "" },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/products`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /not configured/);
  });
});

test("does not expose Shopify GraphQL errors to storefront visitors", async () => {
  await withServer({
    fetchImpl: async () => new Response(JSON.stringify({
      errors: [{ message: "Internal Shopify diagnostic" }],
    }), { status: 200 }),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/products`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /couldn't complete/);
  });
});

test("clears the Shopify cart cookie on request", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/cart`, { method: "DELETE" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cart: null });
    assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  });
});
