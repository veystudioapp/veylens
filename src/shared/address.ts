import type { Connection } from "./api"

/** Where a connection goes, as said under its name: `host:port`, or the
 * Cloud SQL instance the connector reaches. */
export function addressOf(connection: Pick<Connection, "host" | "port" | "cloudSql">): string {
  return connection.cloudSql
    ? `Cloud SQL ${connection.cloudSql.instance}`
    : `${connection.host}:${connection.port}`
}
