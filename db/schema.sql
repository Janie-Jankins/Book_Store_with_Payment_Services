CREATE TABLE IF NOT EXISTS bookstore_books (
  slug text PRIMARY KEY,
  title text NOT NULL,
  author text NOT NULL,
  genre text NOT NULL,
  description text NOT NULL,
  price numeric(10, 2) NOT NULL CHECK (price >= 0),
  currency char(3) NOT NULL DEFAULT 'ZAR',
  kind text NOT NULL CHECK (kind IN ('published', 'fictional')),
  isbn text,
  cover_url text,
  cover_theme text NOT NULL,
  featured boolean NOT NULL DEFAULT false,
  stock_count integer NOT NULL DEFAULT 0 CHECK (stock_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bookstore_carts (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bookstore_cart_items (
  cart_id uuid NOT NULL REFERENCES bookstore_carts(id) ON DELETE CASCADE,
  book_id text NOT NULL REFERENCES bookstore_books(slug) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  PRIMARY KEY (cart_id, book_id)
);

CREATE INDEX IF NOT EXISTS bookstore_books_genre_idx ON bookstore_books (genre);
CREATE INDEX IF NOT EXISTS bookstore_cart_items_cart_idx ON bookstore_cart_items (cart_id);
