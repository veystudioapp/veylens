import type { ChangeSet, ParamValues, QueryResult } from "../shared/api"
import { bindParameters } from "../shared/params"
import { startsLikeRead } from "../shared/statements"
import type { Connections } from "./connections"

/** Rows a statement typed into the SQL tab may bring back. */
export const QUERY_ROWS = 2000

/**
 * A statement from the renderer — the SQL tab, a dashboard tile — under the
 * connection's access: on a read-only connection only a read runs, and it
 * runs in a read-only transaction whatever the caller asked for.
 */
export async function runUserQuery(
  connections: Connections,
  connectionId: string,
  sql: string,
  requestedReadOnly: boolean,
  params?: ParamValues
): Promise<QueryResult> {
  const readOnly =
    requestedReadOnly || connections.access(connectionId) === "read_only"
  if (readOnly && !requestedReadOnly && !startsLikeRead(sql)) {
    connections.assertWritable(connectionId)
  }
  const driver = connections.driver(connectionId)
  if (!params) return driver.query(sql, { readOnly, maxRows: QUERY_ROWS })
  // A tile's SQL with the dashboard's filters: bound, never spliced in.
  const bound = bindParameters(sql, params, connections.get(connectionId).engine)
  return driver.query(bound.text, {
    readOnly,
    maxRows: QUERY_ROWS,
    values: bound.values,
  })
}

/** Rows edited in a table tab; refused on a read-only connection. */
export async function applyUserChanges(
  connections: Connections,
  connectionId: string,
  changes: ChangeSet
): Promise<number> {
  connections.assertWritable(connectionId)
  return connections.driver(connectionId).apply(changes)
}
