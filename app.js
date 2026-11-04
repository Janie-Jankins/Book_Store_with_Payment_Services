const books = [
  { id: "quiet", title: "The Quiet Hours", author: "Mara Ellison", category: "Fiction", price: 18.00, rating: "4.9", reviews: 128, badge: "Reader favorite", cover: "cover-cream", coverTitle: "The quiet<br>hours", kicker: "A novel", color: "#d9c8a9" },
  { id: "wild", title: "A Wilder Mind", author: "Theo Bennett", category: "Mindful living", price: 21.00, rating: "4.8", reviews: 96, badge: "New", cover: "cover-sun", coverTitle: "A wilder<br>mind", kicker: "Find your way", color: "#d99265" },
  { id: "ordinary", title: "Ordinary Wonder", author: "Lena Hart", category: "Poetry", price: 16.50, rating: "5.0", reviews: 74, badge: "", cover: "cover-bloom", coverTitle: "Ordinary<br>wonder", kicker: "Small poems", color: "#b7ad88" },
  { id: "somewhere", title: "Somewhere, Slowly", author: "June Park", category: "Fiction", price: 19.00, rating: "4.7", reviews: 112, badge: "Bestseller", cover: "cover-sky", coverTitle: "Somewhere,<br>slowly", kicker: "A novel", color: "#718b91" },
  { id: "gather", title: "The Art of Gathering", author: "Nina Rowan", category: "Nonfiction", price: 24.00, rating: "4.9", reviews: 205, badge: "", cover: "cover-berry", coverTitle: "The art of<br>gathering", kicker: "Make room", color: "#866b78" },
  { id: "small", title: "Small Things, Slowly", author: "Ada Wells", category: "Mindful living", price: 20.00, rating: "4.8", reviews: 87, badge: "", cover: "cover-leaf", coverTitle: "Small things,<br>slowly", kicker: "A gentle guide", color: "#657f68" },
  { id: "blue", title: "The Blue Between", author: "Elliot James", category: "Fiction", price: 17.50, rating: "4.9", reviews: 143, badge: "", cover: "cover-dark", coverTitle: "The blue<br>between", kicker: "A novel", color: "#454e49" },
  { id: "soft", title: "A Soft Place to Land", author: "Mina Flores", category: "Poetry", price: 15.00, rating: "4.8", reviews: 61, badge: "", cover: "cover-pink", coverTitle: "A soft place<br>to land", kicker: "Poems for us", color: "#d9a69a" }
];

const CART_STORAGE_KEY = "chapter-co-cart";
const CHECKOUT_DETAILS_STORAGE_KEY = "chapter-co-checkout-details";
const MAX_QUANTITY = 10;
const ZAR_PER_USD = 18.5;
const bookGrid = document.querySelector("#book-grid");
const emptyState = document.querySelector("#empty-state");
const searchInput = document.querySelector("#book-search");
const cartOverlay = document.querySelector("#cart-overlay");
const cartItemsElement = document.querySelector("#cart-items");
const cartEmpty = document.querySelector("#cart-empty");
const cartFooter = document.querySelector("#cart-footer");
const toast = document.querySelector("#toast");
const checkoutScreen = document.querySelector("#checkout-screen");
const cartTitle = document.querySelector("#cart-title");
const shippingSection = document.querySelector("#shipping-section");
const paymentSection = document.querySelector("#payment-section");
const orderSuccess = document.querySelector("#order-success");
const restoredCheckoutDetails = loadCheckoutDetails();
for (const [field, value] of Object.entries(restoredCheckoutDetails)) {
  const input = document.querySelector("#shipping-form").elements.namedItem(field);
  if (input && typeof value === "string" && "value" in input) input.value = value;
}

let activeCategory = "All";
let cart = loadCart();
let checkoutDetails = null;
let toastTimer;

function usdToZarCents(usdAmount) {
  return Math.round(Math.round(usdAmount * 100) * ZAR_PER_USD);
}

function formatZarCents(cents) {
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
  }).format(cents / 100);
}

function formatUsdAmountAsZar(usdAmount) {
  return formatZarCents(usdToZarCents(usdAmount));
}

function loadCart() {
  const savedCart = sessionStorage.getItem(CART_STORAGE_KEY);
  if (!savedCart) return {};
  try {
    const parsedCart = JSON.parse(savedCart);
    if (!parsedCart || typeof parsedCart !== "object" || Array.isArray(parsedCart)) return {};
    return Object.fromEntries(Object.entries(parsedCart).filter(([id, quantity]) =>
      books.some((book) => book.id === id) &&
      Number.isInteger(quantity) &&
      quantity > 0 &&
      quantity <= MAX_QUANTITY
    ));
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error("Could not restore the saved shopping bag:", error);
      return {};
    }
    throw error;
  }
}

