const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createServer,
  usdCentsToZarCents,
  validateOrder,
  verifyPaystackSignature,
} = require("./server");

const quietLogger = { error() {}, info() {} };
const shippingAddress = {
  name: "Reader",
  address: "1 Book Lane",
  city: "Cape Town",
  zip: "8001",
  country: "ZA",
};

async function withServer(options, run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chapter-co-payment-test-"));
  const server = createServer({
    ...options,
    env: {
      RESEND_API_KEY: "re_test_example",
      RESEND_FROM_EMAIL: "Chapter & Co. <orders@example.com>",
      PAYMENT_ORDERS_FILE: path.join(tempDir, "orders.json"),
      ...options.env,
    },
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
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function validOrder(overrides = {}) {
  return {
    email: "reader@example.com",
    items: [{ id: "quiet", quantity: 1 }],
    shippingAddress,
    ...overrides,
  };
}

test("validates books, delivery details, and server-calculated shipping", () => {
  const smallOrder = validateOrder(validOrder());
  assert.equal(smallOrder.subtotal, 1800);
  assert.equal(smallOrder.shipping, 495);

  const freeShippingOrder = validateOrder(validOrder({
    items: [{ id: "gather", quantity: 2 }],
  }));
  assert.equal(freeShippingOrder.subtotal, 4800);
  assert.equal(freeShippingOrder.shipping, 0);
  assert.throws(() => validateOrder(validOrder({
    items: [{ id: "quiet", quantity: 1 }, { id: "quiet", quantity: 2 }],
  })), /only once/);
  assert.throws(() => validateOrder(validOrder({
    shippingAddress: { ...shippingAddress, country: "XX" },
  })), /supported delivery country/);
});

test("rejects malformed or out-of-range order input", () => {
  assert.throws(() => validateOrder(validOrder({ email: "not-an-email" })), /valid email/);
  assert.throws(() => validateOrder(validOrder({ items: [{ id: "unknown", quantity: 1 }] })), /unavailable/);
  assert.throws(() => validateOrder(validOrder({ items: [{ id: "quiet", quantity: 11 }] })), /between 1 and 10/);
  assert.throws(() => validateOrder(validOrder({
    shippingAddress: { ...shippingAddress, address: "" },
  })), /street address/);
});

test("converts USD minor units to rounded ZAR cents", () => {
  assert.equal(usdCentsToZarCents(1800), 33300);
  assert.equal(usdCentsToZarCents(495), 9158);
});

test("initializes Paystack checkout with trusted ZAR amount and shipping metadata", async () => {
  let paystackRequest;
  await withServer({
    env: { PAYSTACK_SECRET_KEY: "sk_test_example", APP_URL: "http://localhost:8765" },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.paystack.co/transaction/initialize");
      paystackRequest = { url, options };
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        status: true,
        data: {
          authorization_url: "https://checkout.paystack.com/example",
          reference: request.reference,
        },
      }), { status: 200 });
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validOrder()),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      checkoutUrl: "https://checkout.paystack.com/example",
    });

    const request = JSON.parse(paystackRequest.options.body);
    assert.equal(paystackRequest.url, "https://api.paystack.co/transaction/initialize");
    assert.equal(request.amount, 42458);
    assert.equal(request.currency, "ZAR");
    assert.equal(request.email, "reader@example.com");
    assert.match(request.reference, /^CC-[0-9a-f-]{36}$/);
    assert.equal(request.metadata.amount, 42458);
    assert.deepEqual(request.metadata.shipping_address, shippingAddress);
    assert.equal(request.callback_url, "http://localhost:8765/?checkout=paystack");
  });
});

test("rejects invalid carts without contacting Paystack", async () => {
  let paystackCalled = false;
  await withServer({
    env: { PAYSTACK_SECRET_KEY: "sk_test_example" },
    fetchImpl: async () => {
      paystackCalled = true;
      throw new Error("Paystack should not be called for invalid input");
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validOrder({ items: [{ id: "unknown", quantity: 1 }] })),
    });
    assert.equal(response.status, 400);
    assert.equal(paystackCalled, false);
  });
});

test("returns a JSON error when Paystack responds with an empty body", async () => {
  await withServer({
    env: { PAYSTACK_SECRET_KEY: "sk_test_example" },
    fetchImpl: async () => new Response(null, { status: 502 }),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validOrder()),
    });
    assert.equal(response.status, 502);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.match((await response.json()).error, /invalid response/);
  });
});

