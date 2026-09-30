# mwcode desktop — design rules

The look of the app, decided screen by screen. Every UI change follows these rules. When a
change needs to break one, ask first; don't quietly make an exception.

All values live in `styles.css`. Colours are the `:root` tokens (`--text`, `--muted`, `--dim`,
`--accent` #7A78F5, `--accent-hi`, `--good`, `--bad`, `--warn`, `--glass*`, `--line*`).

---

## 1. One screen

- The app is **one chat screen** plus a sidebar. There is no split view (it was removed for v1
  and archived in `C:\Projects\frogemain\archive\workbench-2026-09-29`).
- **The sidebar hides only when the user hides it** (its panel button, Ctrl+B, or a click on
  the scrim). Nothing hides it automatically, including the agent starting work. A window
  under 820px opens it floating over the chat.
- The chat header holds: the sidebar toggle (when hidden), the session pill, quick tabs, and at
  the far end Run plus the window buttons. There is no title bar.

## 2. Corners

- Nearly square everywhere. Three sizes only, as tokens: `--r-sm` 2px (chips), `--r` 3px
  (buttons, hover boxes, menus), `--r-lg` 4px (big panels: composer, dialogs, cards).
  Never write a raw `border-radius` in px; use a token. Only dots and spinners stay round (`50%`).
- The window's four outer corners use Windows 11's small rounding (`roundWindowCorners` in
  `main.js`, via koffi → `DwmSetWindowAttribute`, DWMWCP_ROUNDSMALL). The fallback is square.

## 3. No coloured fills

**A box is never filled with a colour.** A coloured box is an **outline**: transparent inside,
a 1px inset ring in its colour.

```css
background:transparent;
box-shadow:inset 0 0 0 1px rgba(122,120,245,.45); /* accent; green 111,191,134; red 236,124,114; amber 234,183,103 */
```

- Ring strength for status colours: **.45**. An accent (purple) ring is never at rest: see §5.
- Use an inset `box-shadow` for the ring, not `border`, so the box doesn't change size.
  Existing rules that already have a border keep it and colour the border instead.
- **Colour by nature keeps its fill**: status dots, progress and usage bars, the text caret,
  the video play button. These aren't boxes.
- **The on/off switch is a box too**: off is a grey outline with a dim knob on the left; on is the
  selected purple outline (.45) with a white knob on the right. Hover brightens it (.7 / .85).
- **Neutral grey surfaces are fine**: the composer, code blocks, your message bubble, cards,
  inputs, menus and pop-ups. Grey is a surface, not a colour.
- **A button is never grey-filled either.** Every button at rest is the same: transparent,
  a grey outline, white text. That includes Cancel, Back, Upload, segmented choices and sort
  buttons, not only the coloured ones. The one exception is a control sitting on top of an
  image (the lightbox arrows, the × on an attachment thumbnail), which keeps a dark backing so
  it stays visible.
- **A danger button** (delete, remove) is a red outline that brightens on hover, never a
  red fill.
- **No box inside a box.**
  - **A group of options is never outlined around the group.** The choices sit in a row as
    plain text. The chosen one has its own purple outline, and the others show the purple
    hover outline. This covers every segmented choice in Settings.
  - **An icon, number or key hint inside a box has no box of its own.** That means the file
    icon on a card, the plug in an empty state, an approval answer's number, the key icon in an
    API-key row, a server's tile in its card, and key hints like `Esc`. The icon or text stands
    alone.
  - **Buttons on a card or panel are fine**: Upload and Edit on the MINDWEAVE.md card, Send in
    the composer, "+ Add server" in an empty state. A card holds its actions.
  - The scan for this is `nested-boxes.mjs` in the `mwcode-design` skill.

## 4. Text and icons inside an outline are white

- Inside an outlined box, text and icons are `var(--text)` (white). **The outline alone
  carries the colour.** No purple text inside a purple box.
- An on/off button that is **on** (pin, pinned quick tab) shows it with a soft ring (.45).
  Its icon stays white.
- **Purple text at rest is only for links** (in the agent's replies, the About text) **and for
  things selected or in use** (the chosen model's check, the Queued badge, the drop screen).
  Headings, labels, "+ Add", "Show more", "Refresh" and other text buttons are white or grey,
  and turn purple on hover. `check-styles.mjs` flags anything else.
- Green or red status words keep their colour (a failed step, a passed test).

## 5. Rest, hover and selected

**Purple means selected, in use, or under the pointer, and nothing else.** A box that is none
of those is grey. One family of states, all outlines, **never a fill**:

| state              | ring                                              |
|--------------------|---------------------------------------------------|
| at rest            | `var(--line-2)`: grey, the same as Upload         |
| hover              | `rgba(122,120,245,.7)`                            |
| selected / on      | `rgba(122,120,245,.45)`                           |
| selected + hover   | `rgba(122,120,245,.85)`: brighter                 |

- A button is **never purple at rest**, however important it is. That includes Send, Edit,
  New session, "+ Add server", Connect and the session pill. It turns purple on hover.
- "Selected" means the state class says so: `.active`, `.on`, `.pinned`, `.open`, `.current`,
  `[aria-pressed="true"]`, and so on. Examples: the current session, the active Settings tab,
  the active rail icon, a pin that's on.
- "In use" means purple while it's showing, because it is the thing happening right now:
  the rename box while you type, the drop screen while you drag, the approval panel while the
  agent waits for an answer.
- **Connected is "in use", so it is purple**, not green: the CONNECTED badge, a connected MCP
  server's tile and dot, the API key in use. Not connected is a plain grey outline with dim text.
- Green is for a finished result that succeeded (✓ passed, tests green) and the Run button.
  Red is failure or danger, amber is a warning. Those stay coloured at rest.
- A status badge next to buttons is the **same height as the buttons** (`--control-h`), so the
  row reads as one line.

- **Every selected box must get a brighter `:hover`.** A new `.active` / `.on` / `.pinned`
  state always comes with its `:hover` rule. Watch specificity: `.x.active:hover` must beat
  `.x.active`.
- The window's close button hovers with a red ring (`rgba(236,124,114,.7)`) and a white ✕,
  not a red fill.
- A selected list item (session, Settings tab) is shown by its outline only. No inner accent
  bar or stripe.

## 6. Centring and pixel alignment

- **Everything sits on whole pixels.** An element on a half pixel blurs across two pixels
  and looks nudged.
  - **Icon sizes are even**, in even boxes: 16px in the 34px rail buttons, 14px in 28–30px
    buttons, 12px in the 22px row buttons.
  - **Heights are even.** No 25px or 29px buttons; the top row's controls are all 28px.
  - **One control height: `--control-h` (28px).** Every button with text, text field, menu
    button ("Millions"), choice and status badge uses it, never its own px height or a height
    made of padding. Only icon-only buttons (rail 34, row 22, composer 28) and the switch differ.
    A control that flexes (`flex:1`) also needs `min-height:var(--control-h)`: in a vertical
    layout `flex:1` sizes its HEIGHT, and without the floor it gets squashed (this hit the run
    command fields and the Usage limits).
  - **Count borders.** A 1px border shrinks the space inside: the rail is 53px (52 plus its
    border), and the chat header has 1px of top padding to balance its bottom border.
- **The top row is one line.** Logo, project name, pin/hide, session pill, tabs, Run and the
  window buttons share a single centre line, 22px from the top.
- **Optical fixes are allowed and expected.** Centre what the eye sees, not the bounding box:
  - the chat bubble is centred on its body, not its tail (`viewBox` shifted down 1.25);
  - the play triangle is nudged right;
  - capital-letter badges get 1px more padding above than below.
- Verify by measuring, not by eye. See the `mwcode-design` skill.

## 7. Spacing in the chat

- **No divider lines** between a row and its output, or between items.
- A header and its own output sit close together: **4px**. Separate items sit apart: **16px**.
- Things are told apart by distance, not by rules or boxes.

## 8. Say it once

- A row states its subject **once, in the header**. The body never repeats it.
  - Commands: the command is in the header, across the full width, cut with "…" only where
    the row ends (full text on hover). The body is the output and the ✓/✗ line. No `$ command`
    line.
  - Edits and writes: the header shows the file and `+N −N`. The body is the diff with no
    "edited …" summary and no "L19 · −1 +1" label. The counts come from that label, not from
    counting the (possibly shortened) preview.
  - A failure always keeps its error text.
- Session names come from the session notes' title: 3–6 words, commit-subject style, no
  project name.

## 9. Diffs

- No line fills. A changed line has a **2px inset edge bar** plus its `+`/`−` sign, both in a
  very soft colour: bar `.32`, sign `.55`.
- Added lines are bright (`#D3D6E1`). Removed lines are dimmed (`#7F8292`): the code that is
  gone. Unchanged lines stay `--dim`.

## 10. Your message

- Your bubble looks like the box it was typed in: `--glass-2` fill, `--line-2` border, no
  colour, no marker dot.

## 11. Opening things

- One open icon (`OPEN_ICON_SVG`) everywhere: on edit, write and read rows, and after files,
  folders and links in the agent's text. It's faint until the row is hovered.
- **Single click** acts everywhere (menus, lists, the open button). Right-click gives the
  alternatives.
- A path becomes clickable only once it's found on disk.

## 12. Behaviour that is part of the look

- Dragging text that starts inside the app never opens the drop overlay. Only drags from
  outside the app attach.
- Esc stops a turn at once, with no "Stopping…" state.

## 13. What's new

- Settings tab before About. A row per item, not a box: the title, then one line of summary (cut with
  an ellipsis), and `Update · date` or `News · date` on the right before the arrow. A hairline sits between
  rows; the accent outline shows only under the pointer. Rows are 57px, full width.
- Newest first, always (by date; a test holds it).
- No on/off switch: news always arrives, so nobody misses an important fix. The line under the title says
  what the page is, then how much is new: "News, updates and fixes for mwcode and Mindweave. You are all caught up."
  No "Checked … Check now" line. An unread item shows a jade dot and NEW at the start of the kind and date on the right, gone once read; a dot also
  shows on the tab and on the Settings gear until everything is read.
- Click a card: its summary fills the Settings content (Back, title, summary, a few points).
  An update with a link also has "Get X"; every summary has "More details".
- No second window: an item's page shows its summary, pictures, points and sections, then buttons: "Get X" /
  "Copy update command" when it is an update, and link buttons ("GitHub ↗", "X ↗", "Website ↗"). The feed's
  `links` (up to 4, https to github.com / the mwcode site / x.com) decide them; without any, core and CLI
  updates point to the Mindweave GitHub and announcements to Website, GitHub and X.
- The list has a header line ("3 new since you last looked." / "You are all caught up.") with
  "Mark all as read", and All / Updates / News choices with their counts as plain text. The tab
  shows the unread number (plain white text, no box). Each card starts flush left with its title; the kind icon (12px, no box) sits at the start of the small "kind · date" line at the bottom, and it has a
  "NEW" word plus dot while unread, the version on updates, and an arrow that nudges on hover.
  Rows fade in one after another only when the page opens (the tab, or Back from an item); a redraw from
  the switch, a filter or a feed update leaves them still.
- Two families: **News** (announcements and messages from us; megaphone icon) and **Updates**,
  labelled by what they update: App (window icon), Core (chip icon), CLI (terminal icon). The
  version lives in the title only (say it once). An update item with a link offers "Get X" (opens the release page); CLI updates also offer "Copy update command".
- An item may carry pictures. Only `https:` (or inline `data:image/`) sources are shown. A
  picture has a grey outline, never a fill; the caption sits under it in dim text. Pictures appear only
  on the summary and the details window, never on the card in the list.

## 14. Marathon

- While a marathon runs the composer keeps its normal status line (thinking, time, Esc to stop)
  and a purple light also runs round the composer's edge. Not gated by reduced motion.
- Above the composer is a **one-line box**: "Marathon", "3 of 8", the current line, an arrow.
  Click it, or the **Marathon tab** that appears in the agents bar next to Main and the
  sub-agents, to open the marathon view (only once the task has started: while it is merely armed, "Your
  next message is the goal", the box has no arrow and opens nothing) (Back / Esc returns to Main). The view lists each task,
  and under it the tool calls the agent made while working on it, drawn like a sub-agent's. The box stays after the run ends until you send a new message.
- Sub-agent and marathon views have **no banner or Back button**: the tab bar is the navigation
  (Main tab, or Esc). The composer is read-only while you look at either ("Viewing Marathon ·
  read only"): they are places to read, not to type in.
- Status dots on tool rows: white and blinking while the step runs; when it ends, green for an
  edit, write, check or command that went through, red if it failed, white for reads and the like.
  Never gated by reduced motion (Windows with animations off reports it).
- **Stop** (the send button while the agent works) is a normal outline button: grey ring at rest,
  white icon, red ring on hover. No fill, no second colour.
- Content comes from the signed feed (`news/`, see below). At the bottom of
  the page: the "Get news and updates" switch, and one dim line saying when it last checked (or
  why it could not), with a "Check now" link. Switched off, the list says so.

### The signed feed (how news reaches users without an update)
- `news/feedCore.js` (format + checks), `news/feedService.js` (fetch, cache, schedule), keys in
  `news/feedKey.js` (public) and `~/.mwcode-news/private.pem` (private, never committed).
- Publish: edit `../mindweave-news/source.json`, run `node news/tools/publish.mjs ../mindweave-news`,
  commit and push that folder to `mindweave-cli/mindweave-news`. Tests: `node --test news/feed.test.mjs`.
- Trust rules: nothing is shown unless the Ed25519 signature checks out (again on every read);
  a lower sequence number is refused (no rollback); items are rebuilt from allow-listed fields as
  plain text; links must be https on github.com or the mwcode site; pictures are used only if their
  bytes match the hash inside the signed feed and really are png/jpeg/webp/gif, and reach the window
  as data; the only copyable command is `npm install -g mindweave[@version]`.

## 15. Coming back after a restart

- A restart (an update, a crash, closing and opening) lands you where you were: the same
  **project**, the same **session** (remembered per project, not just "the newest"), the sidebar as
  you left it, **Settings open on the same page** (and What's new on the same item, the Usage tab,
  the filter), your settings and switches, and a **half-typed message**.
- Anything new that adds a page, a tab or a choice you can leave open should be saved in `saveUi()`
  (renderer.js) so it comes back too.

## 16. Versions

- About shows three: **App** (the app's own version, `package.json`), **Core** (the mindweave package) and **CLI** (the CLI the app installs is that same package, so it reads the core's number). Feedback carries the app version and the core's.
- The feed judges each item by its own version: news and app updates by the app's, core updates by the core's, CLI updates by the CLI's. An update already installed is not shown.
- The app's number is `version` in `package.json`. It is a placeholder (0.1.0) until the owner sets it.
- **Update available (About):** one update: that version's chip becomes a button, "New update available. Update now", with a soft purple ring and a light sweeping round it. Two or more: the chips stay, the ones with an update get the ring, and an "Update all" button (same shimmer) appears. Pressing either turns the row into one progress button, then "Restart to update"; after the restart the row is plain chips again with the new versions. This is the ONE case where a button is purple at rest (the ring only, never a fill); the checker knows `.has-update`.
- MOCKUP until the installer exists: `localStorage 'mw:mock-updates'` = `app`, `cli`, `core` or a list (`app,cli`) pretends those are out and fakes the download; `mw:mock-installed` remembers the fake result. Without the flag a real update item's button opens its release page. The real installer goes in `startUpdate()` (renderer.js).
- **Top-row update box:** when any update is out (app, core or CLI), an "Update available" box shows in the top row just left of Run, same shimmer ring and height as the other top-row controls. It says "Updating…" and "Restart to update" while an update runs, and hides when there is nothing to update. Clicking it opens Settings on About.
- **What has been read is kept in the main process** (`feed-state.json`, written the moment an item is opened), not in the window's storage, which is flushed lazily and lost on a forced quit or crash. Same reason applies to anything else that must survive a restart exactly.
- **Everything remembered is saved at once, in the main process, and survives a forced quit.** The window's `localStorage` is not used (it is flushed late): use `mwStore.getItem / setItem / removeItem` (preload.js), which writes `ui-state.json` before the call returns. Files are written to a temporary file and renamed, with the last good copy kept as `.bak`, so a crash cannot leave a half-written or empty file. The window's size, place and maximised state are saved too, and reopen where they were (only if still on a screen). Anything new that should survive a restart goes through one of these.

## 17. Nothing you did is lost (session content, queue, scroll)

- **Your message** is written to the session file the moment it is sent, before the model is asked
  anything (`recordUserMessage`, and the marathon's goal), not after the first answer.
- **A reply being written** is kept in `partial-reply.json` a few times a second (at most ~0.3 s behind, and written at once on a normal close) and cleared when its step
  is saved. After a crash the next start adds it to the conversation, ending "(interrupted)", unless a
  saved reply already holds those words.
- **Messages waiting in the queue** are kept in `queued-messages.json` and come back in the message box
  (with their pastes and files) at the next start.
- Settings menu rows are exactly 34px with an 18px text line: icon and label share one centre line on whole
  pixels (an inherited 1.55 line height had put them on half pixels).
- **Opening the app always lands on the latest message** (held at the bottom for about a second while rows
  settle, unless you scroll). The saved reading spot below is only for going back to a session while the app runs.
- **Where you were reading** is saved per session (`mw:scroll:<id>`, last 40 sessions) as you scroll and
  put back when the session opens: after a restart, or coming back from another session. At the bottom
  means "follow", the same as a fresh open.
- **The draft** is written synchronously when the window closes. The session is loaded once, however
  many things ask for it at startup (`ensureSession` shares one load).

## 18. Send it again

- When the last message got no answer (the send failed, you stopped the agent, or the reply ends
  "(interrupted)"), a small **send again** icon (↻) sits beside that message (left of its Edit icon) and
  on the row that says what happened. One click sends exactly what was sent, files and pastes included.
  Only the last turn has it, and it goes away when anything new is sent. After a restart it is offered for
  a plain-text message; one that had pastes or files is not (those bytes are no longer to hand).
- Grey outline at rest, purple on hover, like the other small icon buttons (24px on the message, 22px on a row).

## 19. Themes

- **System** (the default), **Light** or **Dark**, in Settings > General > Theme. main.js sets
  `nativeTheme.themeSource`; the page's `@media (prefers-color-scheme: light)` block redefines the tokens.
  Windows switching light/dark while the app is open is followed live.
- **Every colour is a token.** No raw greys or whites in rules: use `--prose`, `--code-text`, `--code-bg`,
  `--card-hover`, `--tint*`, `--shadow`, `--scrim`, `--diff-*` and the rest. A new token needs a value in
  both the `:root` block and the light block. Exceptions that stay dark on purpose: masks, and controls
  sitting on top of an image or video (lightbox, recording overlay).
- The accent rings (`rgba(122,120,245,…)`) are the same in both themes.
- Light is **mist**, chosen by the owner: the dark theme turned inside out, dimmed so it never glares.
  A soft green-grey ground (#D6DCD8, panels #E0E5E2), near-black green text (#0F1713) and lines
  (rgba(16,40,30,…)). No pure white, no beige, no blue-grey.

## 20. Long sessions stay light

- A session opens on its last 400 history events; a **Show earlier** bar at the top adds 400 more per
  click without moving the view (rows carry `data-ev`). A live run past 900 rows trims to 500 while you
  follow at the bottom (never while you read further up); Show earlier then reloads the history.
- Redrawing a session never scrolls per row (`bulkDrawing`): each scroll forced a full layout and a
  marathon-sized session took 95 s to open. Now ~2.5 s, 6K elements instead of 162K, 349 MB instead of 957 MB.
- Output over 120K characters keeps its start and end with a "N lines (K KB) not shown" line. A reply over
  20K characters re-renders a few times a second while it streams, not every frame.
- App icon: `assets/icon.ico` (16–256px, the one-colour logo in white, built by `npx electron build/make-icon.js` from `assets/logo-mono.png`),
  on the window and the taskbar; `app.setAppUserModelId('com.mindweave.mwcode')` gives it its own taskbar button.
- Task Manager reads the name and icon from the program file. From source that is `electron.exe`, so
  `build/brand-electron.js` (run by `postinstall`) stamps "mwcode" and the icon onto it with rcedit. A
  packaged build names its own exe.

## 21. The accent is mint (was purple, then brown, then leaf)

- Where the rules above say **purple**, read **the accent**. It is a fresh mint: `--accent-rgb` is
  61,163,122 in Toned and a deeper 22,117,84 on Light, so rings read on the pale ground. Brown read as a
  book or coffee app; the earlier palettes are kept in `archive/palette-*.css`. Every ring is written
  `rgba(var(--accent-rgb), .45 / .7 / .85)`; never a raw colour. Changing the accent is one line per theme.
- Themes: **System** (default), **Light** (warm off-white) and **Toned**, the dark one: a near-black with
  a faint green tint (ground #080A09, panels #111413, text #EEF2EF), never black. Its setting value is still `dark`.
- Success (`--good`, Run) is a yellow-green (#A3CF6E / #467F1A), away from the blue-green mint, so it never reads as the accent;
  red is only for errors. The accent must never be red.

## 22. Projects and search

- The project list slides open (200ms) and shut (150ms): height, padding, border and margin together, so
  nothing pops at the ends (`slideList`). The sidebar slides the same way (200ms in, 150ms out):
  docked it slides off the left edge and the chat widens with it; floating it slides over the chat and the
  scrim fades. A second toggle mid-slide turns it around from where it is (`slideSide`). Pop-up menus elsewhere just appear.
- Session rows stand 4px apart, so an outlined row never touches the next.
- Up to 100 projects are remembered. The project menu scrolls past six; "Open other project…" stays below it.
- The sidebar search finds **projects and sessions**: matching projects (by name or folder) under a
  "Projects" heading first, then sessions. Enter opens the first result, Esc or the × clears.
- The search box is the same height as New session (32px), text on whole pixels, grey ring at rest,
  the accent ring while you type in it (it is in use).
- **Right-click a project** (in the menu, in the search results, or the name at the top) for **Rename** and
  **Remove from list**. Both touch the app only: a rename is a label (`projectNames` in desktop-state;
  emptied, it goes back to the folder name), and removing only drops it from the list. The folder, its
  sessions and the name the agent sees never change. The open project can be renamed, not removed.
- **Renaming in place (sessions and projects): the row becomes the field.** The text box has no border or
  fill of its own (no box inside a box); the row gets the accent ring while you type and keeps its exact
  height. Never put a boxed input inside an outlined row.

## 23. Fonts (bundled)

- **Fraunces** (`--display`, a soft warm serif) for **every heading and every name of a thing**: page and section
  titles (`.settings-section-title`, `.rs-group`), detail titles (provider, key, MCP server), provider names in the
  list, the project name in the sidebar, mode names, What's new and feedback titles, the marathon label, the
  empty-chat greeting, the About name, and h1–h4 in replies. One shared rule at the end of styles.css; add new
  headings to it. The composer's pickers (thinking, provider, model) use it too, kept soft: weight 500 and
  muted until pointed at. A serif label that clips (ellipsis) needs a 20px line box, or the tails of g, j, p,
  q and y get cut. Always `font-variation-settings:'SOFT' 60–70`. Not for small uppercase group labels, row
  labels, file names or code.
- **Instrument Sans** (`--body`) for all other text. **IBM Plex Mono** (`--mono`) for code, commands, numbers.
- The files live in `assets/fonts` (Open Font Licence, licences beside them); `fonts.css` is generated by
  `node build/make-fonts-css.js`. Nothing is fetched from the internet to draw text.
- Chat text uses **whole-pixel line heights** (22px replies, 20px tool rows, 19px output) and the chat
  scrolls to whole pixels; a fractional line height put every row on a different fraction and blurred it.
- The tool-row dot sits 1px below its box centre: the eye centres it on the lowercase letters, not the capitals.

## 24. Show more, and the speed budget

- Show more opens with a short animation (160ms) to the measured height, or at once past 900px of growth
  (animating a huge height stutters on slow machines). Show less is instant and keeps the button exactly
  where it was on screen. One toggle for all of them: `toggleTrunc` (renderer.js).
- After Show more, the view glides down just enough to show the Show less button (16px under it), but never
  past the start of what was opened; a block taller than the screen keeps its start in view. The glide is
  one motion with the opening: the block grows and the view follows it in the same frames, on one
  ease-out curve (200–320ms, `unfold`). A wheel scroll mid-way hands the view back to the reader.
- Show earlier draws only the new chunk above what is on screen (`drawReplay(start, end)`), never the whole thing again.
- Measured on a simulated low-end PC (CPU 3x slower): buttons, menus, tabs and Settings answer in 10–40ms;
  Show more 10–22ms; switching to a 2MB session ~280ms; Show earlier ~290ms. Keep new UI inside that.
- Speed tests on the owner's PC stay light: small sessions, at most 3x slowdown, one area at a time.

## 25. Reading the chat while the agent works

- **Scrolled up, you stay put.** New rows below, and rows growing below, never move what you are reading
  (measured: 0px). Only your own input (wheel, scrollbar, click, keys) takes the scroll over; the browser's
  own adjustments (rows settling their height) never cancel a scroll the app is running.
- **Jump to latest:** a small round ↓ floats just above the message box once you are more than half a screen
  up; a dot shows when something new arrived below. Click it to glide to the bottom and follow again.
- The chat runs straight down to the message box: no band between them (the composer has no top padding;
  the chat has 26px at its end instead).
- **Nothing answered?** A message of yours with no reply after it (the app closed, the send failed) gets a ↻
  "Get a reply": the agent answers it as it is, nothing is sent twice (`chat:continue` → core `continueTurn`).
  A reply cut off mid-way ("(interrupted)") gets **Continue** (carry on) and ↻ (send the message again).

## 26. First launch: no project, no key

- **No project yet** (nothing opened before, or every remembered folder is gone): the sidebar button reads
  "Open a project" (no arrow) and opens the folder picker; the heading is "What should we work on?" (no
  "in …"); Run and the project-only rows in Settings > General (MINDWEAVE.md, Run command) are hidden;
  Permissions, Rules & Skills and Usage open on **All projects**; the empty list says "Open a project to
  start"; New session and sending both open the folder picker first (sending then goes out).
  The app never opens its own folder or wherever it was started from as a project. Behind the scenes the
  session lives in an empty `no-project` folder in the app's data, which is never shown or listed.
- **No key yet**: the composer shows one **Connect a provider ›** button (Settings > Providers) in place of
  the thinking, provider and model pickers, the context meter and Marathon; the send button is locked, with
  "Connect a provider to start" on hover. It
  checks again whenever Settings closes. A first key for a provider other than the default model's moves
  the chat onto that provider's first model, so the composer never offers a model without a key.
- **Startup order**: the window is created first and the core loads alongside it (`turnRunner()` also
  loads the config); the page's first question waits for it. On this PC Electron itself takes ~1 s before
  any app code runs (Windows Defender checks the 235 MB exe on every start); the app's own part is ~0.4 s.

## 27. The window on each system (Windows, Linux, macOS)

The same app everywhere: its own title bar, round corners, square when maximised or full screen. How each
system gets there differs, and on Linux most of the obvious fixes were tried and are wrong.

- **macOS**: the system's own window: `titleBarStyle: 'hidden'` with its red, yellow and green buttons top
  left at `trafficLightPosition {x: 16, y: 16}` (centred on the 44px header row), and macOS's own corners,
  shadow and resizing. `html.mac` (renderer.js) hides our window buttons, gives the logo's place to
  the system's buttons, moves the sidebar header and a hidden sidebar's header past them, and starts the
  rail's dividing line below the header row (the buttons are wider than the rail). The same in full
  screen: macOS slides its buttons back in with the menu bar there, so a logo in their place was covered,
  and switching the layout made it jump going in and out. The red button hides the window (the app
  stays in the Dock; clicking it shows it again); Cmd+Q quits. The menu bar (app, Edit, View, Window) is
  what makes Cmd+C, Cmd+V and Cmd+Q work at all. Shortcut labels read ⌘; both keys always worked.

- **Windows**: the native frame stays with its title bar hidden (`titleBarStyle: 'hidden'`, not
  `frame: false`), because Windows only animates maximise, minimise and snapping for framed windows. The
  small corners come from Windows itself (`DWMWCP_ROUNDSMALL`). Windows draws the shadow and does the
  resizing.
- **Linux, corners**: no window manager offers small corners, so the window is see-through
  (`transparent: true`) and the page is cut to the rounded shape: `html.round-window body` gets
  `clip-path: inset(0 round var(--r-lg))` and a see-through background (`.app` carries the colour).
  A clip rather than `border-radius`, so overlays covering the whole window are rounded too; the body's
  own colour would paint the whole window, corners included. `html.window-square` (sent by main.js on
  maximise and full screen) takes the clip off.
- **Linux, resizing**: the system does it, from Electron's own border (`hasShadow: true`; with the
  see-through window it draws nothing visible). **Never** a margin around the page or resize handles in
  the page: WSL draws its shadow around the window's full size, so a margin leaves a detached "ghost"
  line, and resizing from the page never feels like a normal app. Both were tried and removed.
- **Linux, minimum size**: some setups (WSL) ignore the 900 × 600 the window asks for. main.js puts it
  back only once resizing has stopped; correcting it during the drag fights the drag.
- **Linux, Wayland**: Electron can move a frameless window on Wayland but not resize it, so the installed
  `mwcode` launcher (build/linux/mwcode) runs the app through XWayland on a Wayland desktop. It has to be
  the launcher: Electron picks the display system before the app's code runs. The same launcher turns on
  WSL's graphics driver when it runs under WSL; without it every frame is drawn by the CPU.
- **Words**: nothing names Windows on another system: "Follows the system", "Open in file manager"
  (Explorer on Windows, Finder on macOS), "Open mwcode when you sign in".
