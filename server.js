const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT || 8765);
const ROOT = __dirname;
const MAX_BODY_BYTES = 16 * 1024;
const ZAR_PER_USD = 18.5;
const CURRENCY = "ZAR";
const CATALOG = Object.freeze({
  quiet: { title: "The Quiet Hours", price: 1800 },
  wild: { title: "A Wilder Mind", price: 2100 },
  ordinary: { title: "Ordinary Wonder", price: 1650 },
  somewhere: { title: "Somewhere, Slowly", price: 1900 },
  gather: { title: "The Art of Gathering", price: 2400 },
  small: { title: "Small Things, Slowly", price: 2000 },
  blue: { title: "The Blue Between", price: 1750 },
  soft: { title: "A Soft Place to Land", price: 1500 },
});
const ALLOWED_COUNTRIES = ["US", "CA", "GB", "AU", "ZA"];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateOrder(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Provide an email address and at least one book.");
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Enter a valid email address.");
  }
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 8) {
    throw new HttpError(400, "Your bag must contain between 1 and 8 different books.");
  }

  const quantities = new Map();
  for (const item of body.items) {
    if (!item || typeof item.id !== "string" || !Object.hasOwn(CATALOG, item.id)) {
      throw new HttpError(400, "Your bag contains an unavailable book.");
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) {
      throw new HttpError(400, "Book quantities must be between 1 and 10.");
    }
    if (quantities.has(item.id)) {
      throw new HttpError(400, "Each book should appear only once in your bag.");
    }
    quantities.set(item.id, item.quantity);
  }

  const subtotal = [...quantities].reduce(
    (total, [id, quantity]) => total + CATALOG[id].price * quantity,
    0,
  );
  const shipping = subtotal >= 4000 ? 0 : 495;
  const shippingAddress = body.shippingAddress;
  if (!shippingAddress || typeof shippingAddress !== "object") {
    throw new HttpError(400, "Provide your delivery details.");
  }
  const address = {};
  for (const [field, label, maxLength] of [
    ["name", "full name", 100],
    ["address", "street address", 200],
    ["city", "city", 100],
    ["zip", "postal code", 20],
  ]) {
    const value = typeof shippingAddress[field] === "string" ? shippingAddress[field].trim() : "";
    if (!value || value.length > maxLength) {
      throw new HttpError(400, `Enter a valid ${label}.`);
    }
    address[field] = value;
  }
  if (!ALLOWED_COUNTRIES.includes(shippingAddress.country)) {
    throw new HttpError(400, "Choose a supported delivery country.");
  }
  address.country = shippingAddress.country;
  return { email, quantities, subtotal, shipping, shippingAddress: address };
}

async function readBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const body = await readBody(request);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HttpError(400, "Request body must be valid JSON.");
    }
    throw error;
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function verifyPaystackSignature(payload, signatureHeader, secret) {
  if (typeof signatureHeader !== "string" || !/^[\da-f]{128}$/i.test(signatureHeader)) return false;
  const expected = crypto.createHmac("sha512", secret).update(payload).digest();
  return crypto.timingSafeEqual(Buffer.from(signatureHeader, "hex"), expected);
}

function usdCentsToZarCents(usdCents) {
  return Math.round(usdCents * ZAR_PER_USD);
}

function formatZarAmount(cents) {
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: CURRENCY,
  }).format(cents / 100);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function isFinalPaymentStatus(status) {
  return status === "success" || status === "failed" || status === "abandoned";
}

