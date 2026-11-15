import { Lock, PencilLine, ShieldCheck } from "lucide-react"
import type { ReactNode } from "react"

import type { AccessMode } from "@shared/api"

export const ACCESS_LABEL: Record<AccessMode, string> = {
  read_write: "Read & write",
  confirm: "Confirm writes",
  read_only: "Read only",
}

export const ACCESS_ICON: Record<AccessMode, ReactNode> = {
  read_write: <PencilLine className="size-3.5" />,
  confirm: <ShieldCheck className="size-3.5" />,
  read_only: <Lock className="size-3.5" />,
}

export const ACCESS_DETAIL: Record<AccessMode, string> = {
  read_write:
    "Edit rows, run any statement. The assistant still asks before every change.",
  confirm:
    "Every write — saving rows, a statement that changes data — asks first and shows what will run. For a database you want to be careful with.",
  read_only:
    "Browse and query only. Editing is off, writes are refused — by this app and by a session the server itself holds read-only — and the assistant cannot change anything.",
}
