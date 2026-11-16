import { createHash, randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"

import type { GoogleAccountState } from "../shared/api"
import type { Secrets } from "./connections"

/**
 * The Google account Vey Lens reads private Google Sheets as, signed in from
 * the app itself — not through gcloud, whose own client Google refuses
 * Sheets to.
 *
 * Signing in is OAuth for installed apps: the browser opens Google's page,
 * Google sends the browser back to a port on 127.0.0.1 this process listens
 * on for that one answer, and the code it carries is traded, with a PKCE
 * verifier, for a refresh token. The token is kept in the keychain; with it
 * the Sheets reader gets an access token whenever it needs one.
 *
 * The OAuth client — a "Desktop app" client in a Google Cloud project, best
 * an Internal one of the company's Workspace — is either built in (set when
 * the app is built) or imported here from the JSON file Google gives.
 * A desktop client's secret is not a secret: Google says so, and PKCE is
 * what protects the exchange.
 */

export type GoogleClient = { clientId: string; clientSecret: string }

/** Read-only, and nothing but Sheets: no Drive, no Gmail. */
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/spreadsheets.readonly"]

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const REVOKE_URL = "https://oauth2.googleapis.com/revoke"

/** How long the browser has to come back before the wait is given up. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

type Stored = {
  /** An imported client; a built-in one is not stored. */
  client?: { clientId: string; secret: { enc: string } | { plain: string } }
  account?: { email: string; token: { enc: string } | { plain: string } }
}

const base64url = (data: Buffer) => data.toString("base64url")

/** The OAuth client in the JSON Google downloads for it. Throws, saying
 * why, for anything else. */
export function parseClientJson(text: string): GoogleClient {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("That is not the JSON file Google gives for an OAuth client.")
  }
  const record = parsed as { installed?: Record<string, unknown>; web?: unknown }
  if (record.web) {
    throw new Error('That is a "Web application" client. Make one of type "Desktop app" and import its JSON.')
  }
  const installed = record.installed
  const clientId = typeof installed?.client_id === "string" ? installed.client_id : ""
  const clientSecret = typeof installed?.client_secret === "string" ? installed.client_secret : ""
  if (!clientId.endsWith(".apps.googleusercontent.com") || !clientSecret) {
    throw new Error('That is not a "Desktop app" OAuth client file (client_secret_….json).')
  }
  return { clientId, clientSecret }
}

/** The page to send the browser to, and what proves the answer is ours. */
export function authorizationRequest(client: GoogleClient, redirectUri: string) {
  const verifier = base64url(randomBytes(32))
  const state = base64url(randomBytes(16))
  const url = new URL(AUTH_URL)
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
    // A refresh token, every time: an earlier grant's may have been revoked.
    access_type: "offline",
    prompt: "consent select_account",
  }).toString()
  return { url: url.toString(), verifier, state }
}

/** What Google sent the browser back with: the code, or why there is none. */
export function callbackResult(requestUrl: string, state: string): { code: string } | { error: string } {
  const params = new URL(requestUrl, "http://127.0.0.1").searchParams
  if (params.get("state") !== state) return { error: "The answer did not come from this sign-in." }
  const error = params.get("error")
  if (error) return { error: error === "access_denied" ? "Access was not granted." : `Google said: ${error}` }
  const code = params.get("code")
  return code ? { code } : { error: "Google sent no code back." }
}

/** The email in an ID token straight from Google's token endpoint. */
function emailOf(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"))
    return typeof payload.email === "string" ? payload.email : null
  } catch {
    return null
  }
}

/** The code traded for tokens. */
export async function exchangeCode(
  client: GoogleClient,
  code: string,
  verifier: string,
  redirectUri: string,
  fetcher: typeof fetch = fetch
): Promise<{ email: string; refreshToken: string }> {
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }).toString(),
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(`Google refused the sign-in: ${String(body.error_description ?? body.error ?? response.status)}`)
  }
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : ""
  if (!refreshToken) throw new Error("Google sent no refresh token back; sign in again.")
  const scope = typeof body.scope === "string" ? body.scope : ""
  if (scope && !scope.includes("spreadsheets.readonly")) {
    throw new Error("Reading Google Sheets was not allowed in the sign-in. Sign in again and tick it.")
  }
  return { email: emailOf(body.id_token) ?? "your Google account", refreshToken }
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#222">` +
  `<div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p>${text}</p></div>`

/** A request's client for the Sheets API: what `gaxios`-style callers need. */
export type RequestClient = {
  request<T>(options: { url: string; params?: Record<string, unknown> }): Promise<{ data: T }>
}

export class GoogleAccount {
  private stored: Stored = {}
  private pending: { cancel: (reason: string) => void } | null = null
  private cached: { token: string; client: RequestClient } | null = null

  constructor(
    private readonly file: string,
    private readonly secrets: Secrets,
    private readonly builtIn: GoogleClient | null,
    private readonly openUrl: (url: string) => Promise<void>,
    /** Told when the account changes: drivers holding the old one reopen. */
    private readonly changed: () => void = () => {},
    /** Google's token endpoints; swapped by a test. */
    private readonly fetcher: typeof fetch = fetch
  ) {
    try {
      this.stored = JSON.parse(readFileSync(file, "utf8")) as Stored
    } catch {
      // None yet.
    }
  }

