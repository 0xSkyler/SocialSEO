# Social SEO 4.3.9 — Concurrent Chromium + Central Keep Alive Timer

Social SEO 4.3.9 keeps the 4.3.7 concurrent model, removes the SEO Tracker, and replaces all per-row rotation timers with one central saved Keep Alive / rotation timer in Settings.

Proxy transport failures are now self-healing: the failed endpoint is marked dead, the slot rotates to another validated proxy, and the same target is retried automatically with a bounded backoff guard.

## Central settings model

- Open **Settings**.
- Edit the central **Keep Alive / rotation timer (seconds)** and any other settings.
- Nothing is persisted while you are editing.
- Click **Save settings** once to save the full settings draft.
- The central rotation value is pushed to every logical slot.
- If the timer or Keep Alive rules changed while slots were active, those active slots are closed and restarted concurrently so the new values take effect immediately.
- The Control Center shows the global timer as read-only; there are no per-slot timer overrides.

## Runtime

All started slots run concurrently with no queue. Each started slot owns its own temporary non-persistent Chromium session while Keep Alive is active. At its global rotation deadline the slot closes Chromium, rotates proxy, and starts a fresh session.

## Build

```powershell
npm.cmd install
npm.cmd run package:win
```

Expected installer:

```text
release\Social-SEO-Setup-4.3.9.exe
```
