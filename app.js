(function() {
  'use strict';

  // Bump on every deploy that touches diagnostics — lets a build be
  // confirmed as "actually running" from the device itself, with no
  // devtools/console access needed (e.g. shown in an error toast).
  var BUILD = 'v18';

  // ==================== CONFIG ====================
  var CONFIG = {
    appName: 'JARVIS',
    api: {
      baseUrl: 'https://workshop-pricing-hampshire-interventions.trycloudflare.com',
      cacheDuration: 60 * 1000, // live schedule — keep it fresh
    },
    splashMinMs: 2200,
  };

  // ==================== STATE ====================
  var state = {
    currentScreen: 'splash',
    screenHistory: [],
    cache: {},
    walkthroughs: [],
    schedDate: null, // 'YYYY-MM-DD' shown on the My Day tab; set to today at init
    overview: null,
    mainTab: 'overview',       // 'overview' | 'myday'
    detailTab: 'profile',      // 'profile' | 'dna' | 'brief'
    selectedCall: null,
    profile: null,
    briefs: {}, // oppId -> reply text, cached for the session so re-opening a tab is instant
    ask: {
      recorder: null,
      chunks: [],
      status: 'idle', // 'idle' | 'listening' | 'thinking'
      micChecked: false,
      micSupported: false,
    },
    goalsDraft: { daily: 0, weekly: 0, monthly: 0 },
    countdownTimer: null,
    openSheetId: null, // 'status-sheet' | 'handoff-confirm-sheet' | 'ask-confirm-sheet' | null
    pendingAction: null, // {type, summary, params} awaiting a Yes/No from ask-confirm-sheet
  };

  var screens = {};

  function $(id) { return document.getElementById(id); }

  function collectScreens() {
    document.querySelectorAll('.screen').forEach(function(s) {
      if (s.id) screens[s.id] = s;
    });
  }

  // ==================== NAVIGATION ====================
  function navigateTo(screenId, options) {
    options = options || {};
    if (options.addToHistory !== false && state.currentScreen && state.currentScreen !== 'splash') {
      state.screenHistory.push(state.currentScreen);
    }
    Object.values(screens).forEach(function(s) { s.classList.add('hidden'); });
    if (screens[screenId]) {
      screens[screenId].classList.remove('hidden');
      state.currentScreen = screenId;
      onScreenEnter(screenId);
      // land focus on content, not header chrome, when a panel has content
      var panel = null;
      if (screenId === 'home') {
        panel = state.mainTab === 'overview' ? $('panel-overview') : $('panel-myday');
      }
      var els = panel ? visibleFocusables(panel) : [];
      if (els.length) els[0].focus();
      else focusFirst(screens[screenId]);
    }
  }

  function navigateBack() {
    if (state.openSheetId) { closeSheet(); return; }
    if (state.screenHistory.length > 0) {
      navigateTo(state.screenHistory.pop(), { addToHistory: false });
    }
  }

  // ==================== FOCUS ====================
  function visibleFocusables(container) {
    return Array.from(
      container.querySelectorAll('.focusable:not([disabled])')
    ).filter(function(el) {
      if (el.closest('.hidden')) return false;
      // when a sheet is open, trap focus inside that specific sheet
      if (state.openSheetId) return !!el.closest('#' + state.openSheetId);
      if (el.closest('.sheet-backdrop')) return false;
      return true;
    });
  }

  function focusFirst(container) {
    var els = visibleFocusables(container);
    if (els.length) els[0].focus();
  }

  // Re-renders replace DOM nodes, which silently drops focus to <body> and
  // strands the D-pad. After any async render, put focus back into the panel.
  function restoreFocusTo(panel) {
    var active = document.activeElement;
    if (active && active !== document.body && document.contains(active) &&
        active.classList && active.classList.contains('focusable')) {
      return; // focus survived
    }
    var els = visibleFocusables(panel);
    if (els.length) els[0].focus();
    else focusFirst(screens[state.currentScreen] || document.body);
  }

  // Spatial navigation: pick the nearest element actually in the pressed
  // direction, weighted to prefer staying aligned on the cross-axis.
  // Returns true if focus moved to an in-direction candidate.
  function moveFocus(direction) {
    var container = screens[state.currentScreen];
    if (!container) return false;

    var focusables = visibleFocusables(container);
    if (focusables.length === 0) return false;

    var current = document.activeElement;
    if (focusables.indexOf(current) === -1) {
      focusFirst(container);
      return true;
    }

    // Inside a swipeable panel, left/right stays within the panel — reaching
    // its edge pages between tabs instead of jumping to header controls.
    if (direction === 'left' || direction === 'right') {
      var panel = current.closest('.main-panel, .tab-panel');
      if (panel) {
        focusables = focusables.filter(function(el) { return panel.contains(el); });
      }
    }

    var cRect = current.getBoundingClientRect();
    var cx = cRect.left + cRect.width / 2;
    var cy = cRect.top + cRect.height / 2;

    var candidate = null, candidateScore = Infinity;
    var wrapCandidate = null, wrapScore = -Infinity;

    focusables.forEach(function(el) {
      if (el === current) return;
      var r = el.getBoundingClientRect();
      var dx = (r.left + r.width / 2) - cx;
      var dy = (r.top + r.height / 2) - cy;

      var primary, cross, inDirection, oppositeDirection;
      switch (direction) {
        case 'up':    primary = -dy; cross = dx; inDirection = dy < -1; oppositeDirection = dy > 1;  break;
        case 'down':  primary = dy;  cross = dx; inDirection = dy > 1;  oppositeDirection = dy < -1; break;
        case 'left':  primary = -dx; cross = dy; inDirection = dx < -1; oppositeDirection = dx > 1;  break;
        case 'right': primary = dx;  cross = dy; inDirection = dx > 1;  oppositeDirection = dx < -1; break;
      }

      if (inDirection) {
        var score = primary + Math.abs(cross) * 2;
        if (score < candidateScore) { candidateScore = score; candidate = el; }
      } else if (oppositeDirection) {
        var wScore = primary - Math.abs(cross) * 2;
        if (wScore > wrapScore) { wrapScore = wScore; wrapCandidate = el; }
      }
    });

    if (candidate) {
      candidate.focus();
      candidate.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return true;
    }

    // Edge of the home panels: left/right pages between Overview and My Day
    if (state.currentScreen === 'home') {
      if (direction === 'left' && state.mainTab === 'myday') { switchMainTab('overview'); return true; }
      if (direction === 'right' && state.mainTab === 'overview') { switchMainTab('myday'); return true; }
    }
    // Detail screen: left/right page through Overview -> DNA -> Brief
    if (state.currentScreen === 'detail' && !state.openSheetId) {
      var order = ['profile', 'dna', 'brief'];
      var idx = order.indexOf(state.detailTab);
      if (direction === 'right' && idx < order.length - 1) { switchDetailTab(order[idx + 1]); return true; }
      if (direction === 'left' && idx > 0) { switchDetailTab(order[idx - 1]); return true; }
    }

    if (wrapCandidate && (direction === 'up' || direction === 'down')) {
      wrapCandidate.focus();
      wrapCandidate.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return true;
    }
    return false;
  }

  // ==================== API ====================
  function apiGet(url, options) {
    options = options || {};
    var cacheKey = options.cacheKey || url;
    var duration = options.cacheDuration || CONFIG.api.cacheDuration;

    if (!options.noCache && state.cache[cacheKey]) {
      var hit = state.cache[cacheKey];
      if (Date.now() - hit.timestamp < duration) return Promise.resolve(hit.data);
    }
    return fetch(url).then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function(data) {
      state.cache[cacheKey] = { data: data, timestamp: Date.now() };
      return data;
    });
  }

  function apiPost(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.success === false) {
          throw new Error(data.error || ('HTTP ' + res.status));
        }
        return data;
      });
    });
  }

  // ==================== THEME ====================
  // No user-facing toggle anymore (replaced by the Ask JARVIS button) — this
  // just re-applies whatever was last saved, or dark by default.
  function applyTheme(theme) {
    document.documentElement.classList.toggle('theme-light', theme === 'light');
    try { localStorage.setItem('jarvis_theme', theme); } catch (e) {}
  }

  // ==================== HELPERS ====================
  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function fmtAmt(amt) {
    if (!amt) return '';
    if (amt >= 1000000) return '$' + (amt / 1000000).toFixed(1) + 'M';
    if (amt >= 1000) return '$' + (amt / 1000).toFixed(1) + 'k';
    return '$' + Math.round(amt).toLocaleString();
  }

  function showToast(message, type) {
    var toast = $('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = 'toast' + (type ? ' ' + type : '');
    toast.offsetHeight; // reflow so the transition re-triggers
    toast.classList.add('visible');
    clearTimeout(toast._t);
    // Errors get longer on screen — no way to pause/hover to re-read them
    // on the glasses, and diagnostic text runs longer than normal toasts.
    var duration = type === 'error' ? 8000 : 2500;
    toast._t = setTimeout(function() { toast.classList.remove('visible'); }, duration);
  }

  // ==================== OVERVIEW TAB ====================
  function loadOverview(silent) {
    if (!silent) {
      $('ov-loading').classList.remove('hidden');
      $('ov-content').classList.add('hidden');
      $('ov-error').classList.add('hidden');
    }
    return apiGet(CONFIG.api.baseUrl + '/api/overview', { cacheKey: 'overview' })
      .then(function(data) {
        state.overview = data;
        renderOverview(data);
        $('ov-loading').classList.add('hidden');
        $('ov-error').classList.add('hidden');
        $('ov-content').classList.remove('hidden');
        if (state.currentScreen === 'home' && state.mainTab === 'overview') {
          restoreFocusTo($('panel-overview'));
        }
      })
      .catch(function() {
        $('ov-loading').classList.add('hidden');
        if (!state.overview) $('ov-error').classList.remove('hidden');
      });
  }

  function countdownLabel(iso) {
    var s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
    if (s <= 0) return 'Now';
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function liveLabel(iso) {
    var m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    return m <= 0 ? 'LIVE' : 'LIVE · ' + m + 'm';
  }

  function clockLabel() {
    return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function nextCallHeaderLabel() {
    var data = state.overview;
    if (!data) return '';
    if (data.currentCall) return 'Live now';
    if (data.nextCall) return 'Next · ' + countdownLabel(data.nextCall.iso);
    return 'No calls left today';
  }

  // Header clock + next-call countdown — always visible on the home screen,
  // independent of which main tab (Overview/My Day) is active.
  function renderHeaderMeta() {
    var meta = $('home-meta');
    if (!meta) return;
    var next = nextCallHeaderLabel();
    meta.innerHTML =
      '<div class="hdr-time">' + escapeHtml(clockLabel()) + '</div>' +
      (next ? '<div class="hdr-next">' + escapeHtml(next) + '</div>' : '');
  }

  function renderOverview(data) {
    renderHeaderMeta();

    // --- Current / Next call cards ---
    var calls = $('ov-calls');
    calls.innerHTML = '';
    if (data.currentCall) {
      calls.appendChild(callCard('Current Call', liveLabel(data.currentCall.iso), data.currentCall, true));
    }
    if (data.nextCall) {
      calls.appendChild(callCard('Next Call', countdownLabel(data.nextCall.iso), data.nextCall, false));
    }
    if (!data.currentCall && !data.nextCall) {
      calls.innerHTML = '<div class="card" style="flex:1"><span class="card-label">Calls</span>' +
        '<div style="font-size:14px;color:var(--text-sub);margin-top:6px">No upcoming calls scheduled.</div></div>';
    }

    // --- Goal bars ---
    var d = data.deals || {};
    var today = d.today || {}, month = d.month || {};
    var g = data.goals || {};
    var week = d.week || {};
    $('ov-goal-bars').innerHTML =
      goalBar('Today', today.count || 0, g.daily, 'c-green') +
      goalBar('This Week', week.count || 0, g.weekly, 'c-blue') +
      goalBar('This Month', month.count || 0, g.monthly, 'c-amber');

    // --- Rings ---
    var q = data.quota || {}, cr = data.consultRate || {};
    var quotaSub = q.amount
      ? (q.unit === 'deals'
          ? Math.round(q.achieved) + ' of ' + Math.round(q.amount) + ' deals'
          : fmtAmt(q.achieved) + ' of ' + fmtAmt(q.amount))
      : 'not connected';
    var crSub = (cr.completed || 0) + '/' + (cr.total || 0) + ' this month';
    $('ov-rings').innerHTML =
      ringCard('Monthly Quota', q.pct || 0, quotaSub, 'var(--green)') +
      ringCard('Consult Rate', cr.pct || 0, crSub, 'var(--amber)');

    startCountdownTicker();
  }

  function callCard(label, timer, call, isLive) {
    var btn = document.createElement('button');
    btn.className = 'call-card focusable' + (isLive ? ' live' : '');
    btn.dataset.action = 'open-call-by-opp';
    btn.dataset.oppId = call.oppId || '';
    if (call.iso) btn.dataset.iso = call.iso;
    btn.dataset.live = isLive ? '1' : '';
    btn.innerHTML =
      '<span class="card-label">' + escapeHtml(label) + '</span>' +
      '<span class="call-timer">' + escapeHtml(timer) + '</span>' +
      (call.name ? '<span class="call-name">' + escapeHtml(call.name) + '</span>' : '');
    return btn;
  }

  function goalBar(label, value, goal, colorClass) {
    var pct;
    if (goal > 0) pct = Math.max(3, Math.min(100, Math.round(value / goal * 100)));
    else pct = value > 0 ? 100 : 3;
    var target = goal > 0 ? '<span class="goal-target"> / ' + goal + '</span>' : '';
    return '<div class="goal-row">' +
      '<div class="goal-row-top">' +
        '<span class="goal-row-label">' + escapeHtml(label) + '</span>' +
        '<span class="goal-row-value">' + value + target + '</span>' +
      '</div>' +
      '<div class="goal-track"><div class="goal-fill ' + colorClass + '" style="width:' + pct + '%"></div></div>' +
    '</div>';
  }

  function ringCard(label, pct, sub, color) {
    var r = 33, C = 2 * Math.PI * r;
    var dash = (C * Math.min(Math.max(pct, 0), 100) / 100).toFixed(1);
    return '<div class="ring-card">' +
      '<div class="ring-wrap">' +
        '<svg width="78" height="78">' +
          '<circle cx="39" cy="39" r="' + r + '" fill="none" stroke="var(--border-soft)" stroke-width="6"/>' +
          '<circle cx="39" cy="39" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="6" ' +
            'stroke-dasharray="' + dash + ' ' + C.toFixed(1) + '" stroke-linecap="round"/>' +
        '</svg>' +
        '<div class="ring-pct">' + pct + '%</div>' +
      '</div>' +
      '<div class="card-label">' + escapeHtml(label) + '</div>' +
      '<div class="ring-sub">' + escapeHtml(sub) + '</div>' +
    '</div>';
  }

  // Ticks the header clock every 15s wherever it's shown — home (both tabs)
  // and the detail/profile screen — plus the Overview call-card timers when
  // that tab is the one visible.
  function startCountdownTicker() {
    stopCountdownTicker();
    tickClocks(); // paint immediately, don't wait for the first tick
    state.countdownTimer = setInterval(tickClocks, 15000);
  }

  function tickClocks() {
    if (state.currentScreen === 'home') {
      renderHeaderMeta();
      if (state.mainTab !== 'overview') return;
      document.querySelectorAll('.call-card').forEach(function(el) {
        var iso = el.dataset.iso;
        if (!iso) return;
        var timerEl = el.querySelector('.call-timer');
        if (timerEl) timerEl.textContent = el.dataset.live ? liveLabel(iso) : countdownLabel(iso);
      });
    } else if (state.currentScreen === 'detail') {
      renderDetailMeta();
    }
  }

  function stopCountdownTicker() {
    if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
  }

  // ==================== MY DAY TAB ====================
  function tagClass(tag) {
    var t = (tag || '').toLowerCase();
    if (t === 'sold') return 'tag-purchased';
    if (t === 'done') return 'tag-completed';
    if (t.indexOf('no-show') !== -1 || t.indexOf('no show') !== -1) return 'tag-noshow';
    if (t === 'lost' || t === 'refused') return 'tag-lost';
    return '';
  }

  // --- Day switching (like the desktop Schedule tab) ---
  function dateStr(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function todayStr() { return dateStr(new Date()); }

  function renderDayLabel() {
    var el = $('day-label');
    if (!el) return;
    var sel = new Date(state.schedDate + 'T12:00:00');
    var diffDays = Math.round((sel - new Date(todayStr() + 'T12:00:00')) / 86400000);
    var pretty = sel.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    var rel = diffDays === 0 ? 'Today' : diffDays === 1 ? 'Tomorrow' : diffDays === -1 ? 'Yesterday' : '';
    el.innerHTML = escapeHtml(rel || pretty) +
      (rel ? '<span class="day-sub">' + escapeHtml(pretty) + '</span>' : '');
  }

  function shiftDay(delta) {
    var d = new Date(state.schedDate + 'T12:00:00');
    d.setDate(d.getDate() + delta);
    state.schedDate = dateStr(d);
    renderDayLabel();
    loadMyDay();
  }

  function loadMyDay(silent, force) {
    if (!silent) {
      $('md-loading').classList.remove('hidden');
      $('myday-list').classList.add('hidden');
      $('md-error').classList.add('hidden');
    }
    var day = state.schedDate || todayStr();
    var params = [];
    if (day !== todayStr()) params.push('date=' + day);
    // force=1 tells the API to re-sync before answering, so a call claimed
    // seconds ago shows up on the first tap instead of waiting out the cache
    if (force) params.push('refresh=1');
    var url = CONFIG.api.baseUrl + '/api/myday' + (params.length ? '?' + params.join('&') : '');
    return apiGet(url, { cacheKey: 'myday_' + day, noCache: !!force })
      .then(function(data) {
        state.walkthroughs = data.walkthroughs || [];
        renderMyDay(state.walkthroughs);
        $('md-loading').classList.add('hidden');
        $('md-error').classList.add('hidden');
        $('myday-list').classList.remove('hidden');
        if (state.currentScreen === 'home' && state.mainTab === 'myday') {
          restoreFocusTo($('panel-myday'));
        }
      })
      .catch(function() {
        $('md-loading').classList.add('hidden');
        if (!state.walkthroughs.length) $('md-error').classList.remove('hidden');
      });
  }

  function renderMyDay(walkthroughs) {
    var list = $('myday-list');
    list.innerHTML = '';
    if (!walkthroughs || walkthroughs.length === 0) {
      list.innerHTML = '<div class="empty-message">No calls scheduled.</div>';
      return;
    }
    walkthroughs.forEach(function(w, index) {
      var row = document.createElement('button');
      row.className = 'wt-row focusable';
      row.dataset.action = 'open-call';
      row.dataset.index = String(index);
      row.innerHTML =
        '<span class="wt-time">' + escapeHtml(w.timeLabel) + '</span>' +
        '<div class="wt-who">' +
          '<span class="wt-name">' + escapeHtml(w.name) + '</span>' +
          '<span class="wt-sub">' + escapeHtml(w.sub) + '</span>' +
        '</div>' +
        '<span class="wt-tag ' + tagClass(w.tag) + '">' + escapeHtml(w.tag) + '</span>';
      list.appendChild(row);
    });
  }

  // ==================== MAIN TABS ====================
  function switchMainTab(tabName) {
    state.mainTab = tabName;
    document.querySelectorAll('#main-tabs .tab-item').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    $('panel-overview').classList.toggle('hidden', tabName !== 'overview');
    $('panel-myday').classList.toggle('hidden', tabName !== 'myday');

    // Render immediately from whatever we already have so focus has somewhere
    // to land, then refresh silently in the background.
    if (tabName === 'overview') {
      if (state.overview) {
        renderOverview(state.overview);
        $('ov-loading').classList.add('hidden');
        $('ov-content').classList.remove('hidden');
      }
      loadOverview(true);
    } else {
      if (state.walkthroughs.length) {
        renderMyDay(state.walkthroughs);
        $('md-loading').classList.add('hidden');
        $('myday-list').classList.remove('hidden');
      }
      loadMyDay(true);
    }

    var panel = tabName === 'overview' ? $('panel-overview') : $('panel-myday');
    var els = visibleFocusables(panel);
    if (els.length) els[0].focus();
    else focusFirst(screens['home']);
  }

  // ==================== GOALS EDITOR ====================
  function openGoals() {
    var g = (state.overview && state.overview.goals) || { daily: 0, weekly: 0, monthly: 0 };
    state.goalsDraft = { daily: g.daily || 0, weekly: g.weekly || 0, monthly: g.monthly || 0 };
    navigateTo('goals');
    renderGoalsDraft();
  }

  function renderGoalsDraft() {
    ['daily', 'weekly', 'monthly'].forEach(function(k) {
      var el = $('goal-val-' + k);
      if (el) el.textContent = String(state.goalsDraft[k]);
    });
  }

  function adjustGoal(key, delta) {
    state.goalsDraft[key] = Math.max(0, (state.goalsDraft[key] || 0) + delta);
    renderGoalsDraft();
  }

  function saveGoals() {
    showToast('Saving goals…');
    apiPost(CONFIG.api.baseUrl + '/api/goals', { goals: state.goalsDraft })
      .then(function(data) {
        if (state.overview) state.overview.goals = data.goals;
        delete state.cache['overview'];
        showToast('Goals saved', 'success');
        navigateBack();
        loadOverview(true);
      })
      .catch(function(err) {
        showToast('Failed: ' + err.message, 'error');
      });
  }

  // ==================== PROFILE DETAIL ====================
  function openCallDetail(call) {
    state.selectedCall = call;
    state.profile = null;
    state.detailTab = 'profile';
    navigateTo('detail');
  }

  function openCallByOpp(oppId, iso) {
    var match = state.walkthroughs.filter(function(w) { return w.oppId === oppId; })[0];
    if (match) { openCallDetail(match); return; }
    // the call may be on a different day than the schedule tab is showing
    var day = iso ? dateStr(new Date(iso)) : todayStr();
    var url = CONFIG.api.baseUrl + '/api/myday' + (day !== todayStr() ? '?date=' + day : '');
    apiGet(url, { cacheKey: 'myday_' + day })
      .then(function(data) {
        var m = (data.walkthroughs || []).filter(function(w) { return w.oppId === oppId; })[0];
        if (m) openCallDetail(m);
        else showToast('Not on the schedule');
      })
      .catch(function() { showToast('Could not load that call', 'error'); });
  }

  function switchDetailTab(tabName) {
    state.detailTab = tabName;
    document.querySelectorAll('#detail .tab-item').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    $('tab-profile').classList.toggle('hidden', tabName !== 'profile');
    $('tab-dna').classList.toggle('hidden', tabName !== 'dna');
    $('tab-brief').classList.toggle('hidden', tabName !== 'brief');
    if (tabName === 'dna') loadDna();
    if (tabName === 'brief') loadBrief();
    var panelMap = { profile: 'tab-profile', dna: 'tab-dna', brief: 'tab-brief' };
    var panel = $(panelMap[tabName]);
    var els = visibleFocusables(panel);
    if (els.length) els[0].focus();
    else focusFirst(screens['detail']);
  }

  // Same two-line clock widget as the home header, second line is this
  // call's own scheduled time instead of a next-call countdown.
  function renderDetailMeta() {
    var meta = $('detail-time');
    if (!meta) return;
    var call = state.selectedCall || {};
    meta.innerHTML =
      '<div class="hdr-time">' + escapeHtml(clockLabel()) + '</div>' +
      (call.timeLabel ? '<div class="hdr-next">' + escapeHtml(call.timeLabel) + '</div>' : '');
  }

  function renderDetailHeader() {
    var call = state.selectedCall || {};
    $('detail-name').textContent = call.name || 'Prospect';
    renderDetailMeta();
    $('detail-badges').innerHTML = '';
  }

  function statusBadgeClass(status) {
    var s = (status || '').toUpperCase();
    if (s.indexOf('HOT') !== -1) return 'b-rose';
    if (s.indexOf('WARM') !== -1) return 'b-amber';
    if (s.indexOf('COLD') !== -1) return 'b-blue';
    return 'b-purple';
  }

  function loadProfile() {
    var call = state.selectedCall;
    if (!call) return;
    $('profile-loading').classList.remove('hidden');
    $('profile-content').classList.add('hidden');

    apiGet(CONFIG.api.baseUrl + '/api/profile?oppId=' + encodeURIComponent(call.oppId), {
      cacheKey: 'profile_' + call.oppId, cacheDuration: 120 * 1000,
    })
      .then(function(p) {
        state.profile = p;
        renderProfile(p);
      })
      .catch(function() {
        // fall back to what the schedule row already knows
        renderProfile({
          name: call.name, stage: call.sub, status: '', customerType: '', awareness: '',
          gender: '', age: null, location: '', currentWeight: null, goalWeight: null, phone: '',
          accountId: call.accountId,
        });
      })
      .then(function() {
        $('profile-loading').classList.add('hidden');
        $('profile-content').classList.remove('hidden');
        if (state.currentScreen === 'detail' && state.detailTab === 'profile' &&
            !screens['detail'].contains(document.activeElement)) {
          focusFirst(screens['detail']);
        }
        loadHandoffState();
      });
  }

  function renderProfile(p) {
    // badges under the header
    var badges = [];
    if (p.status) badges.push('<span class="badge ' + statusBadgeClass(p.status) + '">' + escapeHtml(p.status) + '</span>');
    if (p.customerType) badges.push('<span class="badge b-purple">' + escapeHtml(p.customerType) + '</span>');
    if (p.awareness) badges.push('<span class="badge b-blue">' + escapeHtml(p.awareness) + '</span>');
    $('detail-badges').innerHTML = badges.join('');

    $('profile-stage').textContent = p.stage || (state.selectedCall && state.selectedCall.sub) || '—';

    var cells = [
      ['Gender', p.gender],
      ['Age', p.age != null ? String(p.age) : ''],
      ['Location', p.location],
      ['Weight', p.currentWeight != null ? p.currentWeight + ' lbs' : ''],
      ['Goal', p.goalWeight != null ? p.goalWeight + ' lbs' : ''],
      ['Phone', p.phone],
    ];
    $('profile-demo').innerHTML = cells
      .filter(function(c) { return c[1]; })
      .map(function(c) {
        return '<div class="demo-cell"><div class="demo-label">' + escapeHtml(c[0]) +
          '</div><div class="demo-value">' + escapeHtml(String(c[1])) + '</div></div>';
      })
      .join('');
  }

  function loadHandoffState() {
    var call = state.selectedCall;
    if (!call || !call.id) return;
    apiGet(CONFIG.api.baseUrl + '/api/handoff-status?eventId=' + encodeURIComponent(call.id), {
      cacheKey: 'handoff_' + call.id, noCache: true,
    })
      .then(function(data) { renderHandoffState(data); })
      .catch(function() { renderHandoffState({ handedOff: false }); });
  }

  function renderHandoffState(data) {
    var btn = $('handoff-btn');
    var info = $('handoff-info');
    if (data.handedOff) {
      btn.classList.add('hidden');
      info.classList.remove('hidden');
      var when = data.handoffTimestamp ? new Date(data.handoffTimestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      $('handoff-info-text').textContent = 'In the claimables pool' +
        (data.originalOwnerName ? ' · from ' + data.originalOwnerName : '') + (when ? ' · ' + when : '');
    } else {
      btn.classList.remove('hidden');
      info.classList.add('hidden');
    }
  }

  function handleHandoff() {
    var call = state.selectedCall;
    if (!call) return;
    showToast('Handing off…');
    apiPost(CONFIG.api.baseUrl + '/api/handoff', { eventId: call.id })
      .then(function() {
        showToast('Call handed off', 'success');
        closeSheet();
        loadHandoffState();
      })
      .catch(function(err) { showToast('Failed: ' + err.message, 'error'); });
  }

  // ==================== SHEETS (status + handoff confirm) ====================
  function openSheet(sheetId) {
    state.openSheetId = sheetId;
    $(sheetId).classList.remove('hidden');
    focusFirst($(sheetId));
  }

  function closeSheet() {
    if (!state.openSheetId) return;
    $(state.openSheetId).classList.add('hidden');
    state.openSheetId = null;
    focusFirst(screens[state.currentScreen]);
  }

  function markCall(disposition) {
    var call = state.selectedCall;
    if (!call) return;
    showToast('Saving…');
    apiPost(CONFIG.api.baseUrl + '/api/mark-call', { oppId: call.oppId, disposition: disposition })
      .then(function(data) {
        call.sub = data.newStage;
        if (state.profile) state.profile.stage = data.newStage;
        $('profile-stage').textContent = data.newStage;
        Object.keys(state.cache).forEach(function(k) {
          if (k.indexOf('myday_') === 0) delete state.cache[k];
        });
        delete state.cache['profile_' + call.oppId];
        closeSheet();
        showToast('Marked ' + disposition.replace('_', ' '), 'success');
      })
      .catch(function(err) { showToast('Failed: ' + err.message, 'error'); });
  }

  // ==================== DNA TAB ====================
  function loadDna() {
    var call = state.selectedCall;
    var accountId = (state.profile && state.profile.accountId) || (call && call.accountId);
    var content = $('dna-content'), empty = $('dna-empty'), loading = $('dna-loading');
    content.classList.add('hidden');
    empty.classList.add('hidden');
    if (!accountId) {
      empty.textContent = 'No account linked to this call.';
      empty.classList.remove('hidden');
      loading.classList.add('hidden');
      return;
    }
    loading.classList.remove('hidden');
    apiGet(CONFIG.api.baseUrl + '/api/dna?accountId=' + encodeURIComponent(accountId), {
      cacheKey: 'dna_' + accountId, cacheDuration: 30 * 60 * 1000,
    })
      .then(function(data) {
        loading.classList.add('hidden');
        if (data.error || !(data.categories || []).length) {
          empty.textContent = data.error || 'No DNA results on file.';
          empty.classList.remove('hidden');
          return;
        }
        // rows are focusable so the D-pad can walk (and scroll) the list
        content.innerHTML = data.categories.map(function(c) {
          var notable = !c.is_average;
          return '<div class="dna-row focusable' + (notable ? ' notable' : '') + '" tabindex="0">' +
            '<span class="dna-trait">' + escapeHtml(c.name) + '</span>' +
            '<span class="dna-result">' + escapeHtml(c.result) + '</span></div>';
        }).join('');
        content.classList.remove('hidden');
        if (state.currentScreen === 'detail' && state.detailTab === 'dna') {
          restoreFocusTo($('tab-dna'));
        }
      })
      .catch(function() {
        loading.classList.add('hidden');
        empty.textContent = 'Could not load DNA results.';
        empty.classList.remove('hidden');
      });
  }

  // ==================== BRIEF TAB (JARVIS precall briefing) ====================
  // Lightweight markdown-lite: escape first (safe), then re-introduce **bold**
  // and leading "- " bullets. Newlines survive as-is under white-space:pre-wrap.
  function renderBriefText(text) {
    var escaped = escapeHtml(text);
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/^- (.+)$/gm, '<span class="brief-bullet">&bull; $1</span>');
    return escaped;
  }

  function loadBrief() {
    var call = state.selectedCall;
    if (!call) return;
    var content = $('brief-content'), empty = $('brief-empty'), loading = $('brief-loading');
    content.classList.add('hidden');
    empty.classList.add('hidden');

    var cached = state.briefs[call.oppId];
    if (cached) {
      loading.classList.add('hidden');
      content.innerHTML = renderBriefText(cached);
      content.classList.remove('hidden');
      return;
    }

    loading.classList.remove('hidden');
    apiPost(CONFIG.api.baseUrl + '/api/assistant', {
      text: 'Give me a precall briefing on ' + call.name + ' for my call today.',
    })
      .then(function(data) {
        loading.classList.add('hidden');
        if (!data.reply) {
          empty.textContent = 'No briefing available.';
          empty.classList.remove('hidden');
          return;
        }
        state.briefs[call.oppId] = data.reply;
        content.innerHTML = renderBriefText(data.reply);
        content.classList.remove('hidden');
        if (state.currentScreen === 'detail' && state.detailTab === 'brief') {
          restoreFocusTo($('tab-brief'));
        }
      })
      .catch(function() {
        loading.classList.add('hidden');
        empty.textContent = 'Could not reach JARVIS for a briefing.';
        empty.classList.remove('hidden');
      });
  }

  // ==================== ASK JARVIS (voice + quick questions) ====================
  // Mic support is unverified on the glasses' own browser — this is checked
  // with plain feature detection (no permission prompt) so the tab still
  // works via the quick-question list even where getUserMedia doesn't exist
  // or is blocked.
  function initAskTab() {
    if (state.ask.micChecked) return;
    state.ask.micChecked = true;
    var apiPresent = !!(
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia &&
      window.MediaRecorder
    );
    if (!apiPresent) {
      state.ask.micSupported = false;
      $('ask-mic-btn').classList.add('hidden');
      $('ask-mic-unsupported').textContent = 'No voice link on this hardware — select a query below.';
      $('ask-mic-unsupported').classList.remove('hidden');
      return;
    }
    // API exists doesn't mean a mic exists — confirmed on-device: this
    // WebView can expose getUserMedia/MediaRecorder yet report zero
    // audioinput devices (NotFoundError on actual capture). Check for a
    // real device before ever showing the button, instead of only finding
    // out after a failed tap. enumerateDevices() reports device *kind*
    // without needing permission first, even though labels stay blank
    // until permission is granted.
    navigator.mediaDevices.enumerateDevices()
      .then(function(devices) {
        var hasMic = devices.some(function(d) { return d.kind === 'audioinput'; });
        state.ask.micSupported = hasMic;
        $('ask-mic-btn').classList.toggle('hidden', !hasMic);
        if (!hasMic) {
          $('ask-mic-unsupported').textContent = 'No mic detected on this device [' + BUILD + '] — select a query below.';
        }
        $('ask-mic-unsupported').classList.toggle('hidden', hasMic);
      })
      .catch(function() {
        // enumerateDevices itself can fail on some WebViews — fall back to
        // showing the button and letting the real getUserMedia catch handle it.
        state.ask.micSupported = true;
        $('ask-mic-btn').classList.remove('hidden');
        $('ask-mic-unsupported').classList.add('hidden');
      });
  }

  function setAskStatus(status) {
    state.ask.status = status;
    var btn = $('ask-mic-btn');
    btn.classList.toggle('listening', status === 'listening');
    btn.classList.toggle('thinking', status === 'thinking');
    // Icon swap (mic <-> stop) is pure CSS, keyed off the .listening class.
    $('ask-mic-label').textContent =
      status === 'listening' ? 'Listening — Tap to End' :
      status === 'thinking'  ? 'Processing Query…' : 'Engage Voice Link';
    document.querySelectorAll('#ask-quick-list .focusable').forEach(function(el) {
      el.disabled = status === 'thinking';
    });
  }

  function toggleAskMic() {
    if (state.ask.status === 'listening') {
      stopAskRecording();
    } else if (state.ask.status === 'idle') {
      startAskRecording();
    }
  }

  function _mimeToFormat(mime) {
    if (!mime) return 'webm';
    if (mime.indexOf('mp4') !== -1) return 'mp4';
    if (mime.indexOf('ogg') !== -1) return 'ogg';
    return 'webm';
  }

  function startAskRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function(stream) {
        var chunks = [];
        var recorder = new MediaRecorder(stream);
        recorder.ondataavailable = function(e) { if (e.data.size) chunks.push(e.data); };
        recorder.onstop = function() {
          stream.getTracks().forEach(function(t) { t.stop(); });
          var mime = recorder.mimeType || 'audio/webm';
          var blob = new Blob(chunks, { type: mime });
          sendAskAudio(blob, _mimeToFormat(mime));
        };
        state.ask.recorder = recorder;
        state.ask.chunks = chunks;
        recorder.start();
        setAskStatus('listening');
      })
      .catch(function(err) {
        console.error('[JARVIS] getUserMedia failed:', err);
        var detail = 'unknown';
        try {
          detail = (err && (err.name || err.message)) || String(err);
        } catch (e) {}
        showToast('Mic unavailable: ' + detail + ' [' + BUILD + ']', 'error');
        state.ask.micSupported = false;
        $('ask-mic-btn').classList.add('hidden');
        $('ask-mic-unsupported').textContent = 'Voice unavailable (' + detail + ', ' + BUILD + ') — use a question below.';
        $('ask-mic-unsupported').classList.remove('hidden');
      });
  }

  function stopAskRecording() {
    if (state.ask.recorder && state.ask.recorder.state !== 'inactive') {
      setAskStatus('thinking');
      state.ask.recorder.stop();
    }
  }

  function sendAskAudio(blob, format) {
    var reader = new FileReader();
    reader.onloadend = function() {
      var base64 = String(reader.result).split(',')[1] || '';
      apiPost(CONFIG.api.baseUrl + '/api/assistant', { audio_base64: base64, audio_format: format })
        .then(function(data) { presentAskResult(data.transcript || '(no speech detected)', data.reply, data.pending_action); })
        .catch(function() {
          setAskStatus('idle');
          showToast('Could not reach JARVIS', 'error');
        });
    };
    reader.readAsDataURL(blob);
  }

  function sendQuickQuestion(question) {
    if (state.ask.status === 'thinking') return;
    setAskStatus('thinking');
    apiPost(CONFIG.api.baseUrl + '/api/assistant', { text: question })
      .then(function(data) { presentAskResult(question, data.reply, data.pending_action); })
      .catch(function() {
        setAskStatus('idle');
        showToast('Could not reach JARVIS', 'error');
      });
  }

  function presentAskResult(transcript, reply, pendingAction) {
    setAskStatus('idle');
    $('ask-transcript').innerHTML =
      '<div class="ask-readout-label">You Asked</div>' +
      '<div class="ask-transcript-text">' + escapeHtml(transcript) + '</div>';
    $('ask-reply').innerHTML =
      '<div class="ask-readout-label">JARVIS</div>' +
      renderBriefText(reply || '(no reply)');
    $('ask-result').classList.remove('hidden');

    if (pendingAction) {
      openPendingActionConfirm(pendingAction);
    } else {
      restoreFocusTo(screens['ask']);
    }
  }

  // ==================== PENDING-ACTION CONFIRMATION ====================
  // Nothing JARVIS proposes (currently: text messages) sends without this —
  // see main.py's propose_text_message / confirm_action for the backend half.
  function openPendingActionConfirm(pendingAction) {
    state.pendingAction = pendingAction;
    var to = (pendingAction.params && pendingAction.params.to) || '';
    var message = (pendingAction.params && pendingAction.params.message) || '';
    $('ask-confirm-preview').innerHTML =
      '<span class="preview-to">To ' + escapeHtml(to) + '</span>' +
      escapeHtml(message);
    openSheet('ask-confirm-sheet');
  }

  function confirmPendingAction() {
    var action = state.pendingAction;
    if (!action) { closeSheet(); return; }
    closeSheet();
    showToast('Sending…');
    apiPost(CONFIG.api.baseUrl + '/api/confirm-action', { type: action.type, params: action.params })
      .then(function() {
        state.pendingAction = null;
        showToast('Sent', 'success');
      })
      .catch(function(err) {
        showToast('Failed to send: ' + err.message, 'error');
      });
  }

  function cancelPendingAction() {
    state.pendingAction = null;
    closeSheet();
  }

  // ==================== ACTIONS ====================
  function handleAction(action, element) {
    switch (action) {
      case 'back': navigateBack(); break;
      case 'refresh':
        state.cache = {};
        if (state.currentScreen === 'home') {
          if (state.mainTab === 'overview') loadOverview();
          else if (state.mainTab === 'myday') loadMyDay(false, true);
        }
        showToast('Refreshing…');
        break;
      case 'main-tab': switchMainTab(element.dataset.tab); break;
      case 'tab': switchDetailTab(element.dataset.tab); break;
      case 'open-ask': navigateTo('ask'); break;
      case 'ask-mic-toggle': toggleAskMic(); break;
      case 'ask-quick': sendQuickQuestion(element.dataset.question); break;
      case 'confirm-pending-action': confirmPendingAction(); break;
      case 'cancel-pending-action': cancelPendingAction(); break;
      case 'open-call':
        var call = state.walkthroughs[Number(element.dataset.index)];
        if (call) openCallDetail(call);
        break;
      case 'open-call-by-opp': openCallByOpp(element.dataset.oppId, element.dataset.iso); break;
      case 'day-prev': shiftDay(-1); break;
      case 'day-next': shiftDay(1); break;
      case 'open-goals': openGoals(); break;
      case 'goal-adjust': adjustGoal(element.dataset.goal, Number(element.dataset.delta)); break;
      case 'save-goals': saveGoals(); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'open-status': openSheet('status-sheet'); break;
      case 'close-sheet': closeSheet(); break;
      case 'mark-call': markCall(element.dataset.disposition); break;
      case 'open-handoff-confirm': openSheet('handoff-confirm-sheet'); break;
      case 'confirm-handoff': handleHandoff(); break;
    }
  }

  function onScreenEnter(screenId) {
    if (screenId === 'home') {
      // renders synchronously from preloaded state, then refreshes silently —
      // guarantees the panel has focusables before focus is placed
      switchMainTab(state.mainTab);
    } else if (screenId === 'detail') {
      renderDetailHeader();
      switchDetailTab('profile');
      loadProfile();
    } else if (screenId === 'ask') {
      initAskTab();
    }
    if (screenId === 'home' || screenId === 'detail') startCountdownTicker();
    else stopCountdownTicker();
  }

  // ==================== EVENTS ====================
  function setupEvents() {
    document.addEventListener('click', function(e) {
      var actionEl = e.target.closest('[data-action]');
      if (actionEl) handleAction(actionEl.dataset.action, actionEl);
    });

    document.addEventListener('keydown', function(e) {
      if (state.currentScreen === 'splash') { e.preventDefault(); return; }
      switch (e.key) {
        case 'ArrowUp':    moveFocus('up');    e.preventDefault(); break;
        case 'ArrowDown':  moveFocus('down');  e.preventDefault(); break;
        case 'ArrowLeft':  moveFocus('left');  e.preventDefault(); break;
        case 'ArrowRight': moveFocus('right'); e.preventDefault(); break;
        case 'Enter':
          if (document.activeElement && document.activeElement.classList.contains('focusable')) {
            document.activeElement.click();
          }
          e.preventDefault();
          break;
        case 'Escape': navigateBack(); e.preventDefault(); break;
      }
    });
  }

  // ==================== INIT ====================
  function init() {
    collectScreens();
    setupEvents();
    var savedTheme = 'dark';
    try { savedTheme = localStorage.getItem('jarvis_theme') || 'dark'; } catch (e) {}
    applyTheme(savedTheme);
    state.schedDate = todayStr();
    renderDayLabel();

    // Boot: splash plays while data preloads; leave after both settle
    // (or after the minimum time even if the network is slow to fail).
    var t0 = Date.now();
    var preload = Promise.all([
      apiGet(CONFIG.api.baseUrl + '/api/overview', { cacheKey: 'overview' })
        .then(function(d) { state.overview = d; })
        .catch(function() {}),
      apiGet(CONFIG.api.baseUrl + '/api/myday', { cacheKey: 'myday_' + todayStr() })
        .then(function(d) { state.walkthroughs = d.walkthroughs || []; })
        .catch(function() {}),
    ]);

    preload.then(function() {
      var wait = Math.max(0, CONFIG.splashMinMs - (Date.now() - t0));
      setTimeout(function() {
        navigateTo('home', { addToHistory: false });
      }, wait);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