  private persist(): void {
    if (!this.stored.client && !this.stored.account) {
      rmSync(this.file, { force: true })
      return
    }
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.stored, null, 2), { mode: 0o600 })
    chmodSync(this.file, 0o600)
  }

  private seal(text: string): { enc: string } | { plain: string } {
    const enc = this.secrets.encrypt(text)
    return enc === null ? { plain: text } : { enc }
  }

  private open(sealed: { enc: string } | { plain: string }): string | null {
    return "plain" in sealed ? sealed.plain : this.secrets.decrypt(sealed.enc)
  }

  /** The client signing in goes through: an imported one over the built-in. */
  private client(): GoogleClient | null {
    const imported = this.stored.client
    if (imported) {
      const secret = this.open(imported.secret)
      if (secret) return { clientId: imported.clientId, clientSecret: secret }
    }
    return this.builtIn
  }

  state(): GoogleAccountState {
    return {
      email: this.stored.account?.email ?? null,
      client: this.stored.client ? "imported" : this.builtIn ? "built_in" : null,
      signingIn: this.pending !== null,
    }
  }

  importClient(json: string): GoogleAccountState {
    const client = parseClientJson(json)
    const before = this.client()?.clientId
    this.stored.client = { clientId: client.clientId, secret: this.seal(client.clientSecret) }
    // A token is only good with the client it was granted to.
    if (before !== client.clientId && this.stored.account) {
      delete this.stored.account
      this.cached = null
      this.changed()
    }
    this.persist()
    return this.state()
  }

  /** Opens the browser and waits for Google to send it back. */
  async signIn(): Promise<GoogleAccountState> {
    const client = this.client()
    if (!client) throw new Error("No Google OAuth client is set up: import the Desktop app client's JSON first.")
    this.pending?.cancel("Started again.")

    const server = http.createServer()
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const request = authorizationRequest(client, redirectUri)

    try {
      const code = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => finish({ error: "Nobody came back from the browser in five minutes." }), SIGN_IN_TIMEOUT_MS)
        const finish = (result: { code: string } | { error: string }) => {
          clearTimeout(timer)
          this.pending = null
          if ("code" in result) resolve(result.code)
          else reject(new Error(result.error))
        }
        this.pending = { cancel: (reason) => finish({ error: reason }) }
        server.on("request", (incoming, outgoing) => {
          const url = incoming.url ?? "/"
          // The browser asks for its icon too; only the answer counts.
          if (!/[?&](state|code|error)=/.test(url)) {
            outgoing.writeHead(404).end()
            return
          }
          const result = callbackResult(url, request.state)
          const ok = "code" in result
          outgoing.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" })
          outgoing.end(
            ok
              ? PAGE("Signed in to Vey Lens", "You can close this tab and go back to the app.")
              : PAGE("Not signed in", "error" in result ? result.error : "")
          )
          finish(result)
        })
        void this.openUrl(request.url).catch((error: unknown) =>
          finish({ error: `Could not open the browser: ${error instanceof Error ? error.message : String(error)}` })
        )
      })
      const { email, refreshToken } = await exchangeCode(client, code, request.verifier, redirectUri, this.fetcher)
      this.stored.account = { email, token: this.seal(refreshToken) }
      this.cached = null
      this.persist()
      this.changed()
      return this.state()
    } finally {
      this.pending = null
      server.close()
      server.closeAllConnections?.()
    }
  }

  cancelSignIn(): void {
    this.pending?.cancel("Signing in was cancelled.")
  }

  /** Forgets the account, and asks Google to drop the grant. */
  async signOut(): Promise<GoogleAccountState> {
    const account = this.stored.account
    if (account) {
      const token = this.open(account.token)
      delete this.stored.account
      this.cached = null
      this.persist()
      this.changed()
      if (token) {
        await this.fetcher(REVOKE_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
        }).catch(() => {})
      }
    }
    return this.state()
  }

  /** Forgets an imported client, going back to the built-in one, if any. */
  forgetClient(): GoogleAccountState {
    if (this.stored.client) {
      delete this.stored.client
      if (this.stored.account) {
        delete this.stored.account
        this.cached = null
        this.changed()
      }
      this.persist()
    }
    return this.state()
  }

  /** A client for the Sheets API as the signed-in account, or null. */
  async requestClient(): Promise<RequestClient | null> {
    const client = this.client()
    const account = this.stored.account
    const token = account ? this.open(account.token) : null
    if (!client || !token) return null
    if (this.cached?.token === token) return this.cached.client
    const { OAuth2Client } = require("google-auth-library") as typeof import("google-auth-library")
    const oauth = new OAuth2Client({ clientId: client.clientId, clientSecret: client.clientSecret })
    oauth.setCredentials({ refresh_token: token })
    const wrapped: RequestClient = {
      request: async (options) => {
        try {
          return await oauth.request(options)
        } catch (error) {
          if (/invalid_grant/i.test(error instanceof Error ? error.message : String(error))) {
            throw new Error(`The Google sign-in of ${account!.email} has expired or was revoked: sign in with Google again.`)
          }
          throw error
        }
      },
    }
    this.cached = { token, client: wrapped }
    return wrapped
  }
}
