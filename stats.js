// Watch history + statistics for the Dispatcharr "Tautulli server" (2026-10-14).
// Dispatcharr keeps no history, so this records it: every POLL_MS it looks at the current sessions,
// keeps one open entry per (stream, program) and closes it when the stream stops or the program
// changes. Entries shorter than MIN_PLAY_S are dropped (channel surfing), like Tautulli's ignore interval.
// The replies reuse real Tautulli rows as type templates (stats-templates.json), because the app
// casts every field strictly.
const fs = require('fs');
const path = require('path');

const POLL_MS = 30e3;
const MIN_PLAY_S = 90;
const KEEP_DAYS = 400;

module.exports = function createStats({ templates, dataDir, activity, log, logoPath }) {
  const T = JSON.parse(fs.readFileSync(path.join(templates, 'stats-templates.json'), 'utf8'));
  const DATA = dataDir;
  const HIST = path.join(DATA, 'history.json');
  const OPEN = path.join(DATA, 'open.json');
  fs.mkdirSync(DATA, { recursive: true });
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const write = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v)); fs.renameSync(f + '.tmp', f); };
  let history = read(HIST, []);
  let open = read(OPEN, {});
  let nextId = history.reduce((m, h) => Math.max(m, h.id), 0) + 1;
  const now = () => Math.floor(Date.now() / 1000);

  // Same type coercion as live sessions: start from the template, overlay values, match JSON types.
  function shape(tpl, over) {
    const o = { ...tpl, ...over };
    for (const [k, v] of Object.entries(o)) {
      if (!(k in tpl) || v === null || v === undefined) continue;
      const want = typeof tpl[k];
      if (want === 'string' && typeof v !== 'string') o[k] = String(v);
      else if (want === 'number' && typeof v !== 'number') o[k] = Number.isFinite(+v) ? +v : 0;
    }
    return o;
  }

  // ---- recorder ----
  function entryFrom(s) {
    const live = s.live === 1 || s.live === '1';
    return {
      session_id: s.session_id, user_id: +s.user_id || 0, user: s.user, kind: live ? 'live' : s.media_type,
      title: s.title, grandparent_title: s.grandparent_title, channel: live ? s.grandparent_title : '', channel_number: s.channel_call_sign || '',
      rating_key: +s.rating_key || 0, thumb: s.thumb, player: s.player, product: s.product, platform: s.platform,
      ip_address: s.ip_address, location: s.location, quality: s.quality_profile, resolution: s.stream_video_full_resolution || '',
      year: s.year || '', parent_media_index: s.parent_media_index || '', media_index: s.media_index || '',
      started: now(), stopped: now(),
    };
  }
  function close(e, at) {
    e.stopped = at;
    if (e.stopped - e.started < MIN_PLAY_S) return;
    history.push({ ...e, id: nextId++ });
  }
  async function poll() {
    let sessions;
    try { sessions = (await activity()).sessions || []; } catch (e) { return log(`history poll failed: ${e.message}`); }
    const t = now(), seen = new Set();
    let changed = false;
    for (const s of sessions) {
      seen.add(s.session_id);
      const cur = open[s.session_id];
      if (cur && cur.title === s.title) { cur.stopped = t; continue; }
      if (cur) { close(cur, t); changed = true; }              // program changed on the same stream
      open[s.session_id] = entryFrom(s);
    }
    for (const [id, e] of Object.entries(open)) {
      // a stream that vanished ended somewhere between its last sighting and now
      if (!seen.has(id)) { close(e, Math.min(t, e.stopped + POLL_MS / 1000)); delete open[id]; changed = true; }
    }
    if (changed) {
      const cutoff = t - KEEP_DAYS * 86400;
      history = history.filter(h => h.stopped >= cutoff);
      write(HIST, history);
    }
    write(OPEN, open);
  }
  // A restart longer than one poll would otherwise stretch open entries over the downtime.
  for (const [id, e] of Object.entries(open)) if (now() - e.stopped > 120) { close(e, e.stopped); delete open[id]; }
  setInterval(poll, POLL_MS).unref?.();
  poll();

  // ---- helpers for the replies ----
  const all = () => history.concat(Object.values(open).filter(e => e.stopped - e.started >= MIN_PLAY_S).map(e => ({ ...e, id: 0, active: true })));
  const dur = h => Math.max(0, h.stopped - h.started);
  const inRange = (rows, days) => { const d = +days || 0; if (!d) return rows; const from = now() - d * 86400; return rows.filter(h => h.started >= from); };
  const pretty = s => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return [d && `${d} days`, h && `${h} hrs`, m && `${m} mins`, !d && x && `${x} secs`].filter(Boolean).join(' ') || '0 mins'; };
  const isMovie = h => h.kind === 'movie';
  const label = h => (h.kind === 'live' ? h.channel || h.grandparent_title : h.kind === 'episode' ? h.grandparent_title : h.title) || h.title;
  const group = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const byPlays = (a, b, statsType) => statsType === 'duration' ? b.dur - a.dur : b.plays - a.plays || b.dur - a.dur;

  function historyRow(h) {
    const live = h.kind === 'live';
    return shape(T.history_row, {
      reference_id: h.id, row_id: h.id, id: h.id, date: h.started, started: h.started, stopped: h.stopped,
      duration: dur(h), play_duration: dur(h), paused_counter: 0,
      user_id: h.user_id, user: h.user, friendly_name: h.user, user_thumb: '',
      platform: h.platform, product: h.product, player: h.player, ip_address: h.ip_address, live: live ? 1 : 0,
      location: h.location, secure: 1, relayed: 0, media_type: live ? 'episode' : h.kind,
      rating_key: h.rating_key, parent_rating_key: h.rating_key, grandparent_rating_key: h.rating_key,
      title: h.title, parent_title: '', grandparent_title: live ? h.channel : h.grandparent_title, original_title: '',
      full_title: (live ? h.channel : h.grandparent_title) ? `${live ? h.channel : h.grandparent_title} - ${h.title}` : h.title,
      year: +h.year || 0, media_index: +h.media_index || 0, parent_media_index: +h.parent_media_index || 0,
      thumb: h.thumb, originally_available_at: '', guid: '', transcode_decision: 'direct play',
      percent_complete: 100, watched_status: 1, group_count: 1, group_ids: String(h.id), state: h.active ? 1 : 0, session_key: 0,
    });
  }

  function getHistory(q) {
    let rows = all();
    if (q.user_id) rows = rows.filter(h => String(h.user_id) === String(q.user_id));
    if (q.user) rows = rows.filter(h => h.user === q.user);
    if (q.rating_key) rows = rows.filter(h => String(h.rating_key) === String(q.rating_key));
    if (q.media_type) { const want = String(q.media_type).split(/,\s*/); rows = rows.filter(h => want.includes(h.kind) || (h.kind === 'live' && (want.includes('live') || want.includes('episode')))); }
    if (q.start_date) rows = rows.filter(h => new Date(h.started * 1000).toISOString().slice(0, 10) === q.start_date);
    if (q.search) { const s = q.search.toLowerCase(); rows = rows.filter(h => `${h.title} ${h.channel} ${h.grandparent_title} ${h.user} ${h.player}`.toLowerCase().includes(s)); }
    const total = all();
    rows.sort((a, b) => b.started - a.started);
    const start = +q.start || 0, length = +q.length || 25;
    return { ...T.history_envelope, draw: +q.draw || 1, recordsTotal: total.length, recordsFiltered: rows.length,
      total_duration: pretty(total.reduce((a, h) => a + dur(h), 0)), filter_duration: pretty(rows.reduce((a, h) => a + dur(h), 0)),
      data: rows.slice(start, start + length).map(historyRow) };
  }

  function homeStats(q) {
    const rows = inRange(all(), q.time_range || 30), n = +q.stats_count || 10, st = q.stats_type === 'duration' ? 'duration' : 'plays';
    const statType = st === 'duration' ? 'total_duration' : 'total_plays';
    const agg = (list, key) => [...group(list, key)].map(([k, g]) => ({ k, g, plays: g.length, dur: g.reduce((a, h) => a + dur(h), 0), users: new Set(g.map(h => h.user)).size, last: g.reduce((a, h) => (h.started > a.started ? h : a)) })).sort((a, b) => byPlays(a, b, st));
    const card = (id, rowsOut, statTypeOverride) => ({ stat_id: id, stat_type: statTypeOverride === undefined ? (T.home[id]?.stat_type ?? null) && statType : statTypeOverride, stat_title: T.home[id]?.stat_title || id, rows: rowsOut });
    const mediaRow = (id, a, extra = {}) => shape(T.home[id].row, {
      title: label(a.last), grandparent_title: label(a.last), total_plays: a.plays, total_duration: a.dur, users_watched: a.users,
      last_play: a.last.started, last_watch: a.last.started, rating_key: a.last.rating_key, grandparent_rating_key: a.last.rating_key, row_id: a.last.id,
      thumb: a.last.thumb, grandparent_thumb: a.last.thumb, art: '', media_type: a.last.kind === 'movie' ? 'movie' : 'episode', live: a.last.kind === 'live' ? 1 : 0,
      user: a.last.user, friendly_name: a.last.user, platform: a.last.platform, section_id: a.last.kind === 'movie' ? 2 : 1, year: +a.last.year || 0, ...extra,
    });
    const tv = rows.filter(h => !isMovie(h)), mov = rows.filter(isMovie);
    const users = agg(rows, h => h.user), plats = agg(rows, h => h.platform);
    // Most concurrent: sweep start/stop events.
    const ev = rows.flatMap(h => [[h.started, 1, h], [h.stopped, -1, h]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let c = 0, best = { count: 0, started: 0, stopped: 0 };
    for (const [t, d] of ev) { c += d; if (c > best.count) best = { count: c, started: t, stopped: t }; else if (c === best.count - 1 && d === -1 && best.stopped === best.started) best.stopped = t; }
    const out = [
      card('top_tv', agg(tv, label).slice(0, n).map(a => mediaRow('top_tv', a))),
      card('popular_tv', agg(tv, label).sort((a, b) => b.users - a.users || b.plays - a.plays).slice(0, n).map(a => mediaRow('popular_tv', a)), null),
      card('top_movies', agg(mov, label).slice(0, n).map(a => mediaRow('top_movies', a))),
      card('popular_movies', agg(mov, label).sort((a, b) => b.users - a.users).slice(0, n).map(a => mediaRow('popular_movies', a)), null),
      card('last_watched', rows.slice().sort((a, b) => b.started - a.started).slice(0, n).map(h => mediaRow('last_watched', { last: h, plays: 1, dur: dur(h), users: 1 }, { user_id: h.user_id, player: h.player, grandchild_title: h.title })), null),
      card('top_users', users.slice(0, n).map(a => mediaRow('top_users', a, { user: a.k, friendly_name: a.k, user_id: a.last.user_id, title: label(a.last) }))),
      card('top_platforms', plats.slice(0, n).map(a => mediaRow('top_platforms', a, { platform: a.k, platform_name: String(a.k).toLowerCase() }))),
      card('most_concurrent', best.count ? [shape(T.home.most_concurrent.row, { title: 'Concurrent Streams', count: best.count, started: best.started, stopped: best.stopped }),
        shape(T.home.most_concurrent.row, { title: 'Concurrent Direct Plays', count: best.count, started: best.started, stopped: best.stopped })] : [], null),
    ];
    return q.stat_id ? out.filter(s => s.stat_id === q.stat_id) : out;
  }

  function usersTable(q) {
    const users = [...group(all(), h => h.user)].map(([u, g]) => { const last = g.reduce((a, h) => (h.started > a.started ? h : a)); return { u, g, last }; })
      .sort((a, b) => b.last.started - a.last.started);
    const start = +q.start || 0, length = +q.length || 25;
    return { draw: +q.draw || 1, recordsTotal: users.length, recordsFiltered: users.length, data: users.slice(start, start + length).map(({ u, g, last }, i) => shape(T.users_row, {
      row_id: last.user_id || i + 1, user_id: last.user_id, username: u, friendly_name: u, title: label(last), email: '', user_thumb: '',
      plays: g.length, duration: g.reduce((a, h) => a + dur(h), 0), last_seen: last.stopped, last_played: label(last), history_row_id: last.id,
      ip_address: last.ip_address, platform: last.platform, player: last.player, rating_key: last.rating_key, media_type: last.kind === 'movie' ? 'movie' : 'episode',
      thumb: last.thumb, parent_title: '', year: +last.year || 0, live: last.kind === 'live' ? 1 : 0, transcode_decision: 'direct play',
      keep_history: 1, allow_guest: 0, is_active: 1,
    })) };
  }
  const userNames = () => [...group(all(), h => h.user)].map(([u, g]) => ({ user_id: g[0].user_id, friendly_name: u }));
  function getUser(q) {
    const g = all().filter(h => String(h.user_id) === String(q.user_id));
    const name = g[0]?.user || '';
    return shape(T.user, { user_id: +q.user_id || 0, username: name, friendly_name: name, email: '', user_thumb: '', is_active: 1, is_admin: 0, is_home_user: 0,
      is_allow_sync: 0, is_restricted: 0, keep_history: 1, deleted_user: 0, allow_guest: 0, row_id: +q.user_id || 0, last_seen: g.reduce((a, h) => Math.max(a, h.stopped), 0), shared_libraries: [] });
  }
  function watchTime(q) {
    const g = all().filter(h => !q.user_id || String(h.user_id) === String(q.user_id));
    return [1, 7, 30, 0].map(d => { const r = inRange(g, d); return shape(T.watch_row, { query_days: d, total_time: r.reduce((a, h) => a + dur(h), 0), total_plays: r.length }); });
  }
  function playerStats(q) {
    const g = all().filter(h => !q.user_id || String(h.user_id) === String(q.user_id));
    return [...group(g, h => h.player)].map(([p, r], i) => shape(T.player_row, { player_name: p, platform: r[0].platform, platform_name: String(r[0].platform).toLowerCase(), total_plays: r.length, total_time: r.reduce((a, h) => a + dur(h), 0), result_id: i }))
      .sort((a, b) => b.total_plays - a.total_plays);
  }

  // ---- graphs: categories + series, series named the way the app maps them ("TV", "Movies", "Live TV") ----
  function graph(cmd, q) {
    const days = +q.time_range || 30, durMode = q.y_axis === 'duration';
    const rows = inRange(all(), days);
    const val = list => (durMode ? list.reduce((a, h) => a + dur(h), 0) : list.length);
    const kinds = { 'Live TV': h => h.kind === 'live', TV: h => h.kind === 'episode', Movies: isMovie };
    const series = (cats, catOf) => Object.entries(kinds).map(([name, f]) => ({ name, data: cats.map(c => val(rows.filter(h => f(h) && catOf(h) === c))) }));
    const local = t => new Date(t * 1000);
    const day = t => { const d = local(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const dates = Array.from({ length: days }, (_, i) => day(now() - (days - 1 - i) * 86400));
    const direct = (cats, catOf) => ['Direct Play', 'Direct Stream', 'Transcode'].map(name => ({ name, data: cats.map(c => (name === 'Direct Play' ? val(rows.filter(h => catOf(h) === c)) : 0)) }));
    switch (cmd) {
      case 'get_plays_by_date': return { categories: dates, series: [...series(dates, h => day(h.started)), { name: 'Total', data: dates.map(c => val(rows.filter(h => day(h.started) === c))) }] };
      case 'get_plays_by_dayofweek': { const c = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']; return { categories: c, series: series(c, h => c[local(h.started).getDay()]) }; }
      case 'get_plays_by_hourofday': { const c = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')); return { categories: c, series: series(c, h => String(local(h.started).getHours()).padStart(2, '0')) }; }
      case 'get_plays_per_month': {
        const months = [...new Set(all().map(h => local(h.started).toLocaleString('en-US', { month: 'short', year: 'numeric' })))];
        const r = all(); return { categories: months, series: Object.entries(kinds).map(([name, f]) => ({ name, data: months.map(m => (durMode ? r.filter(h => f(h) && local(h.started).toLocaleString('en-US', { month: 'short', year: 'numeric' }) === m).reduce((a, h) => a + dur(h), 0) : r.filter(h => f(h) && local(h.started).toLocaleString('en-US', { month: 'short', year: 'numeric' }) === m).length)) })) };
      }
      case 'get_plays_by_top_10_platforms': { const c = [...group(rows, h => h.platform)].sort((a, b) => b[1].length - a[1].length).slice(0, 10).map(x => x[0]); return { categories: c, series: series(c, h => h.platform) }; }
      case 'get_plays_by_top_10_users': { const c = [...group(rows, h => h.user)].sort((a, b) => b[1].length - a[1].length).slice(0, 10).map(x => x[0]); return { categories: c, series: series(c, h => h.user) }; }
      case 'get_plays_by_stream_type': return { categories: dates, series: direct(dates, h => day(h.started)) };
      case 'get_plays_by_source_resolution': case 'get_plays_by_stream_resolution': { const c = [...new Set(rows.map(h => h.resolution || 'unknown'))]; return { categories: c, series: direct(c, h => h.resolution || 'unknown') }; }
      case 'get_concurrent_streams_by_stream_type': {
        const peak = c => { const r = rows.filter(h => day(h.started) === c); const ev = r.flatMap(h => [[h.started, 1], [h.stopped, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]); let n = 0, m = 0; for (const [, d] of ev) { n += d; m = Math.max(m, n); } return m; };
        return { categories: dates, series: [{ name: 'Direct Play', data: dates.map(peak) }, { name: 'Direct Stream', data: dates.map(() => 0) }, { name: 'Transcode', data: dates.map(() => 0) }, { name: 'Max. Concurrent Streams', data: dates.map(peak) }] };
      }
      default: return null;
    }
  }

  return {
    handle(cmd, q) {
      switch (cmd) {
        case 'get_history': return getHistory(q);
        case 'get_home_stats': return homeStats(q);
        case 'get_users_table': return usersTable(q);
        case 'get_user_names': return userNames();
        case 'get_user': return getUser(q);
        case 'get_user_watch_time_stats': return watchTime(q);
        case 'get_user_player_stats': return playerStats(q);
        default: return graph(cmd, q);
      }
    },
    counts: () => ({ history: history.length, open: Object.keys(open).length }),
  };
};
