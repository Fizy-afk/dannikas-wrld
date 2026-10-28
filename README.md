# • ๔คภภเкคร ฬгl๔ •

A private hub and Chrome home page, made as a gift.

## Privacy
- **Password:** the page asks for a password once per device. After that, the device remembers it (Settings → Lock this device makes it forget).
- **Encrypted data:** the personal data (schedule, name, links) is in `data/private.js`, encrypted with AES-256-GCM. The key comes from the password (PBKDF2, 250k rounds). Without the password that file is unreadable, and the password itself isn't stored anywhere in this repo.
- **Readable source stays off GitHub:** the readable versions of the private data live in a folder that's never uploaded. Its build script makes `data/private.js`.
- **Device-only data:** notes, to-dos, shortcuts, layout and settings are saved only in the browser on each device. Settings → Download backup / Restore a backup moves them between devices.

## Features
- **Sidebar (like Opera's):** a rail on the left, or a dock along the bottom on phones.
  - **Spotify:** opens Spotify in a new tab.
  - **sportsYou:** opens in a slim window docked beside the page, because sportsYou blocks being shown inside other sites.
  - **Jumps:** buttons that go straight to each section.
  - Both logos are their real logos, drawn in the accent color.
- **Search and shortcuts:** a search bar (Google, DuckDuckGo or Bing) with shortcut bubbles under it.
- **Right now:** the current class, with a live countdown, resource buttons and a school-day dial.
- **Classes:** class cards with resource bubbles. Each one can link to its own Canvas course, either by hand or with the "Find my classes" bookmark.
- **This week:** a calendar of the week, plus "Coming up" and a to-do list.
- **Notes:** an Apple Notes-style notes app with checklists. Notes can be imported from Apple Notes by copy/paste or as files.
- **Settings (gear icon):** name, color, starfield, motion, clock, search engine, which sections show, backup, and locking the device.
- **Edit mode:** hold down on anything. Items wiggle, sections, cards and shortcuts can be dragged into a new order and snap into place, and the − badge hides something.
- **Background:** a live starfield, shooting stars, cards that light up and tilt, and a sparkle when a to-do is checked off.
- **Chat:** a little chat room — a floating bubble on the password page, and a Chat button in the sidebar once unlocked. It needs its own short chat code (separate from the password), which each device remembers.

## Chat setup (Cloudflare)
The chat runs on a Cloudflare Pages Function (`functions/api/chat.js`) with a D1 database. Messages are stored there, not on GitHub.
- D1 database: **wrld-chat** (already created).
- On the Pages project → Settings → Bindings: add a **D1 database** binding named `CHAT_DB` → `wrld-chat`.
- On the Pages project → Settings → Variables and Secrets: add a **secret** named `CHAT_CODE` with the chat code.
- Redeploy (or push any commit) so the binding and secret take effect.
- To change the code later, edit `CHAT_CODE` and redeploy; devices will ask for the new one.
- **Push notifications:** `sw.js` (background worker) shows a notification for new messages even when the site is closed. Each device signs up when notifications are allowed (on join or the bell button); signups live in the `subs` table and the signing key in the `config` table of `wrld-chat`. iPhone only supports this after adding the site to the Home Screen and opening it from there.

## Code map
| File | Job |
|---|---|
| `js/gate.js` | Password lock, decrypts the private data, then loads everything else |
| `js/prefs.js` | Settings + layout storage, toasts |
| `js/core.js` | Schedule engine |
| `js/app.js` | Right now, dial, class cards, week, coming up, to-dos |
| `js/home.js` | Search, shortcut bubbles, home-page popup |
| `js/canvas.js` | Canvas links and "Find my classes" |
| `js/notes.js` | Notes and Apple Notes import |
| `js/settings.js` | The settings panel, backup / restore |
| `js/edit.js` | Hold-to-edit mode: wiggle, drag and snap, hide |
| `js/sidebar.js` | The sidebar rail and the sportsYou panel |
| `js/sky.js`, `js/fx.js` | Starfield, card glow and tilt, title wave, sparkles |
| `js/icons.js` | Bundled Lucide icons |
| `data/vibes.js`, `js/vibes.js`, `css/vibes.css` | Shows & music. See `LLM_INSTRUCTIONS.md` |

## Updating
- Push changes to `main`. GitHub Pages republishes in about a minute.
- When a CSS or JS file changes, bump its `?v=` number. Those are in `index.html` for the files it loads directly, and `VERSION` in `js/gate.js` for the rest, so browsers fetch the new copy.
