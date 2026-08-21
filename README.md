# 369 Showroom Check

> Scheduled proof that a showroom still matches its agreed layout — staff walk a round on their
> phone, the server compares each photo against the reference, and a missed round is visible.

369 Showroom Check is an [Expo](https://expo.dev) React Native app using Expo Router. An
administrator defines how many rounds happen per day and the time window for each. While a window
is open, staff record a round: the app guides them through a directional sweep of the room, uploads
the shots, and the server scores each one against the reference image for that direction. Rounds
that nobody walked show up as missed.

The judgement stays on the server. The phone guides and captures; it never decides whether a shot
passed.

## How a round works

1. **A window opens.** Rounds are configured with a start and end time — morning, afternoon,
   evening, night, as many as the site needs. Recording is only possible while a window is open.
2. **The sweep.** The recorder walks the operator through the directions that make up the round,
   using the gyroscope to tell them how far they have turned since the last shot.
3. **Upload.** Shots go up against that slot for that day. One recording per slot per day; a
   manager deleting one re-opens the slot.
4. **Comparison.** The server matches each shot to its reference and assigns a match band.
   Optionally an AI provider analyses the round as well.
5. **Review.** Comparisons, recordings and missed rounds are all browsable in the app.

### Why the gyroscope and not the compass

From [src/recorder/useTurnSense.js](src/recorder/useTurnSense.js): a showroom is full of steel
shelving, and a magnetometer indoors can sit still through a quarter turn or jump forty degrees
standing still. The gyroscope measures rotation itself and does not care what the room is made of.
It drifts, but only over minutes, and the question here spans the few seconds between one
photograph and the next.

It is **guidance and nothing more.** Nothing in the round waits on it — a phone with no gyroscope,
or one reading nonsense, must never stop somebody finishing their work. The real check on whether
they faced the right way is the comparison the server runs afterwards.

## Features

**Rounds** — open-round cards, the live slot clock driven by server time rather than device time,
and a recorder with capture-mode switching, directional capture, sweep chips and clip review.

**Recordings and comparisons** — per-recording detail, per-shot match proof, recompute-match, and
a comparison view per round.

**Missed rounds** — a dedicated list of slots that closed unrecorded.

**AI analysis** — optional, configured in-app. Three providers, each with a default model kept in
step with the server:

| Provider | Default model |
|---|---|
| Gemini | `gemini-2.5-flash` |
| Ollama | `llama3.2-vision` |
| OpenAI-compatible | *(none — set your own)* |

**Guides and manuals** — reference guides per round and in-app manuals served from Odoo.

**Settings** — rounds, AI, and general configuration, all gated on the manager role.

**Multi-language** — strings and error translation through
[src/i18n/](src/i18n/), with a language toggle.

## Tech stack

| | |
|---|---|
| Framework | Expo SDK ~54, React Native 0.81.5, React 19.1 |
| Routing | Expo Router 6 — `(auth)` and `(tabs)` groups |
| Auth | Context + `expo-secure-store`, with an Odoo database picker |
| Capture | expo-camera, expo-image-picker, **expo-sensors** (gyroscope), expo-video |
| Transport | JSON-RPC via [src/api/rpcClient.js](src/api/rpcClient.js) |
| Other | react-native-webview, expo-sharing, expo-intent-launcher, react-native-svg |

## Odoo backend

| Module | Purpose |
|---|---|
| `showroom_check` | Scheduled photo check that a showroom matches its agreed layout. v19.0.3.9.0, LGPL-3. |

It lives in [odoo_modules/showroom_check/](odoo_modules/showroom_check/).

**It depends on `base` and `web` only,** deliberately. This is not an HR or attendance module — it
needs no employees, contracts or payroll, and adding `hr` would drag a large dependency tree into
a database that may not want it.

The administrator configures rounds per day and their windows, capture duration, video quality and
format, who may record, and how long recordings are kept before automatic deletion.

**The Odoo-side dashboard requires HTTPS.** Browsers refuse camera access on pages served over
plain HTTP; the dashboard detects this and explains it. Reverse-proxy setup is in
[the module's own doc/README.md](odoo_modules/showroom_check/doc/README.md).

> **Naming note.** The product is Showroom Check, but the Odoo models, security groups and view
> files are still named `cleaning.*`, and the app keeps `src/cleaning/` and `src/api/cleaning.js`
> to match. The GitHub remote is likewise still `Cleaning_management`. Same thing, earlier name.

## Getting started

**Prerequisites** — Node.js 18+, npm, and a reachable Odoo 19 server with `showroom_check`
installed and served over HTTPS.

```bash
npm install
npx expo start
```

Sign in with the server address, pick the database, and authenticate. Recording needs camera
permission and a phone with a gyroscope for the turn guidance — the round still works without one.

Two helpers in [scripts/](scripts/) make testing possible outside a real window:

```bash
python scripts/seed_test_rounds.py     # create rounds to work against
python scripts/open_test_round.py      # force a window open now
```

## Project structure

```
app/                Expo Router routes
                      (auth)/login
                      (tabs)/ rounds, recordings, comparisons, profile
                      recorder, recording/[id], comparison/[id], guide/[id]
                      missed, help, settings/ (index, rounds, ai)
src/
  api/              rpcClient, backend, cleaning, config, manual, errors
  recorder/         CaptureModeSwitch, DirectionCapture, SweepChips,
                    ClipReview, useTurnSense (gyroscope guidance)
  cleaning/         dates, matchBands, serverClock, useSlotClock
  auth/             AuthContext, RequireAuth, storage
  components/       AppDialog, DatabasePicker, PhotoCapture, ImageViewer,
                    ManualList, OpenRoundCard, GradientBackground, ...
  i18n/             LanguageProvider, translations
  theme/ utils/
scripts/            seed_test_rounds.py, open_test_round.py
odoo_modules/       showroom_check
Documents/          administrator and user manuals, plus screenshots
```

## Documentation

- [Documents/App document/](Documents/App%20document/) — *369 Showroom Check — Administrator
  Manual* and *— User Manual*, each as `.docx` and `.pdf`, with a screenshot set (including a
  redacted variant).
- [AGENTS.md](AGENTS.md) — a standing reminder to read the versioned Expo docs before writing code.
