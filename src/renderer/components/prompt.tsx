import { useEffect, useState } from "react"
import { create } from "zustand"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

type Request = {
  title: string
  label: string
  initial?: string
  action: string
  resolve: (value: string | null) => void
}

const usePrompt = create<{ request: Request | null }>(() => ({ request: null }))

/** One line of text, asked for in the app's own dialog. Null when cancelled. */
export function promptText(
  options: Omit<Request, "resolve">
): Promise<string | null> {
  usePrompt.getState().request?.resolve(null)
  return new Promise((resolve) =>
    usePrompt.setState({ request: { ...options, resolve } })
  )
}

export function PromptHost() {
  const request = usePrompt((state) => state.request)
  const [value, setValue] = useState("")

  useEffect(() => {
    setValue(request?.initial ?? "")
  }, [request])

  const settle = (result: string | null) => {
    request?.resolve(result)
    usePrompt.setState({ request: null })
  }

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) settle(null)
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (value.trim()) settle(value.trim())
          }}
        >
          <DialogHeader>
            <DialogTitle>{request?.title}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            aria-label={request?.label}
            placeholder={request?.label}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => settle(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              {request?.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