function saveCart() {
  sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
}

function loadCheckoutDetails() {
  const savedDetails = sessionStorage.getItem(CHECKOUT_DETAILS_STORAGE_KEY);
  if (!savedDetails) return {};
  try {
    const parsedDetails = JSON.parse(savedDetails);
    return parsedDetails && typeof parsedDetails === "object" && !Array.isArray(parsedDetails)
      ? parsedDetails
      : {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error("Could not restore saved checkout details:", error);
      return {};
    }
    throw error;
  }
}

function renderBooks() {
  const searchTerm = searchInput.value.trim().toLowerCase();
  const visibleBooks = books.filter((book) => {
    const matchesCategory = activeCategory === "All" || book.category === activeCategory;
    const matchesSearch = `${book.title} ${book.author} ${book.category}`.toLowerCase().includes(searchTerm);
    return matchesCategory && matchesSearch;
  });

  bookGrid.innerHTML = visibleBooks.map((book) => `
    <article class="book-card">
      <div class="book-cover-wrap">
        ${book.badge ? `<span class="book-badge">${book.badge}</span>` : ""}
        <div class="book-cover ${book.cover}" style="--cover:${book.color}">
          <span class="cover-kicker">${book.kicker}</span>
          <span class="cover-shape" aria-hidden="true"></span>
          <span class="cover-title">${book.coverTitle}</span>
          <span class="cover-author">${book.author}</span>
        </div>
        <button class="quick-add" type="button" data-add="${book.id}" aria-label="Add ${book.title} to bag">Add to bag — ${formatUsdAmountAsZar(book.price)}</button>
      </div>
      <div class="book-info">
        <span class="book-category">${book.category}</span>
        <h3>${book.title}</h3>
        <p class="book-author">by ${book.author}</p>
        <div class="book-meta">
          <span class="book-rating" aria-label="${book.rating} out of 5 stars">★ <span>${book.rating} (${book.reviews})</span></span>
          <span class="book-price">${formatUsdAmountAsZar(book.price)}</span>
        </div>
      </div>
    </article>
  `).join("");
  emptyState.hidden = visibleBooks.length > 0;
}

function cartQuantity() {
  return Object.values(cart).reduce((total, quantity) => total + quantity, 0);
}

function addToCart(bookId) {
  if ((cart[bookId] || 0) >= MAX_QUANTITY) {
    showToast(`You can add up to ${MAX_QUANTITY} copies of each book`);
    return;
  }
  cart[bookId] = (cart[bookId] || 0) + 1;
  saveCart();
  renderCart();
  showToast(`${books.find((book) => book.id === bookId).title} added to your bag`);
}

function changeQuantity(bookId, amount) {
  cart[bookId] = Math.min(MAX_QUANTITY, (cart[bookId] || 0) + amount);
  if (cart[bookId] <= 0) delete cart[bookId];
  saveCart();
  renderCart();
}

function renderCart() {
  const quantity = cartQuantity();
  document.querySelector("#cart-count").textContent = quantity;
  document.querySelector("#cart-item-label").textContent = `(${quantity})`;

  const entries = books.filter((book) => cart[book.id]);
  cartItemsElement.innerHTML = entries.map((book) => `
    <article class="cart-item">
      <div class="cart-item-cover" style="--cover:${book.color}">${book.coverTitle}</div>
      <div class="cart-item-details">
        <h3>${book.title}</h3>
        <p>${book.author}</p>
        <div class="quantity-control" aria-label="Quantity for ${book.title}">
          <button type="button" data-quantity="${book.id}" data-change="-1" aria-label="Remove one ${book.title}">−</button>
          <span>${cart[book.id]}</span>
          <button type="button" data-quantity="${book.id}" data-change="1" aria-label="Add one ${book.title}" ${cart[book.id] >= MAX_QUANTITY ? "disabled" : ""}>+</button>
        </div>
      </div>
      <span class="cart-item-price">${formatZarCents(usdToZarCents(book.price) * cart[book.id])}</span>
    </article>
  `).join("");

  const subtotal = entries.reduce((sum, book) => sum + book.price * cart[book.id], 0);
  document.querySelector("#cart-subtotal").textContent = formatZarCents(
    entries.reduce((sum, book) => sum + usdToZarCents(book.price) * cart[book.id], 0),
  );
  const remaining = Math.max(0, 40 - subtotal);
  document.querySelector("#shipping-note").textContent = remaining === 0
    ? "You've unlocked free shipping. Happy reading!"
    : `You're ${formatUsdAmountAsZar(remaining)} away from free shipping.`;
  cartEmpty.classList.toggle("visible", quantity === 0);
  cartFooter.classList.toggle("empty", quantity === 0);
}

