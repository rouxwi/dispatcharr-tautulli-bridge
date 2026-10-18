# Dispatcharr → Tautulli Remote bridge

See your **[Dispatcharr](https://github.com/Dispatcharr/Dispatcharr)** live TV and VOD streams in the
**[Tautulli Remote](https://github.com/Tautulli/Tautulli-Remote)** app, right next to your Plex activity.

Tautulli Remote can hold several Tautulli servers and shows their activity together. This small service
pretends to be one more Tautulli server, but its data comes from Dispatcharr. Add it to the app and you get:

- **Activity**: a card per viewer with the channel logo, what's on now (from your guide), channel number,
  user, device (e.g. *TiviMate (Android 14)*), source provider, resolution and bitrate, plus a progress bar
  through the current programme. VOD movies and episodes show up as movie/episode cards.
- **Stop stream** from the app (ends that viewer's connection in Dispatcharr).
- **History, Statistics, Users and Graphs**: the bridge records Dispatcharr sessions itself (Dispatcharr
  keeps no watch history), so you get most-watched channels, most active users and devices, plays per
  day/hour, peak concurrent streams, and per-user watch time.

Your real Tautulli keeps handling Plex. Nothing is changed in Dispatcharr.

---

## Requirements

- A recent **Dispatcharr** with API keys (Settings → Users), the `/proxy/ts/status` live status endpoint and
  the EPG `current-programs` endpoint.
- The **Tautulli Remote** app (Android / iOS), version 3.x.
- Docker.

## 1. Get a Dispatcharr API key

In Dispatcharr open **Settings → Users**, edit an **admin** user, and copy (or generate) its **API key**.
The bridge needs an admin key because it reads every user's streams and can stop them.

> ⚠️ Generating a *new* key replaces the old one. If other tools (Teamarr, Swaparr, …) already use this
> user's key, copy the existing key instead of generating a new one.

## 2. Make a device token

The app logs in with a 32-character token you choose:

```bash
openssl rand -hex 16
```

## 3. Run it

### Docker Compose (recommended)

```bash
git clone https://github.com/rouxwi/dispatcharr-tautulli-bridge.git
cd dispatcharr-tautulli-bridge
cp .env.example .env      # then edit .env
docker compose up -d --build
```

### docker run

```bash
docker run -d --name dispatcharr-tautulli-bridge --restart unless-stopped \
  -p 8182:8182 \
  -e DISPATCHARR_URL=http://192.168.1.10:9191 \
  -e DISPATCHARR_API_KEY=your-dispatcharr-api-key \
  -e DEVICE_TOKEN=your-32-character-token \
  -e SERVER_NAME=Dispatcharr \
  -v /path/to/data:/data \
  --memory 256m --cpus 0.5 \
  ghcr.io/rouxwi/dispatcharr-tautulli-bridge:latest
```

### Unraid

Build the image once from a shell (`git clone` this repo, then `docker build -t dispatcharr-tautulli-bridge .`), then add a container (Docker tab → *Add Container*) with repository `dispatcharr-tautulli-bridge`,
port `8182`, path `/data` → `/mnt/user/appdata/dispatcharr-tautulli-bridge`, and the four variables below.

### Settings

| Variable | Required | Description |
|---|---|---|
| `DISPATCHARR_URL` | yes | Dispatcharr's address as seen from the container, e.g. `http://192.168.1.10:9191` |
| `DISPATCHARR_API_KEY` | yes | API key of a Dispatcharr **admin** user |
| `DEVICE_TOKEN` | yes | 32 characters; the app uses it as its login |
| `SERVER_NAME` | no | Name shown in the app (default `Dispatcharr`) |
| `PORT` | no | Listen port (default `8182`) |
| `DATA_DIR` | no | Where history and devices are stored (default `/data`) |

Check it's up: `curl http://localhost:8182/health` → `ok`.

## 4. Add it to Tautulli Remote

In the app: **Settings → Register a Tautulli Server**, then either

- **type it in**: *Primary connection address* `http://<your-server>:8182` and *Device token* = your token, or
- **scan a QR code** containing `ADDRESS|TOKEN`, e.g.
  ```bash
  qrencode -o bridge.png "http://192.168.1.10:8182|your-32-character-token"
  ```

It appears as a second server (named after `SERVER_NAME`). Pull to refresh the Activity screen.

## Reaching it away from home

Put it behind your reverse proxy like any web app, over HTTPS. It answers on any path that ends in `/api/v2`,
so you can give it its own sub-domain **or** a path on an existing one.

**Sub-domain** (`https://dtv.example.com`): proxy to `http://<host>:8182`.

**Path on an existing host** (`https://tautulli.example.com/dispatcharr`), nginx / Nginx Proxy Manager
*Advanced* tab:

```nginx
location /dispatcharr/ {
    proxy_pass http://192.168.1.10:8182;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

In the app, use `https://tautulli.example.com/dispatcharr` as the address. The app stores a primary and a
secondary address, so you can keep the home address as the second one.

## How it works

- **Activity** polls Dispatcharr's live proxy status (`/proxy/ts/status`) and VOD stats (`/proxy/vod/stats/`),
  joins them with users (`/api/accounts/users/`), channels, M3U account names (to show the provider) and what's
  on now (`POST /api/epg/current-programs/`), and returns it as a Tautulli `get_activity` reply.
- **History** is recorded every 30 seconds into `DATA_DIR/history.json`: one entry per viewer per programme
  (a game and the show after it are separate entries). Plays under 90 seconds aren't kept (channel surfing),
  and history is kept for about 13 months. History starts the day you install the bridge.
- **Logos and posters** are proxied through the bridge. Channel logos are fitted onto a dark 2:3 poster tile,
  because the app crops images to fill a poster frame.
- **Field types matter.** The app casts each field strictly (e.g. `duration` must be a string), so every reply
  is built from real Tautulli responses used as type templates (`templates/`). If the app shows *Failure*, a
  type mismatch is the usual cause.

## Limitations

- It imitates the parts of the Tautulli API the app uses: activity, images, stop stream, history, home stats,
  users and graphs. Libraries, Recently Added and push notifications are empty or not supported.
- Users are Dispatcharr users. Connections without a known user show the client's IP address instead.
- A future Tautulli Remote release could need new endpoints; open an issue if a screen breaks.

## Troubleshooting

| Symptom | Check |
|---|---|
| App says *Invalid apikey* / won't register | Token in the app must equal `DEVICE_TOKEN` (32 characters). |
| App shows *Failure* on Activity | `docker logs dispatcharr-tautulli-bridge`; check the bridge can reach `DISPATCHARR_URL` and the API key is an admin's. |
| No program titles, only channel names | Those channels have no guide data in Dispatcharr. |
| Provider shows a host name | The stream's host doesn't match any M3U account's server URL. |

## Security

- Treat `DEVICE_TOKEN` like a password: anyone with it can see who is watching and stop streams.
- The Dispatcharr API key is an admin key; it stays inside the container and is never sent to the app.
- Use HTTPS when exposing it to the internet.

## License

MIT, see [LICENSE](LICENSE). Not affiliated with Tautulli or Dispatcharr.
