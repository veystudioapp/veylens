import type { ServerEngine } from "../../shared/api"
import type { RawSession } from "../db/types"

export type ObjectKind = "table" | "view" | "materialized view"

/** One table or view of the source, as the target is to have it. */
export type SourceObject = {
  name: string
  kind: ObjectKind
  rowEstimate: number | null
  /** What makes it, once the schema and the types and sequences it uses are
   * there. A view's run only after every table is made and filled. */
  create: string[]
  /** After every table's rows: indexes, keys to other tables, comments. A
   * view's run right after it is made. */
  after: string[]
  /** Right after its rows, when they are copied: sequences moved past them. */
  afterData: string[]
  /** What rows are read and written by; none for a view, nor a generated
   * column, which the target works out itself. */
  columns: string[]
  /** Rows are read from it: not from a view, nor from a partition whose
   * parent is copied too — its rows come through the parent. */
  readsData: boolean
  /** Copied tables its foreign keys point at: their rows go in first. */
  dependsOn: string[]
  /** An identity column is written with the value given (Postgres's
   * OVERRIDING SYSTEM VALUE). */
  overriding: boolean
}

export type Described = {
  objects: SourceObject[]
  /** Before any table is made: the types and sequences they use. */
  prelude: string[]
  warnings: string[]
}

export type TargetState = {
  schemaExists: boolean
  /** What the schema already has, by name. */
  existing: Map<string, ObjectKind>
}

/** What differs between engines when tables are copied. */
export interface CopyEngine {
  readonly engine: ServerEngine
  /** Whether a failed copy leaves nothing behind: Postgres makes tables in
   * a transaction; MySQL commits each one as it is made. */
  readonly transactional: boolean
  /** Rows one INSERT carries at most, and how big it may get. */
  rowsPerInsert(columns: number): number
  readonly insertBytes: number

  quote(name: string): string
  /** A consistent read of the source, from this point on. */
  beginSource(session: RawSession, schema: string): Promise<void>
  inspectTarget(session: RawSession, schema: string): Promise<TargetState>
  describe(
    source: RawSession,
    target: RawSession,
    from: string,
    to: string,
    names: string[],
    state: TargetState,
    options: { data: boolean }
  ): Promise<Described>
  createSchema(source: RawSession, from: string, to: string): Promise<string>
  drop(to: string, objects: { name: string; kind: ObjectKind }[]): string[]
  truncate(to: string, names: string[]): string[]

  /** The target's session made ready to write; for Postgres, the
   * transaction everything runs in. */
  beginTarget(session: RawSession, to: string): Promise<void>
  /** After the schema is surely there. */
  enterSchema(session: RawSession, to: string): Promise<void>
  /** Around one table's rows, when the copy as a whole is not one
   * transaction. */
  beginTable(session: RawSession): Promise<void>
  commitTable(session: RawSession): Promise<void>
  /** A statement that may fail without failing the copy — a view whose
   * dependencies are not made yet. Resolves with the error, or null. */
  attempt(session: RawSession, statements: string[]): Promise<Error | null>
  finishTarget(session: RawSession): Promise<void>

  select(from: string, table: string, columns: string[]): string
  insert(to: string, table: string, columns: string[], rows: number, overriding: boolean): string
}

/** Text for a SQL string literal. */
export const literal = (text: string) => `'${text.replace(/'/g, "''")}'`

export const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

export const text = (value: unknown): string =>
  value === null || value === undefined ? "" : Buffer.isBuffer(value) ? value.toString("utf8") : String(value)

/** Each in turn: a session runs one statement at a time. */
export async function inOrder<T extends (() => Promise<unknown>)[]>(
  steps: [...T]
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results: unknown[] = []
  for (const step of steps) results.push(await step())
  return results as { [K in keyof T]: Awaited<ReturnType<T[K]>> }
}
