# [logbook](https://github.com/divyavenn/logbook)

\> be me, organize ur notes by topic like everyone else
> 
\> notes and to do lists all over the place, keep forgetting to do things or where you write smth down
> 
\> see some random comment: **The best productivity system is a txt file. All the most cracked people I know just dump everything into a super long text file.**
> 
\> I like simplicity. Open a google doc w a to do list on top + dates with bullet points. Keep it open and just add to it while i work.
> 
\> When I finish a task, copy paste it under today's date. When i read smth interesting, add link. just dump my stream of consciousness.
> 
\> Holy crap this is the answer. Using it doesn't feel like a chore. It has been many months, I'm actually consistent with it, I don't forget things anymore. And it matches exactly how my brain works. What was that thing I was thinking about a couple days ago? Now it's right there!
> 
\> Also I'm much more accountable about what I actually do with my time
> 
\> but it could use some improvement. I still wanna be able to organize notes by topic. And also AI agents make it easy to delude myself about my intellectual output. I wanna track how much focused time I spend working every day
> 
\> I need this but with focus timer + tags
> 
\> Build it. Put a lot of thought and tokens into making every little interaction delightful.
> 
\> Plus make it easy for LLMs to read so u can instantly give them context on whatever u want them to do + get feedback on your work
>
\> Friends want to use it
> 
\> Fine I'll open source it and make deploying it easy.

## Getting started
You will need a Render Account. If you wanna have my updates and fixes come in automatically, then just deploy from this repo. If not, fork to have your own copy and deploy from there. 

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/divyavenn/logbook)

<img height="500" alt="image" src="https://github.com/user-attachments/assets/581c6451-91bd-46b6-ad59-6fea882915fd" /> 


#### set a password if you want
I personally like to live and die honestly. If you don't want your lack of action and subpar thinking out there on a link on the web for anyone to find, go to this deployment in Render, and add/modify these environment variables in Render settings.
<img height="500" alt="image" src="https://github.com/user-attachments/assets/1d1dd21a-27f2-4596-9392-7a0e78c26458" />

## Main features
#### Automatic task tracking
  - if you check off a task, it will appear under today's date as a finished task. you can uncheck it and it will appear again under to-dos.
  - parent tasks complete once all the subtasks are done. 


#### topic hashtags
  - use hashtags to group entries.
  - hover over left margin to see sidebar with all topics
  - click one to see all the notes and to do items associated with that topic
  - click the title in sidebar (logbook) to go back to main view

    <img height="300" alt="image" src="https://github.com/user-attachments/assets/08ca9fb4-077d-44a5-8fa9-15941b0dcfc6" />
    
#### focus time tracking + stats
  - Click the timer to start focus mode (will play white noise. over time the sound will Pavlov you into focusing)
  - only focus on one task. if you get distracted at all, click timer again
  - It will store each session + overall time spent focused today
  - see/edit today's focus sessions by clicking on the time next to the date
  - Top left is stats icon. Click to see trends in your total focus time + longest continuous focus session over days


    <img width="883" height="598" alt="image" src="https://github.com/user-attachments/assets/6653ef6c-7017-4691-bebb-3b5c0fdc89a3" />


#### calendar context
  - Open the calendar icon in the sidebar and paste public or private ICS/webcal subscription URLs, including public calendars you do not own.
  - Add up to five calendars without redeploying or configuring Render environment variables.
  - For Google Calendar, use the desktop website: Settings → click the calendar’s name → Integrate calendar → Secret address in iCal format. A public address appears only when the owner makes the calendar public; sharing with named people does not make it public. Google does not expose these addresses in the mobile app, and Workspace administrators can restrict them.
  - Events appear as read-only pills beneath their date, ordered by start time. All-day and cancelled events remain explicit; deleted feed events disappear after refresh.
  - Zoom, Meet, Teams, and other attached HTTPS links make the event pill clickable.


