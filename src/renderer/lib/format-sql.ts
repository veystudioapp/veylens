import { format, type KeywordCase, type SqlLanguage } from "sql-formatter"

import type { Engine } from "@shared/api"

const DIALECT: Record<Engine, SqlLanguage> = {
  postgres: "postgresql",
  mysql: "mysql",
  duckdb: "duckdb",
}

/** A statement laid out one clause to a line. What the formatter cannot parse
 * comes back as it was, since a statement shown untidy beats one not shown. */
export function formatSql(sql: string, engine?: Engine, keywordCase: KeywordCase = "preserve"): string {
  try {
    return format(sql, { language: engine ? DIALECT[engine] : "sql", tabWidth: 2, keywordCase })
  } catch {
    return sql
  }
}
