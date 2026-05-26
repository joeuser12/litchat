# Lit Chat

A desktop wrapper for [chat.literotica.com](https://chat.literotica.com) — a candy wrapper, if you will.

Built with [Electron](https://www.electronjs.org/) around the site's existing CandyChat/BOSH-XMPP interface.

## Features

- Persistent login session (no need to log in on every launch)
- BOSH keepalive runs unthrottled even when the window is minimised
- Desktop notifications for incoming DMs
- Presence notifications for watched users
- Dark mode
- Chat log viewer — search conversation history by username
- Per-user notes
- Room manager — browse, favourite, and auto-join rooms on startup

## Installation

Download the latest release for your platform from the [Releases](../../releases) page.

- **Linux** — download the `.AppImage`, make it executable, and run it
- **Windows** — run the `.exe` installer
- **macOS** — open the `.dmg` and drag to Applications

## User data

Logs, settings, and your `user.css` customisations are stored in:

| Platform | Location |
|----------|----------|
| Linux    | `~/.config/Lit Chat/` |
| Windows  | `%APPDATA%\Lit Chat\` |
| macOS    | `~/Library/Application Support/Lit Chat/` |

## Customisation

Edit `user.css` in your user data folder to override any site styles. Changes take effect on the next page load (Ctrl+R).

You can also place a `user.js` file in the same folder — it will be injected into the page on every load.

## Building from source

```
npm install
npm start          # run in development
npm run build:linux
npm run build:win
npm run build:mac
```