function showCartView() {
  checkoutScreen.hidden = true;
  cartItemsElement.hidden = false;
  cartEmpty.hidden = false;
  cartFooter.hidden = false;
  cartTitle.firstChild.textContent = "Your bag ";
}

function showCheckoutStep(step) {
  checkoutScreen.hidden = false;
  cartItemsElement.hidden = true;
  cartEmpty.hidden = true;
  cartFooter.hidden = true;
  cartTitle.firstChild.textContent = "Checkout ";
  shippingSection.hidden = step !== "shipping";
  paymentSection.hidden = step !== "payment";
  orderSuccess.hidden = step !== "success";
  document.querySelector("#shipping-step").classList.toggle("active", step === "shipping");
  document.querySelector("#payment-step").classList.toggle("active", step === "payment");
  document.querySelector("#shipping-step").hidden = step === "success";
  document.querySelector("#payment-step").hidden = step === "success";
}

function renderPaymentSummary() {
  const formData = new FormData(document.querySelector("#shipping-form"));
  checkoutDetails = Object.fromEntries(formData.entries());
  sessionStorage.setItem(CHECKOUT_DETAILS_STORAGE_KEY, JSON.stringify(checkoutDetails));
  const review = document.querySelector("#shipping-review");
  review.replaceChildren();
  const name = document.createElement("strong");
  name.textContent = checkoutDetails.name;
  const address = document.createElement("div");
  const countryLabel = document.querySelector("#shipping-form [name='country'] option:checked").textContent;
  address.textContent = `${checkoutDetails.address}, ${checkoutDetails.city} ${checkoutDetails.zip}, ${countryLabel}`;
  const email = document.createElement("div");
  email.textContent = checkoutDetails.email;
  review.append(name, address, email);

  const entries = books.filter((book) => cart[book.id]);
  const subtotal = entries.reduce((sum, book) => sum + book.price * cart[book.id], 0);
  const shipping = subtotal >= 40 ? 0 : 4.95;
  const summary = document.querySelector("#order-summary");
  summary.innerHTML = `
    <h4>Your books</h4>
    ${entries.map((book) => `<div class="summary-item"><span>${book.title} × ${cart[book.id]}</span><span>${formatZarCents(usdToZarCents(book.price) * cart[book.id])}</span></div>`).join("")}
    <div class="summary-item"><span>Shipping</span><span>${shipping === 0 ? "Free" : formatUsdAmountAsZar(shipping)}</span></div>
    <div class="summary-total"><span>Total</span><span>${formatZarCents(entries.reduce((sum, book) => sum + usdToZarCents(book.price) * cart[book.id], 0) + usdToZarCents(shipping))}</span></div>
  `;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function openCart() {
  showCartView();
  cartOverlay.hidden = false;
  document.querySelector("#close-cart").focus();
  document.body.style.overflow = "hidden";
}

function closeCart() {
  cartOverlay.hidden = true;
  document.body.style.overflow = "";
  document.querySelector("#open-cart").focus();
}

function showPaymentError(message) {
  const error = document.querySelector("#payment-error");
  error.textContent = message;
  error.hidden = false;
}

async function readApiResponse(response, action) {
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(`${action} returned an empty response (HTTP ${response.status}). Make sure the Node backend is running with npm.cmd start.`);
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${action} returned an invalid response (HTTP ${response.status}). Open the site served by the Node backend at http://localhost:8765.`);
    }
    throw error;
  }
}

async function beginPayment() {
  const button = document.querySelector("#payment-submit");
  const error = document.querySelector("#payment-error");
  error.hidden = true;
  button.disabled = true;
  button.textContent = "Connecting to secure checkout…";
  try {
    const response = await fetch("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: checkoutDetails.email,
        items: Object.entries(cart).map(([id, quantity]) => ({ id, quantity })),
        shippingAddress: {
          name: checkoutDetails.name,
          address: checkoutDetails.address,
          city: checkoutDetails.city,
          zip: checkoutDetails.zip,
          country: checkoutDetails.country,
        },
      }),
    });
    const result = await readApiResponse(response, "Payment setup");
    if (!response.ok) {
      showPaymentError(result.error || "We couldn't start checkout. Please try again.");
      return;
    }
    const checkoutUrl = new URL(result.checkoutUrl);
    if (checkoutUrl.origin !== "https://checkout.paystack.com") {
      throw new Error("The payment provider returned an invalid checkout link.");
    }
    window.location.assign(checkoutUrl.href);
  } catch (error) {
    console.error("Could not start Paystack checkout:", error);
    showPaymentError(error instanceof TypeError
      ? "We couldn't connect to secure checkout. Please try again."
      : error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Continue to secure payment <span aria-hidden="true">→</span>';
  }
}

