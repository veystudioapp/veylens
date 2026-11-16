import type { SVGProps } from "react"

/** A files connection: a sheet of cells with a folded corner, in green. */
export const Files = (props: SVGProps<SVGSVGElement>) => (
  <svg {...props} viewBox="0 0 24 24" fill="none">
    <path
      className="fill-emerald-50 stroke-emerald-600 dark:fill-emerald-950 dark:stroke-emerald-400"
      strokeWidth="1.5"
      strokeLinejoin="round"
      d="M6 2.75h8.5L19.25 7.5v12.25a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V4.25A1.5 1.5 0 0 1 6 2.75Z"
    />
    <path
      className="stroke-emerald-600 dark:stroke-emerald-400"
      strokeWidth="1.5"
      strokeLinejoin="round"
      d="M14.5 2.75V7.5h4.75"
    />
    <path
      className="stroke-emerald-600 dark:stroke-emerald-400"
      strokeWidth="1.25"
      d="M7.5 11h9M7.5 14h9M7.5 17h9M11 11v6"
    />
  </svg>
)
