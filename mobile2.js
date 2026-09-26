/* JARVIS Mobile v2 — standalone phone app.
   Data: the same myday_api the desktop Command Center uses, over the cloudflared tunnel whose
   URL is published in tunnel-url.txt (kept current by glasses_tunnel_supervisor.py).
   Override for local testing: mobile.html?api=http://localhost:8787 */
(function () {
  'use strict';
  var BUILD = 'm2.1';
  var REP = 'Ethan McConkie';
  var REPQ = 'rep=' + encodeURIComponent(REP);

  var S = {
    base: '', view: 'home', overlay: null,
    overview: null, myday: {}, dayOffset: 0, analyses: null, pipeline: null, plHeat: 'All', plQ: '',
    live: null, liveCache: null, callsTab: 'tx', liveTab: 'tx', pastDetail: {},
    profiles: {}, extras: {}, dna: {}, phoneProfiles: {}, profTab: 'overview', dnaAll: false, txSel: {},
    ask: { status: 'idle', heard: '', reply: '', recorder: null }, pending: null, sheet: null, apiOk: true
  };
  var $app = document.getElementById('app');

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clean(n) { return String(n || '').replace(/\s+-\s+Alter System\s*$/i, '').trim(); }
  function first(n) { return String(n || '').split(/\s|-/)[0] || ''; }
  function initials(n) { return clean(n).split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() || '?'; }
  function fmtPhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(raw || '');
  }
  function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; }
  function clock(iso, endIso) {
    var end = endIso ? new Date(endIso).getTime() : Date.now();
    var s = Math.max(0, Math.floor((end - new Date(iso).getTime()) / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function countdown(iso) {
    if (!iso) return '';
    var ms = new Date(iso).getTime() - Date.now(), past = ms < 0, m = Math.floor(Math.abs(ms) / 60000);
    var t = m >= 1440 ? Math.floor(m / 1440) + 'd ' + Math.floor((m % 1440) / 60) + 'h' : m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm';
    return past ? 'started ' + t + ' ago' : 'in ' + t;
  }
  function dayLabel(iso) {
    var d = new Date(iso), t0 = new Date(); t0.setHours(0, 0, 0, 0);
    var diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t0) / 86400000);
    return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'long' });
  }
  function greeting() { var h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
  function ymd(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function dateFor(off) { var d = new Date(); d.setDate(d.getDate() + off); return d; }
  function pctOf(a, b) { return b ? Math.max(0, Math.min(100, Math.round(a / b * 100))) : 0; }
  function ringBg(pct, a, b) {
    var p = Math.max(0, Math.min(100, pct)), e = Math.min(100, p + 8);
    return 'conic-gradient(' + a + ' 0% ' + p + '%,' + b + ' ' + p + '% ' + e + '%,rgba(255,255,255,.07) ' + e + '% 100%)';
  }
  var HEAT = { Hot: '#f5a3b0', Warm: '#f5c97a', Cold: '#7ec8e3', Unset: '#8a8498', Sold: '#93e6b8' };
  function heatClass(h) { return { Hot: 'rose', Warm: 'amber', Cold: 'sky', Sold: 'green' }[h] || 'gray'; }
  var OUTCOME = { purchased: ['green', 'Purchased', '#93e6b8'], considering: ['amber', 'Considering', '#f5c97a'] };

  // small markdown: "# Heading" / "- bullet" / paragraphs
  function md(text, cls) {
    var lines = String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean), out = '', ul = false;
    function close() { if (ul) { out += '</ul>'; ul = false; } }
    lines.forEach(function (l) {
      var h = /^#{1,4}\s+(.*)$/.exec(l);
      if (h) { close(); out += '<h4>' + inline(h[1]) + '</h4>'; return; }
      var b = /^[-*•]\s+(.*)$/.exec(l);
      if (b) { if (!ul) { out += '<ul>'; ul = true; } out += '<li><span>' + inline(b[1]) + '</span></li>'; return; }
      close(); out += '<p>' + inline(l) + '</p>';
    });
    close();
    return '<div class="md ' + (cls || '') + '">' + out + '</div>';
  }
  function inline(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'); }
  function toast(msg, kind) {
    var t = document.createElement('div'); t.className = 'toast' + (kind ? ' ' + kind : ''); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2800);
  }

  // ---------- data cache (stale-while-revalidate) ----------
  // Last-known data is saved on the phone so the app opens instantly and still shows
  // pipeline / profiles / past calls when the API or tunnel is unreachable.
  var CK = 'jarvis_m2_cache_v1', persistTimer = null;
  function cacheLoad() {
    try {
      var c = JSON.parse(localStorage.getItem(CK) || 'null');
      if (!c || Date.now() - c.t > 7 * 864e5) return;
      S.overview = c.overview || null; S.myday = c.myday || {}; S.analyses = c.analyses || null; S.pipeline = c.pipeline || null;
      S.profiles = c.profiles || {}; S.dna = c.dna || {}; S.extras = c.extras || {}; S.phoneProfiles = c.phoneProfiles || {};
      if (c.history) S.live = { on_call: false, history: c.history };
      S.cacheAt = c.t;
    } catch (e) {}
  }
  function ready(o) {
    var out = {};
    Object.keys(o || {}).slice(-40).forEach(function (k) { var v = o[k]; if (v && !v.loading && !v.notFound) out[k] = v; });
    return out;
  }
  function slimExtras(ex) {
    var out = {};
    Object.keys(ex || {}).slice(-15).forEach(function (k) {
      var v = ex[k]; if (!v || v.loading) return;
      out[k] = { notes: v.notes || [], activity: v.activity || [], transcripts: (v.transcripts || []).slice(0, 3).map(function (t) { return { date: t.date, recording_id: t.recording_id, text: String(t.text || '').slice(0, 6000) }; }) };
    });
    return out;
  }
  function persist() {
    var snap = { t: Date.now(), overview: S.overview, myday: S.myday, analyses: S.analyses, pipeline: S.pipeline, profiles: ready(S.profiles), dna: ready(S.dna),
      extras: slimExtras(S.extras), phoneProfiles: ready(S.phoneProfiles), history: (S.live && S.live.history) || (S.liveCache && S.liveCache.history) || null };
    try { localStorage.setItem(CK, JSON.stringify(snap)); }
    catch (e) { try { snap.extras = {}; localStorage.setItem(CK, JSON.stringify(snap)); } catch (e2) {} }
  }
  function markFresh() {
    S.cacheAt = Date.now(); S.apiOk = true;
    clearTimeout(persistTimer); persistTimer = setTimeout(persist, 1500);
  }

  // ---------- api ----------
  function resolveBase() {
    var q = new URLSearchParams(location.search).get('api');
    if (q) return Promise.resolve(q.replace(/\/$/, ''));
    return fetch('tunnel-url.txt?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.text(); })
      .then(function (t) { return t.trim().replace(/\/$/, ''); }).catch(function () { return S.base; });
  }
  function request(path, opts, retried) {
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, (opts && opts.timeout) || 25000);
    var o = { signal: ctl.signal };
    if (opts && opts.body !== undefined) { o.method = 'POST'; o.headers = { 'Content-Type': 'application/json' }; o.body = JSON.stringify(opts.body); }
    return fetch(S.base + path, o).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || (d && d.success === false)) throw new Error((d && d.error) || 'HTTP ' + r.status);
        markFresh(); return d;
      });
    }).catch(function (e) {
      clearTimeout(timer);
      if (!retried && (e.name === 'TypeError' || e.name === 'AbortError')) {
        return resolveBase().then(function (b) { if (b && b !== S.base) { S.base = b; return request(path, opts, true); } S.apiOk = false; throw e; });
      }
      S.apiOk = false; throw e;
    });
  }
  function get(path, opts) { return request(path, opts); }
  function post(path, body, timeout) { return request(path, { body: body, timeout: timeout || 240000 }); }

  // ---------- loaders ----------
  function loadOverview() {
    return get('/api/overview?' + REPQ).then(function (d) {
      if (d && !d.error) { S.overview = d; if (d.nextCall && d.nextCall.oppId) loadProfile(d.nextCall.oppId); }
    }).catch(function () {}).then(render);
  }
  function loadMyday(off) {
    var day = ymd(dateFor(off)), q = off === 0 ? '?' + REPQ : '?date=' + day + '&' + REPQ;
    return get('/api/myday' + q).then(function (d) { if (d && !d.error) S.myday[day] = d; }).catch(function () {}).then(render);
  }
  function loadAnalyses() { return get('/api/analyses?limit=6').then(function (d) { if (d && d.analyses) S.analyses = d.analyses; }).catch(function () { S.analyses = S.analyses || []; }).then(render); }
  function loadPipeline() { return get('/api/pipeline?' + REPQ).then(function (d) { if (d && d.rows) S.pipeline = d.rows; }).catch(function () {}).then(render); }
  function loadProfile(oppId) {
    if (S.profiles[oppId]) return Promise.resolve();
    S.profiles[oppId] = { loading: true };
    return get('/api/profile?oppId=' + encodeURIComponent(oppId)).then(function (p) {
      S.profiles[oppId] = (p && !p.error) ? p : { notFound: true };
      if (p && p.accountId) loadDna(p.accountId);
    }).catch(function () { delete S.profiles[oppId]; }).then(render);
  }
  function loadExtras(oppId) {
    if (S.extras[oppId]) return Promise.resolve();
    S.extras[oppId] = { loading: true };
    return get('/api/profile-extras?oppId=' + encodeURIComponent(oppId)).then(function (d) {
      S.extras[oppId] = (d && !d.error) ? d : { notes: [], activity: [], transcripts: [] };
    }).catch(function () { S.extras[oppId] = { notes: [], activity: [], transcripts: [] }; }).then(render);
  }
  // Cached profile: show it now, quietly refresh it in the background.
  function refreshProfile(oppId) {
    get('/api/profile?oppId=' + encodeURIComponent(oppId)).then(function (p) { if (p && !p.error) { S.profiles[oppId] = p; render(); } }).catch(function () {});
    get('/api/profile-extras?oppId=' + encodeURIComponent(oppId)).then(function (d) { if (d && !d.error) { S.extras[oppId] = d; render(); } }).catch(function () {});
  }
  function loadDna(accountId) {
    if (S.dna[accountId]) return Promise.resolve();
    S.dna[accountId] = { loading: true };
    return get('/api/dna?accountId=' + encodeURIComponent(accountId)).then(function (d) { S.dna[accountId] = d || { categories: [] }; })
      .catch(function () { S.dna[accountId] = { categories: [] }; }).then(render);
  }
  function loadPhoneProfile(phone) {
    if (!phone || S.phoneProfiles[phone]) return Promise.resolve();
    S.phoneProfiles[phone] = { loading: true };
    return get('/api/profile-by-phone?phone=' + encodeURIComponent(phone)).then(function (p) {
      S.phoneProfiles[phone] = (p && !p.error && p.oppId) ? p : { notFound: true };
      if (p && p.oppId) S.profiles[p.oppId] = p;
      if (p && p.accountId) loadDna(p.accountId);
    }).catch(function () { S.phoneProfiles[phone] = { notFound: true }; }).then(render);
  }
  function loadPast(sid) {
    if (S.pastDetail[sid]) return Promise.resolve();
    S.pastDetail[sid] = { loading: true };
    return get('/api/live-call?callSid=' + encodeURIComponent(sid)).then(function (d) { S.pastDetail[sid] = (d && !d.error) ? d : { missing: true }; })
      .catch(function () { S.pastDetail[sid] = { missing: true }; }).then(render);
  }

  // ---------- live call (Cue relay: SSE + poll safety net) ----------
  function liveOn() { return !!(S.live && S.live.on_call); }
  function noteLive() {
    if (liveOn()) { S.liveCache = S.live; loadPhoneProfile(S.live.phone); }
    if (S.overlay && S.overlay.type === 'live') patchLive(); else render();
  }
  function fetchLive() { return get('/api/live-call').then(function (d) { if (d && !d.error) { S.live = d; noteLive(); } }).catch(function () {}); }
  var es = null;
  function initLive() {
    fetchLive();
    setInterval(fetchLive, 20000);
    if (typeof EventSource === 'undefined') return;
    try {
      es = new EventSource(S.base + '/api/live-call-events');
      es.onmessage = function (m) {
        var e; try { e = JSON.parse(m.data); } catch (x) { return; }
        if (e.type === 'snapshot') S.live = e.data;
        else if (e.type === 'paragraph' && S.live) {
          var ps = S.live.paragraphs = S.live.paragraphs || [], hit = false;
          for (var i = 0; i < ps.length; i++) if (ps[i].id === e.id) { ps[i].text = e.text; hit = true; break; }
          if (!hit) ps.push({ id: e.id, speaker: e.speaker, text: e.text });
        } else if (e.type === 'notes' && S.live) {
          S.live.notes = e.notes; S.live.notes_full = e.notes_full; S.live.notes_updated_at = e.notes_updated_at;
        } else return;
        noteLive();
      };
    } catch (x) {}
  }
  function paras(d) {
    if (!d) return [];
    if (d.paragraphs && d.paragraphs.length) return d.paragraphs;
    return (d.transcript || []).map(function (l, i) { return { id: i, speaker: l.speaker, text: l.text }; });
  }

  // ---------- shared fragments ----------
  var ICON = {
    home: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    day: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/>',
    calls: '<path d="M4 5c0 8 7 15 15 15l2-4-6-2-2 2c-2-1-4-3-5-5l2-2-2-6z"/>',
    pipe: '<rect x="4" y="12" width="4" height="8"/><rect x="10" y="7" width="4" height="13"/><rect x="16" y="3" width="4" height="17"/>'
  };
  function tabbarHTML() {
    var v = S.overlay ? null : S.view;
    function t(name, label, icon, cls) {
      return '<button data-act="tab" data-v="' + name + '" class="' + (v === name ? 'on' : '') + '" aria-label="' + label + '">' + icon + '<span>' + label + '</span></button>';
    }
    function ico(k, live) { var s = '<svg viewBox="0 0 24 24">' + ICON[k] + '</svg>'; return live ? '<span class="livephone">' + s + '</span>' : s; }
    return '<nav class="tabbar">' + t('home', 'Home', ico('home')) + t('day', 'Day', ico('day')) +
      '<button data-act="tab" data-v="ask" aria-label="Ask JARVIS"><span class="mic ' + (v === 'ask' ? 'on' : '') + '"><svg viewBox="0 0 24 24">' + ICON.mic + '</svg></span></button>' +
      t('calls', 'Calls', ico('calls', liveOn())) + t('pipeline', 'Pipeline', ico('pipe')) + '</nav>';
  }
  function waveHTML(n) { var s = ''; for (var i = 0; i < (n || 18); i++) s += '<i style="animation-delay:' + ((i * 0.11) % 1.1).toFixed(2) + 's"></i>'; return '<div class="wave">' + s + '</div>'; }
  function av(color, text) { return '<div class="sm-av" style="background:' + color + '22;color:' + color + '">' + esc(text) + '</div>'; }

  // ---------- HOME ----------
  function liveCardHTML() {
    var L = S.live, ps = paras(L), last = ps[ps.length - 1];
    var name = clean(L.customer_name) || fmtPhone(L.phone);
    return '<button class="livecard" data-act="open-live"><div class="row"><div class="liveav"><b>' + esc(initials(name)) + '</b><i></i></div>' +
      '<div class="grow"><div class="onair"><i></i>On a call</div><div class="ell" style="font-family:var(--sora);font-size:18px;font-weight:700;margin-top:3px">' + esc(name) + '</div></div>' +
      '<div class="timer" data-elapsed="' + esc(L.started_at) + '">' + clock(L.started_at) + '<small>elapsed</small></div></div>' +
      waveHTML(18) +
      (last ? '<div class="quote"><b class="' + (last.speaker === 'rep' ? 'rep' : '') + '">' + (last.speaker === 'rep' ? 'You' : 'Customer') + '</b>' + esc(last.text.slice(0, 140)) + '</div>' : '') +
      '<div class="openlive">Open live call<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></div></button>';
  }
  function recentHTML() {
    var an = (S.analyses || []).slice(0, 3);
    var rows = an.length ? an.map(function (x) {
      var o = OUTCOME[String(x.outcome || '').toLowerCase()] || ['gray', 'Analyzed', '#8a8498'];
      return '<div class="listrow" data-act="open-profile" data-id="' + esc(x.oppId || '') + '" style="cursor:pointer">' + av(o[2], initials(x.name)) +
        '<div class="grow ell name" style="font-size:13.5px">' + esc(clean(x.name)) + '</div><span class="pill ' + o[0] + '">' + o[1] + '</span></div>';
    }).join('') : '<div class="empty" style="padding:22px 0">' + (S.analyses ? 'No analyzed calls yet.' : 'Loading…') + '</div>';
    return '<div class="card" style="padding:12px 16px 4px"><div class="row" style="margin-bottom:2px"><span class="eyebrow" style="font-size:10px">Recent &middot; analyzed</span><span style="margin-left:auto;font-size:10.5px;font-weight:700;color:var(--green)">notes saved</span></div>' + rows + '</div>';
  }
  function homeHTML() {
    var o = S.overview || {}, nc = o.nextCall, cc = o.currentCall, g = o.goals || {}, dl = o.deals || {};
    var q = o.quota || {}, cr = o.consultRate || {};
    var qp = q.pct != null ? q.pct : pctOf(q.achieved, q.amount), cp = cr.pct != null ? cr.pct : pctOf(cr.completed, cr.total);
    var prof = nc && S.profiles[nc.oppId], name = (prof && prof.name) ? clean(prof.name) : clean(nc && nc.name);
    var next;
    if (nc) {
      next = '<div class="nextcard" data-act="open-profile" data-id="' + esc(nc.oppId) + '" role="button" tabindex="0">' +
        '<div class="kicker"><span class="dot"></span>Next call<span class="cd" data-cd="' + esc(nc.iso) + '">' + countdown(nc.iso) + '</span></div>' +
        '<div class="row" style="margin-top:10px"><div class="grow"><div class="bigtime">' + esc(fmtTime(nc.iso)) + '</div><div style="font-family:var(--sora);font-size:16px;font-weight:600;margin-top:6px" class="ell">' + esc(name) +
        ' <span style="font-family:Manrope,sans-serif;font-size:12px;color:var(--sub);font-weight:500">&middot; ' + dayLabel(nc.iso) + '</span></div></div><div class="avatar">' + esc(initials(name)) + '</div></div>' +
        '<div class="row" style="margin-top:12px"><div class="btn primary grow">Open profile</div>' +
        (nc.id ? '<div class="btn danger" data-act="ask-handoff" data-id="' + esc(nc.id) + '">Hand off</div>' : '') + '</div></div>';
    } else {
      next = '<div class="card"><div class="empty" style="padding:26px 0">No upcoming calls scheduled.</div></div>';
    }
    function deal(label, key, goalKey, c1, c2) {
      var n = (dl[key] || {}).count || 0, goal = g[goalKey] || 0;
      return '<div><div class="t">' + label + '</div><div class="n">' + n + '<small> / ' + goal + '</small></div><div class="bar"><i style="width:' + pctOf(n, goal) + '%;background:linear-gradient(90deg,' + c1 + ',' + c2 + ')"></i></div></div>';
    }
    return '<div class="scroll ' + (innerHeight >= 780 ? 'fit' : '') + '">' +
      '<div class="top fixed"><div class="grow"><div class="eyebrow">' + esc(o.date || new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })) + '</div>' +
      '<div class="h1 ell" style="font-size:26px">' + greeting() + ', ' + esc(o.firstName || first(REP)) + '</div></div>' +
      '<button class="orbbtn" data-act="tab" data-v="ask" aria-label="Ask JARVIS"><i></i></button></div>' +
      next +
      '<div class="two fixed"><div class="ringcard"><div class="ring" style="background:' + ringBg(qp, '#f5c97a', '#f5a3b0') + '"><div>' + qp + '%</div></div><div><div class="lbl9">Quota</div><div style="font-size:13px;font-weight:800;margin-top:4px">' + (q.achieved != null ? q.achieved : 0) + ' / ' + (q.amount != null ? q.amount : 0) + '</div><div style="font-size:11px;color:var(--sub);margin-top:2px">' + esc(q.unit || 'deals') + '</div></div></div>' +
      '<div class="ringcard"><div class="ring" style="background:' + ringBg(cp, '#7ec8e3', '#c9b6ea') + '"><div>' + cp + '%</div></div><div><div class="lbl9">Consults</div><div style="font-size:13px;font-weight:800;margin-top:4px">' + (cr.completed || 0) + ' of ' + (cr.total || 0) + '</div><div style="font-size:11px;color:var(--sub);margin-top:2px">completed</div></div></div></div>' +
      '<div class="card fixed"><div class="row" style="margin-bottom:10px"><span class="eyebrow" style="font-size:10px">Deals closed</span><button class="editgoals" data-act="goals">&#9998; Goals</button></div>' +
      '<div class="deals3">' + deal('Today', 'today', 'daily', '#9fd5b4', '#7ec8e3') + deal('Week', 'week', 'weekly', '#c9b6ea', '#7ec8e3') + deal('Month', 'month', 'monthly', '#f5c97a', '#f5a3b0') + '</div></div>' +
      (liveOn() ? liveCardHTML() : recentHTML()) + '</div>';
  }

  // ---------- DAY ----------
  function dayHTML() {
    var day = ymd(dateFor(S.dayOffset)), d = S.myday[day], w = (d && d.walkthroughs) || [];
    var title = dateFor(S.dayOffset).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    var rows = w.map(function (c) {
      var t = (c.sub || '') + ' ' + (c.tag || ''), k = /purchas|won|sold/i.test(t) ? ['#93e6b8', 'green', 'Sold'] : /complete|done/i.test(t) ? ['#7ec8e3', 'sky', 'Completed'] : /no.?show|cancel|resched/i.test(t) ? ['#f5a3b0', 'rose', c.tag || 'At risk'] : ['#c9b6ea', 'purple', 'Scheduled'];
      return '<button class="tl" data-act="open-profile" data-id="' + esc(c.oppId || '') + '"><span class="t">' + esc(c.timeLabel || fmtTime(c.iso)) + '</span>' +
        '<span class="d" style="background:' + k[0] + ';box-shadow:0 0 0 4px #0f0c17,0 0 12px ' + k[0] + '"></span>' +
        '<span class="b"><span class="grow ell name" style="font-size:14px">' + esc(clean(c.name)) + '</span><span class="pill ' + k[1] + '">' + esc(k[2]) + '</span></span></button>';
    }).join('');
    var done = w.filter(function (c) { return /complete|done|purchas|won|sold/i.test((c.sub || '') + ' ' + (c.tag || '')); }).length;
    return '<div class="scroll"><div><div class="eyebrow">My Day</div><div class="h1">' + esc(title) + '</div></div>' +
      '<div class="row fixed"><button class="chip" data-act="day" data-d="-1" aria-label="Previous day" style="padding:0 16px">&#9664;</button>' +
      '<div class="seg grow"><button class="' + (S.dayOffset === 0 ? 'on' : '') + '" data-act="day" data-to="0">Today</button><button class="' + (S.dayOffset === 1 ? 'on' : '') + '" data-act="day" data-to="1">Tomorrow</button></div>' +
      '<button class="chip" data-act="day" data-d="1" aria-label="Next day" style="padding:0 16px">&#9654;</button></div>' +
      (d ? '<div class="row fixed"><span class="pill green" style="padding:9px 14px;font-size:12px">' + done + ' of ' + w.length + ' calls done</span></div>' : '') +
      (!d ? '<div class="loading">Loading calls…</div>' : w.length ? '<div class="timeline">' + rows + '</div>' : '<div class="empty">No calls scheduled.</div>') + '</div>';
  }

  // ---------- CALLS ----------
  function callsHTML() {
    var live = liveOn(), L = S.live, hist = (S.live && S.live.history) || [];
    var head = '<div><div class="eyebrow">Calls</div><div class="h1">' + (live ? 'Live now' : 'No live call') + '</div></div>';
    var banner = '';
    if (live) {
      var name = clean(L.customer_name) || fmtPhone(L.phone), ps = paras(L), tail = ps.slice(-2);
      var body = S.callsTab === 'notes'
        ? (L.notes ? md(L.notes) : '<div class="note">Notes appear once the call gets going.</div>')
        : (tail.length ? '<div class="tx">' + tail.map(function (p) { return bubble(p, false); }).join('') + '</div>' : '<div class="note">Transcript will appear as the call progresses.</div>');
      banner = '<div class="livecard" style="cursor:default"><div class="row" data-act="open-live" style="cursor:pointer"><div class="liveav"><b>' + esc(initials(name)) + '</b><i></i></div>' +
        '<div class="grow"><div class="onair"><i></i>On a call</div><div class="ell" style="font-family:var(--sora);font-size:19px;font-weight:700;margin-top:3px">' + esc(name) + '</div></div>' +
        '<div class="timer" data-elapsed="' + esc(L.started_at) + '" style="font-size:22px">' + clock(L.started_at) + '<small>elapsed</small></div></div>' +
        '<div data-act="open-live" style="cursor:pointer">' + waveHTML(16) + '</div>' +
        '<div class="seg live"><button class="' + (S.callsTab === 'tx' ? 'on' : '') + '" data-act="callstab" data-t="tx">Transcript</button><button class="' + (S.callsTab === 'notes' ? 'on' : '') + '" data-act="callstab" data-t="notes">Live notes</button><button data-act="open-live" style="color:var(--purple)">Expand &rsaquo;</button></div>' + body + '</div>';
    }
    var past = hist.length ? hist.map(function (h) {
      var nm = clean(h.customer_name) || fmtPhone(h.phone);
      return '<button class="rowbtn" data-act="open-past" data-sid="' + esc(h.call_sid) + '"><div class="sm-av" style="width:40px;height:40px;background:linear-gradient(135deg,#f5c97a,#dba455);color:#231d2b;font-weight:800">' + esc(initials(nm)) + '</div>' +
        '<div class="grow"><div class="ell" style="font-size:14px;font-weight:700">' + esc(nm) + '</div><div class="subline" style="margin-top:2px">' + new Date(h.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</div></div>' +
        '<span class="pill green">' + (h.turn_count || 0) + ' lines</span></button>';
    }).join('') : '<div class="empty">' + (S.live ? 'No past calls yet.' : 'Loading…') + '</div>';
    return '<div class="scroll">' + head + banner + '<div class="eyebrow" style="padding-top:4px">Past calls</div><div style="display:flex;flex-direction:column;gap:8px">' + past + '</div></div>';
  }
  function bubble(p, cur) {
    var rep = p.speaker === 'rep';
    return '<div class="bub ' + (rep ? 'rep' : 'cx') + (cur ? ' cur' : '') + '"><b>' + (rep ? 'You' : 'Customer') + '</b>' + esc(p.text) + '</div>';
  }

  // ---------- LIVE / PAST CALL (expanded) ----------
  function callData() {
    var o = S.overlay;
    function nm(d) { var pf = S.phoneProfiles[d.phone]; return clean(d.customer_name) || (pf && pf.name ? clean(pf.name) : fmtPhone(d.phone)); }
    if (o.type === 'live') { var L = liveOn() ? S.live : S.liveCache; return L ? { live: liveOn(), d: L, name: nm(L), phone: L.phone, start: L.started_at, end: liveOn() ? null : L.ended_at } : null; }
    var d = S.pastDetail[o.sid];
    if (!d || d.loading || d.missing) return { pending: true, missing: d && d.missing };
    return { live: false, d: d, name: nm(d), phone: d.phone, start: d.started_at, end: d.ended_at };
  }
  function callBodyHTML(c) {
    var t = S.liveTab, d = c.d;
    if (t === 'tx') {
      var ps = paras(d);
      return ps.length ? '<div class="tx">' + ps.map(function (p, i) { return bubble(p, c.live && i === ps.length - 1); }).join('') + (c.live ? '<div class="livemark"><i></i>Live &middot; updating</div>' : '') + '</div>'
        : '<div class="empty">Transcript will appear here as the call progresses.</div>';
    }
    if (t === 'notes') {
      var n = d.notes_full || d.notes;
      return n ? md(n) + (d.notes_updated_at ? '<div class="note" style="margin-top:10px">Updated <span data-since="' + esc(d.notes_updated_at) + '">' + since(d.notes_updated_at) + '</span></div>' : '') : '<div class="empty">Notes will appear once the call gets going.</div>';
    }
    var pp = c.phone && S.phoneProfiles[c.phone];
    if (!pp || pp.loading) return '<div class="loading">Looking up profile…</div>';
    if (pp.notFound) return '<div class="empty">No matching profile for this number.</div>';
    return profileSummary(pp, true);
  }
  function since(iso) { var s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000)); return s < 5 ? 'just now' : s < 60 ? s + 's ago' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; }
  function callHTML() {
    var c = callData();
    if (!c) return '<div class="scroll"><button class="back" data-act="back">&#8249; Calls</button><div class="empty">The call has ended.</div></div>';
    if (c.pending) return '<div class="scroll"><button class="back" data-act="back">&#8249; Calls</button><div class="' + (c.missing ? 'empty' : 'loading') + '">' + (c.missing ? 'Could not load this call.' : 'Loading call…') + '</div></div>';
    if (c.phone) loadPhoneProfile(c.phone);
    var pp = c.phone && S.phoneProfiles[c.phone], prof = pp && !pp.loading && !pp.notFound ? pp : null;
    var chips = (c.d.customer_status ? '<span class="pill ' + heatClass(c.d.customer_status[0].toUpperCase() + c.d.customer_status.slice(1)) + '">' + esc(c.d.customer_status) + '</span>' : '') +
      (prof && prof.awareness ? '<span class="pill sky">' + esc(prof.awareness) + '</span>' : '') + (prof && prof.stage ? '<span class="pill gray">' + esc(prof.stage) + '</span>' : '');
    return '<div class="fixed" style="padding:calc(env(safe-area-inset-top) + 14px) 18px 0;display:flex;flex-direction:column;gap:14px">' +
      '<div class="row"><button class="back" data-act="back"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>Calls</button>' +
      (c.live ? '<span class="onair" style="margin-left:auto"><i></i>Live now</span>' : '<span class="pill gray" style="margin-left:auto">' + (c.d.ended_at ? 'Ended ' + fmtTime(c.d.ended_at) : 'Ended') + '</span>') + '</div>' +
      '<div class="row"><div class="pav" style="box-shadow:0 0 0 3px ' + (c.live ? 'rgba(147,230,184,.6)' : 'rgba(255,255,255,.1)') + '">' + esc(initials(c.name)) + '</div>' +
      '<div class="grow"><div class="ell" style="font-family:var(--sora);font-size:22px;font-weight:700;letter-spacing:-.4px">' + esc(c.name) + '</div><div class="subline" style="font-size:12.5px;color:var(--sub);margin-top:3px">' + esc(fmtPhone(c.phone)) + (prof && prof.location ? ' &middot; ' + esc(prof.location) : '') + '</div></div>' +
      '<div class="timer" data-elapsed="' + esc(c.start) + '"' + (c.end ? ' data-end="' + esc(c.end) + '"' : '') + ' style="font-size:26px">' + clock(c.start, c.end) + '<small>' + (c.live ? 'elapsed' : 'length') + '</small></div></div>' +
      (chips ? '<div class="row" style="flex-wrap:wrap;gap:7px">' + chips + '</div>' : '') + (c.live ? waveHTML(20) : '') +
      '<div class="seg ' + (c.live ? 'live' : '') + '"><button class="' + (S.liveTab === 'tx' ? 'on' : '') + '" data-act="livetab" data-t="tx">Transcript</button><button class="' + (S.liveTab === 'notes' ? 'on' : '') + '" data-act="livetab" data-t="notes">Notes</button><button class="' + (S.liveTab === 'profile' ? 'on' : '') + '" data-act="livetab" data-t="profile">Profile</button></div></div>' +
      '<div id="livebody" class="scroll" style="padding-top:14px;padding-bottom:calc(env(safe-area-inset-bottom) + 34px)">' + callBodyHTML(c) + '</div>';
  }
  function patchLive() {
    var el = document.getElementById('livebody');
    if (!el) { render(); return; }
    var c = callData(); if (!c || c.pending) { render(); return; }
    var nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    el.innerHTML = callBodyHTML(c);
    if (S.liveTab === 'tx' && nearBottom) el.scrollTop = el.scrollHeight;
    if (!c.live && S.overlay.type === 'live') render();   // call just ended: refresh header state
  }

  // ---------- PROFILE ----------
  var DNA_TRAITS = {
    'Ease of Weight Loss': { tiers: ['Below Avg.', 'Average'], colors: { 'Below Avg.': 'o', 'Average': 'g' } },
    'Ease of Keeping Weight Off': { tiers: ['Below Avg.', 'Average', 'Above Avg.'], colors: { 'Below Avg.': 'o', 'Average': 'g', 'Above Avg.': 'g' } },
    'Impact of Eating Carbohydrates': { tiers: ['Lower Carb', 'Avg. Carb', 'Higher Carb'], colors: { 'Lower Carb': 'r', 'Avg. Carb': 'g', 'Higher Carb': 'g' } },
    'Impact of Eating Protein': { tiers: ['Lower Protein', 'Avg. Protein', 'Higher Protein'], colors: { 'Lower Protein': 'r', 'Avg. Protein': 'g', 'Higher Protein': 'g' } },
    'Impact of Eating Fat': { tiers: ['Lower Fat', 'Avg. Fat', 'Higher Fat'], colors: { 'Lower Fat': 'r', 'Avg. Fat': 'g', 'Higher Fat': 'g' } },
    'Inflammation Risk': { tiers: ['Average', 'Above Avg.'], colors: { 'Average': 'g', 'Above Avg.': 'r' } },
    'Bone Density Risk': { tiers: ['Average', 'Slightly Above Avg.', 'Above Avg.'], colors: { 'Average': 'g', 'Slightly Above Avg.': 'o', 'Above Avg.': 'r' } },
    'Mental Decline Risk': { tiers: ['Average', 'Slightly Above Avg.', 'Above Avg.'], colors: { 'Average': 'g', 'Slightly Above Avg.': 'o', 'Above Avg.': 'r' } },
    'Stress and Anxiety Resilience': { tiers: ['Average', 'Above Avg.'], colors: { 'Average': 'o', 'Above Avg.': 'g' } }
  };
  var SHORT = { 'Below Avg.': 'Below', 'Above Avg.': 'Above', 'Slightly Above Avg.': 'S. Above', 'Avg. Carb': 'Average', 'Avg. Protein': 'Average', 'Avg. Fat': 'Average', 'Lower Carb': 'Low', 'Lower Protein': 'Low', 'Lower Fat': 'Low', 'Higher Carb': 'High', 'Higher Protein': 'High', 'Higher Fat': 'High' };
  function dnaRows(prof, keyOnly) {
    var d = prof && prof.accountId && S.dna[prof.accountId];
    if (!d || d.loading) return '<div class="loading">Loading DNA results…</div>';
    var cats = d.categories || [], by = {}; cats.forEach(function (c) { by[c.name] = c; });
    var rows = [];
    Object.keys(DNA_TRAITS).forEach(function (name) {
      var c = by[name], sp = DNA_TRAITS[name]; if (!c || sp.tiers.indexOf(c.result) < 0) return;
      var tone = sp.colors[c.result] || 'g';
      if (keyOnly && (c.result === 'Average' || /^Avg\./.test(c.result)) && tone === 'g') return;
      rows.push('<div class="dnarow tone-' + tone + '"><div class="h"><i style="background:var(--tone)"></i>' + esc(name) + '</div><div class="dnaseg">' +
        sp.tiers.map(function (t) { return '<span class="' + (t === c.result ? 'on' : '') + '"' + (t === c.result ? ' style="background:var(--tone)"' : '') + '>' + esc(SHORT[t] || t) + '</span>'; }).join('') + '</div></div>');
    });
    if (by['Best Exercise']) rows.unshift('<div class="dnarow tone-g"><div class="h"><i style="background:var(--tone)"></i>Best Exercise</div><div style="font-size:13px;font-weight:700;color:var(--ink)">' + esc(by['Best Exercise'].result) + '</div></div>');
    return rows.length ? rows.join('') : '<div class="empty">No DNA results on file.</div>';
  }
  function profileSummary(prof, compact) {
    var togo = prof.currentWeight != null && prof.goalWeight != null && prof.currentWeight > prof.goalWeight ? prof.currentWeight - prof.goalWeight : null;
    return '<div style="display:flex;flex-direction:column;gap:10px"><div class="facts">' +
      fact('Age', prof.age != null ? prof.age : '—') + fact('Gender', prof.gender || '—') +
      fact('Current', prof.currentWeight != null ? prof.currentWeight + '<small> lb</small>' : '—') + fact('Goal', prof.goalWeight != null ? prof.goalWeight + '<small> lb</small>' : '—') + '</div>' +
      '<div class="fact" style="display:flex;align-items:center;gap:10px"><div class="grow"><div class="k">DNA report</div><div style="font-size:13px;font-weight:800;margin-top:4px;color:' + (prof.reportUnlocked ? 'var(--green)' : 'var(--sub)') + '">' + (prof.reportUnlocked ? 'Report unlocked' : 'Not released') + '</div></div></div>' +
      '<div class="sect">Key traits</div>' + dnaRows(prof, true) +
      (compact && prof.oppId ? '<button class="btn ghost full" data-act="open-profile" data-id="' + esc(prof.oppId) + '">Open full profile &rsaquo;</button>' : '') + '</div>';
  }
  function fact(k, v) { return '<div class="fact"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
  function txBody(text) {
    return '<div class="txraw">' + String(text || '').split('\n').filter(function (l) { return l.trim(); }).slice(0, 400).map(function (l) {
      var m = /^(Rep|Customer|Agent|Speaker\s*\d+)\s*:\s*(.*)$/i.exec(l);
      if (!m) return '<div>' + esc(l) + '</div>';
      return '<div><b class="' + (/^rep|agent/i.test(m[1]) ? 'r' : 'c') + '">' + esc(m[1]) + '</b> ' + esc(m[2]) + '</div>';
    }).join('') + '</div>';
  }
  function profileHTML() {
    var oppId = S.overlay.oppId, prof = S.profiles[oppId], ex = S.extras[oppId] || {};
    var back = '<div class="row fixed"><button class="back" data-act="back"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>Back</button></div>';
    if (!oppId) return '<div class="scroll">' + back + '<div class="empty">No profile linked to this call.</div></div>';
    loadProfile(oppId); loadExtras(oppId);
    if (!prof || prof.loading) return '<div class="scroll">' + back + '<div class="loading">Loading profile…</div></div>';
    if (prof.notFound) return '<div class="scroll">' + back + '<div class="empty">Could not load this profile.</div></div>';
    var name = clean(prof.name), togo = prof.currentWeight != null && prof.goalWeight != null ? prof.currentWeight - prof.goalWeight : null;
    var head = '<div class="phead"><div class="row"><div class="pav">' + esc(initials(name)) + '</div><div class="grow"><div style="font-family:var(--sora);font-size:21px;font-weight:700;letter-spacing:-.4px">' + esc(name) + '</div><div style="font-size:12.5px;color:var(--sub);margin-top:4px">' +
      esc([prof.location, prof.gender, prof.age != null ? prof.age : ''].filter(Boolean).join(' · ')) + '</div></div></div>' +
      '<div class="row" style="flex-wrap:wrap;gap:7px">' + (prof.status ? '<span class="pill amber">' + esc(prof.status) + '</span>' : '') + (prof.awareness ? '<span class="pill sky">' + esc(prof.awareness) + '</span>' : '') + (prof.customerType ? '<span class="pill gray">' + esc(prof.customerType) + '</span>' : '') + (prof.stage ? '<span class="pill gray">' + esc(prof.stage) + '</span>' : '') + '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px">' +
      (prof.phone ? '<a class="btn primary" href="tel:' + esc(prof.phone) + '" style="font-size:12.5px">Call</a><a class="btn ghost" href="sms:' + esc(prof.phone) + '" style="font-size:12.5px">Message</a>' : '<div class="btn ghost" style="opacity:.4;grid-column:span 2">No phone</div>') +
      '<button class="btn ghost" data-act="brief" data-id="' + esc(oppId) + '" style="font-size:12.5px">Brief me</button></div></div>';
    var tabs = ['overview', 'dna', 'notes', 'calls'], labels = { overview: 'Overview', dna: 'DNA', notes: 'Notes', calls: 'Calls' };
    var seg = '<div class="seg fixed">' + tabs.map(function (t) { return '<button class="' + (S.profTab === t ? 'on' : '') + '" data-act="ptab" data-t="' + t + '">' + labels[t] + '</button>'; }).join('') + '</div>';
    var body = '';
    if (S.profTab === 'overview') {
      body = '<div class="facts">' + fact('Current', prof.currentWeight != null ? prof.currentWeight + '<small> lb</small>' : '—') + fact('Goal', prof.goalWeight != null ? '<span style="color:#9fd5b4">' + prof.goalWeight + '</span><small> lb</small>' : '—') + '</div>' +
        (togo != null && togo > 0 ? '<div class="note">' + togo + ' lb to go</div>' : '') +
        (prof.zillowUrl ? '<a class="fact" href="' + esc(prof.zillowUrl) + '" target="_blank" rel="noopener" style="display:block"><div class="k">Home</div><div class="v" style="font-size:14px;color:var(--sky)">View on Zillow &rsaquo;</div></a>' : '') +
        '<div class="fact" style="display:flex;align-items:center;gap:10px"><div class="grow"><div class="k">DNA report</div><div style="font-size:13px;font-weight:800;margin-top:4px;color:' + (prof.reportUnlocked ? 'var(--green)' : 'var(--sub)') + '">' + (prof.reportUnlocked ? 'Report unlocked' : 'Not released') + '</div></div>' +
        (!prof.reportUnlocked ? '<button class="btn primary" data-act="ask-unlock" data-id="' + esc(oppId) + '" style="min-height:40px;font-size:12px">Unlock</button>' : '') + '</div>' +
        '<button class="btn ghost full" data-act="ask-mark" data-id="' + esc(oppId) + '">Update call status</button>' +
        '<div class="sect">Activity</div>' + (ex.loading ? '<div class="loading">Loading…</div>' : (ex.activity && ex.activity.length ? '<div class="act">' + ex.activity.slice(0, 8).map(function (a) {
          return '<div class="i ' + (a.future ? 'future' : '') + '"><div class="c">' + (a.future ? '○' : '✓') + '</div><div><div class="n">' + esc(a.subject) + '</div><div class="m">' + esc(a.when) + '</div></div></div>';
        }).join('') + '</div>' : '<div class="note">No activity on file.</div>'));
    } else if (S.profTab === 'dna') {
      body = '<div class="row"><div class="seg grow"><button class="' + (!S.dnaAll ? 'on' : '') + '" data-act="dnamode" data-all="0">Key traits</button><button class="' + (S.dnaAll ? 'on' : '') + '" data-act="dnamode" data-all="1">All traits</button></div></div>' +
        '<div class="legend"><span><i style="background:#33912e"></i>Typical</span><span><i style="background:#e88909"></i>Notable</span><span><i style="background:#d64545"></i>Elevated</span></div>' + dnaRows(prof, !S.dnaAll);
    } else if (S.profTab === 'notes') {
      body = ex.loading ? '<div class="loading">Loading…</div>' : (ex.notes && ex.notes.length ? ex.notes.map(function (n) {
        return '<div class="notebox"><div class="src">Call notes &middot; ' + esc(n.date || '') + '</div>' + md(n.text, '') + '</div>';
      }).join('') : '<div class="empty">No notes saved yet.</div>');
    } else {
      var tx = ex.transcripts || [], sel = Math.min(S.txSel[oppId] || 0, Math.max(0, tx.length - 1));
      body = ex.loading ? '<div class="loading">Loading…</div>' : tx.length ?
        '<div class="chips">' + tx.slice(0, 8).map(function (t, i) { return '<button class="chip ' + (i === sel ? 'on' : '') + '" data-act="txsel" data-i="' + i + '">' + esc(t.date || 'Call ' + (i + 1)) + (/^LIVE/.test(t.recording_id || '') ? ' · live' : '') + '</button>'; }).join('') + '</div>' + txBody(tx[sel].text)
        : '<div class="empty">No transcripts saved yet.</div>';
    }
    return '<div class="scroll">' + back + head + seg + '<div style="display:flex;flex-direction:column;gap:10px">' + body + '</div></div>';
  }

  // ---------- PIPELINE ----------
  function plRowsHTML() {
    var rows = S.pipeline || [], q = S.plQ.trim().toLowerCase();
    var list = rows.filter(function (r) { return (S.plHeat === 'All' || r.h === S.plHeat) && (!q || String(r.n || '').toLowerCase().indexOf(q) >= 0 || String(r.t || '').toLowerCase().indexOf(q) >= 0 || String(r.s || '').toLowerCase().indexOf(q) >= 0); });
    if (!S.pipeline) return '<div class="loading">Loading pipeline…</div>';
    if (!list.length) return '<div class="empty">No accounts match. Clear the search or pick another filter.</div>';
    return list.slice(0, 80).map(function (r) {
      var c = HEAT[r.h] || '#8a8498';
      return '<button class="rowbtn" data-act="open-profile" data-id="' + esc(r.id) + '"><div class="ringav" style="background:linear-gradient(140deg,' + c + ',rgba(255,255,255,.05))"><div style="color:' + c + '">' + esc(initials(r.n)) + '</div></div>' +
        '<div class="grow"><div class="name ell">' + esc(clean(r.n)) + '</div><div class="subline ell">' + esc(r.t || r.s || '') + '</div></div><span class="pill ' + heatClass(r.h) + '">' + esc(r.h) + '</span></button>';
    }).join('');
  }
  function plCountLabel() {
    var rows = S.pipeline || [], q = S.plQ.trim().toLowerCase();
    var n = rows.filter(function (r) { return (S.plHeat === 'All' || r.h === S.plHeat) && (!q || String(r.n || '').toLowerCase().indexOf(q) >= 0 || String(r.t || '').toLowerCase().indexOf(q) >= 0 || String(r.s || '').toLowerCase().indexOf(q) >= 0); }).length;
    return n + (n === 1 ? ' account' : ' accounts');
  }
  function pipelineHTML() {
    var rows = S.pipeline || [], hc = { All: rows.length };
    rows.forEach(function (r) { hc[r.h] = (hc[r.h] || 0) + 1; });
    var chips = ['All', 'Hot', 'Warm', 'Cold', 'Unset', 'Sold'].filter(function (k) { return k === 'All' || hc[k]; }).map(function (k) {
      return '<button class="chip ' + (S.plHeat === k ? 'on' : '') + '" data-act="heat" data-k="' + k + '">' + k + ' ' + (hc[k] || 0) + '</button>';
    }).join('');
    return '<div class="scroll"><div class="row fixed" style="align-items:flex-end"><div><div class="eyebrow">Pipeline</div><div class="h1">Open accounts</div></div><div id="plcount" style="margin-left:auto;font-family:var(--sora);font-size:13px;font-weight:700;color:var(--sub);padding-bottom:4px">' + plCountLabel() + '</div></div>' +
      '<div class="search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8f89a5" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input id="plq" type="search" value="' + esc(S.plQ) + '" placeholder="Search name or stage" aria-label="Search pipeline" autocomplete="off"></div>' +
      '<div class="chips">' + chips + '</div><div id="plrows" style="display:flex;flex-direction:column;gap:8px;flex:none">' + plRowsHTML() + '</div></div>';
  }

  // ---------- ASK ----------
  var QUICK = ["What's my next call?", 'How am I doing on quota?', 'Who needs a follow-up today?'];
  function askHTML() {
    var A = S.ask, busy = A.status === 'thinking', rec = A.status === 'listening';
    var label = rec ? 'Listening' : busy ? 'Thinking' : A.reply ? 'Speaking' : 'Standing by';
    return '<div class="scroll" style="align-items:center"><div class="row fixed" style="width:100%"><div style="font-family:var(--sora);font-size:17px;font-weight:800;letter-spacing:5px">JARVIS</div><div class="mono" style="margin-left:auto;font-size:10.5px;letter-spacing:2px;text-transform:uppercase;color:var(--blue)">' + label + '</div></div>' +
      '<div class="orb ' + (busy || rec ? 'busy' : '') + '"><span class="ripple"></span><span class="ripple" style="animation-delay:1.5s"></span><div class="core"></div><div class="rim"></div></div>' +
      '<div class="heard">' + esc(rec ? 'Listening…' : busy ? 'Thinking…' : A.heard || 'Tap the mic or ask below') + '</div>' +
      (A.reply ? '<div class="reply">' + md(A.reply, 'brief') + '</div>' : '') +
      '<div class="chips" style="width:100%">' + QUICK.map(function (q, i) { return '<button class="chip" data-act="askq" data-i="' + i + '"' + (busy ? ' disabled' : '') + '>' + esc(q) + '</button>'; }).join('') + '</div>' +
      '<div style="margin-top:auto;display:flex;flex-direction:column;gap:12px;align-items:center;width:100%;padding-top:10px">' +
      '<button class="micbig ' + (rec ? 'rec' : '') + '" data-act="mic" aria-label="Voice"' + (busy ? ' disabled' : '') + '><svg viewBox="0 0 24 24">' + (rec ? '<rect x="7" y="7" width="10" height="10" rx="2" fill="#0d0a16"/>' : ICON.mic + '<path d="M8 21h8"/>') + '</svg></button>' +
      '<div class="textin"><input id="asktext" type="text" placeholder="Or type to JARVIS" enterkeyhint="send" aria-label="Type to JARVIS" autocomplete="off"><button data-act="asksend" aria-label="Send"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div></div></div>';
  }
  function ask(text, display) {
    if (S.ask.status === 'thinking') return;
    S.ask.status = 'thinking'; S.ask.heard = display || text; S.ask.reply = ''; render();
    post('/api/assistant', { text: text }).then(function (d) { presentAsk(display || text, d); }).catch(function () { S.ask.status = 'idle'; render(); toast('Could not reach JARVIS', 'err'); });
  }
  function presentAsk(heard, d) {
    S.ask.status = 'idle'; S.ask.heard = d.transcript || heard; S.ask.reply = d.reply || '(no reply)'; render();
    if (d.pending_action) { S.pending = d.pending_action; S.sheet = 'pending'; render(); }
  }
  function startMic() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder)) { toast('Voice is not available here', 'err'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var chunks = [], rec = new MediaRecorder(stream);
      rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
      rec.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var mime = rec.mimeType || 'audio/webm', blob = new Blob(chunks, { type: mime });
        var fmt = mime.indexOf('mp4') !== -1 ? 'mp4' : mime.indexOf('ogg') !== -1 ? 'ogg' : 'webm';
        var fr = new FileReader();
        fr.onloadend = function () {
          post('/api/assistant', { audio_base64: String(fr.result).split(',')[1] || '', audio_format: fmt })
            .then(function (d) { presentAsk('(no speech detected)', d); }).catch(function () { S.ask.status = 'idle'; render(); toast('Could not reach JARVIS', 'err'); });
        };
        fr.readAsDataURL(blob);
      };
      S.ask.recorder = rec; rec.start(); S.ask.status = 'listening'; render();
    }).catch(function (e) { toast('Mic unavailable: ' + ((e && e.name) || 'error'), 'err'); });
  }
  function stopMic() { var r = S.ask.recorder; if (r && r.state !== 'inactive') { S.ask.status = 'thinking'; render(); r.stop(); } }

  // ---------- sheets ----------
  function sheetHTML() {
    var s = S.sheet; if (!s) return '';
    var inner = '';
    if (s === 'pending' && S.pending) {
      var p = S.pending.params || {};
      inner = '<h3>Send this text?</h3><div class="pv"><b>To ' + esc(p.to || '') + '</b>' + esc(p.message || '') + '</div><button class="btn primary" data-act="confirm-pending">Send</button><button class="btn ghost" data-act="sheet-close">Cancel</button>';
    } else if (s.type === 'handoff') {
      inner = '<h3>Hand off this call?</h3><p>Moves it to the claimables pool for another rep to pick up.</p><button class="btn danger" data-act="confirm-handoff">Hand it off</button><button class="btn ghost" data-act="sheet-close">Cancel</button>';
    } else if (s.type === 'unlock') {
      inner = '<h3>Unlock the DNA report?</h3><p>Releases the report to the customer.</p><button class="btn primary" data-act="confirm-unlock">Unlock report</button><button class="btn ghost" data-act="sheet-close">Cancel</button>';
    } else if (s.type === 'mark') {
      inner = '<h3>Update call status</h3>' + [['completed', 'Completed', 'primary'], ['no_show', 'No show', 'danger'], ['rescheduled', 'Rescheduled', 'ghost'], ['canceled', 'Canceled', 'danger']].map(function (o) {
        return '<button class="btn ' + o[2] + '" data-act="confirm-mark" data-disp="' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '<button class="btn ghost" data-act="sheet-close">Cancel</button>';
    } else if (s.type === 'goals') {
      var g = (S.overview && S.overview.goals) || {};
      inner = '<h3>Deal goals</h3><label>Daily</label><input id="g-daily" type="number" inputmode="numeric" value="' + (g.daily || 0) + '"><label>Weekly</label><input id="g-weekly" type="number" inputmode="numeric" value="' + (g.weekly || 0) + '"><label>Monthly</label><input id="g-monthly" type="number" inputmode="numeric" value="' + (g.monthly || 0) + '"><button class="btn primary" data-act="confirm-goals">Save goals</button><button class="btn ghost" data-act="sheet-close">Cancel</button>';
    }
    return '<div class="sheetbg" data-act="sheet-bg"><div class="sheet">' + inner + '</div></div>';
  }

  // ---------- render ----------
  var lastKey = '';
  function render() {
    var scrollEl = $app.querySelector('.scroll'), st = scrollEl ? scrollEl.scrollTop : 0;
    var ov = S.overlay, html;
    if (ov) html = ov.type === 'profile' ? profileHTML() : callHTML();
    else html = { home: homeHTML, day: dayHTML, calls: callsHTML, pipeline: pipelineHTML, ask: askHTML }[S.view]();
    var key = ov ? ov.type + (ov.oppId || ov.sid || '') : S.view;
    $app.classList.toggle('live-bg', !!ov && ov.type !== 'profile' || (!ov && S.view === 'calls' && liveOn()));
    var focusId = document.activeElement && document.activeElement.id, val = focusId && document.activeElement.value;
    var pill = !S.apiOk && S.cacheAt ? '<div class="offline">Offline &middot; showing saved data from ' + since(new Date(S.cacheAt).toISOString()).replace(' ago', '') + ' ago</div>' : '';
    $app.innerHTML = html + (ov && ov.type !== 'profile' ? '' : tabbarHTML()) + pill + sheetHTML();
    var el = $app.querySelector('.scroll'); if (el && key === lastKey) el.scrollTop = st;
    if (ov && ov.type !== 'profile' && ov.type) { var lb = document.getElementById('livebody'); if (lb && S.liveTab === 'tx' && key !== lastKey) lb.scrollTop = lb.scrollHeight; }
    lastKey = key;
    if (focusId) { var f = document.getElementById(focusId); if (f) { f.value = val; f.focus(); } }
  }

  // ---------- navigation ----------
  function openOverlay(o) {
    S.overlay = o; try { history.pushState({ o: 1 }, ''); } catch (e) {}
    if (o.type === 'past') loadPast(o.sid);
    if (o.type === 'profile') { S.profTab = 'overview'; if (S.profiles[o.oppId] && !S.profiles[o.oppId].loading) refreshProfile(o.oppId); }
    if (o.type === 'live') S.liveTab = 'tx';
    render();
  }
  function closeOverlay(fromPop) {
    if (!S.overlay) return;
    S.overlay = null; if (!fromPop) { try { history.back(); } catch (e) {} }
    render();
  }
  window.addEventListener('popstate', function () { if (S.sheet) { S.sheet = null; render(); } else if (S.overlay) closeOverlay(true); });
  function setView(v) {
    S.overlay = null; S.view = v; S.sheet = null;
    if (v === 'home') { loadOverview(); loadAnalyses(); }
    if (v === 'day') loadMyday(S.dayOffset);
    if (v === 'pipeline') loadPipeline();
    if (v === 'calls') fetchLive();
    render();
  }

  // ---------- events ----------
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-act]'); if (!t) return;
    var a = t.getAttribute('data-act'), D = t.dataset;
    if (a === 'sheet-bg') { if (ev.target !== t) return; S.sheet = null; render(); return; }
    switch (a) {
      case 'tab': setView(D.v); break;
      case 'back': if (S.overlay) closeOverlay(); break;
      case 'open-profile': if (D.id) openOverlay({ type: 'profile', oppId: D.id }); break;
      case 'open-live': if (liveOn() || S.liveCache) openOverlay({ type: 'live' }); break;
      case 'open-past': openOverlay({ type: 'past', sid: D.sid }); break;
      case 'callstab': S.callsTab = D.t; render(); break;
      case 'livetab': S.liveTab = D.t; render(); break;
      case 'ptab': S.profTab = D.t; render(); break;
      case 'dnamode': S.dnaAll = D.all === '1'; render(); break;
      case 'txsel': S.txSel[S.overlay.oppId] = +D.i; render(); break;
      case 'heat': S.plHeat = D.k; render(); break;
      case 'day':
        if (D.to != null) S.dayOffset = +D.to; else S.dayOffset += +D.d;
        loadMyday(S.dayOffset); render(); break;
      case 'brief': {
        var p = S.profiles[D.id]; S.overlay = null; S.view = 'ask'; try { history.back(); } catch (e) {}
        ask('Give me a tight pre-call briefing on ' + clean(p && p.name) + '.', 'Brief me on ' + clean(p && p.name)); break;
      }
      case 'goals': S.sheet = { type: 'goals' }; render(); break;
      case 'ask-handoff': S.sheet = { type: 'handoff', id: D.id }; render(); break;
      case 'ask-unlock': S.sheet = { type: 'unlock', id: D.id }; render(); break;
      case 'ask-mark': S.sheet = { type: 'mark', id: D.id }; render(); break;
      case 'sheet-close': S.sheet = null; render(); break;
      case 'confirm-handoff': doHandoff(); break;
      case 'confirm-unlock': doUnlock(); break;
      case 'confirm-mark': doMark(D.disp); break;
      case 'confirm-goals': doGoals(); break;
      case 'confirm-pending': doPending(); break;
      case 'askq': ask(QUICK[+D.i]); break;
      case 'asksend': { var i = document.getElementById('asktext'); if (i && i.value.trim()) { var v = i.value.trim(); i.value = ''; ask(v); } break; }
      case 'mic': S.ask.status === 'listening' ? stopMic() : startMic(); break;
    }
  });
  document.addEventListener('input', function (ev) {
    if (ev.target.id === 'plq') {
      S.plQ = ev.target.value;
      var r = document.getElementById('plrows'), c = document.getElementById('plcount');
      if (r) r.innerHTML = plRowsHTML(); if (c) c.textContent = plCountLabel();
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target.id === 'asktext') { var v = ev.target.value.trim(); if (v) { ev.target.value = ''; ask(v); } }
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.getAttribute && ev.target.getAttribute('role') === 'button') { ev.preventDefault(); ev.target.click(); }
  });

  // ---------- actions ----------
  function done(msg) { S.sheet = null; toast(msg, 'ok'); render(); }
  function fail(e) { S.sheet = null; toast('Failed: ' + e.message, 'err'); render(); }
  function doHandoff() { var id = S.sheet.id; toast('Handing off…'); post('/api/handoff', { eventId: id }, 30000).then(function () { done('Call handed off'); loadOverview(); }).catch(fail); }
  function doUnlock() { var id = S.sheet.id; toast('Unlocking report…'); post('/api/unlock-report', { oppId: id }, 30000).then(function () { delete S.profiles[id]; done('Report unlocked'); loadProfile(id); }).catch(fail); }
  function doMark(d) {
    var id = S.sheet.id; toast('Saving…');
    post('/api/mark-call', { oppId: id, disposition: d }, 30000).then(function () { delete S.profiles[id]; S.myday = {}; done('Marked ' + d.replace('_', ' ')); loadProfile(id); }).catch(fail);
  }
  function doGoals() {
    var g = { daily: +document.getElementById('g-daily').value || 0, weekly: +document.getElementById('g-weekly').value || 0, monthly: +document.getElementById('g-monthly').value || 0 };
    post('/api/goals', { goals: g }, 30000).then(function () { if (S.overview) S.overview.goals = g; done('Goals saved'); }).catch(fail);
  }
  function doPending() {
    var a = S.pending; if (!a) { S.sheet = null; render(); return; }
    S.sheet = null; render(); toast('Sending…');
    post('/api/confirm-action', { type: a.type, params: a.params }, 60000).then(function () { S.pending = null; toast('Sent', 'ok'); }).catch(function (e) { toast('Failed to send: ' + e.message, 'err'); });
  }

  // ---------- ticks ----------
  setInterval(function () {
    document.querySelectorAll('[data-elapsed]').forEach(function (n) {
      var end = n.getAttribute('data-end'), small = n.querySelector('small'), txt = clock(n.getAttribute('data-elapsed'), end);
      n.firstChild && n.firstChild.nodeType === 3 ? (n.firstChild.nodeValue = txt) : (n.insertBefore(document.createTextNode(txt), n.firstChild));
    });
    document.querySelectorAll('[data-cd]').forEach(function (n) { n.textContent = countdown(n.getAttribute('data-cd')); });
    document.querySelectorAll('[data-since]').forEach(function (n) { n.textContent = since(n.getAttribute('data-since')); });
  }, 1000);
  setInterval(function () { if (!S.overlay && !S.sheet && document.activeElement && document.activeElement.tagName !== 'INPUT') { if (S.view === 'home') { loadOverview(); loadAnalyses(); } else if (S.view === 'day') loadMyday(S.dayOffset); } }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { fetchLive(); if (S.view === 'home') loadOverview(); } });

  // ---------- boot ----------
  cacheLoad();
  if (S.cacheAt) render();
  resolveBase().then(function (b) {
    S.base = b;
    render();
    loadOverview(); loadAnalyses(); initLive();
    var sp = document.getElementById('splash');
    setTimeout(function () { if (sp) { sp.classList.add('gone'); setTimeout(function () { sp.remove(); }, 500); } }, 900);
  });
  window.JarvisMobile = { S: S, build: BUILD };
})();
