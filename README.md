# Vey Data

A desktop database explorer you can talk to. Connect to PostgreSQL or MySQL,
browse and edit tables like in any database client, and ask questions about
your data in plain language in the chat on the right — Claude reads the schema,
runs the SQL and shows what it found.

Electron + React, built the same way as [Vey](../vey): esbuild for the main
process, Vite for the renderer, one typed IPC contract between them, and
Vey's shadcn components (`base-nova` on Base UI) and stylesheet for the UI.

## Run it

```bash
bun install
bun run dev        # builds main, starts Vite, opens the window
```

The chat runs the `claude` CLI already on your machine, signed in as you
(install it and run `claude` once to log in). `CLAUDE_BIN` points it at a
custom install. Without it the explorer and viewer still work.

No database handy? `bun run demo:pg` starts a small sample Postgres on
`127.0.0.1:54329` (user `postgres`, password `postgres`, database `postgres`,
SSL off).

```bash
bun run test       # the Postgres driver against a real (in-process) Postgres
bun run typecheck
bun run build      # dist-electron/ + dist-renderer/
bun run package    # electron-builder → release/
```

## What it does

- **Explorer** — saved connections, their schemas, tables and views; search.
  A connection can be given a colour (red for production, say): its icon
  and its open tab carry it. Every kind of thing has its own colour across
  the app — tables blue, views teal, schemas amber, dashboards orange,
  business context green, SQL tabs pink (`lib/tones.tsx`, `--tone-*` in
  `index.css`).
- **Viewer** — tabs. A table tab pages, sorts and filters rows, and edits them:
  double-click a cell, add or delete rows, then **Save** (⌘S) applies
  everything in one transaction. Edits go through the primary key, so a table
  without one is read-only. A SQL tab runs whatever you type (⌘↵; with a
  selection, only the selection).
- **Formatted values** — as NocoDB or Airtable set them: a short value from a
  small set (a status, a category) as a coloured tag, emails and URLs as
  links (⌘-click opens a URL), a foreign key as a chip naming its table,
  decimals with grouped thousands, booleans as checkboxes, NULL as a mark.
  Read off the type, the name, the foreign keys and the values on screen
  (`lib/cell-format.ts`); only the drawing changes — an edit starts from the
  text the database printed, and the palette button in a table's toolbar
  turns it off everywhere. Images (an http(s) address ending in .png, .jpg…)
  show as thumbnails, which loads them from wherever they are hosted.
- **Field settings** — a column's menu › *Field settings…*, after NocoDB's
  field types and their options: Number (decimals 0–8, seven separator
  styles, 1.2K/3.4M abbreviation), Currency (code, locale, decimals,
  abbreviation), Percent (75 or 0.75 is 75%, as a bar or a ring), Date & time
  (NocoDB's 19 formats plus locale, relative and as-printed; HH:mm or
  HH:mm:ss; 12/24-hour; the zone a `timestamptz` is shown in), Duration,
  Single and Multi select (a colour per value), Checkbox and Rating (icon,
  colour, max), Progress, Email, Phone, URL, Image, Colour, Text — the ones
  that suit the column's kind — and a description shown as ⓘ in the header.
  The column a row is known by is picked by itself (a name, a title, an
  email). Kept per
  connection and table in `library.json` (`tableFields`); only the drawing
  changes.
