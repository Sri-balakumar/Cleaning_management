# Cleaning Management

Proof-of-visit for office cleaning staff. An administrator sets up the daily
cleaning rounds and their times; a Record button on the dashboard becomes
available only while a round's window is open, and records a short clip from the
camera as evidence that somebody attended.

---

## Before it will work: HTTPS is required

**Web browsers refuse to give a page access to the camera unless the address
starts with `https`.** This is a browser security rule and cannot be turned off
from inside Odoo.

At the moment this server is reached at `http://10.96.160.80:8069`, so the
Record button will show a message explaining the problem instead of working.
The module is complete and correct; it simply cannot get to the camera from a
plain `http` address.

There are two ways to fix it.

### Option A — put a reverse proxy in front of Odoo (recommended)

This is the proper fix and only has to be done once.

1. **Install [Caddy](https://caddyserver.com/download)** on the Odoo server.
   Ports 80 and 443 are currently free.

2. **Create a Caddyfile** — a working starting point is in
   `Caddyfile.sample` next to this file. Adjust the host name at the top.

3. **Tell Odoo it is behind a proxy.** In
   `C:\Program Files\Odoo 19.0.20260119\server\odoo.conf`, change:

   ```ini
   proxy_mode = True
   ```

   Then restart the Odoo service.

4. **Point people at the new address.** In Odoo, go to Settings, turn on
   developer mode, then Technical → System Parameters and set `web.base.url` to
   the new `https://...` address.

5. **Trust the certificate.** Caddy issues its own certificate for a local name.
   Each computer needs to trust it once, or people will see a warning the first
   time. If the server has a real DNS name reachable from the internet, Caddy
   will fetch a genuine certificate automatically and there is nothing to trust.

> **Why `request_buffers` is in the sample file:** without it, Caddy passes a
> slow upload straight through, so a cleaner on poor Wi-Fi ties up an Odoo
> worker for the whole transfer and the request gets cut off at the two-minute
> limit. With it, Caddy takes the upload at the client's pace and hands Odoo the
> finished file all at once. It is the single most useful line in the file.

### Option B — a per-computer workaround, for testing only

Chrome and Edge can be told to treat one specific plain-`http` address as if it
were secure. Add these to the browser shortcut's target:

```
--unsafely-treat-insecure-origin-as-secure=http://10.96.160.80:8069
--user-data-dir=C:\Temp\odoo-camera-profile
```

This has to be repeated on every computer that records, and it breaks if the
server's address ever changes. Use it to try the module out, not to run it.

---

## Setting it up

1. **Install the module.** Apps → search for *Cleaning Management* → Install.

2. **Give people access.** Settings → Users → pick a person → under
   **Cleaning Management** choose:
   - **User** — can open the dashboard and record.
   - **Manager** — can also set everything up, see everybody's recordings, and
     delete them.

   Administrators get Manager automatically.

3. **Set up the rounds.** Cleaning → Configuration → Settings:
   - **Office timezone** — the one clock the whole schedule runs on. All times
     below are read in this timezone for everybody, so the window opens at the
     same real moment no matter where the person looking at it is.
   - **Rounds** — add one line per visit with a name and a start and end time.
   - **Recording** — how long each recording lasts, the picture quality, and the
     format.
   - **Who can record** — either everyone with the User role, or a specific list.
   - **Keeping recordings** — how long to keep them, and whether to delete the
     whole entry or just the video.

---

## How it works day to day

A cleaner opens **Cleaning**. Each round for today is shown as a card:

| Card | Meaning |
|---|---|
| Grey, counting down | The round has not started yet |
| **Blue with a Record button** | The window is open — press Record |
| Green with a tick | Already recorded today |
| Red | The window passed and nothing was recorded |

Pressing **Record now** opens the camera, shows a preview, and records for the
configured length with a countdown. The clip then uploads with a progress bar.

Only one recording is kept per round per day. If it needs to be done again, a
Manager deletes the existing recording, which re-opens that round.

---

## Things worth knowing

**Rounds cannot run past midnight.** A night round from 22:00 to 02:00 has to be
entered as two rounds: 22:00–23:59 and 00:00–02:00.

**Keep recordings short.** Thirty to sixty seconds is plenty. This server stops
any request that takes longer than two minutes, and a long recording produces a
file too large to upload in that time. The settings page shows the expected file
size and refuses to save a combination that would be too big.

**No sound is recorded.** This keeps the files small, avoids a second permission
prompt, and avoids capturing conversations happening around the camera. Consider
whether the people being recorded should be told; in many places that is a legal
requirement.

**Deleting a recording does not immediately free disk space.** Odoo marks the
file and removes it during a later clean-up, usually within a day. This is
normal and is not a sign that the deletion failed.

**"The camera is being used by another program"** is the most common problem in
practice. Teams, Zoom and similar apps hold onto the camera even when they look
closed.

---

## If something is not working

Turn on developer mode, open the Cleaning dashboard, and press
**Diagnostics**. That panel shows whether the connection is secure, which
cameras were found, whether permission was granted, and which video formats this
browser actually supports. A screenshot of it answers most questions in one go.

---

## Technical notes

- Models: `cleaning.config`, `cleaning.slot`, `cleaning.recording`, and a
  read-only report view `cleaning.slot.missed`.
- Depends only on `base` and `web`. This is **not** an HR or attendance module
  and needs no employee records.
- Videos are stored as Odoo attachments in the file store, so they are included
  in a normal Odoo backup.
- Old recordings are removed by Odoo's own housekeeping job — there is no
  separate scheduled action to configure.
- The upload route has its own size limit taken from **Maximum Upload Size** in
  the settings. It does not change the limit for any other upload in the
  database.

### Running the tests

```
odoo-bin -d <database> -i cleaning_management --test-enable \
         --test-tags /cleaning_management --stop-after-init
```
