import { inOrder, num, text, type CopyEngine, type Described, type ObjectKind, type SourceObject } from "./engine"

const quote = (name: string) => `\`${name.replace(/`/g, "``")}\``

/** A computed column, which is not written; DEFAULT_GENERATED only says the
 * default is an expression. */
const GENERATED = /\b(virtual|stored) generated\b/i

/**
 * MySQL to MySQL, the way mysqldump does it: tables made from SHOW CREATE
 * TABLE, rows read in one consistent snapshot, written with key checks off
 * and times in UTC. MySQL commits each CREATE as it runs, so a copy that
 * fails part-way keeps the tables it made; each table's rows go in as one
 * transaction.
 */
export const mysqlCopy: CopyEngine = {
  engine: "mysql",
  transactional: false,
  rowsPerInsert: () => 1000,
  // Well under max_allowed_packet, which is 4 MB on older servers.
  insertBytes: 1024 * 1024,
  quote,

  async beginSource(session) {
    await session.query("SET SESSION time_zone = '+00:00'")
    await session.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")
    try {
      await session.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
    } catch {
      // A server too old to say READ ONLY here.
      await session.query("START TRANSACTION WITH CONSISTENT SNAPSHOT")
    }
  },

  async inspectTarget(session, schema) {
    const [found, tables] = await inOrder([
      () => session.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?", [schema]),
      () => session.query("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ?", [
        schema,
      ]),
    ])
    return {
      schemaExists: found.rows.length > 0,
      existing: new Map(
        tables.rows.map((row) => [text(row[0]), (text(row[1]) === "VIEW" ? "view" : "table") as ObjectKind])
      ),
    }
  },

  async describe(source, _target, from, to, names, state): Promise<Described> {
    const [tables, columns, keys, views, triggers] = await inOrder([
      () => source.query(
        `SELECT table_name, table_type, table_rows FROM information_schema.tables
          WHERE table_schema = ? AND table_name IN (?)`,
        [from, names]
      ),
      () => source.query(
        `SELECT table_name, column_name, extra FROM information_schema.columns
          WHERE table_schema = ? AND table_name IN (?)
          ORDER BY table_name, ordinal_position`,
        [from, names]
      ),
      () => source.query(
        `SELECT table_name, constraint_name, unique_constraint_schema, referenced_table_name
           FROM information_schema.referential_constraints
          WHERE constraint_schema = ? AND table_name IN (?)`,
        [from, names]
      ),
      () => source.query(
        `SELECT table_name, view_definition, security_type, check_option FROM information_schema.views
          WHERE table_schema = ? AND table_name IN (?)`,
        [from, names]
      ),
      () => source.query(
        `SELECT COUNT(*) FROM information_schema.triggers
          WHERE event_object_schema = ? AND event_object_table IN (?)`,
        [from, names]
      ),
    ])

    const warnings: string[] = []
    const copied = new Set(tables.rows.map((row) => text(row[0])))
    const triggerCount = num(triggers.rows[0]?.[0]) ?? 0
    if (triggerCount) warnings.push(`Triggers (${triggerCount}) are not copied.`)

    const columnsOf = new Map<string, string[]>()
    for (const row of columns.rows) {
      if (GENERATED.test(text(row[2]))) continue
      const table = text(row[0])
      columnsOf.set(table, [...(columnsOf.get(table) ?? []), text(row[1])])
    }

    const dependsOf = new Map<string, string[]>()
    for (const row of keys.rows) {
      const table = text(row[0])
      const refSchema = text(row[2])
      const refTable = text(row[3])
      if (refSchema !== from) continue
      if (copied.has(refTable)) {
        if (refTable !== table) dependsOf.set(table, [...(dependsOf.get(table) ?? []), refTable])
      } else if (!state.existing.has(refTable)) {
        // Made anyway — key checks are off — but it points at nothing.
        warnings.push(
          `The foreign key ${text(row[1])} of ${table} points at ${refTable}, which is not copied and not in ${to}: rows added to ${table} later are refused until it is there.`
        )
      }
    }

    const viewOf = new Map(views.rows.map((row) => [text(row[0]), row]))
    const target = (name: string) => `${quote(to)}.${quote(name)}`
    const objects: SourceObject[] = []
    for (const row of tables.rows) {
      const name = text(row[0])
      if (text(row[1]) === "VIEW") {
        const view = viewOf.get(name)
        const definition = text(view?.[1])
        if (!definition) {
          warnings.push(`The definition of the view ${name} cannot be read (it needs SHOW VIEW): it is not copied.`)
          continue
        }
        const check = text(view?.[3])
        objects.push({
          name,
          kind: "view",
          rowEstimate: null,
          create: [
            `CREATE${text(view?.[2]) === "INVOKER" ? " SQL SECURITY INVOKER" : ""} VIEW ${target(name)} AS ` +
              // The server prints every table qualified by its database.
              definition.split(`${quote(from)}.`).join(`${quote(to)}.`) +
              (check && check !== "NONE" ? ` WITH ${check} CHECK OPTION` : ""),
          ],
          after: [],
          afterData: [],
          columns: [],
          readsData: false,
          dependsOn: [],
          overriding: false,
        })
        continue
      }
      const shown = await source.query(`SHOW CREATE TABLE ${quote(from)}.${quote(name)}`)
      const ddl = text(shown.rows[0]?.[1])
        // The copy counts on from its own rows.
        .replace(/\s+AUTO_INCREMENT=\d+/, "")
        .replace(/^CREATE TABLE `(?:[^`]|``)+`/, `CREATE TABLE ${target(name)}`)
      objects.push({
        name,
        kind: "table",
        rowEstimate: num(row[2]),
        create: [ddl],
        after: [],
        afterData: [],
        columns: columnsOf.get(name) ?? [],
        readsData: true,
        dependsOn: dependsOf.get(name) ?? [],
        overriding: false,
      })
    }
    return { objects, prelude: [], warnings }
  },

  async createSchema(source, from, to) {
    const found = await source.query(
      `SELECT default_character_set_name, default_collation_name
         FROM information_schema.schemata WHERE schema_name = ?`,
      [from]
    )
    const charset = text(found.rows[0]?.[0])
    const collation = text(found.rows[0]?.[1])
    return (
      `CREATE DATABASE ${quote(to)}` +
      (charset ? ` CHARACTER SET ${charset}` : "") +
      (collation ? ` COLLATE ${collation}` : "")
    )
  },

  drop(to, objects) {
    const statements: string[] = []
    const views = objects.filter((item) => item.kind !== "table").map((item) => `${quote(to)}.${quote(item.name)}`)
    const tables = objects.filter((item) => item.kind === "table").map((item) => `${quote(to)}.${quote(item.name)}`)
    if (views.length) statements.push(`DROP VIEW ${views.join(", ")}`)
    if (tables.length) statements.push(`DROP TABLE ${tables.join(", ")}`)
    return statements
  },

  truncate(to, names) {
    return names.map((name) => `TRUNCATE TABLE ${quote(to)}.${quote(name)}`)
  },

  async beginTarget(session) {
    await session.query("SET SESSION time_zone = '+00:00'")
    // Tables in any order, rows of a child before its parent's.
    await session.query("SET SESSION foreign_key_checks = 0")
    // A 0 in an AUTO_INCREMENT column is kept as 0, not given the next number.
    await session.query("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_AUTO_VALUE_ON_ZERO')")
  },

  async enterSchema(session, to) {
    // For the names SHOW CREATE TABLE printed unqualified: keys to tables
    // of the same database.
    await session.query(`USE ${quote(to)}`)
  },

  async beginTable(session) {
    await session.query("START TRANSACTION")
  },
  async commitTable(session) {
    await session.query("COMMIT")
  },

  async attempt(session, statements) {
    try {
      for (const statement of statements) await session.query(statement)
      return null
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  },

  async finishTarget() {},

  select(from, table, columns) {
    return `SELECT ${columns.map(quote).join(", ")} FROM ${quote(from)}.${quote(table)}`
  },

  insert(to, table, columns, rows) {
    const tuple = `(${columns.map(() => "?").join(", ")})`
    return `INSERT INTO ${quote(to)}.${quote(table)} (${columns.map(quote).join(", ")}) VALUES ${Array.from(
      { length: rows },
      () => tuple
    ).join(", ")}`
  },
}