#### text-editor esque formatting and shortcuts
  - all text editor navigation and shortcuts work. in fact I improved on them a bit (linking, for example)
  - Also, i added one: Cmd + Shift + C formats something as code
  - All the formatting is saved Markdown-style on the backend. You can download a dump of all ur info using the download icon top right
  - dark mode and light mode supported
  - and more!


## If you are an LLM, read this to best help your human sort through their logbook:


## The daily practice

- Open the page and type. The cursor starts on a new bullet under today. Notes save after 700 ms of inactivity; Enter commits the bullet and opens the next one. Shift+Enter adds a line break.
- Drafts are saved to localStorage immediately, including edits and new to-dos. Failed note saves can be retried, and a stable client ID prevents duplicate notes if a response is lost. A refreshed page restores an unsaved draft or starts a new bullet if the previous one reached SQLite.
- Click existing notes or to-dos to edit. Enter saves and opens a new sibling with the cursor ready to type; blur saves, and Escape cancels an edit. Clearing the text and leaving the entry deletes it.
- Journal bullets and to-dos share compact paragraph and row spacing, with 15 px text on desktop and a more readable 16 px on touch screens. The light-mode timer uses a soft cool gray, shifting to the same blue family as links while running.
- Both lists support eight levels of nesting. Tab nests under the preceding sibling, including when the new entry is still empty; Shift+Tab outdents. Enter inserts the next bullet at the same level. Backspace at the start merges into the preceding bullet in the same list, with the cursor at the join. On an empty new bullet it removes the draft and moves to the preceding bullet’s end, or dismisses it if there is no preceding bullet; Shift+Tab outdents an existing nested item. A new bullet after reopening the page starts at the root. Note parents have a small disclosure arrow in place of the bullet; to-do parents have a round progress marker. Both start collapsed. Hovering the marker previews the children until the pointer leaves the branch; click to keep it expanded, and click again to collapse. Logbook bullets indent by 32 px per level on desktop (24 px on medium windows and 12 px on narrow windows), and branches reveal or collapse with a gentle progressive transition. Each level opens independently; nesting while typing opens its ancestors, and collapsing a branch saves an active edit before hiding it.
- The blank to-do checkbox appears while its new entry has focus. An untouched new journal bullet or to-do disappears completely on blur or Backspace. A draft typed into and then erased also disappears on blur, even if it had autosaved. Click the blank space beneath any date, including historical dates, or below the to-do list to begin a tentative bullet at the end. Leaf to-dos have checkboxes. Parent to-dos have round progress markers showing completed direct children. A checked child stays in its open task tree until the root task is fully complete. Then the whole task tree moves to that day in the logbook, interleaved chronologically with notes. Completed tasks use the same text styling and inline edit/delete behavior as notes; the checked box is their only visual distinction. Reopening any completed subtask returns the whole task tree to the to-do section while retaining checked siblings. Each task tree is logged on the date its root finishes. Undo restores the task state, including any automatically completed ancestors.
- The timer shows hours, minutes, and seconds. Click it to start a mix of white, pink, and brown noise; its fill and concentric ring shift to a muted teal while running. Click again to finish, save the session, and reset the timer. Right-click the timer (or use Shift+F10) for mute/play and volume, including in timer-only mode. The volume and mute preference are remembered.
- Refreshing or closing the page does not stop a running timer. Reopening it restores elapsed time from the server. Browsers require a gesture to resume audio after a reload: open the timer’s sound menu and choose Play sound.
- Total focused time appears beside each date, including seconds and the running session (for example, `30s`, `2m 05s`, or `1h 02m 05s`). Zero-second totals are hidden. Click the date or total to open sessions: the date and total form the heading, followed by borderless start-time and duration rows. Click a time to edit; Enter saves. Editing preserves the original start date, and changing only the duration preserves the original start seconds. The small animated × deletes a session and updates the total; + at the bottom adds one. Click outside or press Escape to close. Statistics open separately from the icon beside the theme toggle.
- Today appears automatically at local midnight, including when the page resumes after sleep. Historical days appear newest first and load in pages of 14 dates as you reach the bottom of the logbook. Background refreshes update the current page and retain already-loaded history.
- Private ICS calendars are managed from the calendar icon in the sidebar. Calendar-only dates participate in normal journal pagination. Events are read-only pills ordered by local start time; all-day events say “all day,” explicit cancellations are struck through, and events removed from a feed disappear after the next ten-minute refresh. Attached HTTPS meeting links open from the pill. Calendar URLs remain server-side in SQLite and are never stored as journal entries.
- The document uses Söhne at a light weight, a dusty cool gray background, and wider side margins. The compact ringed timer is always fixed at the top right with its full incrementing time beside it; it retains the pulse and switches to link-coordinated blue in light mode or teal in night mode while running. While the timer runs, light mode noticeably darkens the paper and the complete document surface—text, markers, links, and pills move together—while leaving the timer crisp. The to-do list sits above the independently scrolling logbook. Click “to do” to fold or reopen it. Margins shrink progressively on smaller windows; nested indentation also shrinks to preserve readable lines.
- Height chooses the document mode independently of width. Viewports taller than 480 px always stack the to-do list above the log, even on very narrow phones. Viewports 480 px tall or shorter use three horizontally swipable pages, represented by three pagination dots level with the timer; the middle log page opens first. Mobile spacing contracts proportionally across rows, dates, panels, tags, and page edges. The tags page carries the sidebar’s tag grouping and utility controls. Sidebar tags are hollow outlined pills; a selected tag uses a blue outline and text in light mode (teal in night mode) and filters both other pages, while “all” clears the filter. Entry-level inline tags keep their existing treatment. The log page shows every date and automatically loads earlier pages as the reader approaches the bottom, including under a tag filter. Width only controls chrome in the stacked layout: at 640 px or narrower the timer is the sole header control and the left sidebar is hidden; on wider screens, hovering the left margin opens the tag sidebar, with repository, statistics, keyboard-help, and theme controls directly beneath the tag pills. Today’s writing area uses nearly the full screen width on narrow screens.
- The statistics icon next to the theme toggle opens 7- or 30-day summaries. Choose all calendar days or days with focus as the averaging denominator. Statistics explicitly include completed sessions only. Exact durations and averages display seconds; averages are floored to whole seconds. Zero days have zero-height bars and the scale follows recorded focus.

