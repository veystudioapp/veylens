import { create } from "zustand"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

type Request = {
  title: string
  description: string
  action: string
  destructive?: boolean
  resolve: (ok: boolean) => void
}

const useConfirm = create<{ request: Request | null }>(() => ({
  request: null,
}))

/**
 * Asks before something that cannot be taken back, in the app's own dialog
 * rather than `window.confirm`. Resolves true only for the action button.
 */
export function confirm(options: Omit<Request, "resolve">): Promise<boolean> {
  useConfirm.getState().request?.resolve(false)
  return new Promise((resolve) =>
    useConfirm.setState({ request: { ...options, resolve } })
  )
}

export function ConfirmHost() {
  const request = useConfirm((state) => state.request)

  const settle = (ok: boolean) => {
    request?.resolve(ok)
    useConfirm.setState({ request: null })
  }

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) settle(false)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title}</AlertDialogTitle>
          <AlertDialogDescription>{request?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={request?.destructive ? "destructive" : "default"}
            onClick={() => settle(true)}
          >
            {request?.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
