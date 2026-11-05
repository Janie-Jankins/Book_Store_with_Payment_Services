const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
const MAX_BODY_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

function cartIdFromRequest(request) {
  const cookie = request.headers.cookie || "";
  const entry = cookie.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("bookCartId="));
  if (!entry) return undefined;
  const cartId = entry.slice("bookCartId=".length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cartId)
    ? cartId
    : undefined;
}

function setCartCookie(request, response, cartId, clear = false, vercel = false) {
  const secure = vercel || request.headers["x-forwarded-proto"] === "https";
  const cookie = clear
    ? "bookCartId=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    : `bookCartId=${encodeURIComponent(cartId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
  response.setHeader("Set-Cookie", secure ? `${cookie}; Secure` : cookie);
}

function validEmail(value) {
  return typeof value === "string" && value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function createServer({
  env = process.env,
  fetchImpl = fetch,
  logger = console,
  databaseQuery: injectedDatabaseQuery,
} = {}) {
  let neonClient;
  async function queryDatabase(query, parameters = []) {
    if (injectedDatabaseQuery) return injectedDatabaseQuery(query, parameters);
    if (!env.DATABASE_URL) {
      throw new HttpError(503, "The bookstore database is not configured.");
    }
    try {
      if (!neonClient) {
        const { neon } = require("@neondatabase/serverless");
        neonClient = neon(env.DATABASE_URL);
      }
      return await neonClient.query(query, parameters);
    } catch (error) {
      const message = String(error.message || "Database request failed.")
        .replaceAll(env.DATABASE_URL, "[redacted]")
        .slice(0, 300);
      logger.error("Bookstore database request failed:", message);
      throw new HttpError(503, "The bookstore database is temporarily unavailable.");
    }
  }

  async function databaseCartById(cartId, request, response) {
    const rows = await queryDatabase(
      `SELECT b.slug, b.title, b.author, b.price::text AS price, b.currency,
              b.cover_url, b.stock_count, ci.quantity
       FROM bookstore_carts c
       LEFT JOIN bookstore_cart_items ci ON ci.cart_id = c.id
       LEFT JOIN bookstore_books b ON b.slug = ci.book_id
       WHERE c.id = $1::uuid
       ORDER BY b.title`,
      [cartId],
    );
    if (!rows.length) {
      if (request && response) setCartCookie(request, response, "", true, env.VERCEL);
      return null;
    }

    const lines = rows.filter((row) => row.slug).map((row) => {
      const amount = (Number(row.price) * row.quantity).toFixed(2);
      return {
        id: row.slug,
        quantity: row.quantity,
        merchandise: {
          title: "Default Title",
          product: { title: row.title, handle: row.slug, vendor: row.author },
          image: row.cover_url ? { url: row.cover_url, altText: row.title } : null,
          price: { amount: row.price, currencyCode: row.currency },
        },
        cost: { totalAmount: { amount, currencyCode: row.currency } },
      };
    });
    const totalQuantity = lines.reduce((total, line) => total + line.quantity, 0);
    const amountCents = lines.reduce(
      (total, line) => total + Math.round(Number(line.cost.totalAmount.amount) * 100),
      0,
    );
    const totalAmount = (amountCents / 100).toFixed(2);
    return {
      id: cartId,
      totalQuantity,
      lines: { nodes: lines },
      cost: {
        subtotalAmount: { amount: totalAmount, currencyCode: "ZAR" },
        totalAmount: { amount: totalAmount, currencyCode: "ZAR" },
      },
    };
  }

  async function cartForRequest(request, response) {
    const cartId = cartIdFromRequest(request);
    if (!cartId) return null;
    return databaseCartById(cartId, request, response);
  }

  return http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    try {
      const requestUrl = new URL(request.url, "http://localhost");
      if (requestUrl.pathname === "/api/simulated-payment" && request.method === "POST") {
        const body = await readJson(request);
        const customerName = typeof body?.customerName === "string" ? body.customerName.trim() : "";
        const customerEmail = body?.customerEmail;
        if (!["success", "failed"].includes(body?.outcome) ||
            !customerName || customerName.length > 100 ||
            !validEmail(customerEmail)) {
          throw new HttpError(400, "Enter your name and a valid email address, then choose a simulation outcome.");
        }

        const {
          EMAILJS_SERVICE_ID: serviceId,
          EMAILJS_TEMPLATE_ID: templateId,
          EMAILJS_PUBLIC_KEY: publicKey,
          EMAILJS_PRIVATE_KEY: privateKey,
        } = env;
        if (!serviceId || !templateId || !publicKey || !privateKey) {
          throw new HttpError(503, "EmailJS notifications are not configured.");
        }

        const cart = await cartForRequest(request, response);
        const lines = cart?.lines?.nodes || [];
        const order = lines.length
          ? {
            items: lines.map((line) =>
              `${line.merchandise.product.title} × ${line.quantity} — ${line.cost.totalAmount.amount} ${line.cost.totalAmount.currencyCode}`,
            ).join("\n"),
            total: cart.cost.subtotalAmount.amount,
            currency: cart.cost.subtotalAmount.currencyCode,
          }
          : {
            items: "Sample demo book × 1 — 100.00 ZAR",
            total: "100.00",
            currency: "ZAR",
          };
        const orderId = `DEMO-${require("node:crypto").randomUUID()}`;
        const templateParams = {
          order_id: orderId,
          customer_name: customerName,
          customer_email: customerEmail.trim(),
          payment_status: body.outcome === "success" ? "SIMULATED SUCCESS" : "SIMULATED FAILURE",
          order_items: order.items,
          order_total: order.total,
          currency: order.currency,
          payment_note: "DEMO ONLY. No payment was attempted and no money was charged.",
        };

        let emailResponse;
        try {
          emailResponse = await fetchImpl("https://api.emailjs.com/api/v1.0/email/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              service_id: serviceId,
              template_id: templateId,
              user_id: publicKey,
              accessToken: privateKey,
              template_params: templateParams,
            }),
          });
        } catch (error) {
          logger.error("EmailJS notification request failed:", error.message);
          throw new HttpError(502, "Could not connect to EmailJS. Please try again.");
        }
        if (!emailResponse.ok) {
          const errorDetail = await emailResponse.text();
          const redactedDetail = [
            serviceId,
            templateId,
            publicKey,
            privateKey,
            ...Object.values(templateParams),
          ].reduce((detail, value) => detail.replaceAll(value, "[redacted]"), errorDetail);
          logger.error(
            "EmailJS rejected the simulation notification:",
            emailResponse.status,
            redactedDetail.slice(0, 500),
          );
          throw new HttpError(502, "EmailJS could not send the notification. Check its service and template settings.");
        }

        sendJson(response, 200, { orderId, outcome: body.outcome, notificationSent: true });
        return;
      }

      if (requestUrl.pathname === "/api/health" && request.method === "GET") {
        await queryDatabase("SELECT 1");
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (requestUrl.pathname === "/api/products" && request.method === "GET") {
        const products = await queryDatabase(
          `SELECT slug AS id, title, author, genre, description,
                  price::text AS price, currency, kind, isbn,
                  cover_url AS "coverUrl", cover_theme AS "coverTheme",
                  featured, stock_count AS "stockCount"
           FROM bookstore_books
           ORDER BY featured DESC, title ASC`,
        );
        sendJson(response, 200, { products });
        return;
      }

      if (requestUrl.pathname === "/api/cart" && request.method === "GET") {
        const cart = await cartForRequest(request, response);
        sendJson(response, 200, { cart });
        return;
      }

      if (requestUrl.pathname === "/api/cart/lines" && request.method === "POST") {
        const body = await readJson(request);
        if (!body || typeof body.merchandiseId !== "string" ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.merchandiseId) ||
            !Number.isInteger(body.quantity) ||
            body.quantity < 1 || body.quantity > 10) {
          throw new HttpError(400, "Choose an available book and a quantity between 1 and 10.");
        }
        const books = await queryDatabase(
          "SELECT stock_count FROM bookstore_books WHERE slug = $1",
          [body.merchandiseId],
        );
        if (!books.length || books[0].stock_count < 1) {
          throw new HttpError(404, "This book is not available.");
        }
        let cartId = cartIdFromRequest(request);
        if (!cartId) {
          cartId = require("node:crypto").randomUUID();
          await queryDatabase("INSERT INTO bookstore_carts (id) VALUES ($1::uuid)", [cartId]);
          setCartCookie(request, response, cartId, false, env.VERCEL);
        }
        const existingLines = await queryDatabase(
          "SELECT quantity FROM bookstore_cart_items WHERE cart_id = $1::uuid AND book_id = $2",
          [cartId, body.merchandiseId],
        );
        const nextQuantity = (existingLines[0]?.quantity || 0) + body.quantity;
        if (nextQuantity > Math.min(10, books[0].stock_count)) {
          throw new HttpError(400, "The requested quantity exceeds the available demo stock.");
        }
        await queryDatabase(
          `INSERT INTO bookstore_cart_items (cart_id, book_id, quantity)
           VALUES ($1::uuid, $2, $3)
           ON CONFLICT (cart_id, book_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
          [cartId, body.merchandiseId, nextQuantity],
        );
        await queryDatabase("UPDATE bookstore_carts SET updated_at = now() WHERE id = $1::uuid", [cartId]);
        sendJson(response, 200, { cart: await databaseCartById(cartId) });
        return;
      }

      if (requestUrl.pathname === "/api/cart/lines" && request.method === "PATCH") {
        const body = await readJson(request);
        if (!body || typeof body.id !== "string" ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.id) ||
            !Number.isInteger(body.quantity) || body.quantity < 0 || body.quantity > 10) {
          throw new HttpError(400, "Choose a valid cart line and quantity.");
        }
        const cartId = cartIdFromRequest(request);
        if (!cartId) throw new HttpError(404, "Your shopping bag is empty.");
        const lines = await queryDatabase(
          `SELECT b.stock_count
           FROM bookstore_cart_items ci
           JOIN bookstore_books b ON b.slug = ci.book_id
           WHERE ci.cart_id = $1::uuid AND ci.book_id = $2`,
          [cartId, body.id],
        );
        if (!lines.length) throw new HttpError(404, "That book is not in your bag.");
        if (body.quantity > Math.min(10, lines[0].stock_count)) {
          throw new HttpError(400, "The requested quantity exceeds the available demo stock.");
        }
        if (body.quantity === 0) {
          await queryDatabase(
            "DELETE FROM bookstore_cart_items WHERE cart_id = $1::uuid AND book_id = $2",
            [cartId, body.id],
          );
        } else {
          await queryDatabase(
            "UPDATE bookstore_cart_items SET quantity = $3 WHERE cart_id = $1::uuid AND book_id = $2",
            [cartId, body.id, body.quantity],
          );
        }
        await queryDatabase("UPDATE bookstore_carts SET updated_at = now() WHERE id = $1::uuid", [cartId]);
        sendJson(response, 200, { cart: await databaseCartById(cartId) });
        return;
      }

      if (requestUrl.pathname === "/api/cart" && request.method === "DELETE") {
        const cartId = cartIdFromRequest(request);
        if (cartId) {
          await queryDatabase("DELETE FROM bookstore_carts WHERE id = $1::uuid", [cartId]);
        }
        setCartCookie(request, response, "", true, env.VERCEL);
        sendJson(response, 200, { cart: null });
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
      const staticFiles = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/index.html": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/styles.css": ["styles.css", "text/css; charset=utf-8"],
      };
      const asset = staticFiles[requestUrl.pathname];
      if (!asset) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": asset[1],
        "Cache-Control": "no-cache",
      });
      response.end(fs.readFileSync(path.join(ROOT, asset[0])));
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
  const port = Number(process.env.PORT || 8765);
  const server = createServer();
  server.listen(port, () => {
    console.log(`Chapter & Co. server listening at http://localhost:${port}`);
  });
}

module.exports = { createServer };
