import { startSampleDb } from "./sample-db"

/**
 * `bun run demo:pg` — a sample Postgres to try the app against.
 *
 * Add a connection with: PostgreSQL, 127.0.0.1, the port below, user
 * `postgres`, password `postgres`, database `postgres`, SSL off.
 */
const port = Number(process.env.PORT ?? 54329)
const db = await startSampleDb(port)
console.log(
  `Sample Postgres on 127.0.0.1:${port} (user postgres / password postgres / database postgres, SSL off). Ctrl+C stops it.`
)
process.on("SIGINT", () => void db.stop().then(() => process.exit(0)))