function createServer({
  env = process.env,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const configuredAppUrl = new URL(env.APP_URL || `http://localhost:${PORT}`);
  if (!["http:", "https:"].includes(configuredAppUrl.protocol) ||
      configuredAppUrl.pathname !== "/" ||
      configuredAppUrl.search ||
      configuredAppUrl.hash ||
      configuredAppUrl.username ||
      configuredAppUrl.password) {
    throw new Error("APP_URL must be an HTTP(S) origin without a path or credentials.");
  }
  const appUrl = configuredAppUrl.origin;
  const ordersFile = env.PAYMENT_ORDERS_FILE || path.join(ROOT, "data", "payment-orders.json");
  let ordersByReference;
  let orderWrites = Promise.resolve();

  async function getOrders() {
    if (ordersByReference) return ordersByReference;
    try {
      const contents = await fsPromises.readFile(ordersFile, "utf8");
      const parsed = JSON.parse(contents);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Payment order store must contain a JSON object.");
      }
      ordersByReference = new Map(Object.entries(parsed));
    } catch (error) {
      if (error.code === "ENOENT") {
        ordersByReference = new Map();
      } else {
        throw error;
      }
    }
    return ordersByReference;
  }

  async function saveOrder(order) {
    const orders = await getOrders();
    orders.set(order.reference, order);
    const contents = JSON.stringify(Object.fromEntries(orders), null, 2);
    const write = orderWrites.then(async () => {
      await fsPromises.mkdir(path.dirname(ordersFile), { recursive: true });
      const temporaryFile = `${ordersFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await fsPromises.writeFile(temporaryFile, contents, { encoding: "utf8", mode: 0o600 });
        await fsPromises.rename(temporaryFile, ordersFile);
      } catch (error) {
        await fsPromises.rm(temporaryFile, { force: true });
        throw error;
      }
    });
    orderWrites = write.catch(() => {});
    await write;
  }

  async function sendStatusEmail(order, status) {
    if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
      throw new HttpError(503, "Payment status email is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.");
    }
    const statusText = status === "success"
      ? "Payment successful"
      : status === "abandoned"
        ? "Payment not completed"
        : "Payment unsuccessful";
    const detail = status === "success"
      ? "Your payment has been received. Thank you for your order."
      : status === "abandoned"
        ? "Checkout was closed before Paystack confirmed a successful payment. No successful charge was recorded."
        : "Paystack did not complete your payment. No successful charge was recorded.";
    let response;
    try {
      response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `payment-${order.reference}-${status}`,
        },
        body: JSON.stringify({
          from: env.RESEND_FROM_EMAIL,
          to: [order.email],
          subject: `${statusText} — Chapter & Co. order ${order.reference}`,
          text: `${statusText}\n\n${detail}\nOrder reference: ${order.reference}\nTotal: ${formatZarAmount(order.amount)}\n\nChapter & Co.`,
          html: `<h1>${escapeHtml(statusText)}</h1><p>${escapeHtml(detail)}</p><p>Order reference: <strong>${escapeHtml(order.reference)}</strong><br>Total: ${escapeHtml(formatZarAmount(order.amount))}</p><p>Chapter &amp; Co.</p>`,
        }),
      });
    } catch (error) {
      logger.error("Resend email request failed:", error);
      throw new HttpError(502, "Could not deliver the payment status email.");
    }
    let result;
    try {
      const body = await response.text();
      result = body.trim() ? JSON.parse(body) : {};
    } catch (error) {
      logger.error("Resend returned an unreadable response:", response.status);
      throw new HttpError(502, "The email provider returned an invalid response.");
    }
    if (!response.ok || !result.id) {
      logger.error("Resend returned an error:", response.status, result?.message || result?.name || "unknown");
      throw new HttpError(502, "Could not deliver the payment status email.");
    }
  }

  async function processPaymentStatus(reference, payment) {
    const orders = await getOrders();
    const order = orders.get(reference);
    if (!order) throw new HttpError(404, "Payment order was not found.");
    if (payment.reference !== reference ||
        payment.currency !== order.currency ||
        (payment.amount !== undefined && payment.amount !== order.amount)) {
      throw new HttpError(409, "Payment details do not match this order.");
    }
    if (!isFinalPaymentStatus(payment.status)) {
      return { paymentStatus: "pending", emailStatus: "not-sent", order };
    }
    if (payment.status === "success" &&
        (payment.metadata?.order_id !== reference || payment.metadata?.amount !== order.amount)) {
      throw new HttpError(409, "Payment details do not match this order.");
    }

    if (isFinalPaymentStatus(order.status) && order.status !== payment.status) {
      return { paymentStatus: order.status, emailStatus: "sent", order };
    }
    order.status = payment.status;
    await saveOrder(order);
    const notifiedStatuses = new Set(order.notifiedStatuses || []);
    let emailStatus = "sent";
    if (!notifiedStatuses.has(payment.status)) {
      try {
        await sendStatusEmail(order, payment.status);
        notifiedStatuses.add(payment.status);
        order.notifiedStatuses = [...notifiedStatuses];
        await saveOrder(order);
      } catch (error) {
        logger.error(`Payment status email failed for ${reference}:`, error.message);
        emailStatus = "failed";
      }
    }
    return { paymentStatus: payment.status, emailStatus, order };
  }

  async function paystackRequest(endpoint, options = {}) {
    if (!env.PAYSTACK_SECRET_KEY) {
      throw new HttpError(503, "Online payments are not configured. Set PAYSTACK_SECRET_KEY to enable checkout.");
    }
    let response;
    try {
      response = await fetchImpl(`https://api.paystack.co/${endpoint}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      });
    } catch (error) {
      logger.error("Paystack request failed:", error);
      throw new HttpError(502, "Could not connect to the payment provider. Please try again.");
    }
    let result;
    try {
      const body = await response.text();
      if (!body.trim()) throw new SyntaxError("Empty response body");
      result = JSON.parse(body);
    } catch (error) {
      logger.error("Paystack returned an unreadable response:", response.status);
      throw new HttpError(502, "Paystack returned an invalid response. Check your API key and try again.");
    }
    if (!response.ok || result.status !== true) {
      logger.error("Paystack returned an error:", response.status, result?.message || "unknown");
      throw new HttpError(502, "The payment provider could not process this request. Please try again.");
    }
    return result;
  }

  return http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    try {
      const requestUrl = new URL(request.url, appUrl);
      if (requestUrl.pathname === "/api/transactions" && request.method === "POST") {
        if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
          throw new HttpError(503, "Payment status email is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL before accepting payments.");
        }
        const order = validateOrder(await readJson(request));
        const orderId = `CC-${crypto.randomUUID()}`;
        const amount = [...order.quantities].reduce(
          (total, [id, quantity]) => total + usdCentsToZarCents(CATALOG[id].price) * quantity,
          0,
        ) + usdCentsToZarCents(order.shipping);
        const transaction = await paystackRequest("transaction/initialize", {
          method: "POST",
          body: JSON.stringify({
            email: order.email,
            amount,
            currency: CURRENCY,
            reference: orderId,
            callback_url: `${appUrl}/?checkout=paystack`,
            metadata: {
              order_id: orderId,
              amount,
              shipping_address: order.shippingAddress,
            },
          }),
        });
        if (typeof transaction.data?.authorization_url !== "string" ||
            transaction.data.reference !== orderId) {
          logger.error("Paystack transaction initialization returned an invalid response.");
          throw new HttpError(502, "The payment provider did not return a checkout link.");
        }
        const checkoutUrl = new URL(transaction.data.authorization_url);
        if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.paystack.com") {
          logger.error("Paystack returned an unexpected checkout URL.");
          throw new HttpError(502, "The payment provider returned an invalid checkout link.");
        }
        await saveOrder({
          reference: orderId,
          email: order.email,
          amount,
          currency: CURRENCY,
          status: "pending",
          notifiedStatuses: [],
        });
        sendJson(response, 201, { checkoutUrl: transaction.data.authorization_url });
        return;
      }

      const transactionMatch = requestUrl.pathname.match(/^\/api\/transactions\/(CC-[0-9a-f-]{36})$/);
      if (transactionMatch && request.method === "GET") {
        const transaction = await paystackRequest(`transaction/verify/${encodeURIComponent(transactionMatch[1])}`);
        const payment = transaction.data;
        const result = await processPaymentStatus(transactionMatch[1], payment);
        sendJson(response, 200, {
          paymentStatus: result.paymentStatus === "success" ? "paid" : result.paymentStatus,
          emailStatus: result.emailStatus,
          customerName: [payment?.customer?.first_name, payment?.customer?.last_name].filter(Boolean).join(" "),
          orderId: result.order.reference,
        });
        return;
      }

      if (requestUrl.pathname === "/api/webhooks/paystack" && request.method === "POST") {
        if (!env.PAYSTACK_SECRET_KEY) {
          throw new HttpError(503, "Paystack webhook verification is not configured.");
        }
        const payload = await readBody(request, 1024 * 1024);
        const signature = request.headers["x-paystack-signature"];
        if (!verifyPaystackSignature(payload, signature, env.PAYSTACK_SECRET_KEY)) {
          throw new HttpError(400, "Invalid Paystack webhook signature.");
        }
        let event;
        try {
          event = JSON.parse(payload.toString("utf8"));
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new HttpError(400, "Webhook body must be valid JSON.");
          }
          throw error;
        }
        if (event.event === "charge.success" || event.event === "charge.failed") {
          const payment = event.data;
          const transaction = await paystackRequest(
            `transaction/verify/${encodeURIComponent(payment.reference)}`,
          );
          const result = await processPaymentStatus(payment.reference, transaction.data);
          if (result.emailStatus === "failed") {
            throw new HttpError(502, "The payment status email could not be delivered.");
          }
        }
        sendJson(response, 200, { received: true });
        return;
      }

      if (request.method === "GET" && ["/", "/index.html", "/app.js", "/styles.css"].includes(requestUrl.pathname)) {
        const file = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
        const contentTypes = {
          "index.html": "text/html; charset=utf-8",
          "app.js": "text/javascript; charset=utf-8",
          "styles.css": "text/css; charset=utf-8",
        };
        response.writeHead(200, {
          "Content-Type": contentTypes[file],
          "Cache-Control": "no-cache",
        });
        response.end(fs.readFileSync(path.join(ROOT, file)));
        return;
      }

      if (requestUrl.pathname.startsWith("/api/")) {
        sendJson(response, 404, { error: "API endpoint not found." });
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      logger.error("Unexpected request error:", error);
      sendJson(response, 500, { error: "An unexpected server error occurred." });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`Chapter & Co. server listening at http://localhost:${PORT}`);
  });
}

module.exports = {
  CATALOG,
  CURRENCY,
  createServer,
  usdCentsToZarCents,
  validateOrder,
  verifyPaystackSignature,
};
