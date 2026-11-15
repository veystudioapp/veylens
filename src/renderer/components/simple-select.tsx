import type { ReactNode } from "react"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

/**
 * A select over a fixed list, as Vey composes one: `items` maps each value
 * to the label shown for it, in the trigger and in the list alike.
 *
 * With a `heading`, the list is a menu below the trigger, headed by what is
 * being chosen and as wide as its words — as a toolbar's menus open — rather
 * than laid over the trigger, as a form's field does.
 */
export function SimpleSelect<Value extends string>({
  value,
  items,
  onChange,
  label,
  size = "sm",
  className,
  align,
  leading,
  heading,
}: {
  value: Value
  items: Record<Value, string>
  onChange: (value: Value) => void
  /** The accessible name — a select has no visible label of its own. */
  label: string
  size?: "sm" | "default"
  className?: string
  align?: "start" | "center" | "end"
  /** Drawn in the trigger before the value — an icon and a name. */
  leading?: ReactNode
  /** What is being chosen, over the list: "Chart type", "Split by". */
  heading?: string
}) {
  const options = (Object.keys(items) as Value[]).map((option) => (
    <SelectItem key={option} value={option}>
      {items[option]}
    </SelectItem>
  ))
  return (
    <Select
      value={value}
      items={items}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next as Value)
      }}
    >
      <SelectTrigger
        size={size}
        aria-label={label}
        className={cn("text-xs", className)}
      >
        {leading}
        <SelectValue />
      </SelectTrigger>
      {heading ? (
        <SelectContent
          align={align ?? "start"}
          alignItemWithTrigger={false}
          className="w-auto max-w-72 min-w-44"
        >
          <SelectGroup>
            <SelectLabel>{heading}</SelectLabel>
            {options}
          </SelectGroup>
        </SelectContent>
      ) : (
        <SelectContent align={align}>{options}</SelectContent>
      )}
    </Select>
  )
}
