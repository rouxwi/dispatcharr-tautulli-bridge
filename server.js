// Dispatcharr as a "Tautulli server" for the Tautulli Remote app (2026-10-14).
// The app can hold several Tautulli servers and shows their activity together, so this
// answers the Tautulli API (/api/v2?cmd=...) with Dispatcharr's live and VOD streams.
// Plex keeps using the real Tautulli. Only what the app needs is implemented:
//   register_device, get_tautulli_info, get_server_info, get_server_id, get_activity,
//   pms_image_proxy (channel logos / posters), terminate_session (stop a stream).
// History, statistics, users and graphs come from stats.js, which records sessions itself.
// Any other command answers "success" with an empty result.
// Auth: the app sends the 32-character device token as `apikey`; anything else gets 401.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const DIR = __dirname;
const TEMPLATES = path.join(DIR, 'templates');
const DATA_DIR = process.env.DATA_DIR || path.join(DIR, 'data');
const PORT = +(process.env.PORT || 8182);
const DISPATCHARR = (process.env.DISPATCHARR_URL || '').replace(/\/$/, '');
const API_KEY = process.env.DISPATCHARR_API_KEY || '';
const TOKEN = process.env.DEVICE_TOKEN || '';
const SERVER_NAME = process.env.SERVER_NAME || 'Dispatcharr';
// Stable ids so the app recognises this server across restarts (never the real Tautulli's).
const SERVER_ID = crypto.createHash('md5').update('dispatcharr-tautulli:' + DISPATCHARR).digest('hex');
const PMS_ID = crypto.createHash('sha1').update('dispatcharr-pms:' + DISPATCHARR).digest('hex');

if (!DISPATCHARR) { console.error('DISPATCHARR_URL is required, e.g. http://192.168.1.10:9191'); process.exit(1); }
if (!API_KEY) { console.error('DISPATCHARR_API_KEY is required (an admin user\'s API key from Dispatcharr)'); process.exit(1); }
if (TOKEN.length !== 32) { console.error('DEVICE_TOKEN must be exactly 32 characters (e.g. openssl rand -hex 16)'); process.exit(1); }
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'session-template.json'), 'utf8'));
const EMPTY = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'empty-replies.json'), 'utf8'));
const INFO = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'tautulli-info.json'), 'utf8'));
const DEVICES = path.join(DATA_DIR, 'devices.json');
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function dx(p, opts = {}) {
  const r = await fetch(DISPATCHARR + p, { ...opts, headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`dispatcharr ${p}: HTTP ${r.status}`);
  return r.json();
}
// Slow-changing lookups, cached.
const cache = {};
async function cached(key, ttlMs, fn) {
  const c = cache[key];
  if (c && Date.now() - c.at < ttlMs) return c.v;
  try { const v = await fn(); cache[key] = { v, at: Date.now() }; return v; }
  catch (e) { if (c) return c.v; throw e; }
}
const users = () => cached('users', 10 * 60e3, async () => {
  const list = await dx('/api/accounts/users/');
  return Object.fromEntries((Array.isArray(list) ? list : list.results || []).map(u => [String(u.id), u.username]));
});
// The channels endpoint has no uuid filter, so keep one uuid -> channel map (refreshed every 30 min,
// or straight away when a channel isn't in it, e.g. a new Teamarr live-game channel).
async function channelInfo(uuid) {
  const load = async () => {
    const r = await dx('/api/channels/channels/');
    return Object.fromEntries((Array.isArray(r) ? r : r.results || []).map(c => [c.uuid, { id: c.id, name: c.name, channel_number: c.channel_number, logo_id: c.logo_id }]));
  };
  let map = await cached('channels', 30 * 60e3, load);
  if (!map[uuid] && Date.now() - (cache.channels?.at || 0) > 60e3) { delete cache.channels; map = await cached('channels', 30 * 60e3, load); }
  const c = map[uuid];
  return c ? { ...c, channel_number: Number.isInteger(+c.channel_number) ? +c.channel_number : c.channel_number } : null;
}
// Provider host -> Dispatcharr's account name ("Ultimate", "8K", "Trex").
const providers = () => cached('providers', 30 * 60e3, async () => {
  const r = await dx('/api/m3u/accounts/');
  const map = {};
  for (const a of Array.isArray(r) ? r : r.results || []) {
    try { if (a.server_url) map[new URL(a.server_url).hostname] = a.name; } catch {}
  }
  return map;
});
const nowPlaying = () => cached('programs', 60e3, async () => {
  const list = await dx('/api/epg/current-programs/', { method: 'POST', body: JSON.stringify({ channel_uuids: null }) });
  return Object.fromEntries((list || []).map(p => [p.channel_uuid, p]));
});

const isLan = ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip || '');
function device(ua = '') {
  const m = ua.match(/^([A-Za-z][\w .+-]*?)\/([\d.]+)(?:\s*\(([^;)]+))?/);
  const product = m ? m[1].trim() : (ua.split(/[ /]/)[0] || 'Unknown');
  const platform = /android/i.test(ua) ? 'Android' : /iphone|ipad|ios|darwin/i.test(ua) ? 'iOS' : /tvos|apple ?tv/i.test(ua) ? 'tvOS' : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'macOS' : /linux/i.test(ua) ? 'Linux' : 'Other';
  return { product, player: m?.[3] ? `${product} (${m[3].trim()})` : product, platform, version: m?.[2] || '' };
}
const res = h => (h >= 2160 ? '4k' : h >= 1080 ? '1080' : h >= 720 ? '720' : h >= 480 ? '480' : h ? 'sd' : '');
const sessionKey = id => String(parseInt(crypto.createHash('md5').update(id).digest('hex').slice(0, 7), 16));
const logoPath = (kind, id) => (kind === 'logo' ? `/dispatcharr/logo/${id || 0}` : id ? `/dispatcharr/${kind}/${id}` : '');