test("verifies the Paystack transaction before confirming payment", async () => {
  let requestedUrl;
  const emailRequests = [];
  let reference;
  await withServer({
    env: { PAYSTACK_SECRET_KEY: "sk_test_example" },
    fetchImpl: async (url, options) => {
      if (url === "https://api.resend.com/emails") {
        emailRequests.push({ headers: options.headers, body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
      }
      requestedUrl = url;
      if (url.endsWith("/transaction/initialize")) {
        reference = JSON.parse(options.body).reference;
        return new Response(JSON.stringify({
          status: true,
          data: {
            authorization_url: "https://checkout.paystack.com/example",
            reference,
          },
        }), { status: 200 });
      }
      reference = url.split("/").pop();
      return new Response(JSON.stringify({
        status: true,
        data: {
          status: "success",
          amount: 42458,
          currency: "ZAR",
          reference,
          customer: { first_name: "Reader", last_name: "One" },
          metadata: { order_id: reference, amount: 42458 },
        },
      }), { status: 200 });
    },
  }, async (baseUrl) => {
    const initialized = await fetch(`${baseUrl}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validOrder()),
    });
    assert.equal(initialized.status, 201);
    await initialized.json();
    const response = await fetch(`${baseUrl}/api/transactions/${reference}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      paymentStatus: "paid",
      emailStatus: "sent",
      customerName: "Reader One",
      orderId: reference,
    });
    assert.equal(requestedUrl, `https://api.paystack.co/transaction/verify/${reference}`);
    assert.equal(emailRequests.length, 1);
    assert.equal(emailRequests[0].body.to[0], "reader@example.com");
    assert.match(emailRequests[0].body.subject, /Payment successful/);
    assert.equal(emailRequests[0].headers["Idempotency-Key"], `payment-${reference}-success`);
    const repeatedResponse = await fetch(`${baseUrl}/api/transactions/${reference}`);
    assert.equal((await repeatedResponse.json()).emailStatus, "sent");
    assert.equal(emailRequests.length, 1);
  });
});

test("does not confirm transactions with a mismatched amount", async () => {
  let reference;
  await withServer({
    env: { PAYSTACK_SECRET_KEY: "sk_test_example" },
    fetchImpl: async (url, options) => {
      if (url.endsWith("/transaction/initialize")) {
        reference = JSON.parse(options.body).reference;
        return new Response(JSON.stringify({
          status: true,
          data: { authorization_url: "https://checkout.paystack.com/example", reference },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: true,
        data: {
          status: "success",
          amount: 1,
          currency: "ZAR",
          reference,
          metadata: { order_id: reference, amount: 42458 },
        },
      }), { status: 200 });
    },
  }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validOrder()),
    });
    const response = await fetch(`${baseUrl}/api/transactions/${reference}`);
    assert.equal(response.status, 409);
  });
});

test("retries a failed status email when Paystack verification is repeated", async () => {
  let reference;
  let emailAttempts = 0;
  await withServer({
    env: { PAYSTACK_SECRET_KEY: "sk_test_example" },
    fetchImpl: async (url, options) => {
      if (url === "https://api.resend.com/emails") {
        emailAttempts += 1;
        if (emailAttempts === 1) {
          return new Response(JSON.stringify({ message: "temporary error" }), { status: 500 });
        }
        return new Response(JSON.stringify({ id: "email_retry_success" }), { status: 200 });
      }
      if (url.endsWith("/transaction/initialize")) {
        reference = JSON.parse(options.body).reference;
        return new Response(JSON.stringify({
          status: true,
          data: { authorization_url: "https://checkout.paystack.com/example", reference },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: true,
        data: {
          reference,
          status: "failed",
          amount: 42458,
          currency: "ZAR",
        },
      }), { status: 200 });
    },
  }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validOrder()),
    });
    const first = await fetch(`${baseUrl}/api/transactions/${reference}`);
    assert.equal((await first.json()).emailStatus, "failed");
    const retry = await fetch(`${baseUrl}/api/transactions/${reference}`);
    assert.equal((await retry.json()).emailStatus, "sent");
    assert.equal(emailAttempts, 2);
  });
});

test("verifies Paystack webhook signatures", () => {
  const body = JSON.stringify({ event: "charge.success" });
  const secret = "sk_test_example";
  const signature = crypto.createHmac("sha512", secret).update(body).digest("hex");
  assert.equal(verifyPaystackSignature(body, signature, secret), true);
  assert.equal(verifyPaystackSignature(`${body} `, signature, secret), false);
  assert.equal(verifyPaystackSignature(body, "invalid", secret), false);
});

test("accepts signed Paystack webhook requests and rejects invalid signatures", async () => {
  const secret = "sk_test_example";
  let reference;
  const sentEmails = [];
  await withServer({
    env: { PAYSTACK_SECRET_KEY: secret },
    fetchImpl: async (url, options) => {
      if (url === "https://api.resend.com/emails") {
        sentEmails.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ id: "email_failed_123" }), { status: 200 });
      }
      if (url.endsWith("/transaction/initialize")) {
        reference = JSON.parse(options.body).reference;
        return new Response(JSON.stringify({
          status: true,
          data: { authorization_url: "https://checkout.paystack.com/example", reference },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: true,
        data: {
          reference,
          status: "failed",
          amount: 42458,
          currency: "ZAR",
          metadata: { order_id: reference, amount: 42458 },
        },
      }), { status: 200 });
    },
  }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validOrder()),
    });
    const body = JSON.stringify({
      event: "charge.failed",
      data: { reference, status: "failed", currency: "ZAR" },
    });
    const signature = crypto.createHmac("sha512", secret).update(body).digest("hex");
    const accepted = await fetch(`${baseUrl}/api/webhooks/paystack`, {
      method: "POST",
      headers: { "x-paystack-signature": signature },
      body,
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { received: true });
    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].subject, /Payment unsuccessful/);

    const rejected = await fetch(`${baseUrl}/api/webhooks/paystack`, {
      method: "POST",
      headers: { "x-paystack-signature": "0".repeat(128) },
      body,
    });
    assert.equal(rejected.status, 400);
  });
});

test("rejects checkout before charging when email settings are missing", async () => {
  await withServer({
    env: {
      PAYSTACK_SECRET_KEY: "sk_test_example",
      RESEND_API_KEY: "",
      RESEND_FROM_EMAIL: "",
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validOrder()),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Payment status email is not configured/);
  });
});
