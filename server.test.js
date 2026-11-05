const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("./server");
const seedBooks = require("./db/catalog-seed");

const quietLogger = { error() {} };
const product = {
  id: "pride-and-prejudice",
  title: "Test Book",
  author: "Test Author",
  genre: "Classic",
  description: "A test description",
  price: "20.00",
  currency: "ZAR",
  kind: "published",
  isbn: "9780000000000",
  coverUrl: null,
  coverTheme: "leaf",
  featured: true,
  stockCount: 20,
};

async function withServer(options, run) {
  const server = createServer({
    env: options.env,
    fetchImpl: options.fetchImpl || (async () => new Response(JSON.stringify({ data: {} }))),
    logger: options.logger || quietLogger,
    databaseQuery: options.databaseQuery,
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

test("sends a clearly labeled sample payment simulation through EmailJS", async () => {
  let emailRequest;
  await withServer({
    env: {
      EMAILJS_SERVICE_ID: "service_test",
      EMAILJS_TEMPLATE_ID: "template_test",
      EMAILJS_PUBLIC_KEY: "public_test",
      EMAILJS_PRIVATE_KEY: "private_test",
    },
    fetchImpl: async (url, options) => {
      emailRequest = { url, options };
      return new Response("OK", { status: 200 });
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/simulated-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outcome: "success",
        customerName: "Test Reader",
        customerEmail: "reader@example.com",
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.match(result.orderId, /^DEMO-/);
    assert.equal(result.outcome, "success");
    assert.equal(result.notificationSent, true);
    assert.equal(emailRequest.url, "https://api.emailjs.com/api/v1.0/email/send");
    const sentEmail = JSON.parse(emailRequest.options.body);
    assert.deepEqual({
      service_id: sentEmail.service_id,
      template_id: sentEmail.template_id,
      user_id: sentEmail.user_id,
      accessToken: sentEmail.accessToken,
    }, {
      service_id: "service_test",
      template_id: "template_test",
      user_id: "public_test",
      accessToken: "private_test",
    });
    assert.equal(sentEmail.template_params.payment_status, "SIMULATED SUCCESS");
    assert.equal(sentEmail.template_params.order_items, "Sample demo book × 1 — 100.00 ZAR");
    assert.match(sentEmail.template_params.payment_note, /no money was charged/);
  });
});

test("sends a failed payment simulation notification without charging", async () => {
  let templateParams;
  await withServer({
    env: {
      EMAILJS_SERVICE_ID: "service_test",
      EMAILJS_TEMPLATE_ID: "template_test",
      EMAILJS_PUBLIC_KEY: "public_test",
      EMAILJS_PRIVATE_KEY: "private_test",
    },
    fetchImpl: async (_url, options) => {
      templateParams = JSON.parse(options.body).template_params;
      return new Response("OK", { status: 200 });
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/simulated-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outcome: "failed",
        customerName: "Test Reader",
        customerEmail: "reader@example.com",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(templateParams.payment_status, "SIMULATED FAILURE");
    assert.match(templateParams.payment_note, /no money was charged/);
  });
});

test("rejects invalid simulation inputs without contacting EmailJS", async () => {
  let requestedEmailJs = false;
  await withServer({
    env: {
      EMAILJS_SERVICE_ID: "service_test",
      EMAILJS_TEMPLATE_ID: "template_test",
      EMAILJS_PUBLIC_KEY: "public_test",
      EMAILJS_PRIVATE_KEY: "private_test",
    },
    fetchImpl: async () => {
      requestedEmailJs = true;
      throw new Error("EmailJS should not be called with invalid data.");
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/simulated-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "paid", customerName: "", customerEmail: "not-an-email" }),
    });
    assert.equal(response.status, 400);
    assert.equal(requestedEmailJs, false);
  });
});

test("returns a clear configuration error when EmailJS is not configured", async () => {
  await withServer({ env: { EMAILJS_SERVICE_ID: "" } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/simulated-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outcome: "failed",
        customerName: "Test Reader",
        customerEmail: "reader@example.com",
      }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /not configured/);
  });
});

test("does not report notification success when EmailJS rejects a send", async () => {
  const loggedErrors = [];
  await withServer({
    env: {
      EMAILJS_SERVICE_ID: "service_test",
      EMAILJS_TEMPLATE_ID: "template_test",
      EMAILJS_PUBLIC_KEY: "public_test",
      EMAILJS_PRIVATE_KEY: "private_test",
    },
    logger: {
      error: (...args) => loggedErrors.push(args),
    },
    fetchImpl: async () => new Response(
      "EmailJS failure detail with private_test and reader@example.com",
      { status: 429 },
    ),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/simulated-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outcome: "failed",
        customerName: "Test Reader",
        customerEmail: "reader@example.com",
      }),
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /could not send/);
  });
  assert.deepEqual(loggedErrors[0], [
    "EmailJS rejected the simulation notification:",
    429,
    "EmailJS failure detail with [redacted] and [redacted]",
  ]);
});

