# Lit Chat

A desktop wrapper for [chat.literotica.com](https://chat.literotica.com) — a candy wrapper, if you will.

Built with [Electron](https://www.electronjs.org/) around the site's existing CandyChat/BOSH-XMPP interface.

## Features

- Persistent login session: no need to log in on every launch
- BOSH keepalive runs unthrottled which means you shouldn't get booted
- Desktop notifications for incoming DMs
- Presence notifications for watched users
- Multiple built-in themes: Dark, Dark Warm, Dark Teal, Nord, Dracula, Gruvbox, Catppuccin Mocha, Tokyo Night, Rosé Pine, Solarized Dark, Solarized Light, and Light
- Chat log viewer — opens to recent DMs; search conversation history by username
- Per-user notes
- Room manager — browse, favourite, and auto-join rooms on startup
- User profile pages open in an in-app window
- Per-room status message toggle — hide join/leave noise in busy rooms without affecting quieter ones
- Multiple profiles — separate cookie sessions and per-profile theme selection
- Adjustable name column — widen the sender-name column beside chat messages (☰ → Name Column) so long usernames aren't clipped
- Minimize to tray (optional, on by default) — the app keeps running in the tray when minimized; relaunching it or clicking the tray icon brings the window back
- **Inline photo sharing in DMs** — upload or link images directly from the chat input; photos are shared via [picpub.art](https://picpub.art) ephemeral albums and appear as inline thumbnails for both users. Recipients without the app see a working browser link. Drag-and-drop or use the 📷 button
- Photo album manager — track active albums, set expiry (1h–7d), enable IP watermarking, or delete albums from the **Photo Albums** menu
- Right-click any sent photo thumbnail to remove that image from the album

## Why a regular browser session feels unstable

Literotica chat is built on **BOSH** (XMPP tunnelled over HTTP long-polling). The client has to keep a steady stream of HTTP requests flowing to the server; if that heartbeat stalls for too long, the server decides you have disconnected and drops your session.

Modern browsers actively work against that heartbeat:

- **Desktop background-tab throttling.** When the chat tab isn't the one you're looking at, the browser throttles its timers and network activity to save power. Leave chat in a background tab (or another window) for a while and the BOSH heartbeat slows enough that the server times you out — so you come back to a dead, disconnected chat.
- **Mobile is much worse.** Phone browsers — **Safari/WebKit on iOS especially** — aggressively suspend tabs to save battery the moment you switch apps or lock the screen. A suspended tab can't poll at all, so the BOSH connection drops almost immediately in the background. Even in the foreground, mobile power management causes frequent reconnects, which is why chat on a phone browser feels flaky and keeps logging you out.

These are deliberate browser power-saving features, not bugs in Literotica — but they make a long-lived chat connection hard to maintain from an ordinary tab.

## How this app helps

This app runs the same Literotica chat interface in its own dedicated window rather than a browser tab, so the BOSH heartbeat **runs unthrottled** and keeps ticking even when the window is in the background or minimized to the tray. The connection stays warm, so you stop getting silently booted and don't have to keep reloading.

> **Note:** this only addresses desktop. Because it is an Electron desktop app, it does not run on phones — mobile browsers would need a different approach (a server-side proxy that holds the BOSH session for you), which this project does not currently provide.

## Before you start

**Close the Literotica chat tab in your browser before launching the app.**

Literotica's chat server keeps your session alive for up to a minute after you close a browser tab. If the server still thinks you are connected, the app will be unable to establish its own connection. If the app appears to hang on startup, close any Literotica tabs in your browser, wait about a minute, then try again. The app will show a warning banner if it detects this situation.

## Installation

- **Linux** — [download LitChat-linux.AppImage](../../releases/latest/download/LitChat-linux.AppImage), make it executable, and run it
- **Windows** — [download LitChat-windows.exe](../../releases/latest/download/LitChat-windows.exe) and run the installer
- **macOS** — [download LitChat-mac.dmg](../../releases/latest/download/LitChat-mac.dmg), open it, drag to Applications — then follow the extra step below 👇

All releases: [Releases page](../../releases)

### macOS: "Lit Chat is damaged and can't be opened"

This message is **normal and expected** the first time you open the app — nothing is actually damaged. Here's why it appears and how to get past it.

Apple charges developers $99/year to have their apps "notarized" (approved by Apple). This is a free hobby project, so it isn't notarized — and when macOS sees a downloaded app that Apple hasn't approved, it refuses to open it and shows the misleading "damaged" message. (If you'd rather not take the app's word for what's in the download, see [Verifying the binaries](#verifying-the-binaries) below.)

The fix is one command that tells macOS "I trust this app". You only need to do this once:

1. Make sure you've dragged **Lit Chat** into your **Applications** folder first
2. Open the **Terminal** app (press `Cmd + Space`, type `terminal`, press Enter)
3. Copy the line below, paste it into the Terminal window, and press Enter:

   ```
   xattr -cr "/Applications/Lit Chat.app"
   ```

4. That's it — no output means it worked. Open Lit Chat normally (it's in Applications / Launchpad)

> **Note:** the old trick of right-click → Open no longer works on recent versions of macOS — the Terminal command above is the way.

**Heads up about updates:** automatic in-app updates also require Apple's approval, so they don't work on macOS. When a new version comes out, download the new DMG, drag it to Applications again, and repeat the Terminal command above.

## Profiles

Profiles give each account its own independent cookie session, theme, and settings.

Manage profiles from the **Profile** menu. Switching profiles restarts the app. To run two profiles simultaneously, launch a second instance with `--profile <id>`:

```
# Packaged app
LitChat --profile bob

# Development
npm start -- --profile bob
```

Profile IDs are the slugified version of the name you gave when creating the profile (e.g. "My Alt" → `my-alt`). They are shown in the window title when more than one profile exists.

Launching a profile that is already running doesn't start a second copy — it just brings the existing window back to the front. This is also the easiest way to recover the window if it has been minimized to the tray and you can't find the tray icon (Windows 11 hides tray icons behind the **^** arrow by the clock unless you pin them).

## User data

Logs, settings, and customisations are stored under a per-profile subdirectory:

| Platform | Location |
|----------|----------|
| Linux    | `~/.config/Lit Chat/profiles/<id>/` |
| Windows  | `%APPDATA%\Lit Chat\profiles\<id>\` |
| macOS    | `~/Library/Application Support/Lit Chat/profiles/<id>/` |

The first profile is always named `default`.

## Customisation

Select a theme from the **Theme** menu. Your choice is saved per profile.

To add your own CSS overrides on top of the active theme, edit `user.css` in your profile's data folder. Changes take effect on Ctrl+R without restarting.

You can also place a `user.js` file in the same folder — it will be injected into the page on every load.

## Verifying the binaries

Every release binary is built exclusively by GitHub Actions — no one uploads binaries by hand. You can verify this in two ways:

**1. Check the release page.**
Each release on [the Releases page](../../releases) was created by the [`Build & Release` workflow](.github/workflows/release.yml). GitHub records which workflow run produced the release; the run log shows the exact commit that was checked out and built.

**2. Cryptographic provenance (SLSA attestation).**
Each binary is signed with a provenance attestation at build time using [GitHub's artifact attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds). The attestation is published to the public [Sigstore](https://www.sigstore.dev/) transparency log and tied to the specific workflow run, repository, and commit — it cannot be forged or back-dated.

To verify a downloaded binary (requires the [GitHub CLI](https://cli.github.com/)):

```
gh attestation verify LitChat-linux.AppImage --repo joeuser12/litchat
gh attestation verify LitChat-windows.exe    --repo joeuser12/litchat
gh attestation verify LitChat-mac.dmg        --repo joeuser12/litchat
```

A passing verification confirms the file you downloaded matches the artifact produced by the Actions run for this repo — it was not tampered with or substituted after the fact. If you want to go further, the verification output includes the exact commit SHA, which you can check against the source in this repo.

## Building from source

```
npm install
npm start              # run in development
npm run build:linux
npm run build:win
npm run build:mac
```
