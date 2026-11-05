const { neon } = require("@neondatabase/serverless");
const books = require("../db/catalog-seed");
const retiredDemoSlugs = [
  "the-salt-lantern",
  "a-map-of-quiet-things",
  "the-last-orchard",
  "a-clockwork-tide",
  "the-glass-garden",
  "when-stars-go-missing",
  "the-paper-astronomer",
  "the-sunday-archive",
];

async function seedCatalog() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to seed the bookstore catalog.");
  }

  const sql = neon(process.env.DATABASE_URL);
  const schema = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "db", "schema.sql"),
    "utf8",
  );
  for (const statement of schema.split(";").map((part) => part.trim()).filter(Boolean)) {
    await sql.query(statement);
  }

  const placeholders = retiredDemoSlugs.map((_, index) => `$${index + 1}`).join(", ");
  await sql.query(
    `DELETE FROM bookstore_cart_items WHERE book_id IN (${placeholders})`,
    retiredDemoSlugs,
  );
  await sql.query(
    `DELETE FROM bookstore_books WHERE slug IN (${placeholders})`,
    retiredDemoSlugs,
  );

  for (const book of books) {
    await sql.query(
      `INSERT INTO bookstore_books
        (slug, title, author, genre, description, price, currency, kind, isbn, cover_url, cover_theme, featured, stock_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title,
         author = EXCLUDED.author,
         genre = EXCLUDED.genre,
         description = EXCLUDED.description,
         price = EXCLUDED.price,
         currency = EXCLUDED.currency,
         kind = EXCLUDED.kind,
         isbn = EXCLUDED.isbn,
         cover_url = EXCLUDED.cover_url,
         cover_theme = EXCLUDED.cover_theme,
         featured = EXCLUDED.featured,
         stock_count = EXCLUDED.stock_count,
         updated_at = now()`,
      [
        book.slug,
        book.title,
        book.author,
        book.genre,
        book.description,
        book.price,
        book.currency,
        book.kind,
        book.isbn,
        book.coverUrl,
        book.coverTheme,
        book.featured,
        book.stockCount,
      ],
    );
  }
  console.log(`Seeded ${books.length} published bookstore listings and removed retired demo titles.`);
}

seedCatalog().catch((error) => {
  console.error("Could not seed bookstore catalog:", error.message);
  process.exitCode = 1;
});