test("loads published book listings from Neon", async () => {
  let query;
  await withServer({
    databaseQuery: async (sql, parameters) => {
      query = { sql, parameters };
      return [product, { ...product, id: "the-alchemist", kind: "published" }];
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/products`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).products, [
      product,
      { ...product, id: "the-alchemist", kind: "published" },
    ]);
    assert.match(query.sql, /FROM bookstore_books/);
    assert.match(query.sql, /cover_url AS "coverUrl"/);
    assert.deepEqual(query.parameters, []);
  });
});

test("seeds 16 published books with ISBNs and cover images", () => {
  assert.equal(seedBooks.length, 16);
  assert.ok(seedBooks.every((book) => book.kind === "published"));
  assert.equal(new Set(seedBooks.map((book) => book.slug)).size, seedBooks.length);
  assert.equal(new Set(seedBooks.map((book) => book.isbn)).size, seedBooks.length);
  assert.ok(seedBooks.every((book) =>
    book.isbn &&
    /^https:\/\/covers\.openlibrary\.org\/b\/(?:id\/\d+|isbn\/\d+)-L\.jpg$/.test(book.coverUrl),
  ));
});

test("creates a database cart, adds a book, and stores its cart ID in a secure cookie", async () => {
  let itemQuantity = 0;
  let cartId;
  const queries = [];
  await withServer({
    env: { VERCEL: "1" },
    databaseQuery: async (sql, parameters) => {
      queries.push({ sql, parameters });
      if (sql.includes("SELECT stock_count FROM bookstore_books")) return [{ stock_count: 20 }];
      if (sql.includes("SELECT quantity FROM bookstore_cart_items")) return itemQuantity ? [{ quantity: itemQuantity }] : [];
      if (sql.includes("INSERT INTO bookstore_carts")) {
        [cartId] = parameters;
        return [];
      }
      if (sql.includes("INSERT INTO bookstore_cart_items")) {
        itemQuantity = parameters[2];
        return [];
      }
      if (sql.includes("UPDATE bookstore_carts")) return [];
      if (sql.includes("SELECT b.slug")) {
        return [{
          slug: product.id,
          title: product.title,
          author: product.author,
          price: product.price,
          currency: product.currency,
          cover_url: null,
          stock_count: 20,
          quantity: itemQuantity,
        }];
      }
      throw new Error(`Unexpected database query: ${sql}`);
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/cart/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchandiseId: product.id, quantity: 1 }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.cart.totalQuantity, 1);
    assert.equal(result.cart.lines.nodes[0].merchandise.product.title, product.title);
    assert.equal(result.cart.cost.subtotalAmount.amount, "20.00");
    assert.match(response.headers.get("set-cookie"), /HttpOnly/);
    assert.match(response.headers.get("set-cookie"), /SameSite=Lax/);
    assert.match(response.headers.get("set-cookie"), /Secure/);
    assert.match(response.headers.get("set-cookie"), new RegExp(`bookCartId=${cartId}`));
    assert.ok(queries.some(({ sql }) => sql.includes("bookstore_cart_items")));
  });
});

test("reads a saved database cart using the HttpOnly cart cookie", async () => {
  const cartId = "0f47ac10-58cc-4372-a567-0e02b2c3d479";
  let requestedParameters;
  await withServer({
    databaseQuery: async (sql, parameters) => {
      requestedParameters = parameters;
      assert.match(sql, /bookstore_carts/);
      return [{
        slug: product.id,
        title: product.title,
        author: product.author,
        price: product.price,
        currency: product.currency,
        cover_url: null,
        stock_count: 20,
        quantity: 2,
      }];
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/cart`, {
      headers: { Cookie: `bookCartId=${cartId}` },
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.cart.totalQuantity, 2);
    assert.equal(result.cart.lines.nodes[0].quantity, 2);
    assert.equal(result.cart.cost.subtotalAmount.amount, "40.00");
    assert.deepEqual(requestedParameters, [cartId]);
  });
});

test("rejects invalid cart lines without querying the database", async () => {
  let queriedDatabase = false;
  await withServer({
    databaseQuery: async () => {
      queriedDatabase = true;
      throw new Error("Database should not be queried for invalid cart lines.");
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/cart/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchandiseId: "", quantity: 11 }),
    });
    assert.equal(response.status, 400);
    assert.equal(queriedDatabase, false);
  });
});

test("returns a clear error when the Neon database is not configured", async () => {
  await withServer({
    env: { DATABASE_URL: "" },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/products`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /database is not configured/);
  });
});

test("clears the database cart and cookie on request", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/cart`, { method: "DELETE" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cart: null });
    assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  });
});
