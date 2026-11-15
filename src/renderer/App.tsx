import { useEffect, useState } from "react"

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePanelRef,
} from "@/components/ui/resizable"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useStore } from "@/lib/store"

import { ChatPanel } from "./components/ChatPanel"
import { ConfirmHost } from "./components/confirm"
import { PromptHost } from "./components/prompt"
import { ConnectionDialog } from "./components/ConnectionDialog"
import { Explorer } from "./components/Explorer"
import { SettingsDialog } from "./components/SettingsDialog"
import { Viewer } from "./components/Viewer"

export function App() {
  const init = useStore((state) => state.init)
  const ready = useStore((state) => state.ready)
  const dialog = useStore((state) => state.dialog)
  const explorer = usePanelRef()
  const chat = usePanelRef()
  const [explorerOpen, setExplorerOpen] = useState(true)
  const [chatOpen, setChatOpen] = useState(true)
  const settings = useStore((state) => state.settings)
  const openSettings = useStore((state) => state.openSettings)

  useEffect(() => {
    void init()
  }, [init])

  const toggle = (panel: typeof explorer) => {
    if (panel.current?.isCollapsed()) panel.current.expand()
    else panel.current?.collapse()
  }

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full flex-col bg-sidebar">
        {/* Until the panels are drawn there is no header to hold the window
            by; this stands in for it. */}
        {!ready && <div className="drag-region h-11 shrink-0" />}

        {ready && (
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
            <ResizablePanel
              id="explorer"
              panelRef={explorer}
              defaultSize={264}
              minSize={208}
              maxSize={480}
              collapsible
              collapsedSize={0}
              onResize={(size) => setExplorerOpen(size.inPixels > 1)}
            >
              <Explorer
                onCollapse={() => explorer.current?.collapse()}
                onSettings={() => openSettings("skills")}
              />
            </ResizablePanel>
            <ResizableHandle className="w-1.5 bg-transparent" />
            <ResizablePanel id="viewer" minSize={320}>
              <Viewer
                explorerOpen={explorerOpen}
                chatOpen={chatOpen}
                onShowExplorer={() => toggle(explorer)}
                onShowChat={() => toggle(chat)}
              />
            </ResizablePanel>
            <ResizableHandle className="w-1.5 bg-transparent" />
            <ResizablePanel
              id="chat"
              panelRef={chat}
              defaultSize={440}
              minSize={320}
              maxSize={760}
              collapsible
              collapsedSize={0}
              onResize={(size) => setChatOpen(size.inPixels > 1)}
            >
              <ChatPanel onCollapse={() => chat.current?.collapse()} />
            </ResizablePanel>
          </ResizablePanelGroup>
        )}

        {dialog && <ConnectionDialog dialog={dialog} />}
        {settings && (
          <SettingsDialog
            section={settings}
            onSection={openSettings}
            onClose={() => openSettings(null)}
          />
        )}
        <ConfirmHost />
        <PromptHost />
      </div>
    </TooltipProvider>
  )
}
