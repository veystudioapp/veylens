import {
  CheckIcon,
  ChevronDownIcon,
  RefreshCw,
  Settings2,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Star,
} from "lucide-react"
import { useState, type ComponentProps, type ReactNode } from "react"

import { chatEfforts, type AgentModel, type ChatEffort } from "@shared/api"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Claude } from "@/components/ui/svgs/claude"
import {
  defaultModelAlias,
  effortFor,
  isReloadingModels,
  orderedModels,
  reloadAgentModels,
} from "@/lib/models"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

export const EFFORT_LABELS: Record<ChatEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
}

/**
 * One control in the composer's toolbar — Vey's `ToolbarButton`. A word
 * rather than an icon alone, since "which model" is not a question a glyph
 * answers. Everything it is not asked about goes to the button, `ref`
 * included, which is what lets it be a menu's trigger.
 */
export function ToolbarButton({
  icon,
  label,
  on,
  className,
  ...rest
}: {
  icon: ReactNode
  label: string
  /** Something chosen: the control stops being the untouched grey. */
  on?: boolean
} & ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-[0.7rem] whitespace-nowrap",
        "transition-colors hover:bg-accent hover:text-foreground",
        "data-[popup-open]:bg-accent data-[popup-open]:text-foreground",
        "[&>svg]:size-3.5 [&>svg]:shrink-0",
        on ? "text-foreground" : "text-muted-foreground",
        className
      )}
      {...rest}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

/** The same menu's trigger in a form: drawn as the form's selects are, with
 * the model and its effort on it. */
function FieldButton({
  icon,
  label,
  className,
  ...rest
}: {
  icon: ReactNode
  label: string
} & ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-input bg-transparent pr-2 pl-2.5 text-xs whitespace-nowrap transition-colors outline-none select-none",
        "hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[popup-open]:border-ring dark:bg-input/30 dark:hover:bg-input/50",
        "[&>svg]:size-3.5 [&>svg]:shrink-0",
        className
      )}
      {...rest}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <ChevronDownIcon className="size-4! text-muted-foreground" />
    </button>
  )
}

/** The row for no model of its own: `Inherit` in the chat, "Same as the
 * chat" for a task that follows it. */
export type NoModelRow = { label: string; description: string }

const INHERIT: NoModelRow = {
  label: "Inherit",
  description: "Use the model in your Claude Code settings",
}

function EffortIcon({ effort }: { effort: ChatEffort }) {
  if (effort === "low") return <SignalLow />
  if (effort === "medium") return <SignalMedium />
  if (effort === "high") return <SignalHigh />
  // `xhigh` and `max` are both four bars; the word tells them apart.
  return <Signal />
}

function RowLabel({
  entry,
  alias,
}: {
  entry: AgentModel
  alias: string | null
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="truncate text-xs font-normal">{entry.label}</span>
      {/* `Default (recommended)` names no model, so the row says which one
          it is standing for. */}
      {entry.value === "default" && alias && (
        <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
          {alias}
        </span>
      )}
      {entry.isNew && (
        <span className="rounded border border-muted-foreground/40 px-1 py-[0.5px] text-[0.5625rem] leading-tight font-semibold tracking-tight text-muted-foreground uppercase">
          New
        </span>
      )}
    </div>
  )
}

function Tick({ shown }: { shown: boolean }) {
  return (
    <div className="flex size-4 shrink-0 items-center justify-center">
      {shown && <CheckIcon className="size-3.5 text-foreground" />}
    </div>
  )
}

/**
 * `--model` and `--effort`, out of the list the user's own `claude` answered
 * with — Vey's `ModelMenu`. A model that takes an effort opens a submenu of
 * its levels; one that takes none is picked outright. `Inherit` is last and
 * is the one row that is not a model: it passes no `--model` at all.
 *
 * The digits pick the row with that number, as in the CLI's own picker.
 */
