import type { Connection, DataSource } from "./api"

/** A source as said in a line: the file's name, or "Google Sheet". */
export function sourceLabel(source: DataSource): string {
  if (source.kind === "google_sheet") return "Google Sheet"
  return source.path.split(/[\\/]/).pop() || source.path
}

/** Where a connection goes, as said under its name: `host:port`, the
 * Cloud SQL instance the connector reaches, or the files it reads. */
export function addressOf(
  connection: Pick<Connection, "host" | "port" | "cloudSql"> &
    Partial<Pick<Connection, "engine" | "sources">>
): string {
  if (connection.engine === "duckdb") {
    const sources = connection.sources ?? []
    if (sources.length === 0) return "no files"
    const first = sourceLabel(sources[0]!)
    return sources.length === 1 ? first : `${first} + ${sources.length - 1} more`
  }
  return connection.cloudSql
    ? `Cloud SQL ${connection.cloudSql.instance}`
    : `${connection.host}:${connection.port}`
}

/** `user@host:port/database`, or for files the files. */
export function locationOf(
  connection: Pick<Connection, "engine" | "user" | "database" | "host" | "port" | "cloudSql" | "sources">
): string {
  if (connection.engine === "duckdb") return addressOf(connection)
  return `${connection.user}@${addressOf(connection)}${connection.database ? `/${connection.database}` : ""}`
}
