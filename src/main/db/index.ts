import os from "node:os"
import path from "node:path"

import { CloudSqlDriver } from "./cloud-sql"
import { FilesDriver } from "./files/driver"
import { MysqlDriver } from "./mysql"
import { PostgresDriver } from "./postgres"
import type { ConnectionConfig, Driver } from "./types"

export type { ConnectionConfig, Driver } from "./types"

export function createDriver(config: ConnectionConfig): Driver {
  if (config.engine === "duckdb") {
    return new FilesDriver({
      sources: config.sources ?? [],
      cacheRoot: config.cacheRoot ?? path.join(os.tmpdir(), "veylens-files"),
    })
  }
  if (config.cloudSql) return new CloudSqlDriver(config, config.cloudSql)
  return config.engine === "mysql"
    ? new MysqlDriver(config)
    : new PostgresDriver(config)
}
