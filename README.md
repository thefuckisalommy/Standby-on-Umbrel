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

## Warning

**What Standby is not.** Standby is a helper, not an inheritance plan, and it cannot promise your transactions will ever be broadcast. It holds no keys and cannot recover anything by itself — it can only broadcast transactions you already signed and stored. It runs on one device that can fail, lose power, or be destroyed; it depends on network access and on a reachable mempool node. The inputs your transactions spend can be moved first, which makes a stored transaction invalid; a stored transaction may not even be valid under Bitcoin's consensus rules, which Standby does not fully check; and even a transaction that does get broadcast can carry too little fee to confirm, leaving it stuck in the mempool. And like any software, it can have bugs. Any of those can mean your heirs receive nothing from this app — the broadcast never goes out, or it goes out and never confirms. If you use Standby as part of planning for the unexpected, have a backup that does not depend on this app working.

## Security

Security notes live in [SECURITY.md](SECURITY.md) — read it before arming a transaction. The short version: Standby's web UI and API are protected only by Umbrel's app login (do not disable it), your signed transactions are stored unencrypted and are bearer, and the check-in receiver on port 3101 is plain HTTP, so keep it on your trusted LAN and Tailscale network only. On the generic Docker path there is no login at all — the web UI listens on localhost only by default; see "Run on any Linux box" before exposing it.
