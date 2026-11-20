import type { RawSession } from "../db/types"
import {
  literal,
  num,
  text,
  type CopyEngine,
  type Described,
  type ObjectKind,
  type SourceObject,
  type TargetState,
  inOrder,
} from "./engine"

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

/** `nextval('name'::regclass)`: the sequence a serial column counts with,
 * as the literal spells it. */
const NEXTVAL = /nextval\('((?:[^']|'')+)'::regclass\)/g
/** A default that is a sequence's next value and nothing else. */
const NEXTVAL_ONLY = /^nextval\('(?:[^']|'')+'::regclass\)$/

/** A name the literal spells without a schema: the sequence is in the
 * schema being copied, as the source is read with only that on its path. */
const UNQUALIFIED = /^(?:"(?:[^"]|"")+"|[^".]+)$/

const RELKIND: Record<string, ObjectKind> = { r: "table", p: "table", f: "table", v: "view", m: "materialized view" }

/**
 * Postgres to Postgres. The source is read with only the schema being copied
 * on its search path, so the server prints what is in it unqualified and
 * anything elsewhere qualified; the target is written with the target schema
 * first on its path, so those same names land there. Everything runs in one
 * transaction: a copy that fails changes nothing.
 */
export const postgresCopy: CopyEngine = {
  engine: "postgres",
  transactional: true,
  // Postgres takes 65535 parameters a statement.
  rowsPerInsert: (columns) => Math.max(1, Math.min(1000, Math.floor(60_000 / Math.max(1, columns)))),
  insertBytes: 16 * 1024 * 1024,
  quote,

  async beginSource(session, schema) {
    await session.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    await session.query(`SET LOCAL search_path = ${quote(schema)}`)
  },

  async inspectTarget(session, schema) {
    const [found, relations] = await inOrder([
      () => session.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]),
      () => session.query(
        `SELECT c.relname, c.relkind FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f', 'v', 'm')`,
        [schema]
      ),
    ])
    return {
      schemaExists: found.rows.length > 0,
      existing: new Map(relations.rows.map((row) => [text(row[0]), RELKIND[text(row[1])] ?? "table"])),
    }
  },

  async describe(source, target, from, to, names, state, options): Promise<Described> {
    const key = [from, names]
    const [relations, columns, constraints, indexes, enums, domains, triggers] = await inOrder([
      () => source.query(
        `SELECT c.relname, c.relkind, c.relispartition,
                (SELECT p.relname FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
                  WHERE i.inhrelid = c.oid LIMIT 1),
                CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END,
                CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
                obj_description(c.oid, 'pg_class'),
                c.reltuples::int8,
                CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END,
                c.relpersistence
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = ANY ($2::text[])
            AND c.relkind IN ('r', 'p', 'f', 'v', 'm')`,
        key
      ),
      () => source.query(
        `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                pg_get_expr(d.adbin, d.adrelid),
                coalesce(to_jsonb(a) ->> 'attidentity', ''),
                coalesce(to_jsonb(a) ->> 'attgenerated', ''),
                col_description(a.attrelid, a.attnum),
                CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
                     THEN quote_ident(co.collname) END
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_type t ON t.oid = a.atttypid
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           LEFT JOIN pg_collation co ON co.oid = a.attcollation
          WHERE n.nspname = $1 AND c.relname = ANY ($2::text[])
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY c.relname, a.attnum`,
        key
      ),
      () => source.query(
        `SELECT c.relname, con.conname, con.contype, pg_get_constraintdef(con.oid),
                fn.nspname, fc.relname, con.conislocal AND con.coninhcount = 0
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_class fc ON fc.oid = con.confrelid
           LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
          WHERE n.nspname = $1 AND c.relname = ANY ($2::text[])
            AND con.contype IN ('p', 'u', 'c', 'x', 'f')
          ORDER BY c.relname, CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 ELSE 2 END, con.conname`,
        key
      ),
      // Indexes a constraint makes are made by it; a partition's that
      // belong to its parent's index are made by that.
      () => source.query(
        `SELECT c.relname, pg_get_indexdef(ix.indexrelid),
                quote_ident(n.nspname) || '.' || quote_ident(c.relname), quote_ident(c.relname)
           FROM pg_index ix
           JOIN pg_class c ON c.oid = ix.indrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = ANY ($2::text[])
            AND NOT EXISTS (SELECT 1 FROM pg_constraint con
                             WHERE con.conindid = ix.indexrelid AND con.conrelid = ix.indrelid)
            AND NOT EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = ix.indexrelid)
          ORDER BY c.relname`,
        key
      ),
      // Enums of the copied schema its columns use, arrays of them too.
      () => source.query(
        `SELECT t.typname,
                to_json(ARRAY(SELECT e.enumlabel FROM pg_enum e
                               WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder))
           FROM pg_type t
          WHERE t.oid IN (
         SELECT et.oid
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_type at ON at.oid = a.atttypid
           JOIN pg_type et ON et.oid = CASE WHEN at.typelem <> 0 AND at.typlen = -1 THEN at.typelem ELSE at.oid END
           JOIN pg_namespace tn ON tn.oid = et.typnamespace
          WHERE n.nspname = $1 AND c.relname = ANY ($2::text[])
            AND a.attnum > 0 AND NOT a.attisdropped
            AND et.typtype = 'e' AND tn.nspname = $1)`,
        key
      ),
      () => source.query(
        `SELECT DISTINCT t.typname
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_type t ON t.oid = a.atttypid
           JOIN pg_namespace tn ON tn.oid = t.typnamespace
          WHERE n.nspname = $1 AND c.relname = ANY ($2::text[])
            AND a.attnum > 0 AND NOT a.attisdropped
            AND t.typtype = 'd' AND tn.nspname = $1`,
        key
      ),
      () => source.query(
        `SELECT count(*) FROM pg_trigger g
           JOIN pg_class c ON c.oid = g.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = ANY ($2::text[]) AND NOT g.tgisinternal`,
        key
      ),
    ])

    const warnings: string[] = []
    const inTarget = (name: string) => `${quote(to)}.${quote(name)}`
    const copied = new Set(relations.rows.map((row) => text(row[0])))

    type Relation = {
      name: string
      relkind: string
      parent: string | null
      bound: string | null
      partitionKey: string | null
      comment: string | null
      estimate: number | null
      viewdef: string | null
      unlogged: boolean
    }
    const rels: Relation[] = relations.rows.map((row) => ({
      name: text(row[0]),
      relkind: text(row[1]),
      parent: row[2] === "t" && row[3] !== null ? text(row[3]) : null,
      bound: row[4] === null ? null : text(row[4]),
      partitionKey: row[5] === null ? null : text(row[5]),
      comment: row[6] === null ? null : text(row[6]),
      estimate: num(row[7]),
      viewdef: row[8] === null ? null : text(row[8]),
      unlogged: row[9] === "u",
    }))
    // A partition of a parent copied with it is made as a partition of the
    // copy; one copied alone is a table of its own.
    const partitionOf = (rel: Relation) => (rel.parent && copied.has(rel.parent) ? rel.parent : null)

    const prelude: string[] = []
    const existingTypes = new Set(
      (
        await target.query(
          `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1`,
          [to]
        )
      ).rows.map((row) => text(row[0]))
    )
    for (const row of enums.rows) {
      const name = text(row[0])
      if (existingTypes.has(name)) continue
      const labels = JSON.parse(text(row[1]) || "[]") as string[]
      prelude.push(`CREATE TYPE ${inTarget(name)} AS ENUM (${labels.map(literal).join(", ")})`)
    }
    for (const row of domains.rows) {
      const name = text(row[0])
      if (!existingTypes.has(name)) {
        warnings.push(`The type ${name} is defined in ${from} and is not copied: make it in ${to} first, or the tables using it cannot be made.`)
      }
    }
    const triggerCount = num(triggers.rows[0]?.[0]) ?? 0
    if (triggerCount) {
      warnings.push(`Triggers (${triggerCount}) are not copied, nor the functions they call.`)
    }

    // Columns, a table at a time.
    type ColumnRow = {
      name: string
      type: string
      notNull: boolean
      expression: string | null
      identity: string
      generated: string
      comment: string | null
      collation: string | null
    }
    const columnsOf = new Map<string, ColumnRow[]>()
    for (const row of columns.rows) {
      const table = text(row[0])
      const list = columnsOf.get(table) ?? []
      list.push({
        name: text(row[1]),
        type: text(row[2]),
        notNull: row[3] === "t",
        expression: row[4] === null ? null : text(row[4]),
        identity: text(row[5]),
        generated: text(row[6]),
        comment: row[7] === null ? null : text(row[7]),
        collation: row[8] === null ? null : text(row[8]),
      })
      columnsOf.set(table, list)
    }

    type ConstraintRow = {
      table: string
      name: string
      type: string
      definition: string
      refSchema: string | null
      refTable: string | null
      own: boolean
    }
    const constraintsOf = new Map<string, ConstraintRow[]>()
    for (const row of constraints.rows) {
      const table = text(row[0])
      const list = constraintsOf.get(table) ?? []
      list.push({
        table,
        name: text(row[1]),
        type: text(row[2]),
        definition: text(row[3]),
        refSchema: row[4] === null ? null : text(row[4]),
        refTable: row[5] === null ? null : text(row[5]),
        own: row[6] === "t",
      })
      constraintsOf.set(table, list)
    }

    const indexesOf = new Map<string, string[]>()
    for (const row of indexes.rows) {
      const table = text(row[0])
      let definition = text(row[1])
      const qualified = text(row[2])
      const bare = text(row[3])
      // The index is made on the copy, whichever way the server named the table.
      for (const name of [qualified, bare]) {
        const at = [` ON ONLY ${name} USING `, ` ON ${name} USING `].find((part) => definition.includes(part))
        if (at) {
          definition = definition.replace(at, at.replace(name, inTarget(table)))
          break
        }
      }
      indexesOf.set(table, [...(indexesOf.get(table) ?? []), definition])
    }

    // Keys to a table that is neither copied nor already in the target
    // would fail: they are left out and said so.
    const missing = new Set<string>()
    const elsewhere = new Map<string, boolean>()
    const reachable = async (schema: string, table: string): Promise<boolean> => {
      if (schema === from) return copied.has(table) || state.existing.has(table)
      const id = `${quote(schema)}.${quote(table)}`
      if (!elsewhere.has(id)) {
        const found = await target.query("SELECT to_regclass($1) IS NOT NULL", [id])
        elsewhere.set(id, found.rows[0]?.[0] === "t")
      }
      return elsewhere.get(id)!
    }

    const objects: SourceObject[] = []
    const sequences = new Set<string>()
    for (const rel of rels) {
      const kind = RELKIND[rel.relkind] ?? "table"
      if (rel.relkind === "f") {
        warnings.push(`${rel.name} is a foreign table and is not copied.`)
        continue
      }
      const name = inTarget(rel.name)
      const create: string[] = []
      const after: string[] = []
      const afterData: string[] = []

      if (kind !== "table") {
        const body = (rel.viewdef ?? "").trim().replace(/;\s*$/, "")
        create.push(
          kind === "view"
            ? `CREATE VIEW ${name} AS\n${body}`
            : `CREATE MATERIALIZED VIEW ${name} AS\n${body}\nWITH ${options.data ? "" : "NO "}DATA`
        )
        after.push(...(indexesOf.get(rel.name) ?? []))
        if (rel.comment) {
          after.push(`COMMENT ON ${kind === "view" ? "VIEW" : "MATERIALIZED VIEW"} ${name} IS ${literal(rel.comment)}`)
        }
        objects.push({
          name: rel.name,
          kind,
          rowEstimate: null,
          create,
          after,
          afterData,
          columns: [],
          readsData: false,
          dependsOn: [],
          overriding: false,
        })
        continue
      }

      const cols = columnsOf.get(rel.name) ?? []
      const parent = partitionOf(rel)
      const own = (constraintsOf.get(rel.name) ?? []).filter((con) => !parent || con.own)
      if (parent) {
        create.push(`CREATE TABLE ${name} PARTITION OF ${inTarget(parent)} ${rel.bound ?? "DEFAULT"}`)
      } else {
        /** Sequences of the copied schema its defaults count with, by the
         * column whose default is that and nothing else — a serial's. */
        const counters: { column: string; sequence: string }[] = []
        const lines = cols.map((column) => {
          let line = `  ${quote(column.name)} ${column.type}`
          if (column.collation) line += ` COLLATE ${column.collation}`
          if (column.generated === "s") {
            line += ` GENERATED ALWAYS AS (${column.expression}) STORED`
          } else if (column.identity) {
            line += ` GENERATED ${column.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`
          } else if (column.expression) {
            const expression = column.expression
            line += ` DEFAULT ${expression.replace(NEXTVAL, (whole, spelled: string) => {
              const ident = spelled.replace(/''/g, "'")
              if (!UNQUALIFIED.test(ident)) return whole
              const sequence = `${quote(to)}.${ident}`
              // Before the table; shared by several, made once.
              if (!sequences.has(sequence)) {
                sequences.add(sequence)
                create.push(`CREATE SEQUENCE IF NOT EXISTS ${sequence}`)
              }
              if (expression.trim() === whole) counters.push({ column: column.name, sequence })
              return `nextval(${literal(sequence)}::regclass)`
            })}`
          }
          if (column.notNull) line += " NOT NULL"
          return line
        })
        for (const con of own) {
          if (con.type !== "f") lines.push(`  CONSTRAINT ${quote(con.name)} ${con.definition}`)
        }
        create.push(
          `CREATE ${rel.unlogged ? "UNLOGGED " : ""}TABLE ${name} (\n${lines.join(",\n")}\n)` +
            (rel.partitionKey ? ` PARTITION BY ${rel.partitionKey}` : "")
        )
        // So the sequence goes when the table does, as a serial's would.
        for (const { column, sequence } of counters) {
          create.push(`ALTER SEQUENCE ${sequence} OWNED BY ${name}.${quote(column)}`)
        }
      }
      // Its sequences count on from the rows copied — the ones a table in
      // the target already had, rows added to it, too. None owned: null,
      // which setval passes over.
      if (options.data) {
        for (const column of cols) {
          if (column.identity || (column.expression && NEXTVAL_ONLY.test(column.expression.trim()))) {
            afterData.push(
              `SELECT setval(pg_get_serial_sequence(${literal(name)}, ${literal(column.name)}), coalesce(max(${quote(column.name)}), 0) + 1, false) FROM ${name}`
            )
          }
        }
      }
      if (parent) {
        for (const con of own) {
          if (con.type !== "f") after.push(`ALTER TABLE ${name} ADD CONSTRAINT ${quote(con.name)} ${con.definition}`)
        }
      }
      after.push(...(indexesOf.get(rel.name) ?? []))
      const dependsOn: string[] = []
      for (const con of own) {
        if (con.type !== "f" || !con.refSchema || !con.refTable) continue
        if (!(await reachable(con.refSchema, con.refTable))) {
          const ref = `${con.refSchema}.${con.refTable}`
          if (!missing.has(`${rel.name}>${ref}`)) {
            missing.add(`${rel.name}>${ref}`)
            warnings.push(`The foreign key ${con.name} of ${rel.name} points at ${ref}, which is not copied and not in the target: it is left out.`)
          }
          continue
        }
        after.push(`ALTER TABLE ${name} ADD CONSTRAINT ${quote(con.name)} ${con.definition}`)
        if (con.refSchema === from && copied.has(con.refTable) && con.refTable !== rel.name) {
          dependsOn.push(con.refTable)
        }
      }
      if (rel.comment) after.push(`COMMENT ON TABLE ${name} IS ${literal(rel.comment)}`)
      for (const column of cols) {
        if (column.comment) {
          after.push(`COMMENT ON COLUMN ${name}.${quote(column.name)} IS ${literal(column.comment)}`)
        }
      }

      objects.push({
        name: rel.name,
        kind,
        rowEstimate: rel.estimate !== null && rel.estimate >= 0 ? rel.estimate : null,
        create,
        after,
        afterData,
        columns: cols.filter((column) => column.generated !== "s").map((column) => column.name),
        readsData: !parent,
        dependsOn,
        overriding: cols.some((column) => column.identity === "a"),
      })
    }

    // Parents before their partitions.
    const depth = (name: string): number => {
      const rel = rels.find((item) => item.name === name)
      const parent = rel ? partitionOf(rel) : null
      return parent ? 1 + depth(parent) : 0
    }
    objects.sort((a, b) => depth(a.name) - depth(b.name))
    return { objects, prelude, warnings }
  },

  async createSchema(_source, _from, to) {
    return `CREATE SCHEMA ${quote(to)}`
  },

  drop(to, objects) {
    const statements: string[] = []
    for (const kind of ["materialized view", "view", "table"] as const) {
      const names = objects.filter((item) => item.kind === kind).map((item) => `${quote(to)}.${quote(item.name)}`)
      if (names.length) statements.push(`DROP ${kind.toUpperCase()} ${names.join(", ")}`)
    }
    return statements
  },

  truncate(to, names) {
    return names.length ? [`TRUNCATE ${names.map((name) => `${quote(to)}.${quote(name)}`).join(", ")}`] : []
  },

  async beginTarget(session, to) {
    await session.query("BEGIN")
    // Unqualified names in what the source printed — types, sequences,
    // tables a key or a view reads — are the target schema's.
    await session.query(`SET LOCAL search_path = ${quote(to)}, public`)
  },
  async enterSchema() {},
  async beginTable() {},
  async commitTable() {},

  async attempt(session, statements) {
    await session.query("SAVEPOINT copy_attempt")
    try {
      for (const statement of statements) await session.query(statement)
      await session.query("RELEASE SAVEPOINT copy_attempt")
      return null
    } catch (error) {
      await session.query("ROLLBACK TO SAVEPOINT copy_attempt")
      return error instanceof Error ? error : new Error(String(error))
    }
  },

  async finishTarget(session) {
    await session.query("COMMIT")
  },

  select(from, table, columns) {
    return `SELECT ${columns.map(quote).join(", ")} FROM ${quote(from)}.${quote(table)}`
  },

  insert(to, table, columns, rows, overriding) {
    let n = 0
    const tuples = Array.from(
      { length: rows },
      () => `(${columns.map(() => `$${++n}`).join(", ")})`
    )
    return (
      `INSERT INTO ${quote(to)}.${quote(table)} (${columns.map(quote).join(", ")})` +
      (overriding ? " OVERRIDING SYSTEM VALUE" : "") +
      ` VALUES ${tuples.join(", ")}`
    )
  },
}