// Guide titles carry markers like "ᴺᵉʷ" in superscript letters; drop them.
const clean = t => String(t || '').replace(/[ᴬ-ᵪᶜ-ᶿʰ-˿⁰-₟]+/g, '').replace(/\s{2,}/g, ' ').trim();
// The app casts fields strictly (e.g. `duration as String?`), so every value must have the same JSON type
// real Tautulli uses for it - the template keeps those types.
function session(over) {
  const s = { ...TEMPLATE, ...over };
  s.title = clean(s.title); s.parent_title = clean(s.parent_title);
  s.full_title = s.grandparent_title ? `${s.grandparent_title} - ${s.title}` : s.title;
  for (const [k, v] of Object.entries(s)) {
    const want = typeof TEMPLATE[k];
    if (!(k in TEMPLATE) || v === null || v === undefined) continue;
    if (want === 'string' && typeof v !== 'string') s[k] = String(v);
    else if (want === 'number' && typeof v !== 'number') s[k] = Number.isFinite(+v) ? +v : 0;
  }
  return s;
}

async function activity() {
  const [status, vod, names, programs, provs] = await Promise.all([
    dx('/proxy/ts/status'), dx('/proxy/vod/stats/').catch(() => ({ vod_connections: [] })), users().catch(() => ({})), nowPlaying().catch(() => ({})), providers().catch(() => ({})),
  ]);
  const sessions = [];
  for (const ch of status.channels || []) {
    const info = await channelInfo(ch.channel_id).catch(() => null);
    const prog = programs[ch.channel_id];
    const height = +(String(ch.resolution || '').split('x')[1] || 0), width = +(String(ch.resolution || '').split('x')[0] || 0);
    const kbps = Math.round(ch.avg_bitrate_kbps || 0);
    const host = String(ch.url || '').match(/\/\/([^/:]+)/)?.[1] || '';
    const provider = provs[host] || host.replace(/^(www\.)?/, '').split('.').slice(-2, -1)[0] || '';
    const progMs = prog ? Date.parse(prog.end_time) - Date.parse(prog.start_time) : 0;
    const progAt = prog ? Date.now() - Date.parse(prog.start_time) : 0;
    for (const c of ch.clients || []) {
      const d = device(c.user_agent);
      const user = names[String(c.user_id)] || (c.user_id && c.user_id !== '0' ? `user ${c.user_id}` : c.ip_address);
      const title = prog?.title || info?.name || ch.channel_name || 'Live TV';
      sessions.push(session({
        session_key: sessionKey(c.client_id), session_id: `live:${ch.channel_id}:${c.client_id}`,
        media_type: 'episode', live: 1, state: 'playing',
        title, grandparent_title: info?.name || ch.channel_name || '', parent_title: prog?.sub_title || '',
        channel_call_sign: info?.channel_number != null ? `Ch ${info.channel_number}` : (ch.channel_name || ''),
        channel_title: info?.name || ch.channel_name || '', channel_stream: 1,
        thumb: logoPath('logo', info?.logo_id), grandparent_thumb: logoPath('logo', info?.logo_id), parent_thumb: logoPath('logo', info?.logo_id),
        rating_key: String(info?.id || ''), grandparent_rating_key: String(info?.id || ''), parent_rating_key: String(info?.id || ''),
        user, friendly_name: user, username: user, user_id: +c.user_id || 0, user_thumb: '',
        ip_address: c.ip_address, ip_address_public: c.ip_address, local: isLan(c.ip_address) ? 1 : 0, location: isLan(c.ip_address) ? 'lan' : 'wan', secure: 1,
        product: d.product, player: d.player, platform: d.platform, platform_name: d.platform.toLowerCase(), product_version: d.version, device: d.product,
        duration: progMs || 0, view_offset: progAt > 0 ? progAt : 0, progress_percent: progMs ? String(Math.min(100, Math.round(progAt / progMs * 100))) : '0',
        bandwidth: kbps, stream_bitrate: kbps, bitrate: kbps,
        quality_profile: [provider ? provider[0].toUpperCase() + provider.slice(1) : '', res(height) ? `${res(height)}${/^\d/.test(res(height)) ? 'p' : ''}` : ''].filter(Boolean).join(' · ') || 'Original',
        transcode_decision: 'direct play', video_decision: 'direct play', audio_decision: 'direct play', stream_video_decision: 'direct play', stream_audio_decision: 'direct play',
        container: 'mpegts', stream_container: 'mpegts', container_decision: 'direct play', stream_container_decision: 'direct play',
        video_codec: ch.video_codec || '', stream_video_codec: ch.video_codec || '', width, height, stream_video_width: width, stream_video_height: height,
        video_resolution: res(height), stream_video_resolution: res(height), video_full_resolution: res(height) ? `${res(height)}${/^\d/.test(res(height)) ? 'p' : ''}` : '', stream_video_full_resolution: res(height) ? `${res(height)}${/^\d/.test(res(height)) ? 'p' : ''}` : '',
        video_dynamic_range: 'SDR', stream_video_dynamic_range: 'SDR',
        audio_codec: ch.audio_codec || '', stream_audio_codec: ch.audio_codec || '', audio_channel_layout: ch.audio_channels || '', stream_audio_channel_layout: ch.audio_channels || '',
        originally_available_at: prog?.start_time?.slice(0, 10) || '', year: '', library_name: 'Live TV', section_id: '',
        summary: prog?.description || '',
      }));
    }
  }
  for (const v of vod.vod_connections || []) {
    const md = v.content_metadata || {};
    for (const c of v.connections || []) {
      const d = device(c.user_agent);
      const user = names[String(c.user_id)] || c.client_ip;
      const dur = (+md.duration_secs || +md.duration || 0) * 1000;
      const pos = (+c.position_seconds || 0) * 1000;
      const episode = v.content_type === 'episode';
      sessions.push(session({
        session_key: sessionKey(c.client_id), session_id: `vod:${c.client_id}`,
        media_type: episode ? 'episode' : 'movie', live: 0, state: 'playing',
        title: v.content_name || 'VOD', grandparent_title: episode ? (md.series_name || '') : '', year: String(md.year || ''),
        parent_media_index: String(md.season_number || ''), media_index: String(md.episode_number || ''),
        thumb: md.logo_url ? `/dispatcharr/url/${Buffer.from(md.logo_url).toString('base64url')}` : '',
        user, friendly_name: user, username: user, user_id: +c.user_id || 0,
        ip_address: c.client_ip, local: isLan(c.client_ip) ? 1 : 0, location: isLan(c.client_ip) ? 'lan' : 'wan', secure: 1,
        product: d.product, player: d.player, platform: d.platform, platform_name: d.platform.toLowerCase(),
        duration: dur, view_offset: pos, progress_percent: dur ? String(Math.min(100, Math.round(pos / dur * 100))) : '0',
        quality_profile: 'Ultimate VOD', transcode_decision: 'direct play', video_decision: 'direct play', audio_decision: 'direct play',
        library_name: 'Dispatcharr VOD',
      }));
    }
  }
  const bw = sessions.reduce((a, s) => a + (+s.bandwidth || 0), 0);
  const lan = sessions.filter(s => s.location === 'lan').reduce((a, s) => a + (+s.bandwidth || 0), 0);
  return { stream_count: String(sessions.length), stream_count_direct_play: sessions.length, stream_count_direct_stream: 0, stream_count_transcode: 0,
    total_bandwidth: bw, lan_bandwidth: lan, wan_bandwidth: bw - lan, sessions };
}

