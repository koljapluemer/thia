# Next steps

The desktop app's own steps.

- [x] **The desktop app serves the gestalter**, as `gestalter` (formerly `gestalts-connector`).
- [x] **gestalts-node ships no app**: gestalter is a website on it, the node has its own settings page: see
  [desktop.md](desktop.md).
- [x] The deployed apps' origins in `ORIGINS` (gestalter.koljasam.com, loop.koljasam.com).
- [ ] A webview instead of the default browser, maybe: on Linux it would bring back GTK (webkit2gtk), which the tray
  avoids.
- [x] Pairing devices and the Android app: removed (2026-11-23); phones use the use app in the browser.
- [ ] Release builds of the desktop app on macOS and Windows runners (their tray and event-loop code is untested),
  and code signing.
- [ ] CI.
