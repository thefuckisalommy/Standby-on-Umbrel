# Standby on Umbrel

Community app store for [Standby](https://github.com/thefuckisalommy/Standby-on-Umbrel) — presigned Bitcoin transactions, ready when they're needed.

Standby helps you prepare Bitcoin transactions in advance and keep them ready for whenever the time comes to use them. Whether you're planning for the unexpected, creating a Bitcoin inheritance plan, or simply keeping a transaction ready for future use, Standby gives you a way to prepare today without needing to act today.

> **Runs on Umbrel or on any Linux box with Docker.** The prebuilt image is built for arm64 and amd64, so it runs on umbrelOS (Raspberry Pi or x86) and on plain Docker — see [Run on any Linux box (Docker)](#run-on-any-linux-box-docker).

## Features

- **Prepare in advance** — store presigned Bitcoin transactions for future use. Sign each one in your own wallet and paste the raw signed hex, or import it from a file — a plain hex file, or a fully-signed PSBT (.psbt); the app never sees your keys.
- **Broadcast manually** — send a prepared transaction whenever you decide it's time.
- **Automate with check-ins** — set a check-in interval. If you stop checking in past it, Standby broadcasts the transactions you armed.
- **Check in from anywhere** — from the app, or with a check-in API key: one address works for any connection (a bot, a shortcut, a script, or any HTTP client). A key can only record a check-in.
- **Dry-run before you trust it** — a dry-run checks whether the inputs are still unspent, and whether an absolute locktime has passed. It never broadcasts. A spent input is read three ways: our own transaction already out there means broadcast, a confirmed spend by another transaction means stale (never broadcast), and an unconfirmed spend by another transaction means a warning — the transaction stays active and a broadcast is still attempted. A transaction whose locktime has not passed yet is reported as timelocked — the node would reject it as non-final — and a failed broadcast is retried on the next hourly check until it succeeds or the inputs are spent.
- **Two mempool nodes** — a primary (mempool.space) with a secondary (blockstream.info) as fallback, so one node being down doesn't stop a broadcast.
- **Slipstream broadcast route** — each transaction can go out via the public mempool or straight to MARA Pool's private mempool (Slipstream). A Slipstream submission stays private until MARA mines it, and it gets its own status — “Slipstream Pending” — until the public nodes see it. Broadcasts and submissions waiting for confirmation live in the Pending Transactions card, and are never re-sent by Broadcast All or the release. A Slipstream transaction can also carry an opt-in Public Fallback (1–90 days, Never by default): if MARA hasn't confirmed it within the chosen time, Standby broadcasts it publicly instead.
- **Pending Transactions** — a card above Archived for transactions that are out the door but not yet confirmed: a public broadcast waiting for its first confirmation (“Broadcast”) and a Slipstream submission waiting on MARA (“Slipstream Pending”). Once confirmed, a tx moves to Archived. A pending tx's hex and route are locked (only the label and notes can change), and a Slipstream-pending tx carries a manual “Broadcast publicly” button if you do not want to wait on MARA.
- **Backup and restore** — export everything (including the check-in keys) as a `standby-backup` file and restore it on a fresh install.

## How it works

- You sign a transaction in your own wallet and paste the raw signed hex into Standby — or import it from a file (a plain hex file, or a fully-signed PSBT; a PSBT that is not fully signed is rejected).
- The app validates the structure and watches the inputs: spend an input with a confirmed transaction and it goes stale — it will never be broadcast; spend it with an unconfirmed one and it warns instead; and if the spending transaction is our own, the transaction is already out there, so it is recorded as broadcast.
- You check in on your schedule, from the app or from any device with a check-in API key.
- If you stop checking in past the broadcast threshold, Standby broadcasts the transactions you armed, in order.
- Once a release starts, it finishes: every armed transaction broadcasts, even if you check in halfway through. The check-in is still recorded, and it resets the clock for the next cycle.
- Your keys never leave your wallet. The app holds only the signed transactions you pasted in; it queries your mempool nodes with your transaction IDs to check the inputs, and sends the full signed hex to a node only when it broadcasts.

## Setup

In Umbrel: App Store → Community App Stores → add this repo's URL:

```
https://github.com/thefuckisalommy/Standby-on-Umbrel
```

Then install Standby from the store. The app's Docker image is built for arm64 and amd64 by GitHub Actions on every push and published to GHCR, so installing just pulls it.

After installing, open the app and add your first transaction: sign it in your own wallet, paste the raw signed hex (or import a hex file or a fully-signed PSBT), and arm it. Set the check-in interval in Settings, then check in — from the app, or by creating a check-in API key for your gadget, shortcut, bot, or script.

## Run on any Linux box (Docker)

No Umbrel needed. Standby is a plain Docker image (`ghcr.io/thefuckisalommy/standby:latest`, multi-arch amd64 and arm64) that runs anywhere Docker runs. It is two services from the same image: the web UI, and a check-in receiver that only records check-ins.

**Prerequisites:** Docker Engine and the Compose plugin. If you don't have them, follow the [Docker Engine install docs](https://docs.docker.com/engine/install/) for your distro, then confirm with `docker compose version`.

**Start it:**
```sh
mkdir standby && cd standby
curl -O https://raw.githubusercontent.com/thefuckisalommy/Standby-on-Umbrel/main/docker-compose.yml
docker compose up -d
# open http://localhost:3100
```

**What is running:**
- `web` — the Standby UI and API, on port 3100. It listens on localhost only (`127.0.0.1:3100`) by default.
- `checkin` — the check-in receiver, on port 3101. It runs the same image with `node checkin-receiver/server.js` and mounts only the shared `./checkin` directory, so it can record a check-in but cannot see or change your transactions.

**Ports:** override with `STANDBY_WEB_PORT` (default 3100) and `STANDBY_CHECKIN_PORT` (default 3101), e.g. `STANDBY_WEB_PORT=8080 docker compose up -d`.

**Reaching the UI:** there is no login screen on this path, and the web UI is localhost-only by default — it is not exposed to your network. Reach it on the box itself, over SSH (`ssh -L 3100:localhost:3100 <box>`), over Tailscale, or behind your own reverse proxy with auth. To open it to your LAN instead, change the web port line in `docker-compose.yml` to `"${STANDBY_WEB_PORT:-3100}:3100"` — only on a network you trust.

**Check-ins:** the receiver listens on port 3101 for API-key check-ins, same as on Umbrel: `curl -X POST http://<box>:3101/checkin -H "Authorization: Bearer <your key>"`. It is plain HTTP, protected only by the key — keep it on your trusted LAN or Tailscale network, as in [SECURITY.md](SECURITY.md).

**Data:** lives in `./data` (app state) and `./checkin` (receiver state) next to the compose file, as plain files. Back up by copying those two directories, or use the in-app Backup download; restore with the in-app Restore.

**Updating:** `docker compose pull && docker compose up -d` — pulls the new `:latest` image and restarts both services. Your data in `./data` and `./checkin` is untouched.

**Stopping:** `docker compose down` stops both services. It does not delete `./data` or `./checkin` — delete those directories yourself to wipe everything.

Everything else — signing, arming, check-ins, releases — works exactly as on Umbrel.

**Without Compose (plain `docker run`):**
```sh
mkdir -p data checkin
docker run -d --name standby-web --restart on-failure -p 127.0.0.1:3100:3100 -v "$PWD/data:/data" -v "$PWD/checkin:/checkin" ghcr.io/thefuckisalommy/standby:latest
docker run -d --name standby-checkin --restart on-failure -p 3101:3101 -v "$PWD/checkin:/checkin" -e PORT=3101 -e CHECKIN_DIR=/checkin ghcr.io/thefuckisalommy/standby:latest node checkin-receiver/server.js
# open http://localhost:3100
```

**Build it yourself / run from source:**
```sh
git clone https://github.com/thefuckisalommy/Standby-on-Umbrel.git
docker build -t standby Standby-on-Umbrel/standby
docker run --rm -p 127.0.0.1:3100:3100 -v "$PWD/data:/data" -v "$PWD/checkin:/checkin" standby
# open http://localhost:3100
```

Or plain Node 24+ (no Docker): `cd Standby-on-Umbrel/standby && node server.js` — same port, data in `./data` next to the server.

## Check-in API keys

The Check-in API keys card shows one address — the receiver URL, filled in by the page itself from `window.location.hostname` (the host the page was opened on IS this Pi: LAN IP, `umbrel.local`, or Tailscale IP). That one address works for any connection, with the key as the password. The key is shown once, when it is created — copy it then.

The details: the check-in endpoint is `POST <address>/checkin` with the key as an `Authorization: Bearer` token, the health check is `GET <address>/health`, and any custom integration takes the address as its base URL (auth Bearer, test path `/health`). A `curl` one-liner: `curl -X POST <address>/checkin -H "Authorization: Bearer <your key>"`.

The receiver answers with nothing but `{"ok": true}`, and every bad key gets the same generic 401 — a caller learns nothing about the setup. The receiver holds no transaction data: it has two routes (`GET /health`, `POST /checkin`), mounts only the checkin directory, and cannot read, generate, or broadcast anything.

The check-in connection is plain HTTP, so the key travels unencrypted. The warnings — keeping port 3101 on your trusted LAN and Tailscale network only, and what a stolen key can do — are in [SECURITY.md](SECURITY.md).

## Broadcast nodes

The app broadcasts via a primary mempool node with a secondary as fallback (mempool.space, then blockstream.info). A release re-checks every armed transaction's inputs first — a confirmed spend of an input by another transaction means stale, never broadcast (an unconfirmed spend warns; our own transaction out there means broadcast) — and a broadcast has a 15-second deadline. The release is evaluated hourly and on demand.

## Slipstream (MARA) broadcast route

Each transaction has its own broadcast route, chosen when you add it and changeable in the Edit popup while it is still Active: **Public mempool** (the default) or **Slipstream (MARA)**. Once the transaction is out the door the route locks, like the hex — if it drops back to 'release-due' it becomes Active again and the route becomes changeable again. Only the selected route is attempted — if Public fails it does not try Slipstream, and if Slipstream fails it does not try Public; there is no automatic fallback on failure. The hourly retry re-attempts the same selected route. The only automatic public broadcast is the opt-in fallback timer below.

Slipstream sends the signed transaction straight to MARA Pool's private mempool, bypassing the public mempool entirely. It stays private until MARA mines it into a block — nobody else can see the transaction (or the keys and spending details behind it) before it confirms. That is the point, and the limit: MARA is about 5% of hashrate, so a Slipstream-only transaction can wait, and admission is best-effort — it does not guarantee a block.

A Slipstream submission gets its own status, **“Slipstream Pending”** — a pseudo-pending-but-success state. It is not “Broadcasted” yet, because it is not visible in the public mempool. It lives in the Pending Transactions card (above Archived), alongside public broadcasts waiting for their first confirmation (“Broadcast”). The app checks on the hourly tick (and on a manual release check): once the public nodes see the transaction, it becomes Broadcasted and moves to Archived; if MARA drops it, it becomes Failed and is retried via Slipstream on the next hourly check. The card shows Slipstream's queue position and next-block likelihood when the last status check brought them back. Neither a public-pending nor a Slipstream-pending tx is re-sent by Broadcast All or the release — they are already out the door.

If you do not want to wait on MARA, a Slipstream-pending card carries a manual **“Broadcast publicly”** button. It broadcasts that one transaction via the public mempool, right now — and only by hand: it is not part of Broadcast All or the release. The confirm names the cost: broadcasting publicly makes the transaction visible to everyone in the public mempool, giving up the Slipstream privacy. On success the tx becomes public-pending (and follows the normal path from there); on failure the error is shown and the tx stays Slipstream-pending.

### Public fallback

A Slipstream transaction can carry an opt-in **Public Fallback**: a number of days (1, 3, 7, 14, 30, 60, or 90; **Never** by default). If the transaction is not publicly visible within that time, Standby broadcasts it publicly instead — the automatic version of the manual button above, for when nobody is watching. The deadline runs from when MARA first accepted the transaction, and changing the duration in the Edit popup while it waits re-times the deadline from that same acceptance (it does not restart the clock); the pending card counts down to it, and the Edit popup for a pending transaction carries a note saying so. A transaction whose Slipstream submit keeps failing falls back from its first attempt instead — so a fee-too-low rejection still goes public after the timer, since the public mempool's floor is lower than Slipstream's. The fallback is checked on the hourly tick and on a manual release check, after the MARA status refresh, and only for Slipstream-route transactions with a duration set. It never fires for a transaction that is already publicly visible (that is recognised as broadcast instead), already broadcast, stale, disarmed, or while releases are paused — and a check-in does not cancel a due fallback. On success the stored route becomes public and the broadcast log says it was a public fallback; on failure the transaction stays as it was and the next tick tries again.

Two things to know before using it. First, the fee floor: Slipstream only accepts transactions at or above its minimum submission rate — currently the higher of 2x the mempool priority fee rate or 2 sat/vB. Standby does not pre-check the fee rate; it attempts the submission and surfaces Slipstream's rejection reason if the fee is too low. Second, the public nodes stay for verification: confirmations, input freshness, and the tip height all still come from your mempool nodes, because Slipstream has no outspend lookup and no general transaction search — it only submits. A check-in clears the “Slipstream Pending” record like any other cycle record, but it cannot recall a transaction already sitting in MARA's queue: if MARA mines it, the app recognises it as broadcast once the public nodes see it; if MARA drops it, the next release re-submits it.

## Warning

**What Standby is not.** Standby is a helper, not an inheritance plan, and it cannot promise your transactions will ever be broadcast. It holds no keys and cannot recover anything by itself — it can only broadcast transactions you already signed and stored. It runs on one device that can fail, lose power, or be destroyed; it depends on network access and on a reachable mempool node. The inputs your transactions spend can be moved first, which makes a stored transaction invalid; a stored transaction may not even be valid under Bitcoin's consensus rules, which Standby does not fully check; and even a transaction that does get broadcast can carry too little fee to confirm, leaving it stuck in the mempool. And like any software, it can have bugs. Any of those can mean your heirs receive nothing from this app — the broadcast never goes out, or it goes out and never confirms. If you use Standby as part of planning for the unexpected, have a backup that does not depend on this app working.

## Security

Security notes live in [SECURITY.md](SECURITY.md) — read it before arming a transaction. The short version: Standby's web UI and API are protected only by Umbrel's app login (do not disable it), your signed transactions are stored unencrypted and are bearer, and the check-in receiver on port 3101 is plain HTTP, so keep it on your trusted LAN and Tailscale network only. On the generic Docker path there is no login at all — the web UI listens on localhost only by default; see "Run on any Linux box" before exposing it.
