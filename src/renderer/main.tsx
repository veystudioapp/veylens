import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import "./index.css"

/*
 * globals.css draws dark under `.dark` on <html>, as in Vey. There is no
 * appearance setting here, so the class follows the system and keeps
 * following it while the window is open.
 *
 * Azure rather than globals.css's indigo default; see index.css.
 */
document.documentElement.dataset.palette = "azure"

const dark = window.matchMedia("(prefers-color-scheme: dark)")
const followSystem = () =>
  document.documentElement.classList.toggle("dark", dark.matches)
followSystem()
dark.addEventListener("change", followSystem)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
