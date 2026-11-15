import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"

/**
 * A small Postgres to point the app at: PGlite (Postgres compiled to WASM)
 * behind a real wire-protocol socket, seeded with a shop's worth of tables.
 * In memory — every start is the same data again.
 */
const SEED = `
CREATE TABLE customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE NOT NULL,
  country text NOT NULL,
  vip boolean NOT NULL DEFAULT false,
  profile jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE products (
  id serial PRIMARY KEY,
  sku text UNIQUE NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  price numeric(10, 2) NOT NULL,
  tags text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE orders (
  id serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers (id),
  status text NOT NULL DEFAULT 'pending',
  ordered_at timestamptz NOT NULL,
  note text
);
CREATE TABLE order_items (
  order_id integer NOT NULL REFERENCES orders (id),
  product_id integer NOT NULL REFERENCES products (id),
  quantity integer NOT NULL,
  unit_price numeric(10, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
CREATE TABLE audit_log (at timestamptz NOT NULL DEFAULT now(), message text);

INSERT INTO customers (name, email, country, vip, profile, created_at)
SELECT 'Customer ' || n,
       'customer' || n || '@example.com',
       (ARRAY['VN', 'JP', 'US', 'DE', 'FR'])[1 + n % 5],
       n % 7 = 0,
       CASE WHEN n % 3 = 0 THEN NULL
            ELSE jsonb_build_object('tier', (ARRAY['free', 'pro'])[1 + n % 2], 'seats', n % 9) END,
       timestamptz '2025-01-01 00:00+00' + (n || ' days')::interval
  FROM generate_series(1, 240) n;

INSERT INTO products (sku, name, category, price, tags)
SELECT 'SKU-' || lpad(n::text, 4, '0'),
       (ARRAY['Desk', 'Lamp', 'Chair', 'Monitor', 'Keyboard', 'Cable'])[1 + n % 6] || ' ' || n,
       (ARRAY['furniture', 'lighting', 'electronics'])[1 + n % 3],
       round((5 + n * 3.37)::numeric, 2),
       CASE WHEN n % 4 = 0 THEN ARRAY['sale', 'new'] ELSE ARRAY[]::text[] END
  FROM generate_series(1, 40) n;

INSERT INTO orders (customer_id, status, ordered_at, note)
SELECT 1 + (n * 7) % 240,
       (ARRAY['pending', 'paid', 'shipped', 'cancelled'])[1 + n % 4],
       timestamptz '2026-01-01 00:00+00' + (n * 5 || ' hours')::interval,
       CASE WHEN n % 10 = 0 THEN 'Gift wrap' END
  FROM generate_series(1, 1500) n;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.id, p.id, 1 + (o.id + p.id) % 4, p.price
  FROM orders o
  JOIN products p ON p.id IN (1 + o.id % 40, 1 + (o.id * 3) % 40);

INSERT INTO audit_log (message) VALUES ('seeded'), ('no primary key here');

CREATE VIEW order_totals AS
SELECT o.id AS order_id, o.customer_id, o.status,
       sum(i.quantity * i.unit_price) AS total
  FROM orders o JOIN order_items i ON i.order_id = o.id
 GROUP BY o.id;

CREATE SCHEMA analytics;
CREATE TABLE analytics.daily_revenue AS
SELECT o.ordered_at::date AS day, sum(i.quantity * i.unit_price) AS revenue
  FROM orders o JOIN order_items i ON i.order_id = o.id
 WHERE o.status <> 'cancelled'
 GROUP BY 1 ORDER BY 1;
`

export async function createSampleDb(): Promise<PGlite> {
  const db = await PGlite.create()
  await db.exec(SEED)
  return db
}

export async function startSampleDb(port: number) {
  const db = await createSampleDb()
  const server = new PGLiteSocketServer({
    db,
    port,
    host: "127.0.0.1",
    maxConnections: 16,
  })
  await server.start()
  return {
    async stop() {
      await server.stop()
      await db.close()
    },
  }
}
