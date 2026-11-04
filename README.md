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