- **Grid, after NocoDB** — 32px rows (the toolbar's fold button gives 25px),
  each column's icon by what it holds and a menu (sort, copy name), the
  row's name column in the accent, and a gutter that offers a checkbox and
  **Expand row**: the row as a form, field by field, editable, its edits
  pending with the table's until **Save**.
  Columns are measured once and held at that width (`table-layout: fixed`),
  so editing a cell or turning a page does not move them; drag a header's
  edge to resize, double-click it (or the menu's *Fit width to content*) to
  fit — dragged widths are kept per table in `localStorage`. A primary key
  is not typed into on a row that exists (the row is found by it), nor is a
  column the database numbers (identity, `nextval(…)` serial,
  AUTO_INCREMENT) on any row; a generated column never.
  **Filter** opens a popover over the grid: "Where …", then each row's own
  *and* / *or*, each condition's choices fitting its column (dates read as
  before/after, booleans as true/false). *and* binds before *or*, as in
  SQL; once both are used the popover reads the whole back with brackets —
  `(paid and VN) or total > 100`. **Add group** puts conditions in brackets
  with words of their own, one level deep. Both the WHERE and the read-back
  come from `combineFilters` in `shared/api.ts`. Nothing runs until
  **Apply** (or Enter); a word in a number column is marked and holds
  Apply back, and while there are unsaved edits Apply says it discards them. **Fields** shows and hides
  columns (searchable, Show all / Hide all, or *Hide field* in a column's
  menu); hidden columns are kept per table in `localStorage`, and a row
  opened as a form still has them all.
- **Calls as they are written** — a tool call is on screen from the model's
  first word of it, not once its input is whole: a spinner and what is coming
  ("Writing a statement — you will be asked before it runs"), and the SQL
  as it is written, read from the streamed partial JSON
  (`readPartialJson`, `shared/agent.ts`). The approval card takes its place
  with the input the CLI hands over, never the partial one.
- **`@` mentions in the chat** — `@` (or the @ button) opens a menu of the
  chat connection's tables and views, its dashboards and metrics, and the
  other connections. A mention is plain text — `@orders`, `@"Sales overview"`,
  `@archive.items` when two schemas share a name — tinted by a mirror behind
  the textarea, so one typed by hand works too. On sending, each is resolved
  (`findMentions`, `shared/mentions.ts`) and listed in the `<viewer>` block
  with what it is — schema, dashboard id and tiles, a metric's SQL, a
  connection's id — looked up again in main, so a deleted one is said to be gone.
- **Pictures in the chat** — paste a screenshot, drop images anywhere on the
  chat panel, or pick them with the picture button. Each is read as it
  arrives (too large is redrawn smaller) and written into the text as
  `[Image #n]`, the CLI's own tag, with a thumbnail above the field; deleting
  the tag or the thumbnail takes it out, and what is sent is renumbered
  (`attachedIn`, `shared/chat-images.ts`). It goes to the model as an image
  block; the transcript keeps a file per picture in `chat-images/`, deleted
  with its chat.
- **Audit log** (Settings › Data) — what was run, changed or refused
  through the app, newest first by day: statements from a SQL tab (reads
  and writes), saved row edits, the assistant's queries, statements, plans,
  dashboard and context changes (each with its chat), cards declined, calls
  the permissions or Settings refused, and edits to connections,
  permissions, tools, business context and deleted dashboards. Browsing a
  table and dashboards refreshing are not kept. Search, narrow by kind / who
  / connection, open an entry to its SQL and outcome, open it in a SQL tab
  or its chat, export CSV, clear. `audit.jsonl` in the data directory, one
  line per entry appended as it happens; the last 5,000 are kept
  (`main/audit.ts`). The assistant's are recorded in one place, as each
  tool call comes back (`Chats.keep`); yours in the IPC handlers.
- **Structure** — a page rather than a list: the table's kind, comment,
  estimated rows, size (and its indexes'), engine and collation; jump
  chips; columns with position, type, required / nullable, default (`auto`
  for serial, identity, AUTO_INCREMENT), comment, PK / unique badges and a
  column's foreign key as a link to its table, searchable; indexes with
  their columns, kind, method and size; keys & rules (primary, unique,
  check, foreign — with ON DELETE); **Referenced by** (the tables pointing
  here, each opening in a tab); and the DDL — `SHOW CREATE TABLE` on MySQL,
  rebuilt from the catalogue on Postgres (columns, constraints, the indexes
  no constraint makes, comments) — to copy or open in a query tab. From
  `Driver.details()`; tables hidden by the permissions are left out of
  Referenced by. MySQL's `DEFAULT_GENERATED` (a default that is an
  expression) no longer marks a column generated and read-only.
- **Connection dialog** — the engines as cards with their marks (from
  [svgl.app](https://svgl.app): `components/ui/svgs/postgresql.tsx`,
  `mysql.tsx`), a connection URL pasted to fill the fields
  (`postgres://user:pass@host:5432/db?sslmode=require`, `mysql://…`), the
  password shown on request, and the test's answer beside its button.
- **Chat** — a Claude Code session per conversation, given database tools and
  nothing else: no shell, no files, no web.

### Analysis

- **Charts** — the agent draws trends and breakdowns in the chat
  (`show_chart`: columns, ranked bars, line, area, a single figure). Every
  chart has a table view, opens in a SQL tab, and pins to a dashboard. A SQL
  tab's result can be charted by hand (Grid / Chart). Drawn as SVG in
  `Chart.tsx` to the dataviz method's specs; the palette is validated against
  this app's own surfaces (see `index.css`).
- **Business context** — per connection, under the connection in the
  explorer: Markdown notes on what the data means, and **metrics** (name,
  meaning, the SQL that computes it). The agent reads them before working
  with a connection and computes a defined metric with its SQL. It can
  propose a metric (`save_metric`) or a note (`append_note`); you approve each.
- **Skills** — Settings (gear, top right) › Skills: how the assistant does
  one kind of task. Three are built in (`src/shared/agent.ts`): *Build a
  dashboard*, *Diagnose a change*, *Choose a chart* — the methods the system
  prompt used to carry — and can be rewritten, switched off, and reset, not
  deleted. Your own ("weekly sales report", "how we write SQL here") have a
  name, when to use it, and Markdown instructions. They apply to every chat
  on every connection. The agent sees each enabled skill's name and
  description in every message's `<viewer>` block and reads the
  instructions with `get_skill` when a request matches; a change applies
  from the next message. Stored in `library.json`. Not used by SQL assist.
- **Settings** — Assistant (Skills, Tools) and Data (Permissions: each
  connection's access, below). A skill is edited with a Write / Preview of
  its Markdown; a tool's mode is coloured by what it means.
- **Tools** — Settings › Tools: each of the agent's tools set to **Allow**,
  **Ask** (an approval card first) or **Off** (refused, and the agent is
  told in the `<viewer>` block). Which modes a tool takes is fixed in
  `TOOL_CATALOG`: the schema tools are always on, and `execute_sql` /
  `execute_plan` are Ask or Off — never Allow. Off also applies to SQL
  assist.
- **SQL assist** — in a SQL tab: **Generate** from a description, **Explain**
  the statement (or the selection), **Fix** one that failed, and **Dry run**
  (the server's plan, nothing run). A one-shot `claude` with read-only tools,
  separate from the chat.
- **Plans** — a change that takes several statements goes through
  `execute_plan`: you review the whole list once, and it runs in one
  transaction (on MySQL, DDL still commits as it runs; the card says so).
- **Dashboards** — tiles on a 4-column grid (drag to reorder; width ¼–full,
  three heights), each a saved read-only query drawn as a chart, KPI,
  matrix, shaded table, or Markdown text; written and previewed in place.
  - **Filters** above the tiles reach the tiles' SQL as parameters; a
    clause in `[[ … ]]` is dropped while its filter is on All:
    - *Date range* (presets, or custom): `{{date_start}}`, `{{date_end}}`.
    - *Choice*, one value of a query's first column: `= {{country}}`.
    - *Multi-choice*, several: `IN ({{status}})`, one placeholder each.
    - *Text search*: `ILIKE {{q}}` (`LIKE` on MySQL), the words as a
      contains / starts-with pattern, `%` and `_` in them escaped — or exact.
    - *Number range*: `{{amount_min}}`, `{{amount_max}}`, both included,
      either open.
    - *Toggle*: `{{vip}}` is 1 for Yes, 0 for No (true/false to Postgres).

    Values are **bound** (`$1`, `?`), never spliced into the SQL; only a
    query opened for you to read (drill-down, "Open as query") has them
    written in, quoted. Edit filters: the list in the bar's order, each
    with its parameter name (from its label), its choices run, an example
    clause to copy, and which tiles use it.
  - **Click a category** to narrow every other tile that has the same
    column; **Show rows** runs the tile's drill-down SQL with `{{value}}`.
  - White cards on a grey desk; a tile's buttons show on hover. Figures are
    labelled by their title, charts fill their tile's height, and a text
    tile is a heading on the desk (a `\n` a model wrote as two characters
    is read as a line break). Filters are pills, tinted while they narrow.
  - **Edit tile**: the SQL (⌘↵ runs it; a filter's name is inserted at the
    caret) over the tile as the dashboard will draw it, at its width and
    height; width, height, the filters it uses and the drill-down beside.
  - Re-run on open, on Refresh, on a timer (1/5/15 min), and when the agent
    changes data. Export a tile as CSV; a drawn chart (bars, lines, areas)
    as PNG too. A tile shown as rows is a plain table that scrolls inside
    the tile's height. **Summarise** asks the
    assistant what stands out under the current filters.
  - The agent builds them the same way: `add_dashboard_filter`, then
    `add_to_dashboard` (with width, height, drill-down), and reads one with
    `get_dashboard`. It changes one in place: `edit_dashboard_tile` (title,
    SQL or text, chart or rows, size, drill-down, position — by the tile's
    number in `get_dashboard`) and `edit_dashboard` (title, refresh).
    `remove_from_dashboard` (a tile or a filter) and `delete_dashboard` wait
    for the user's yes on a card in the chat, like a saved metric.
- **More chart forms** — `kpi` (value, signed change against the previous
  period in status colours with an arrow, sparkline), `pivot` (a matrix
  shaded in one hue, with totals), `table` (numbers shaded by size),
  stacked bars and areas, and `series` for results in long form
  (`GROUP BY month, channel` → one line per channel; past eight, "Other").
- **Diagnosing a change** — the system prompt carries a method (confirm the
  change, decompose it by dimension and by driver, follow the biggest
  contributors, check the data itself, conclude with evidence) as the
  built-in *Diagnose a change* skill; the empty chat's *Diagnose a change…*
  puts a question to fill in into the composer.

## Access per connection

Each connection has an access mode, set in Settings › Permissions (the
connection's dialog says which it has and links there) and shown by an icon
in the explorer:

- **Read & write** — the default.
- **Confirm writes** — saving rows and any statement that does not start
  like a read ask first, showing what will run.
- **Read only** — editing is off and writes are refused, three times over:
  in the main process (`user-queries.ts`, the agent's write tools, and its
  approvals, which are denied before a card is shown), in the driver (which
  runs everything as a read), and on the server, whose sessions are opened
  with `default_transaction_read_only` (Postgres) or
  `SET SESSION TRANSACTION READ ONLY` (MySQL).

This is the app's own lock, on top of whatever the database user may do.
The assistant asks before every change in every mode.

### Permissions, finer

Open a connection in Settings › Permissions for more, on top of the access
mode (which stays the floor: Confirm writes raises Allow to Ask, Read only
blocks everything):

- **Statements** — Insert, Update, Delete and Change the schema (DDL, and
  calls whose effect cannot be read) each **Allow**, **Ask** or **Block**.
- **Schemas and tables** — a rule on a schema (`audit.*`) or a table:
  **Hidden** (not listed, not described, refused in any statement that names
  it; the assistant does not see it), **Read only**, or **Writable** (for a
  table inside a schema set otherwise). The most specific rule wins.
- **Guards** — refuse UPDATE/DELETE without WHERE; a most rows one write may
  change (past it the statement, script or plan is rolled back); a timeout
  per statement; a most rows a query returns.

Every driver is wrapped in a guard (`src/main/db/guarded.ts`), so the
explorer, table tabs, the SQL tab, dashboard tiles and the agent's tools all
meet the same rules; what is blocked is refused there, what asks is asked by
the renderer (a confirm) or the agent's approval card — and a blocked agent
write is refused before a card is shown. The agent is told the rules in its
`<viewer>` block. The SQL is read, not run (`src/shared/permissions.ts`: a
tokenizer that knows strings, quoted names, comments and dollar quotes; the
statement's kind; the tables after FROM, JOIN, INTO, UPDATE, TABLE…), so it
is best effort: a view, a function or dynamic SQL can reach a table whose
name is not in the text. The database user's grants remain the hard
boundary. On MySQL a plan's steps are not time-limited, and a row limit
cannot take back DDL, which MySQL commits as it runs (it changes no rows).

## How the agent is kept in its lane

- Its read tool (`run_query`) runs inside a `READ ONLY` transaction and refuses
  anything that does not start like a read.
- Its write tools (`execute_sql`, `execute_plan`) show you exactly what will
  run and wait for your answer; so do the ones that change what you wrote
  down (`save_metric`, `append_note`). Each approval is for that call with
  those arguments, and is also checked in this process, so a CLI configured
  to skip permission prompts fails closed instead of writing.
- A dry run of a write is an `EXPLAIN` in a read-only transaction (Postgres)
  or a plain `EXPLAIN` (MySQL, whose `EXPLAIN ANALYZE` — which runs the
  statement — is let through for reads only).
- A query it opens in the viewer is run read-only until you edit it.
- Results are capped (rows and size) before they reach the model.

## Layout

```
src/shared/api.ts      the IPC contract: types + channel names, nothing else
src/preload/index.ts   the bridge (`window.veydata`)
src/main/
  main.ts              window, wiring
  ipc.ts               one handler per contract method
  connections.ts       saved connections (passwords via the OS keychain)
  db/                  Driver interface; postgres.ts, mysql.ts, sql.ts
  chats.ts             conversations and the `claude` session behind each
  agent-tools.ts       the tools the agent is given (and the editor's helper)
  assist.ts            SQL assist: one-shot Generate / Explain / Fix
  library.ts           notes, metrics and dashboards (`library.json`)
src/shared/chart.ts    what can be charted, shared by the agent and the viewer
src/shared/params.ts   dashboard filters as SQL parameters; date presets
src/renderer/          React app: Explorer, Viewer (TableView, QueryView,
                       DashboardView, KnowledgeView), ChatPanel, Chart
  components/ui/       shadcn components, copied from Vey (`components.json`)
  styles/              Vey's globals.css + motion.css; app-only styles in index.css
```

Adding a call across the bridge means touching `api.ts`, the preload and
`ipc.ts` — the type on `DesktopApi` makes the compiler point at whichever one
was missed.

Data lives in Electron's `userData` directory (`VEYDATA_HOME` overrides it):
`connections.json`, `library.json` and `chats/`.

`bun run test` runs the drivers and the analysis features (tools, plans, dry
runs, library, chart rules) against an in-process Postgres.
