const MAX_QUANTITY = 10;
const products = [];
const bookGrid = document.querySelector("#book-grid");
const emptyState = document.querySelector("#empty-state");
const searchInput = document.querySelector("#book-search");
const cartOverlay = document.querySelector("#cart-overlay");
const cartItemsElement = document.querySelector("#cart-items");
const cartEmpty = document.querySelector("#cart-empty");
const cartFooter = document.querySelector("#cart-footer");
const toast = document.querySelector("#toast");
const categoryRow = document.querySelector(".category-row");
const sortSelect = document.querySelector("#book-sort");
const catalogCount = document.querySelector("#catalog-count");
const favorites = new Set(loadFavoriteIds());
const simulationForm = document.querySelector("#simulation-checkout-form");
const simulationMessage = document.querySelector("#simulation-message");
let activeCategory = "All";
let cart = null;
let toastTimer;
let cartMutationQueue = Promise.resolve();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatMoney(money) {
  const amount = Number(money?.amount);
  if (!Number.isFinite(amount) || !money.currencyCode) return "";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: money.currencyCode,
  }).format(amount);
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let result;
  try {
    result = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`The storefront returned an invalid response (HTTP ${response.status}).`);
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(result.error || `The request failed (HTTP ${response.status}).`);
  }
  return result;
}

