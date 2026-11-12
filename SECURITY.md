# Standby — security notes

Standby holds presigned Bitcoin transactions. Read this before arming one.

## The app login is Umbrel's — do not disable it

Standby's web UI and API are protected only by Umbrel's app login. The app has no login of its own. Do not disable Umbrel's app login for Standby (the per-app toggle, or `PROXY_AUTH_ADD: "false"` in the compose) — with it off, anyone who can reach the app can read, change, and broadcast your transactions.

State-changing API requests are also rejected unless they come from the app's own page: the browser's Origin must match the app (or the proxy's forwarded host), and the request must use a JSON content type. So another website you visit cannot trigger a check-in, a pause, or a broadcast with your login — scripts and curl, which send no Origin, are unaffected.

## Your signed transactions are stored unencrypted — and they are bearer

Standby stores your signed transactions unencrypted in the app's data directory on the device. A signed transaction is bearer: whoever holds the signed hex can broadcast it, with or without Standby. Anyone who can read the app's data directory — device SSH, Docker access, a stolen drive — can read your signed transactions. Protect access to the device itself.

A signed hex also reveals the destination addresses and amounts.

## Broadcasts are real

The dry-run buttons only check whether the inputs are still unspent — they never broadcast. A release broadcasts for real, so keep the inputs unspent (spend one and the transaction goes stale and is never broadcast), use RBF so the heir can fee-bump, and remember a false-positive release moves real funds. If this device is down, nothing broadcasts.

A release re-checks every armed transaction's inputs first — a spent input means stale, never broadcast — and a broadcast has a 15-second deadline. Releases are evaluated hourly and on demand.

## Broadcast All sends disarmed transactions too

Disarming a transaction only stops automatic release. Broadcast All sends every stored transaction that has not broadcast yet, including disarmed ones. (The confirmation dialog says so when you click it.)

## Check-in keys and the receiver (port 3101)

A check-in key can only record a check-in: it cannot read your transactions, broadcast anything, or change settings. Give each service its own key so you can revoke one without touching the others. The key is shown once, when it is created — copy it then.

The check-in connection is plain HTTP: the key travels unencrypted. Keep port 3101 on your trusted LAN and Tailscale network only — never port-forward it or expose it to the internet. A stolen key can only check in, but it can keep the switch from ever triggering, so revoke a key the moment you suspect it leaked.

The receiver holds no transaction data: it has two routes (`GET /health`, `POST /checkin`), mounts only the checkin directory, and cannot read, generate, or broadcast anything. It answers every bad key with the same generic 401, so a caller learns nothing about the setup. Each check-in records the caller's address, shown in the Recent check-ins log, so a check-in you didn't make is visible.

## Backups are not encrypted

A backup is a plain JSON file of everything needed to restore the setup: every signed transaction (hex included), your settings, and the check-in clock, plus the check-in and broadcast history and the check-in key hashes. It contains the signed hexes, which reveal the destination addresses and amounts, so treat it like the transactions themselves and keep it somewhere safe.

## What leaves the device

Your keys never leave your wallet — the app never sees them. The app queries your mempool nodes with your transaction IDs to check the inputs (mempool.space as primary, blockstream.info as fallback), and sends the full signed hex to a node only when it broadcasts. Nothing else leaves the device: no keys, no recipient, no messages.