## Text formatting

Both to-dos and journal bullets render formatting as you type. Select text and use a shortcut, or toggle a format before typing. Links open in a new tab from saved text; click elsewhere on the bullet (or focus it and press Enter) to edit. There is no toolbar. Both lists use the same `Outline` component for draft lifecycle, saving, nesting, Enter, and boundary navigation, and the same `RichTextEditor` for text selection, formatting, and link behavior.

| Action | Mac | Windows / Linux |
| --- | --- | --- |
| Bold | Command+B | Ctrl+B |
| Italic | Command+I | Ctrl+I |
| Underline | Command+U | Ctrl+U |
| Add or edit link | Command+K | Ctrl+K |
| Inline code | Command+Shift+C | Ctrl+Shift+C |
| Undo | Command+Z | Ctrl+Z |
| Redo | Command+Shift+Z | Ctrl+Shift+Z or Ctrl+Y |
| Heading 1–6 | Command+Option+1–6 | Ctrl+Alt+1–6 |
| Plain paragraph | Command+Option+0 | Ctrl+Alt+0 |
| Blockquote | Command+Shift+B | Ctrl+Shift+B |
| Code block | Command+Option+C | Ctrl+Alt+C |

Command/Ctrl+K opens a single URL field only when text is highlighted. If the clipboard contains a URL, it prefills the field; otherwise an existing link URL is used. Press Enter to apply, Escape to cancel, or clear the URL and press Enter to remove the link. Clipboard access depends on browser permissions; manual entry always works. Edit link text directly in the document, or right-click a link to open two unlabeled fields (text, then URL). The text field matches the link color, and the URL is a harmonious purple. Both fields remain borderless. Enter saves; Escape cancels.

