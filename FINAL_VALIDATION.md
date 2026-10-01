# Social SEO 4.3.9 validation targets

- Chromium only.
- SEO Tracker absent.
- No visit queue or app-level concurrency cap.
- All started slots launch concurrently.
- No per-row rotation input or public per-slot rotation IPC.
- One global Keep Alive / rotation timer in Settings.
- Settings page stages edits and saves them with one Save settings action.
- Saving runtime timer/rule changes synchronizes all slots and restarts active sessions.
- ProxyScrape automatic source and manual proxy.txt import remain.
- Full verification: typecheck, smoke, runtime-smoke, lint, tests, production build, NSIS package.
