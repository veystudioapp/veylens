import {
  AuthTypes,
  Connector,
  IpAddressTypes,
} from "@google-cloud/cloud-sql-connector"

import type {
  ChangeSet,
  CloudSql,
  CloudSqlIpType,
  RowsRequest,
  TableRef,
} from "../../shared/api"
import { MysqlDriver } from "./mysql"
import { PostgresDriver } from "./postgres"
import type { ConnectionConfig, Driver, PlanLimits, QueryOptions, RawSession } from "./types"

export const IP_TYPE: Record<CloudSqlIpType, IpAddressTypes> = {
  public: IpAddressTypes.PUBLIC,
  private: IpAddressTypes.PRIVATE,
  psc: IpAddressTypes.PSC,
}

/** What went wrong reaching Google, with what to do about it. */
export function withHint(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/credential|invalid_grant|invalid_rapt|reauth/i.test(message)) {
    return new Error(
      `${message}\nSign in to Google on this machine with \`gcloud auth application-default login\`, then try again.`
    )
  }
  if (/permission|not authorized|forbidden|\b403\b/i.test(message)) {
    return new Error(
      `${message}\nThe Google account needs the Cloud SQL Client role on the instance's project.`
    )
  }
  return error instanceof Error ? error : new Error(message)
}

/**
 * A Postgres or MySQL driver whose connections go through Google's Cloud SQL
 * connector. Asking Google for the instance's address and a certificate takes
 * a round trip, so the driver beneath is built on first use; a failure there
 * is not kept, and the next call asks again.
 */
export class CloudSqlDriver implements Driver {
  private readonly connector = new Connector()
  private inner: Promise<Driver> | null = null
  private closed = false

  constructor(
    private readonly config: ConnectionConfig,
    private readonly cloudSql: CloudSql
  ) {}

  private ready(): Promise<Driver> {
    if (this.closed) return Promise.reject(new Error("This connection was closed."))
    this.inner ??= this.connector
      .getOptions({
        instanceConnectionName: this.cloudSql.instance,
        ipType: IP_TYPE[this.cloudSql.ipType],
        authType: this.cloudSql.auth === "iam" ? AuthTypes.IAM : AuthTypes.PASSWORD,
      })
      .then(
        ({ stream }) => {
          // The connector encrypts the connection itself: the driver's own
          // SSL stays off, and with IAM there is no password to send.
          const config: ConnectionConfig = {
            ...this.config,
            ssl: "off",
            ...(this.cloudSql.auth === "iam" ? { password: "" } : {}),
          }
          return config.engine === "mysql"
            ? new MysqlDriver(config, { stream })
            : new PostgresDriver(config, { stream, ssl: false })
        },
        (error: unknown) => {
          this.inner = null
          throw withHint(error)
        }
      )
    return this.inner
  }

  async ping() {
    return (await this.ready()).ping()
  }
  async tree() {
    return (await this.ready()).tree()
  }
  async table(ref: TableRef) {
    return (await this.ready()).table(ref)
  }
  async details(ref: TableRef) {
    return (await this.ready()).details(ref)
  }
  async rows(request: RowsRequest) {
    return (await this.ready()).rows(request)
  }
  async apply(changes: ChangeSet) {
    return (await this.ready()).apply(changes)
  }
  async query(sql: string, options: QueryOptions) {
    return (await this.ready()).query(sql, options)
  }
  async explain(sql: string) {
    return (await this.ready()).explain(sql)
  }
  async runPlan(statements: string[], limits?: PlanLimits) {
    return (await this.ready()).runPlan(statements, limits)
  }
  async viewSources() {
    const inner = await this.ready()
    return inner.viewSources ? inner.viewSources() : []
  }
  async diagram(schema: string) {
    const inner = await this.ready()
    if (!inner.diagram) throw new Error("This kind of connection has no foreign keys to draw.")
    return inner.diagram(schema)
  }

  async rawSession<T>(work: (session: RawSession) => Promise<T>): Promise<T> {
    const inner = await this.ready()
    if (!inner.rawSession) throw new Error("This kind of connection cannot be copied.")
    return inner.rawSession(work)
  }

  async close(): Promise<void> {
    this.closed = true
    const inner = await this.inner?.catch(() => null)
    await inner?.close()
    this.connector.close()
  }
}