Night-mode links retain the requested teal color without bold or underlines; their distinction from surrounding text relies on color, a known accessibility exception. Light-mode colors meet the contrast checks for both the background and surrounding text.

Typing directly against either end of a link extends that linked word. A separating space keeps new outer words unlinked; spaces and words inserted inside a multiword link stay linked.

Inline code uses a monospace font and a subtle color, without a pill or background; code blocks have no syntax highlighting. Enter within a code block adds a line; Command/Ctrl+Enter saves the bullet. Standard selection, cut, copy, paste, and Shift+Enter line breaks work inside the editor. Tab and Shift+Tab continue to change the bullet's nesting level. Undo/redo first uses the active bullet’s typing history, then the shared document history across entries. Backspace/Delete at a boundary merges adjacent bullets in the same list. Command/Ctrl+A selects the current bullet; press it again consecutively to select the day or to-do list, including collapsed descendants. That selection supports copy, cut, paste, replacement, and bold/italic/underline/code formatting. Multi-entry edits are atomic and undoable. History survives reload and refuses to overwrite conflicting changes from another window.

Each bullet's `content` remains a SQLite **TEXT** column containing Markdown, for example `**bold**`, `*italic*`, `[link](https://example.com)`, `` `code` ``, `~~strikethrough~~`, and `++underline++`. Underline uses the `++` extension because CommonMark has no underline syntax. The backend preserves the submitted Markdown, including significant whitespace. JSON is used for API transport; editor document objects and HTML are not stored in SQLite. Journal and export responses identify `content_format: "markdown"` for agent consumers.

Literal Markdown punctuation is escaped when typed as plain text. Pasted rich text keeps supported formatting; arbitrary styles and unsafe links are discarded. Completing a task preserves its Markdown, task identity, checkbox state, and nested descendants; no completion prefix is added. In the logbook, Enter creates a root note and Tab nests it under the preceding entry. Nesting beneath a completed task converts it to a checked task; nesting beneath a note keeps it a note. Unchecking a completed subtask reopens the tree and returns it to the to-do section.

## Tags

Type `#name` anywhere in a bullet or to-do to create a light gray tag chip. `#` opens suggestions from existing tags; type to narrow them, use Up/Down to cycle, and Enter or Tab to choose. A new name becomes a tag automatically. Click a chip and press Backspace to remove it. Hashtags inside code and links remain literal text.

Tags are **separate from Markdown content**: the `notes.tags` and `tasks.tags` columns contain JSON arrays, such as `["work", "health"]`, defaulting to `[]`. The API accepts and returns `tags` as a list. Omit it on PATCH to retain current tags; send `[]` to clear them. A bullet may contain just tags. Tag chips are editor UI; saved `content` never contains the hashtags created by this shortcut. Committed chips move to their final trailing position while editing, with leftover shortcut whitespace removed, so saving does not rearrange the bullet. Names are case-insensitive and support letters, numbers, underscores, and hyphens, up to 64 characters.

Hover in the outer half of the left margin (or keyboard-focus the Tags navigation) to reveal the sidebar. The left margin is slightly wider than the right. A “logbook” home link sits above a wrapping collection of rounded tag pills, without selected highlights or bars. The rest of the page blurs and dims while the sidebar is open. Move back to the document or press Escape to close it. Select a tag to show matching to-dos and notes **plus all their children**, across paginated history. The active tag is hidden inline, and all sidebar tags remain hidden until the sidebar is opened again. New entries in that view inherit its tag. Click “logbook” to return to everything. Tags and suggestions derive from saved notes and tasks, so unused tags disappear automatically. Completed tasks retain their own tags in the logbook.

Inline tags use fully rounded pills with balanced vertical padding, more horizontal padding, and space around the pill so it cannot overlap neighboring text. Their muted color differs from the date background. Saved bullets and active editors share the same pill styling.