const serverInfo = () => ({ pms_name: SERVER_NAME, pms_version: 'Dispatcharr', pms_platform: 'Linux', pms_ip: new URL(DISPATCHARR).hostname, pms_port: +(new URL(DISPATCHARR).port || 80),
  pms_ssl: 0, pms_url: DISPATCHARR, pms_url_manual: 1, pms_identifier: PMS_ID, pms_plexpass: 1 });

async function terminate(q) {
  const id = q.session_id || '';
  let m;
  if ((m = id.match(/^live:([^:]+):(.+)$/))) await dx(`/proxy/ts/stop_client/${m[1]}`, { method: 'POST', body: JSON.stringify({ client_id: m[2] }) });
  else if ((m = id.match(/^vod:(.+)$/))) await dx('/proxy/vod/stop_client/', { method: 'POST', body: JSON.stringify({ client_id: m[1] }) });
  else throw new Error('unknown session');
  log(`terminated ${id}${q.message ? ` (${q.message})` : ''}`);
}

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
// Fallback when a channel has no usable logo (e.g. the provider's logo URL is dead): a dark poster tile with a
// simple TV icon, drawn from shapes only so it needs no fonts in the container.
const TV_SVG = (w, h) => {
  const s = Math.min(w, h) * 0.45, x = (w - s) / 2, y = (h - s * 0.8) / 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#1c1f26"/>
  <g fill="none" stroke="#8a93a6" stroke-width="${s * 0.06}" stroke-linecap="round">
    <rect x="${x}" y="${y + s * 0.18}" width="${s}" height="${s * 0.62}" rx="${s * 0.08}"/>
    <line x1="${x + s * 0.35}" y1="${y}" x2="${x + s * 0.5}" y2="${y + s * 0.16}"/><line x1="${x + s * 0.65}" y1="${y}" x2="${x + s * 0.5}" y2="${y + s * 0.16}"/>
    <line x1="${x + s * 0.3}" y1="${y + s * 0.92}" x2="${x + s * 0.7}" y2="${y + s * 0.92}"/></g></svg>`);
};
async function image(q, out) {
  const img = q.img || '';
  let url = null, m;
  if ((m = img.match(/^\/dispatcharr\/logo\/(\d+)/))) url = `${DISPATCHARR}/api/channels/logos/${m[1]}/cache/`;
  else if ((m = img.match(/^\/dispatcharr\/url\/([\w-]+)/))) url = Buffer.from(m[1], 'base64url').toString();
  if (q.return_hash === '1') return send(out, 200, { img_hash: crypto.createHash('md5').update(img).digest('hex') });
  if (url) try {
    const r = await fetch(url, { headers: url.startsWith(DISPATCHARR) ? { 'X-API-Key': API_KEY } : {}, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      let body = Buffer.from(await r.arrayBuffer()), type = r.headers.get('content-type') || 'image/png';
      // The app asks for a poster shape (e.g. 300x450) and crops whatever it gets to fill it, which cuts
      // wide channel logos apart. Channel logos get fitted inside that size on a dark tile instead;
      // VOD posters are already poster-shaped and are only resized.
      const w = Math.min(+q.width || 0, 1000), h = Math.min(+q.height || 0, 1500);
      if (w > 0 && h > 0) try {
        if (img.startsWith('/dispatcharr/logo/')) {
          const lw = Math.round(w * 0.8), lh = Math.round(h * 0.8);
          const fitted = await sharp(body).resize(lw, lh, { fit: 'inside' }).png().toBuffer();
          body = await sharp({ create: { width: w, height: h, channels: 4, background: '#1c1f26' } })
            .composite([{ input: fitted, gravity: 'center' }]).png().toBuffer();
        } else {
          body = await sharp(body).resize(w, h, { fit: 'cover' }).png().toBuffer();
        }
        type = 'image/png';
      } catch (e) { log(`resize failed for ${img}: ${e.message}`); }
      out.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' }); return out.end(body);
    }
  } catch {}
  const w = Math.min(+q.width || 0, 1000), h = Math.min(+q.height || 0, 1500);
  if (img.startsWith('/dispatcharr/logo/') && w > 0 && h > 0) try {
    const tile = await sharp(TV_SVG(w, h)).png().toBuffer();
    out.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=600' }); return out.end(tile);
  } catch (e) { log(`fallback tile failed: ${e.message}`); }
  out.writeHead(200, { 'Content-Type': 'image/png' }); out.end(PIXEL);
}

function send(out, code, data, message = null) {
  out.writeHead(code, { 'Content-Type': 'application/json' });
  out.end(JSON.stringify({ response: { result: code === 200 ? 'success' : 'error', message, data } }));
}

// Watch history: records Dispatcharr sessions so History / Statistics / Users / Graphs have data.
const stats = require('./stats')({ templates: TEMPLATES, dataDir: DATA_DIR, activity, log, logoPath });

http.createServer(async (req, out) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') { out.writeHead(200); return out.end('ok'); }
  if (!/\/api\/v2\/?$/.test(u.pathname)) { out.writeHead(404); return out.end(); }
  const q = Object.fromEntries(u.searchParams);
  const key = q.apikey || req.headers['x-api-key'] || '';
  if (key.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(TOKEN))) return send(out, 401, {}, 'Invalid apikey');
  const cmd = q.cmd || '';
  try {
    switch (cmd) {
      case 'register_device': {
        fs.mkdirSync(path.dirname(DEVICES), { recursive: true });
        const devs = fs.existsSync(DEVICES) ? JSON.parse(fs.readFileSync(DEVICES, 'utf8')) : {};
        devs[q.device_id || 'unknown'] = { name: q.device_name, platform: q.platform, version: q.version, at: new Date().toISOString() };
        fs.writeFileSync(DEVICES, JSON.stringify(devs, null, 1));
        log(`registered device ${q.device_name} (${q.platform} ${q.version || ''})`);
        return send(out, 200, { ...serverInfo(), server_id: SERVER_ID, ...INFO });
      }
      case 'get_tautulli_info': return send(out, 200, INFO);
      case 'get_server_info': return send(out, 200, serverInfo());
      case 'get_server_id': return send(out, 200, { identifier: PMS_ID });
      case 'get_server_friendly_name': return send(out, 200, SERVER_NAME);
      case 'get_activity': return send(out, 200, await activity());
      case 'terminate_session': await terminate(q); return send(out, 200, null);
      case 'pms_image_proxy': return image(q, out);
      default: {
        const r = stats.handle(cmd, q);
        return send(out, 200, r !== null && r !== undefined ? r : cmd in EMPTY ? EMPTY[cmd] : {});
      }
    }
  } catch (e) {
    log(`${cmd} failed: ${e.message}`);
    return send(out, 200, cmd === 'get_activity' ? { stream_count: '0', sessions: [], total_bandwidth: 0, lan_bandwidth: 0, wan_bandwidth: 0 } : {}, e.message);
  }
}).listen(PORT, () => log(`dispatcharr-tautulli on :${PORT} -> ${DISPATCHARR} (server id ${SERVER_ID})`));
