/**
 * "Sign in with Google": the OAuth client file, the request, the browser
 * coming back to the loopback port, the code traded for a token, the token
 * kept. Google's token endpoint is answered here. `bun test/google-account.ts`.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { googleFetcher, useSignedInAccount } from "../src/main/db/files/google-sheets"
import {
  authorizationRequest,
  callbackResult,
  exchangeCode,
  GoogleAccount,
  parseClientJson,
} from "../src/main/google-account"

/** Whether a port on 127.0.0.1 can be listened on here: not in every
 * sandbox. Without one, the checks that need it say they were skipped. */
const canListen = await new Promise<boolean>((resolve) => {
  const server = http.createServer()
  server.once("error", () => resolve(false))
  server.listen(0, "127.0.0.1", () => server.close(() => resolve(true)))
})

let failed = 0
async function check(name: string, body: () => Promise<void> | void, needsPort = false) {
  if (needsPort && !canListen) {
    console.log(`skip ${name} (no loopback port can be opened here)`)
    return
  }
  try {
    await body()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n     ${(error as Error).stack}`)
  }
}

const dir = mkdtempSync(path.join(os.tmpdir(), "veylens-google-test-"))
const client = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-test" }
const clientJson = JSON.stringify({
  installed: { client_id: client.clientId, client_secret: client.clientSecret, redirect_uris: ["http://localhost"] },
})
/** A keychain that marks what it sealed, so the file can be checked for it. */
const secrets = {
  encrypt: (text: string) => `sealed:${Buffer.from(text).toString("base64")}`,
  decrypt: (data: string) => Buffer.from(data.replace(/^sealed:/, ""), "base64").toString(),
}
const idToken = (email: string) =>
  `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`

await check("the client file: a Desktop app client, nothing else", () => {
  assert.deepEqual(parseClientJson(clientJson), client)
  assert.throws(() => parseClientJson(JSON.stringify({ web: { client_id: "x" } })), /Web application/)
  assert.throws(() => parseClientJson("{"), /not the JSON/)
  assert.throws(() => parseClientJson(JSON.stringify({ installed: { client_id: "x" } })), /Desktop app/)
})

await check("the request asks for Sheets read-only, offline, with PKCE", () => {
  const request = authorizationRequest(client, "http://127.0.0.1:5555")
  const url = new URL(request.url)
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth")
  assert.equal(url.searchParams.get("scope"), "openid email https://www.googleapis.com/auth/spreadsheets.readonly")
  assert.equal(url.searchParams.get("access_type"), "offline")
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:5555")
  assert.equal(url.searchParams.get("state"), request.state)
  assert.notEqual(url.searchParams.get("code_challenge"), request.verifier)
})

await check("the answer: its state checked, a refusal said", () => {
  assert.deepEqual(callbackResult("/?state=s&code=c", "s"), { code: "c" })
  assert.match((callbackResult("/?state=other&code=c", "s") as { error: string }).error, /did not come/)
  assert.match((callbackResult("/?state=s&error=access_denied", "s") as { error: string }).error, /not granted/)
})

await check("the code traded for a token: the email read, a refusal or a missing grant said", async () => {
  const answer = (status: number, body: object) => (async () => Response.json(body, { status })) as unknown as typeof fetch
  assert.deepEqual(
    await exchangeCode(client, "c", "v", "http://127.0.0.1:1", answer(200, {
      refresh_token: "r",
      id_token: idToken("a@azoom.jp"),
      scope: "openid https://www.googleapis.com/auth/spreadsheets.readonly",
    })),
    { email: "a@azoom.jp", refreshToken: "r" }
  )
  await assert.rejects(
    exchangeCode(client, "c", "v", "http://127.0.0.1:1", answer(400, { error: "invalid_grant", error_description: "Bad Request" })),
    /refused the sign-in: Bad Request/
  )
  await assert.rejects(
    exchangeCode(client, "c", "v", "http://127.0.0.1:1", answer(200, { refresh_token: "r", scope: "openid email" })),
    /not allowed/
  )
  await assert.rejects(exchangeCode(client, "c", "v", "http://127.0.0.1:1", answer(200, {})), /no refresh token/)
})

await check("signing in: browser back on the loopback port, token kept sealed, then signing out", async () => {
  const exchanged: URLSearchParams[] = []
  const revoked: string[] = []
  const fakeGoogle = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ""))
    if (String(url) === "https://oauth2.googleapis.com/token") {
      exchanged.push(body)
      return Response.json({
        refresh_token: "refresh-1",
        id_token: idToken("dev@azoom.jp"),
        scope: "openid https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/userinfo.email",
      })
    }
    revoked.push(body.get("token") ?? "")
    return new Response("")
  }) as typeof fetch
  let changes = 0
  let pages = ""
  const account = new GoogleAccount(
    path.join(dir, "google-account.json"),
    secrets,
    null,
    // The browser: Google signs the user in and sends it back.
    async (url) => {
      const request = new URL(url)
      const back = new URL(request.searchParams.get("redirect_uri")!)
      back.searchParams.set("state", request.searchParams.get("state")!)
      back.searchParams.set("code", "the-code")
      setTimeout(async () => {
        await fetch(new URL("/favicon.ico", back)).catch(() => {})
        pages = await (await fetch(back)).text()
      }, 20)
    },
    () => changes++,
    fakeGoogle
  )
  assert.deepEqual(account.state(), { email: null, client: null, signingIn: false })
  await assert.rejects(account.signIn(), /import/)
  assert.equal(account.importClient(clientJson).client, "imported")

  const state = await account.signIn()
  assert.deepEqual(state, { email: "dev@azoom.jp", client: "imported", signingIn: false })
  assert.equal(changes, 1)
  const sent = exchanged[0]!
  assert.equal(sent.get("code"), "the-code")
  assert.equal(sent.get("grant_type"), "authorization_code")
  assert.match(sent.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.ok((sent.get("code_verifier") ?? "").length >= 43)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.match(pages, /Signed in to Vey Lens/)

  const file = readFileSync(path.join(dir, "google-account.json"), "utf8")
  assert.ok(!file.includes("refresh-1") && !file.includes("GOCSPX-test"), "a secret was written in the clear")
  assert.ok(await account.requestClient(), "no client for the Sheets API")

  // Kept across a restart.
  const again = new GoogleAccount(path.join(dir, "google-account.json"), secrets, null, async () => {})
  assert.equal(again.state().email, "dev@azoom.jp")

  assert.equal((await account.signOut()).email, null)
  assert.deepEqual(revoked, ["refresh-1"])
  assert.equal(await account.requestClient(), null)
  assert.equal(account.forgetClient().client, null)
}, true)

await check("a sign-in can be cancelled, and the built-in client is used without an import", async () => {
  const account = new GoogleAccount(path.join(dir, "other.json"), secrets, client, async () => {})
  assert.equal(account.state().client, "built_in")
  const pending = account.signIn()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(account.state().signingIn, true)
  account.cancelSignIn()
  await assert.rejects(pending, /cancelled/)
  assert.equal(account.state().signingIn, false)
}, true)

await check("a private sheet is read as the account signed in from the app", async () => {
  const asked: string[] = []
  useSignedInAccount(async () => ({
    request: async <T,>(options: { url: string }) => {
      asked.push(options.url)
      if (options.url.endsWith("/not-shared")) {
        throw Object.assign(new Error("The caller does not have permission"), { response: { status: 403 } })
      }
      return { data: { properties: { title: "Budget" } } as T }
    },
  }))
  assert.equal((await googleFetcher.gridData("sheet-1")).properties?.title, "Budget")
  assert.deepEqual(asked, ["https://sheets.googleapis.com/v4/spreadsheets/sheet-1"])
  await assert.rejects(googleFetcher.gridData("not-shared"), /cannot open this spreadsheet: share it/)
  useSignedInAccount(async () => null)
})

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : "\nall passed")
process.exit(failed ? 1 : 0)