export function ModelMenu({
  models,
  model,
  effort,
  onPick,
  variant = "toolbar",
  none = INHERIT,
  label,
  className,
}: {
  models: AgentModel[]
  model: string | null
  effort: ChatEffort | null
  onPick: (model: string | null, effort: ChatEffort | null) => void
  /** The composer's toolbar, or a form — Settings, which it also links to
   * from the toolbar. */
  variant?: "toolbar" | "field"
  /** What the row for a null model says. */
  none?: NoModelRow
  /** The trigger's accessible name. */
  label?: string
  className?: string
}) {
  const rows = orderedModels(models)
  const chosen = rows.find((entry) => entry.value === model)
  const alias = defaultModelAlias(models)
  // Held only so the digit shortcuts can close it.
  const [open, setOpen] = useState(false)
  const reloading = isReloadingModels()
  const openSettings = useStore((state) => state.openSettings)

  // The toolbar names the model that answers, not the row that asked for it.
  const nameOf = (entry: AgentModel) =>
    entry.value === "default" ? (alias ?? entry.label) : entry.label

  const buttonLabel =
    model === null
      ? none.label
      : chosen
        ? effort && chatEfforts(models, model).includes(effort)
          ? `${nameOf(chosen)} · ${EFFORT_LABELS[effort]}`
          : nameOf(chosen)
        : model

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          variant === "field" ? (
            <FieldButton
              icon={<Claude />}
              label={buttonLabel}
              aria-label={label ?? "Model"}
              className={className}
            />
          ) : (
            <ToolbarButton
              icon={<Claude />}
              label={buttonLabel}
              title="Model"
              on={model !== null}
              className={className}
            />
          )
        }
      />
      <DropdownMenuContent
        align={variant === "field" ? "end" : "start"}
        side={variant === "field" ? "bottom" : "top"}
        className="w-72"
        onKeyDown={(event) => {
          const at = Number(event.key)
          if (!at || at > rows.length) return
          event.preventDefault()
          const target = rows[at - 1]!
          onPick(
            target.value,
            effortFor(chatEfforts(models, target.value), effort)
          )
          setOpen(false)
        }}
      >
        {rows.map((entry) => {
          const levels = chatEfforts(models, entry.value)
          const isSelected = model === entry.value

          if (levels.length > 0) {
            return (
              <DropdownMenuSub key={entry.value}>
                <DropdownMenuSubTrigger
                  onClick={() => onPick(entry.value, effortFor(levels, effort))}
                  className="flex cursor-pointer items-center gap-2 px-2 py-1.5"
                >
                  <Tick shown={isSelected} />
                  <RowLabel entry={entry} alias={alias} />
                  {isSelected && effort && (
                    <span className="text-[0.6875rem] font-normal text-muted-foreground/80">
                      {EFFORT_LABELS[effort]}
                    </span>
                  )}
                  {entry.isFavorite && (!isSelected || !effort) && (
                    <Star className="size-3.5 shrink-0 text-muted-foreground/70" />
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-36">
                  {levels.map((level) => (
                    <DropdownMenuItem
                      key={level}
                      onClick={() => onPick(entry.value, level)}
                      className="flex cursor-pointer items-center justify-between px-2 py-1.5 text-xs"
                    >
                      <span className="flex items-center gap-1.5">
                        <EffortIcon effort={level} />
                        {EFFORT_LABELS[level]}
                      </span>
                      {isSelected && effort === level && (
                        <CheckIcon className="size-3.5 text-foreground" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          }

          return (
            <DropdownMenuItem
              key={entry.value}
              onClick={() => onPick(entry.value, null)}
              className="flex cursor-pointer items-center gap-2 px-2 py-1.5"
            >
              <Tick shown={isSelected} />
              <RowLabel entry={entry} alias={alias} />
              {entry.isFavorite && (
                <Star className="size-3.5 shrink-0 text-muted-foreground/70" />
              )}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onPick(null, null)}
          className="flex cursor-pointer items-center gap-2 px-2 py-1.5"
        >
          <Tick shown={model === null} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs font-normal">{none.label}</span>
            <span className="truncate text-[0.625rem] text-muted-foreground">
              {none.description}
            </span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* The menu stays open so the new rows land in front of whoever
            asked for them. */}
        <DropdownMenuItem
          closeOnClick={false}
          disabled={reloading}
          onClick={() => void reloadAgentModels()}
          className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
        >
          <div className="flex size-4 shrink-0 items-center justify-center">
            <RefreshCw className={cn("size-3.5", reloading && "animate-spin")} />
          </div>
          {reloading ? "Reloading models…" : "Reload models"}
        </DropdownMenuItem>
        {variant === "toolbar" && (
          <DropdownMenuItem
            onClick={() => openSettings("ai")}
            className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
          >
            <div className="flex size-4 shrink-0 items-center justify-center">
              <Settings2 className="size-3.5" />
            </div>
            Model settings…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
