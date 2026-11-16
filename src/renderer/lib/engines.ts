import type { ComponentType, SVGProps } from "react"

import type { Engine } from "@shared/api"

import { Files } from "@/components/ui/svgs/files"
import { MySQL } from "@/components/ui/svgs/mysql"
import { PostgreSQL } from "@/components/ui/svgs/postgresql"

export const ENGINE_LABEL: Record<Engine, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  duckdb: "Files",
}

export const ENGINE_LOGO: Record<Engine, ComponentType<SVGProps<SVGSVGElement>>> = {
  postgres: PostgreSQL,
  mysql: MySQL,
  duckdb: Files,
}