async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const checkoutState = params.get("checkout");
  if (checkoutState !== "paystack") return;

  openCart();
  checkoutDetails = loadCheckoutDetails();
  const reference = params.get("reference") || params.get("trxref");
  if (reference) {
    showCheckoutStep("success");
    document.querySelector("#confirmation-message").textContent = "Confirming your payment…";
    try {
      const response = await fetch(`/api/transactions/${encodeURIComponent(reference)}`);
      const result = await readApiResponse(response, "Payment verification");
      if (!response.ok) {
        throw new Error(result.error || "We couldn't confirm your payment yet.");
      }
      if (result.paymentStatus !== "paid") {
        if (checkoutDetails.email) {
          showCheckoutStep("payment");
          const paymentMessage = result.paymentStatus === "pending"
            ? "Paystack hasn't confirmed a final payment status yet."
            : `Paystack reports the payment as ${result.paymentStatus}.`;
          const emailMessage = result.emailStatus === "sent"
            ? " A status email was sent to your checkout address."
            : result.emailStatus === "failed"
              ? " We couldn't send the status email; please contact the shop."
              : "";
          showPaymentError(`${paymentMessage}${emailMessage} Your bag is saved if you'd like to try again.`);
        } else {
          showCheckoutStep("shipping");
        }
      } else {
        const orderReference = result.orderId ? ` Order ${result.orderId}.` : "";
        document.querySelector("#confirmation-message").textContent =
          `Thanks${result.customerName ? `, ${result.customerName}` : ""}! Your payment is confirmed.${orderReference}`;
        document.querySelector("#order-success-note").textContent = result.emailStatus === "sent"
          ? `Your payment was processed securely by Paystack. A status email was sent to ${checkoutDetails.email}.`
          : "Your payment was processed securely by Paystack, but we couldn't send the status email. Please contact the shop.";
        cart = {};
        sessionStorage.removeItem(CHECKOUT_DETAILS_STORAGE_KEY);
        saveCart();
        renderCart();
      }
    } catch (error) {
      console.error("Could not confirm Paystack transaction:", error);
      if (checkoutDetails.email) {
        showCheckoutStep("payment");
        showPaymentError(error.message);
      } else {
        showCheckoutStep("shipping");
      }
    }
  } else if (checkoutDetails.email) {
    showCheckoutStep("payment");
    showPaymentError("We couldn't verify the payment reference. Your bag is still here if you'd like to retry.");
  } else {
    showCheckoutStep("shipping");
  }
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
}

document.querySelector(".category-row").addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  activeCategory = button.dataset.category;
  document.querySelectorAll(".category-chip").forEach((chip) => {
    const selected = chip === button;
    chip.classList.toggle("active", selected);
    chip.setAttribute("aria-pressed", String(selected));
  });
  renderBooks();
});

bookGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-add]");
  if (button) addToCart(button.dataset.add);
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
  if (event.key !== "Escape") return;
  if (!cartOverlay.hidden) {
    closeCart();
    return;
  }
  const searchBox = document.querySelector("#search-box");
  if (searchBox.classList.contains("search-open")) {
    searchBox.classList.remove("search-open");
    document.querySelector("#search-toggle").setAttribute("aria-expanded", "false");
    document.querySelector("#search-toggle").focus();
  }
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

document.querySelector("#checkout-button").addEventListener("click", () => {
  if (cartQuantity() === 0) return;
  showCheckoutStep("shipping");
  document.querySelector("#shipping-form input[name='email']").focus();
});

document.querySelector("#shipping-form").addEventListener("submit", (event) => {
  event.preventDefault();
  renderPaymentSummary();
  showCheckoutStep("payment");
  document.querySelector("#payment-submit").focus();
});

document.querySelector("#payment-form").addEventListener("submit", (event) => {
  event.preventDefault();
  beginPayment();
});

checkoutScreen.addEventListener("click", (event) => {
  const button = event.target.closest("[data-checkout-action]");
  if (!button) return;
  if (button.dataset.checkoutAction === "bag") {
    showCartView();
  } else {
    showCheckoutStep("shipping");
    document.querySelector("#shipping-form input[name='email']").focus();
  }
});

document.querySelector("#finish-checkout").addEventListener("click", () => {
  closeCart();
  showToast("Thanks for stopping by the bookshop!");
});

document.querySelector("#newsletter-form").addEventListener("submit", (event) => {
  event.preventDefault();
  document.querySelector("#newsletter-message").textContent = "You're on the list. Keep an eye on your inbox!";
  event.currentTarget.reset();
});

renderBooks();
renderCart();
handleCheckoutReturn();
