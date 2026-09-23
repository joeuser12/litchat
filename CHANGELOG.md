# Changelog

What changed in each Lit Chat release, newest first. The section for a version is
published as the body of its [GitHub release](https://github.com/joeuser12/litchat/releases),
so keep the heading format `## [x.y.z] - YYYY-MM-DD`.

Versions before 0.9.0 are not listed here; see the [tags](https://github.com/joeuser12/litchat/tags).

## [0.9.26] - 2026-09-23

### Fixed
- **Messages stopped showing in the chat window until a restart.** A single error while showing
  one message made Candy stop showing all later ones, in every room and private chat, while the log
  kept recording them. The chat window now keeps working after such an error.

### Added
- Errors like this are written to `page-errors.log` in the profile folder, so they can be sent
  along with a bug report.

## [0.9.25] - 2026-09-22

### Fixed
- **Rooms button shows one room chooser.** Candy's own "Choose a room" popup used to open behind
  Lit Chat's Rooms window, and flashed up when joining a room from it. It no longer appears.

## [0.9.24] - 2026-09-20

### Fixed
- **A failed photo upload says why.** It used to end with just "fetch failed". It now says Lit Chat
  could not reach PicPub, gives the underlying reason (for example a name lookup failure), and
  suggests checking a firewall, VPN or proxy.

### Changed
- Requests to PicPub now go through the same network stack as the chat itself, so they follow your
  system proxy and certificate settings, which the previous one did not.

## [0.9.23] - 2026-09-20

### Added
- Right-click in the chat window offers Cut, Copy, Paste and Select All in the message box,
  Copy on selected text, and Copy Link Address on links. There was no right-click menu there before.

### Fixed
- **macOS: copy and paste.** The app's menu had no Edit menu, which macOS needs to route Cmd+C,
  Cmd+V, Cmd+X, Cmd+A and Cmd+Z, so they did nothing in the chat. The Edit menu is now there.
- **Failed photo and link uploads now say so.** When the upload itself failed (picpub rejecting
  it, a timeout, no network), the "Uploading…" line simply vanished and nothing else appeared.
  The error now stays under the message box until you click it, and is shown even if the message
  list cannot be found.

## [0.9.22] - 2026-09-19

### Added
- **Green dot for other Lit Chat users.** People who are also running Lit Chat get a small
  green dot in the user list, next to the menu arrow (hover it for "Uses LitChat"). When a
  private chat between two Lit Chat users opens, or a private message arrives, the apps
  recognise each other with an invisible handshake that other chat clients neither show nor
  react to. Who you have met is remembered per profile, so the dot is there straight away
  next time. Nothing is sent to people you are not talking to. This is an initial step for richer
  DMs when we know both sides are using the app.

### Changed
- Photo and link DMs are sent straight into their own chat tab instead of switching to it
  and back.

## [0.9.21] - 2026-09-18

### Fixed
- The ignore icon in the user list stays on the same line as the other icons instead of
  wrapping when the user is also a moderator or owner, or when the list has a scrollbar.

## [0.9.20] - 2026-09-18

### Changed
- **Ignore now works everywhere.** The site's own Ignore only applied in the room where you
  clicked it. Ignore and Unignore in the user popup menu now cover every room and private
  messages, trigger no notifications or away replies, and stick across sessions. Anyone you
  had already ignored is carried over; manage the list under ☰ → Notifications → Ignored Users.

## [0.9.19] - 2026-09-18

### Fixed
- Reopening a DM no longer shows a stray old photo at the bottom of the restored history, and
  photos appear at their real positions again.

## [0.9.18] - 2026-09-09

### Added
- A portable Windows build, `LitChat-windows-portable.exe`, next to the installer: a single file
  you can rename and put anywhere. The portable build does not auto-update.

## [0.9.17] - 2026-09-06

### Fixed
- Minimizing no longer makes the window vanish on Linux desktops without a tray. Minimize to
  tray is now off by default on Linux and refuses to hide the window when there is no tray.
- Unmaximizing no longer collapses the window to a bare title bar on Linux.

## [0.9.16] - 2026-09-03

### Added
- **Name Column** setting (☰ → Name Column) to widen the sender-name column so long usernames
  are not clipped. The default is now wider (150px); choose Normal to restore the old layout.

## [0.9.15] - 2026-09-03

### Added
- **Minimize to Tray** option in the menu.

### Fixed
- Relaunching the app restores the running window instead of starting a second, stuck process
  (the app seemed to disappear from the Windows 11 taskbar and had to be killed in Task Manager).

## [0.9.14] - 2026-09-01

### Security
- Fixed a way a crafted "View photo:" message could inject markup into your restored DM history.
- Link previews and hot-linked images now apply to private messages only, so links in public
  rooms no longer make the app contact arbitrary hosts. Previews refuse loopback and local-network
  addresses and read at most 256 KB.

### Fixed
- Message timestamps in the logs: large or slow messages and messages you sent are stamped with
  when they actually happened.
- Photo uploads no longer hang or freeze the window: every request has a timeout and files are
  streamed in slices instead of one large transfer.

### Changed
- Faster DM history: one shared, cached log reader, lazily loaded images, and placeholders for
  thumbnails that fail to load.

## [0.9.13] - 2026-07-28

### Fixed
- Old messages replayed or delivered late are logged with their original time instead of "now".
- Inline videos in DM chat hide the raw "View photo:" link like photos do, and shared videos in
  the restored DM history show as players instead of broken images.

## [0.9.12] - 2026-07-28

### Fixed
- Links and images in DM history appearing out of order.

### Added
- Videos can be dragged in or picked with the photo button, not just images.

## [0.9.11] - 2026-07-27

### Fixed
- A photo could land in the wrong DM tab if you switched tabs while it was uploading.

## [0.9.10] - 2026-07-21

### Added
- **Low Memory Mode** (GPU acceleration and spellcheck off), switched on automatically on systems
  with 4 GB of RAM or less. Your own choice is never overridden.

## [0.9.9] - 2026-07-11

### Changed
- Updated the underlying Electron runtime from 31 to 43.

## [0.9.8] - 2026-07-11

### Fixed
- Dragging in a photo could send the previous drag's image instead. The app now shows a note
  when an identical photo already in the album was reused.

## [0.9.7] - 2026-07-08

### Fixed
- Chat log messages that randomly went missing (received messages were sometimes not saved), and
  logging stopping for the rest of the session after opening DevTools.

### Changed
- DM history shows your last 100 messages instead of 30.
- Prefix a link with `!` to send the original picpub URL as it is instead of converting it to an
  album link.

## [0.9.6] - 2026-07-01

### Changed
- The macOS build is universal, so it runs on both Apple Silicon and Intel Macs. The README
  explains the Gatekeeper "damaged" message for unsigned apps, and on macOS the update menu item
  opens the GitHub releases page.

## [0.9.5] - 2026-06-24

### Added
- Right-click context menu in pop-up link and profile windows, and management of watched users.

## [0.9.4] - 2026-06-23

### Added
- Single-use and 1, 5 and 30 minute options for photo album link duration. A single-use album
  expires after the first view by someone else.

## [0.9.3] - 2026-06-13

### Fixed
- The logged-out login form sometimes showing on first load.

## [0.9.2] - 2026-06-13

### Fixed
- Photo DMs started from a room with a space in its name were rejected by the server and never
  arrived.
- Inline photos not showing for the recipient.

## [0.9.1] - 2026-06-08

### Fixed
- Bare picpub album links in DMs are shown as a plain link, the same as people without the app see.

## [0.9.0] - 2026-06-08

### Fixed
- Bug fixes and menu cleanup.

[0.9.26]: https://github.com/joeuser12/litchat/compare/v0.9.25...v0.9.26
[0.9.25]: https://github.com/joeuser12/litchat/compare/v0.9.24...v0.9.25
[0.9.24]: https://github.com/joeuser12/litchat/compare/v0.9.23...v0.9.24
[0.9.23]: https://github.com/joeuser12/litchat/compare/v0.9.22...v0.9.23
[0.9.22]: https://github.com/joeuser12/litchat/compare/v0.9.21...v0.9.22
[0.9.21]: https://github.com/joeuser12/litchat/compare/v0.9.20...v0.9.21
[0.9.20]: https://github.com/joeuser12/litchat/compare/v0.9.19...v0.9.20
[0.9.19]: https://github.com/joeuser12/litchat/compare/v0.9.18...v0.9.19
[0.9.18]: https://github.com/joeuser12/litchat/compare/v0.9.17...v0.9.18
[0.9.17]: https://github.com/joeuser12/litchat/compare/v0.9.16...v0.9.17
[0.9.16]: https://github.com/joeuser12/litchat/compare/v0.9.15...v0.9.16
[0.9.15]: https://github.com/joeuser12/litchat/compare/v0.9.14...v0.9.15
[0.9.14]: https://github.com/joeuser12/litchat/compare/v0.9.13...v0.9.14
[0.9.13]: https://github.com/joeuser12/litchat/compare/v0.9.12...v0.9.13
[0.9.12]: https://github.com/joeuser12/litchat/compare/v0.9.11...v0.9.12
[0.9.11]: https://github.com/joeuser12/litchat/compare/v0.9.10...v0.9.11
[0.9.10]: https://github.com/joeuser12/litchat/compare/v0.9.9...v0.9.10
[0.9.9]: https://github.com/joeuser12/litchat/compare/v0.9.8...v0.9.9
[0.9.8]: https://github.com/joeuser12/litchat/compare/v0.9.7...v0.9.8
[0.9.7]: https://github.com/joeuser12/litchat/compare/v0.9.6...v0.9.7
[0.9.6]: https://github.com/joeuser12/litchat/compare/v0.9.5...v0.9.6
[0.9.5]: https://github.com/joeuser12/litchat/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/joeuser12/litchat/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/joeuser12/litchat/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/joeuser12/litchat/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/joeuser12/litchat/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/joeuser12/litchat/compare/v0.8.9...v0.9.0
