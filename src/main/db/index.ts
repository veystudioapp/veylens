import { CloudSqlDriver } from "./cloud-sql"
import { MysqlDriver } from "./mysql"
import { PostgresDriver } from "./postgres"
import type { ConnectionConfig, Driver } from "./types"

export type { ConnectionConfig, Driver } from "./types"

export function createDriver(config: ConnectionConfig): Driver {
  if (config.cloudSql) return new CloudSqlDriver(config, config.cloudSql)
  return config.engine === "mysql"
    ? new MysqlDriver(config)
    : new PostgresDriver(config)
}
