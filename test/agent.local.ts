/**
 * One real conversation against the sample Postgres: `bun test/agent.local.ts`.
 *
 * Not part of `bun run test` — it starts the `claude` on this machine and
 * spends a few tokens on the account it is signed in to.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { Chats } from "../src/main/chats"
import { Connections } from "../src/main/connections"
import { PostgresDriver } from "../src/main/db/postgres"
import { Library } from "../src/main/library"
import type { ChatEvent } from "../src/shared/api"
import { openSamplePostgres } from "./sample-postgres"

const sample = await openSamplePostgres()
const dataDir = mkdtempSync(path.join(tmpdir(), "veylens-agent-"))
const connections = new Connections(
  path.join(dataDir, "connections.json"),
  { encrypt: () => null, decrypt: () => null },
  (config) => new PostgresDriver(config, { stream: sample.stream })
)
const shop = connections.save(null, {
  name: "Shop",
  engine: "postgres",
  host: "in-process",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "postgres",
  ssl: "off",
})

const approve = process.argv.includes("--approve")
let done: () => void = () => {}
const library = new Library(dataDir, () => {})
const chats = new Chats(dataDir, connections, library, (event: ChatEvent) => {
  if (event.type === "delta") return void process.stdout.write(event.text)
  if (event.type === "item") {
    const item = event.item
    if (item.kind === "tool") {
      console.log(
        `\n[tool ${item.tool} ${item.status}] ${JSON.stringify(item.input)}${item.output ? `\n  → ${item.output.slice(0, 300)}` : ""}`
      )
      if (item.status === "awaiting") {
        chats.answerApproval(event.chatId, item.id, approve)
      }
    } else if (item.kind !== "assistant") {
      console.log(`\n[${item.kind}] ${item.text}`)
    }
  } else if (event.type === "summary") {
    if (!event.chat.busy) done()
  } else {
    console.log(`\n[${event.type}] ${JSON.stringify(event)}`)
  }
})

console.log(await chats.status())
const chat = chats.create()
const ask = async (text: string) => {
  const finished = new Promise<void>((resolve) => (done = resolve))
  await chats.send({
    chatId: chat.id,
    text,
    model: process.env.MODEL ?? "haiku",
    effort: null,
    context: { connectionId: shop.id, tab: null },
  })
  await finished
  console.log("\n— turn over —")
}

for (const question of process.argv.slice(2).filter((arg) => !arg.startsWith("--"))) {
  await ask(question)
}

chats.closeAll()
await connections.closeAll()
await sample.close()
process.exit(0)