function safeImageUrl(image) {
  const imageUrl = typeof image === "string" ? image : image?.url;
  if (!imageUrl) return "";
  try {
    const url = new URL(imageUrl);
    return url.protocol === "https:" &&
      url.hostname === "covers.openlibrary.org"
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function productCategory(product) {
  return product.genre?.trim() || "Books";
}

function loadFavoriteIds() {
  try {
    const stored = JSON.parse(localStorage.getItem("chapter-co-favorites") || "[]");
    return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
  } catch (error) {
    console.error("Could not load saved favorites:", error);
    return [];
  }
}

function saveFavoriteIds() {
  try {
    localStorage.setItem("chapter-co-favorites", JSON.stringify([...favorites]));
  } catch (error) {
    console.error("Could not save favorites:", error);
    showToast("Favorites could not be saved on this device.");
  }
}

function renderCategories() {
  const categories = [...new Set(products.map(productCategory))]
    .filter((category) => category && category !== "All")
    .sort((left, right) => left.localeCompare(right));
  categoryRow.innerHTML = [
    `<button class="category-chip${activeCategory === "All" ? " active" : ""}" type="button" data-category="All" aria-pressed="${activeCategory === "All"}">All books <span>${products.length.toString().padStart(2, "0")}</span></button>`,
    ...categories.map((category) => `<button class="category-chip${activeCategory === category ? " active" : ""}" type="button" data-category="${escapeHtml(category)}" aria-pressed="${activeCategory === category}">${escapeHtml(category)}</button>`),
  ].join("");
}

function renderBooks(message) {
  const searchTerm = searchInput.value.trim().toLowerCase();
  const visibleProducts = products.filter((product) => {
    const matchesCategory = activeCategory === "All" || productCategory(product) === activeCategory;
    const searchableText = `${product.title} ${product.author} ${productCategory(product)} ${product.description}`;
    return matchesCategory && searchableText.toLowerCase().includes(searchTerm);
  });
  const sortMode = sortSelect.value;
  visibleProducts.sort((left, right) => {
    if (sortMode === "price-asc") return Number(left.price) - Number(right.price);
    if (sortMode === "price-desc") return Number(right.price) - Number(left.price);
    if (sortMode === "title") return left.title.localeCompare(right.title);
    return Number(right.featured) - Number(left.featured) || left.title.localeCompare(right.title);
  });

  bookGrid.innerHTML = visibleProducts.map((product) => {
    const price = formatMoney({ amount: product.price, currencyCode: product.currency });
    const imageUrl = safeImageUrl(product.coverUrl);
    const theme = ["cream", "berry", "dark", "leaf", "pink", "bloom", "sky", "sun"].includes(product.coverTheme)
      ? product.coverTheme
      : "cream";
    const isFavorite = favorites.has(product.id);
    const image = imageUrl
      ? `<img class="book-cover-image" data-cover-fallback="${theme}" src="${escapeHtml(imageUrl)}" alt="Cover of ${escapeHtml(product.title)}" loading="lazy" />`
      : `<div class="book-cover cover-${theme}" role="img" aria-label="Illustrated cover for ${escapeHtml(product.title)}"><span class="cover-kicker">${escapeHtml(product.author)}</span><span class="cover-shape" aria-hidden="true"></span><span class="cover-title">${escapeHtml(product.title)}</span><span class="cover-author">${escapeHtml(product.author)}</span></div>`;
    const addButton = product.stockCount > 0
      ? `<button class="quick-add" type="button" data-add="${escapeHtml(product.id)}" data-title="${escapeHtml(product.title)}" aria-label="Add ${escapeHtml(product.title)} to bag">Add to bag — ${escapeHtml(price)}</button>`
      : `<button class="quick-add" type="button" disabled>Sold out</button>`;

    return `
      <article class="book-card${product.featured ? " is-featured" : ""}" data-book="${escapeHtml(product.id)}">
        <div class="book-cover-wrap">
          ${image}
          <span class="book-badge">${product.kind === "fictional" ? "Fictional demo" : "Published book"}</span>
          <button class="favorite-button${isFavorite ? " is-favorite" : ""}" type="button" data-favorite="${escapeHtml(product.id)}" aria-label="${isFavorite ? "Remove from" : "Add to"} favorites" aria-pressed="${isFavorite}">♥</button>
          ${addButton}
        </div>
        <div class="book-info">
          <span class="book-category">${escapeHtml(productCategory(product))}</span>
          <h3>${escapeHtml(product.title)}</h3>
          <p class="book-author">by ${escapeHtml(product.author)}</p>
          <p class="book-description">${escapeHtml(product.description)}</p>
          <div class="book-meta">
            <span class="book-price">${escapeHtml(price)}</span>
          </div>
        </div>
      </article>
    `;
  }).join("");

  bookGrid.querySelectorAll("img[data-cover-fallback]").forEach((image) => {
    image.addEventListener("error", () => {
      const card = image.closest(".book-card");
      const product = products.find((book) => book.id === card.dataset.book);
      if (!product) return;
      const fallback = document.createElement("div");
      fallback.className = `book-cover cover-${image.dataset.coverFallback}`;
      fallback.setAttribute("role", "img");
      fallback.setAttribute("aria-label", `Illustrated cover for ${product.title}`);
      fallback.innerHTML = `<span class="cover-kicker">${escapeHtml(product.author)}</span><span class="cover-shape" aria-hidden="true"></span><span class="cover-title">${escapeHtml(product.title)}</span><span class="cover-author">${escapeHtml(product.author)}</span>`;
      image.replaceWith(fallback);
    }, { once: true });
  });
  catalogCount.textContent = `${visibleProducts.length} ${visibleProducts.length === 1 ? "book" : "books"}`;
  emptyState.textContent = message || (products.length === 0
    ? "Our shelves are being stocked. Please check back soon."
    : "No books found. Try another search.");
  emptyState.hidden = visibleProducts.length > 0;
}

function renderCart() {
  const lines = cart?.lines.nodes || [];
  const quantity = cart?.totalQuantity || 0;
  document.querySelector("#cart-count").textContent = quantity;
  document.querySelector("#cart-item-label").textContent = `(${quantity})`;
  cartItemsElement.innerHTML = lines.map((line) => {
    const imageUrl = safeImageUrl(line.merchandise.image);
    const cover = imageUrl
      ? `<img class="cart-item-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(line.merchandise.image.altText || line.merchandise.product.title)}" loading="lazy" />`
      : `<div class="cart-item-cover">${escapeHtml(line.merchandise.product.title)}</div>`;
    const lineTotal = formatMoney(line.cost.totalAmount);
    return `
      <article class="cart-item">
        ${cover}
        <div class="cart-item-details">
          <h3>${escapeHtml(line.merchandise.product.title)}</h3>
          ${line.merchandise.title !== "Default Title" ? `<p>${escapeHtml(line.merchandise.title)}</p>` : ""}
          <div class="quantity-control" aria-label="Quantity for ${escapeHtml(line.merchandise.product.title)}">
            <button type="button" data-quantity="${escapeHtml(line.id)}" data-change="-1" aria-label="Remove one">−</button>
            <span>${line.quantity}</span>
            <button type="button" data-quantity="${escapeHtml(line.id)}" data-change="1" aria-label="Add one" ${line.quantity >= MAX_QUANTITY ? "disabled" : ""}>+</button>
          </div>
        </div>
        <span class="cart-item-price">${escapeHtml(lineTotal)}</span>
      </article>
    `;
  }).join("");

  document.querySelector("#order-total-label").textContent =
    quantity > 0 ? "Cart total (simulation only)" : "Sample demo order";
  document.querySelector("#cart-subtotal").textContent = quantity > 0
    ? formatMoney(cart?.cost.subtotalAmount)
    : formatMoney({ amount: "100.00", currencyCode: "ZAR" });
  cartEmpty.classList.toggle("visible", quantity === 0);
  cartFooter.classList.remove("empty");
}

async function loadProducts() {
  try {
    const result = await apiRequest("/api/products");
    products.splice(0, products.length, ...result.products);
    renderCategories();
    renderBooks();
  } catch (error) {
    console.error("Could not load the bookstore catalog:", error);
    renderBooks(error.message);
  }
}

async function refreshCart() {
  const result = await apiRequest("/api/cart");
  cart = result.cart;
  renderCart();
}

async function addToCart(merchandiseId, title) {
  const addRequest = cartMutationQueue.then(() => apiRequest("/api/cart/lines", {
    method: "POST",
    body: JSON.stringify({ merchandiseId, quantity: 1 }),
  }));
  cartMutationQueue = addRequest.catch(() => {});
  try {
    const result = await addRequest;
    cart = result.cart;
    renderCart();
    showToast(`${title} added to your bag`);
  } catch (error) {
    console.error("Could not add book to cart:", error);
    showToast(error.message);
  }
}

function surpriseMe() {
  const searchTerm = searchInput.value.trim().toLowerCase();
  const choices = products.filter((product) =>
    (activeCategory === "All" || productCategory(product) === activeCategory) &&
    `${product.title} ${product.author} ${productCategory(product)} ${product.description}`
      .toLowerCase().includes(searchTerm),
  );
  if (!choices.length) {
    showToast("No books match your current filters.");
    return;
  }
  const choice = choices[Math.floor(Math.random() * choices.length)];
  const card = bookGrid.querySelector(`[data-book="${CSS.escape(choice.id)}"]`);
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  card?.classList.add("surprise-highlight");
  setTimeout(() => card?.classList.remove("surprise-highlight"), 1800);
}

async function changeQuantity(lineId, change) {
  const line = cart?.lines.nodes.find((item) => item.id === lineId);
  if (!line) return;
  const quantity = line.quantity + change;
  if (quantity > MAX_QUANTITY) {
    showToast(`You can add up to ${MAX_QUANTITY} copies of each book`);
    return;
  }
  try {
    const result = await apiRequest("/api/cart/lines", {
      method: "PATCH",
      body: JSON.stringify({ id: lineId, quantity }),
    });
    cart = result.cart;
    renderCart();
  } catch (error) {
    console.error("Could not update bookstore cart:", error);
    showToast(error.message);
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

async function simulatePayment(outcome) {
  const buttons = simulationForm.querySelectorAll("button[type='submit']");
  buttons.forEach((button) => { button.disabled = true; });
  simulationMessage.textContent = "Sending simulation notification…";
  simulationMessage.classList.remove("simulation-success");
  try {
    const result = await apiRequest("/api/simulated-payment", {
      method: "POST",
      body: JSON.stringify({
        outcome,
        customerName: simulationForm.elements.customerName.value,
        customerEmail: simulationForm.elements.customerEmail.value,
      }),
    });
    simulationMessage.textContent = outcome === "success"
      ? `SIMULATED SUCCESS — no money was charged. Notification sent (${result.orderId}). If you don't see it, check your spam or junk folder.`
      : `SIMULATED FAILURE — no money was charged. Notification sent (${result.orderId}). If you don't see it, check your spam or junk folder.`;
    simulationMessage.classList.add("simulation-success");
  } catch (error) {
    console.error("Could not send simulated payment notification:", error);
    simulationMessage.textContent = error.message;
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function openCart() {
  cartOverlay.hidden = false;
  document.body.style.overflow = "hidden";
  document.querySelector("#close-cart").focus();
  try {
    await refreshCart();
  } catch (error) {
    console.error("Could not load bookstore cart:", error);
    showToast(error.message);
  }
}

function closeCart() {
  cartOverlay.hidden = true;
  document.body.style.overflow = "";
  document.querySelector("#open-cart").focus();
}

categoryRow.addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  activeCategory = button.dataset.category;
  categoryRow.querySelectorAll(".category-chip").forEach((chip) => {
    const selected = chip === button;
    chip.classList.toggle("active", selected);
    chip.setAttribute("aria-pressed", String(selected));
  });
  renderBooks();
});

sortSelect.addEventListener("change", () => renderBooks());
document.querySelector("#surprise-pick").addEventListener("click", surpriseMe);

bookGrid.addEventListener("click", (event) => {
  const favoriteButton = event.target.closest("[data-favorite]");
  if (favoriteButton) {
    const bookId = favoriteButton.dataset.favorite;
    if (favorites.has(bookId)) favorites.delete(bookId);
    else favorites.add(bookId);
    saveFavoriteIds();
    renderBooks();
    return;
  }
  const button = event.target.closest("[data-add]");
  if (button) addToCart(button.dataset.add, button.dataset.title);
});

cartItemsElement.addEventListener("click", (event) => {
  const button = event.target.closest("[data-quantity]");
  if (button) changeQuantity(button.dataset.quantity, Number(button.dataset.change));
});

document.querySelector("#open-cart").addEventListener("click", openCart);
document.querySelector("#close-cart").addEventListener("click", closeCart);
document.querySelector(".overlay-dismiss").addEventListener("click", closeCart);
document.querySelector("#continue-shopping").addEventListener("click", closeCart);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !cartOverlay.hidden) closeCart();
});

document.querySelector("#search-toggle").addEventListener("click", () => {
  const searchBox = document.querySelector("#search-box");
  if (window.matchMedia("(max-width: 650px)").matches) {
    const isOpen = searchBox.classList.toggle("search-open");
    document.querySelector("#search-toggle").setAttribute("aria-expanded", String(isOpen));
    if (isOpen) searchInput.focus();
  } else {
    searchInput.focus();
  }
});

searchInput.addEventListener("input", () => {
  renderBooks();
  if (searchInput.value.trim().length === 1) {
    document.querySelector("#bestsellers").scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

simulationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  simulatePayment(event.submitter.value);
});

document.querySelector("#newsletter-form").addEventListener("submit", (event) => {
  event.preventDefault();
  document.querySelector("#newsletter-message").textContent = "Thanks for your interest. The reading list is coming soon.";
  event.currentTarget.reset();
});

renderCategories();
renderBooks("Loading books…");
renderCart();
loadProducts();
refreshCart().catch((error) => {
  console.error("Could not restore bookstore cart:", error);
});