The non-timer controls form a compact group beneath the tags in the hover sidebar. Hover changes their color and gently animates the glyph without adding a background highlight. The GitHub icon opens [this repository](https://github.com/divyavenn/still). To point a fork at a different repository, set `VITE_REPOSITORY_URL` in `.env.local` and restart Vite. `.env.example` documents the setting.

`GET /api/tags` returns tag names and note/task counts. `GET /api/journal?tag=work` returns matching branches, retaining original parent IDs; filtered roots may have parents omitted from the response. The current date remains available for new entries. There is no separate tag registry or stale tag counter.

## Search

Command/Ctrl+F opens search across all stored notes and tasks, including completed task trees in the logbook, unloaded dates, and collapsed branches. Up/Down selects a result; Enter opens its date and expands its ancestors. Results paginate without loading the entire archive into the document. Selecting a result clears the tag filter so the surrounding context is available.

## Data and time

The runtime database is **`data/still.sqlite3`** by default and remains ignored by Git. The first launch copies the fictional sample journal from **`seed/still-seed.sqlite3`** only when the runtime database does not exist. Pulling new code therefore never replaces personal entries. Delete the runtime database if you intentionally want to start over from the sample, or set `STILL_SEED_ON_FIRST_RUN=false` before first launch to start empty.

Override the runtime location with `STILL_DB_PATH`. Custom locations start empty unless `STILL_SEED_ON_FIRST_RUN=true`; the Render Blueprint enables it so a brand-new persistent disk gets the sample. `STILL_SEED_PATH` can point to a different starter database.

After editing the fictional starter content in `scripts/build_seed.py`, rebuild the tracked database with `python -m scripts.build_seed`.

SQLite fits a personal logbook: no cloud account, no deployment-time secrets to configure, and a portable database. Foreign keys, WAL mode, transactional writes, and a unique index allowing only one running session protect consistency. Numbered, transactional schema upgrades run at startup; the current schema is version 11. Entry IDs use SQLite AUTOINCREMENT so a deleted ID is never assigned to a different entry. The legacy migration preserves note IDs, remaps the former task ID space, and retains each list's saved order.

The normalized tables are:

| Table | Stored facts |
| --- | --- |
| `days` | Unique journal date and creation timestamp |
| `entries` | Note/task kind, optional day, Markdown content, JSON tags, parent entry, shared sibling position, timestamps, retry ID |
| `sessions` | UTC start and end timestamps; a null end means running |
| `calendar_subscriptions` | Public/private ICS URLs, feed-provided names, connection status, and the last successful feed for throttle-safe display |
| `document_operations` | IDs, timestamps, and undo/redo state for document transactions |
| `document_changes` | Relational before/after row images for each changed bullet; Markdown and tag arrays retain their normal representation |

Notes and tasks are the same entity. `entries.kind` is `note` or `task`. Notes always have a `day_id`; active task trees have a null `day_id`; a finished task tree shares the logbook day's `day_id`. `completed_at` stores each task checkbox state separately because a checked subtask can still belong to an active tree whose `day_id` is null. Root positions are shared across both kinds, so logbook entries stay interleaved without copying task content into note rows. The older `/api/notes` and `/api/tasks` routes and export arrays remain compatibility views over `entries`.

Totals and statistics are derived; no aggregate counters can become stale. Timestamps are UTC ISO 8601. The browser supplies its IANA timezone. Notes keep the calendar date they were written under; session and task-completion statistics are grouped in the requested timezone. Sessions crossing midnight are split using real local day boundaries, including 23- and 25-hour daylight-saving days. The longest session for a day is that day’s longest uninterrupted portion of a session. Overlapping or future manual sessions are rejected.

Bullet hierarchy uses an **ordered adjacency list**, not a JSON document. Each bullet is a row with `parent_id` (a self-referencing foreign key, null for roots) and integer `position` among its siblings. Depth is derived from the parent chain. This allows individual edits, transactional branch moves, recursive SQL queries, and per-bullet analytics without replacing a whole document. The API returns flat records with parent IDs; the UI reconstructs nested HTML lists.

The API rejects cycles, missing parents, cross-day nesting, and moves that would push any descendant beyond eight levels. SQLite foreign keys and triggers also enforce valid parent references, acyclic trees, and same-location ancestry. Deleting a parent promotes its children one level in the same order. In the logbook, root entries are notes; indenting under an entry converts the moved branch to its parent's kind. A branch nested under a completed task is completed too. Parents complete automatically when all direct children are complete. A checked child is retained while its immediate parent is open. Parents cannot be manually completed while they have unfinished children. Reopening a child returns the whole tree to to-dos, reopens completed ancestors, and keeps earlier completed siblings checked.

Export a normalized snapshot with `GET /api/export`. For a complete SQLite backup while the app is running, use SQLite’s online backup command rather than copying a database with an active WAL:

```sh
sqlite3 data/still.sqlite3 ".backup 'still-backup.sqlite3'"
```

The download icon in focus statistics performs the same kind of consistent online backup through `GET /api/backup`. The response is a complete `.sqlite3` file that can be opened independently in SQLite, DB Browser, TablePlus, Datasette, Python, or R. Backups include private calendar subscription URLs, so handle them as secrets. Authentication protects this endpoint whenever `STILL_AUTH_ENABLED=true`.

Authentication is available but disabled by default. With `STILL_AUTH_ENABLED=true`, the app opens behind a password gate and successful entry creates an HTTP-only session cookie; there is no username. Bearer authentication with the same password remains available for API clients. While authentication is disabled, an internet deployment is public: anyone with its URL can read and modify the journal. Render supplies HTTPS at the edge, but HTTPS alone does not restrict access.

## Agent API

Agents can start at **`/llms.txt`**, then read **`/api/agent/journal`** for structured JSON or **`/journal.md`** for Markdown. These representations work without JavaScript and include collapsed descendants and history beyond the browser's loaded page. The HTML advertises them through alternate links, and the production server adds HTTP `Link` headers. A no-JavaScript browser gets a link to the Markdown document. No controls are added to the interactive interface.

```sh
curl 'http://127.0.0.1:8000/api/agent/journal?start=2026-09-01&end=2026-09-17&timezone=America%2FLos_Angeles'
curl 'http://127.0.0.1:8000/journal.md?tag=work&q=design&timezone=America%2FLos_Angeles'
```

The versioned JSON includes ISO dates, original `content_markdown`, separate tags, explicit `{text, url}` links, stable `(kind, id)` keys, ordered `children`, task completion relationships, and numeric focus durations in seconds. Completed and running durations are separate. Sessions crossing midnight expose both their whole duration and `seconds_on_day`, so daily sums do not double-count time.

Date ranges are inclusive and default to the last 30 calendar days, including zero days. `limit` paginates 1–100 dates; follow `next_url` until null. `tag` and `q` filter bullets while retaining matching descendants and ancestor context (`matched: false`); focus totals remain unfiltered because sessions are not assigned to tags. `tasks=visible|all|none` selects the current task snapshot independently of the note date range. The next-page URL omits tasks to prevent repetition. Each response uses a read-only SQLite snapshot and includes only saved data. `/llms.txt` documents the full contract and query semantics; OpenAPI defines the recursive response schema.

The production homepage supports the same queries with `Accept: application/json` or `Accept: text/markdown`. On Vite, use the explicit representation URLs. Agents need network access to the running site, just like a browser; no data is sent to an external LLM service.

Interactive OpenAPI docs: **http://127.0.0.1:8000/docs**. Machine-readable schema: `/openapi.json`.

| Endpoint | Purpose |
| --- | --- |
| `GET /llms.txt` | Agent discovery guide, data contract, and query examples |
| `GET /api/agent/journal` | Read-only, versioned document tree with date/text/tag filters, links, tasks, focus totals, and session allocations |
| `GET /journal.md` | The same filtered document as Markdown, without JavaScript |
| `GET /api/tags` | Existing tag names and counts from notes and tasks |
| `GET /api/search?q=...&offset=0&limit=40` | Archive-wide search with paginated results and parent/date references |
| `POST /api/document/edit` | Atomic batch of create/edit/delete/move operations, returning an undo operation ID |
| `POST /api/document/history` | Undo or redo a group of document operations, checking for conflicting edits |
| `POST /api/tasks/{id}/reopen` | Undo completion, reopening completed ancestors without reopening unrelated siblings |
| `GET /api/journal` | Current day, notes, completed task trees for each logbook date, active to-dos, live focus totals, and active timer; cursor pagination with `before` and `limit`, optional `tag` filter or exact-date `on` lookup |
| `POST /api/notes` | Create a note with `date`, `content`, optional `parent_id`, `after_id`, and `client_id` for retries |
| `PATCH /api/notes/{id}` / `DELETE /api/notes/{id}` | Edit or delete a note |
| `PATCH /api/notes/{id}/location` | Move a branch using `parent_id` (null for root) and optional preceding sibling `after_id` |
| `POST /api/tasks` | Add a to-do with `content`, optional `parent_id`, `after_id`, and `client_id` |
| `PATCH /api/tasks/{id}` / `DELETE /api/tasks/{id}` | Edit or delete an open to-do |
| `PATCH /api/tasks/{id}/location` | Move a to-do branch using `parent_id` and optional `after_id` |
| `POST /api/tasks/{id}/complete` | Complete a leaf and any ready ancestors, adding their completion entries to the current day |
| `GET /api/timer` | Active session and server time |
| `POST /api/timer/start` | Start, or return the existing running session |
| `POST /api/timer/stop` | Finish a specific `session_id`; retries cannot stop a newer session |
| `GET /api/sessions?date=YYYY-MM-DD` | Sessions intersecting a day, with full duration and seconds allocated to that day |
| `POST /api/sessions` / `PATCH /api/sessions/{id}` | Add or edit `started_at` (timezone-aware) and `duration_seconds` |
| `DELETE /api/sessions/{id}` | Delete a finished session |
| `GET /api/stats` | Summary metrics and daily records |
| `GET /api/stats/daily` | Daily records suitable for joining to health data |
| `GET /api/export` | All normalized records with schema version |
| `GET /api/backup` | Download a consistent, complete SQLite database backup |

Date-based reads and task completion accept `timezone`, defaulting to UTC. Stats accept inclusive `start` and `end` dates (up to 3,660 days). Missing bounds default to the last seven days. All durations in API responses are seconds; the interface formats them in hours, minutes, and seconds.

```sh
curl 'http://127.0.0.1:8000/api/stats/daily?start=2026-09-01&end=2026-09-16&timezone=America%2FLos_Angeles'
```

Each daily record contains `date`, `focused_seconds`, `longest_session_seconds`, `session_count`, `first_started_at`, `last_ended_at`, `note_count`, and `completed_task_count`. Join on `date` after using the same timezone as your Oura data. A cross-midnight session counts once in each day it touches, and once in the summary’s unique `session_count`.

The summary provides averages over all calendar days and separate `average_active_day_*` values for days with focus. It explicitly returns `includes_running_session: false`. Oura connectivity and correlation analysis are left for the future agent integration.

## Checks

```sh
npm test                 # isolated SQLite tests: transactions, retries, stats, midnight, DST
npm run build            # strict TypeScript check and Vite production bundle
npm run test:e2e          # Chrome browser tests against an isolated /tmp SQLite database
```

Browser tests use the installed Google Chrome via Playwright. Run `npx playwright install chrome` on machines without it. Build before the browser suite; it tests the production app. Test databases and screenshots never touch the personal database.

The interface follows [make-interfaces-feel-better](https://github.com/jakubkrehel/make-interfaces-feel-better), with the user's document reference taking precedence: styled-components throughout, the reference’s Söhne font, tabular timer numbers, native modal focus management, compact document rows (44 px on touch devices), explicit transitions, and reduced-motion support. No style sheets or inline `style` attributes are used. There are no decorative images, taglines, or formatting toolbars; the page shows document content, the timer, and quiet theme and statistics icons.
