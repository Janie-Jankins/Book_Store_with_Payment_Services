const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
const MAX_BODY_BYTES = 16 * 1024;
const API_VERSION = "2026-10";
const CART_FRAGMENT = `
  fragment CartFields on Cart {
    id
    checkoutUrl
    totalQuantity
    cost {
      subtotalAmount { amount currencyCode }
      totalAmount { amount currencyCode }
    }
    lines(first: 100) {
      nodes {
        id
        quantity
        merchandise {
          ... on ProductVariant {
            id
            title
            price { amount currencyCode }
            product { title handle }
            image { url altText }
          }
        }
        cost { totalAmount { amount currencyCode } }
      }
    }
  }
`;
const PRODUCTS_QUERY = `
  query Products($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        title
        handle
        description
        productType
        vendor
        tags
        availableForSale
        priceRange { minVariantPrice { amount currencyCode } }
        featuredImage { url altText width height }
        variants(first: 10) {
          nodes {
            id
            title
            availableForSale
            price { amount currencyCode }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
const GET_CART_QUERY = `
  query Cart($cartId: ID!) {
    cart(id: $cartId) { ...CartFields }
  }
  ${CART_FRAGMENT}
`;
const CREATE_CART_MUTATION = `
  mutation CartCreate {
    cartCreate(input: {}) {
      cart { ...CartFields }
      userErrors { message }
    }
  }
  ${CART_FRAGMENT}
`;
const ADD_TO_CART_MUTATION = `
  mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart { ...CartFields }
      userErrors { message }
    }
  }
  ${CART_FRAGMENT}
`;
const UPDATE_CART_MUTATION = `
  mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) {
      cart { ...CartFields }
      userErrors { message }
    }
  }
  ${CART_FRAGMENT}
`;
const REMOVE_FROM_CART_MUTATION = `
  mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
    cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
      cart { ...CartFields }
      userErrors { message }
    }
  }
  ${CART_FRAGMENT}
`;

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
    .find((part) => part.startsWith("shopifyCartId="));
  if (!entry) return undefined;
  try {
    return decodeURIComponent(entry.slice("shopifyCartId=".length));
  } catch {
    return undefined;
  }
}

function setCartCookie(request, response, cartId, clear = false, vercel = false) {
  const secure = vercel || request.headers["x-forwarded-proto"] === "https";
  const cookie = clear
    ? "shopifyCartId=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    : `shopifyCartId=${encodeURIComponent(cartId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
  response.setHeader("Set-Cookie", secure ? `${cookie}; Secure` : cookie);
}

function createServer({
  env = process.env,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  async function shopifyFetch(query, variables = {}) {
    const domain = env.SHOPIFY_STORE_DOMAIN;
    const token = env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;
    if (!domain || !token) {
      throw new HttpError(503, "Shopify storefront is not configured.");
    }
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain)) {
      throw new HttpError(503, "Shopify store domain is invalid.");
    }

    let response;
    try {
      response = await fetchImpl(`https://${domain}/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      logger.error("Shopify Storefront API request failed:", error.message);
      throw new HttpError(502, "Could not connect to Shopify. Please try again.");
    }

    let result;
    try {
      result = await response.json();
    } catch (error) {
      logger.error("Shopify Storefront API returned invalid JSON:", response.status);
      throw new HttpError(502, "Shopify returned an invalid response.");
    }
    if (!response.ok || result.errors?.length) {
      const messages = (result.errors || []).map((entry) => entry.message);
      logger.error("Shopify Storefront API returned an error:", response.status, messages);
      throw new HttpError(502, "Shopify couldn't complete this request. Please try again.");
    }
    return result.data;
  }

  async function createCart() {
    const result = await shopifyFetch(CREATE_CART_MUTATION);
    const payload = result.cartCreate;
    if (payload.userErrors.length) {
      throw new HttpError(400, payload.userErrors.map((error) => error.message).join(" "));
    }
    return payload.cart;
  }

  async function cartForRequest(request, response) {
    const cartId = cartIdFromRequest(request);
    if (!cartId) return null;
    const result = await shopifyFetch(GET_CART_QUERY, { cartId });
    if (!result.cart) {
      setCartCookie(request, response, "", true, env.VERCEL);
      return null;
    }
    return result.cart;
  }

  return http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    try {
      const requestUrl = new URL(request.url, "http://localhost");
      if (requestUrl.pathname === "/api/health" && request.method === "GET") {
        await shopifyFetch("{ shop { name } }");
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (requestUrl.pathname === "/api/products" && request.method === "GET") {
        const products = [];
        let after = null;
        while (true) {
          const result = await shopifyFetch(PRODUCTS_QUERY, { first: 100, after });
          const connection = result.products;
          if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
            throw new HttpError(502, "Shopify returned an incomplete product catalog.");
          }
          products.push(...connection.nodes);
          if (!connection.pageInfo.hasNextPage) break;
          if (typeof connection.pageInfo.endCursor !== "string" ||
              !connection.pageInfo.endCursor ||
              connection.pageInfo.endCursor === after) {
            throw new HttpError(502, "Shopify returned an incomplete product catalog.");
          }
          after = connection.pageInfo.endCursor;
        }
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
            body.merchandiseId.length > 512 ||
            !Number.isInteger(body.quantity) ||
            body.quantity < 1 || body.quantity > 10) {
          throw new HttpError(400, "Choose an available book and a quantity between 1 and 10.");
        }
        let cart = await cartForRequest(request, response);
        if (!cart) {
          cart = await createCart();
          setCartCookie(request, response, cart.id, false, env.VERCEL);
        }
        const result = await shopifyFetch(ADD_TO_CART_MUTATION, {
          cartId: cart.id,
          lines: [{ merchandiseId: body.merchandiseId, quantity: body.quantity }],
        });
        const payload = result.cartLinesAdd;
        if (payload.userErrors.length) {
          throw new HttpError(400, payload.userErrors.map((error) => error.message).join(" "));
        }
        sendJson(response, 200, { cart: payload.cart });
        return;
      }

      if (requestUrl.pathname === "/api/cart/lines" && request.method === "PATCH") {
        const body = await readJson(request);
        if (!body || typeof body.id !== "string" || body.id.length > 512 ||
            !Number.isInteger(body.quantity) || body.quantity < 0 || body.quantity > 10) {
          throw new HttpError(400, "Choose a valid cart line and quantity.");
        }
        const cartId = cartIdFromRequest(request);
        if (!cartId) throw new HttpError(404, "Your shopping bag is empty.");
        if (body.quantity === 0) {
          const result = await shopifyFetch(REMOVE_FROM_CART_MUTATION, {
            cartId,
            lineIds: [body.id],
          });
          const payload = result.cartLinesRemove;
          if (payload.userErrors.length) {
            throw new HttpError(400, payload.userErrors.map((error) => error.message).join(" "));
          }
          sendJson(response, 200, { cart: payload.cart });
          return;
        }
        const result = await shopifyFetch(UPDATE_CART_MUTATION, {
          cartId,
          lines: [{ id: body.id, quantity: body.quantity }],
        });
        const payload = result.cartLinesUpdate;
        if (payload.userErrors.length) {
          throw new HttpError(400, payload.userErrors.map((error) => error.message).join(" "));
        }
        sendJson(response, 200, { cart: payload.cart });
        return;
      }

      if (requestUrl.pathname === "/api/cart" && request.method === "DELETE") {
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
