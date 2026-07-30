(function() {
  'use strict';

  // ==================== CONFIG ====================
  var CONFIG = {
    appName: 'My Day',
    storageKey: 'mdg_myday',
    api: {
      baseUrl: 'https://sparc-meant-francis-celebs.trycloudflare.com',
      cacheDuration: 60 * 1000, // 1 min — this is a live schedule, keep it fresh
    },
  };

  // ==================== STATE ====================
  var state = {
    currentScreen: 'home',
    screenHistory: [],
    isLoading: false,
    error: null,
    data: { walkthroughs: [] },
    cache: {},
    selectedCall: null,
    activeTab: 'status',
  };

  // ==================== DOM REFS ====================
  var screens = {};

  function collectScreens() {
    document.querySelectorAll('.screen').forEach(function(s) {
      if (s.id) screens[s.id] = s;
    });
  }

  // ==================== NAVIGATION ====================
  function navigateTo(screenId, options) {
    options = options || {};
    var addToHistory = options.addToHistory !== false;

    if (addToHistory && state.currentScreen) {
      state.screenHistory.push(state.currentScreen);
    }

    Object.values(screens).forEach(function(s) { s.classList.add('hidden'); });
    if (screens[screenId]) {
      screens[screenId].classList.remove('hidden');
      state.currentScreen = screenId;
      onScreenEnter(screenId);
      focusFirst(screens[screenId]);
    }
  }

  function navigateBack() {
    if (state.screenHistory.length > 0) {
      navigateTo(state.screenHistory.pop(), { addToHistory: false });
    }
  }

  // ==================== FOCUS MANAGEMENT ====================
  function focusFirst(container) {
    var el = container.querySelector('.focusable:not([disabled]):not(.hidden)');
    if (el) el.focus();
  }

  function moveFocus(direction) {
    var container = screens[state.currentScreen];
    if (!container) return;

    var focusables = Array.from(
      container.querySelectorAll('.focusable:not([disabled]):not(.hidden)')
    ).filter(function(el) {
      // exclude focusables inside a hidden tab panel
      var panel = el.closest('.tab-panel');
      return !panel || !panel.classList.contains('hidden');
    });
    if (focusables.length === 0) return;

    var current = document.activeElement;
    var idx = focusables.indexOf(current);

    if (idx === -1) {
      focusFirst(container);
      return;
    }

    var nextIdx;
    if (direction === 'up' || direction === 'left') {
      nextIdx = idx > 0 ? idx - 1 : focusables.length - 1;
    } else {
      nextIdx = idx < focusables.length - 1 ? idx + 1 : 0;
    }
    focusables[nextIdx].focus();
    focusables[nextIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ==================== API LAYER ====================
  function apiGet(url, options) {
    options = options || {};
    var cacheKey = options.cacheKey || url;
    var cacheDuration = options.cacheDuration || CONFIG.api.cacheDuration;

    if (!options.noCache && state.cache[cacheKey]) {
      var cached = state.cache[cacheKey];
      if (Date.now() - cached.timestamp < cacheDuration) {
        return Promise.resolve(cached.data);
      }
    }

    if (!options.silent) setLoading(true);
    clearError();

    return fetch(url)
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        state.cache[cacheKey] = { data: data, timestamp: Date.now() };
        if (!options.silent) setLoading(false);
        return data;
      })
      .catch(function(err) {
        if (!options.silent) setLoading(false);
        setError(err.message || 'Failed to load data');
        throw err;
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

  // ==================== UI HELPERS ====================
  function setLoading(isLoading) {
    state.isLoading = isLoading;
    var spinner = document.getElementById('loading');
    var list = document.getElementById('myday-list');
    if (spinner) spinner.classList.toggle('hidden', !isLoading);
    if (isLoading && list) list.classList.add('hidden');
    var status = document.getElementById('status-indicator');
    if (status && isLoading) status.textContent = 'Loading…';
  }

  function setError(message) {
    state.error = message;
    var errorEl = document.getElementById('error');
    var list = document.getElementById('myday-list');
    if (errorEl) {
      errorEl.classList.remove('hidden');
      var msgEl = errorEl.querySelector('.error-message');
      if (msgEl) msgEl.textContent = message;
    }
    if (list) list.classList.add('hidden');
    var status = document.getElementById('status-indicator');
    if (status) status.textContent = 'Error';
  }

  function clearError() {
    state.error = null;
    var errorEl = document.getElementById('error');
    if (errorEl) errorEl.classList.add('hidden');
  }

  function showToast(message, type) {
    var toast = document.getElementById('toast');
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
    setTimeout(function() { toast.classList.remove('visible'); }, 2500);
  }

  // ==================== MY DAY RENDERING ====================
  function tagClass(tag) {
    var t = (tag || '').toLowerCase();
    if (t.indexOf('purchased') !== -1) return 'tag-purchased';
    if (t.indexOf('completed') !== -1) return 'tag-completed';
    if (t.indexOf('no-show') !== -1 || t.indexOf('no show') !== -1) return 'tag-noshow';
    if (t.indexOf('lost') !== -1) return 'tag-lost';
    return '';
  }

  function renderMyDay(walkthroughs) {
    var list = document.getElementById('myday-list');
    var errorEl = document.getElementById('error');
    if (errorEl) errorEl.classList.add('hidden');
    if (!list) return;

    list.innerHTML = '';

    if (!walkthroughs || walkthroughs.length === 0) {
      list.innerHTML = '<div class="empty-message">No calls scheduled today.</div>';
      list.classList.remove('hidden');
      return;
    }

    walkthroughs.forEach(function(w) {
      var row = document.createElement('div');
      row.className = 'wt-row focusable';
      row.tabIndex = 0;
      row.innerHTML =
        '<span class="wt-time">' + escapeHtml(w.timeLabel) + '</span>' +
        '<div class="wt-who">' +
          '<span class="wt-name">' + escapeHtml(w.name) + '</span>' +
          '<span class="wt-sub">' + escapeHtml(w.sub) + '</span>' +
        '</div>' +
        '<span class="wt-tag ' + tagClass(w.tag) + '">' + escapeHtml(w.tag) + '</span>';
      row.addEventListener('click', function() { openCallDetail(w); });
      list.appendChild(row);
    });

    list.classList.remove('hidden');
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function loadMyDay() {
    var url = CONFIG.api.baseUrl + '/api/myday';
    apiGet(url, { cacheKey: 'myday' })
      .then(function(data) {
        state.data.walkthroughs = data.walkthroughs || [];
        renderMyDay(state.data.walkthroughs);
        var status = document.getElementById('status-indicator');
        if (status) {
          var now = new Date();
          status.textContent = state.data.walkthroughs.length + ' today · updated ' +
            now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        }
      })
      .catch(function() {
        // setError already called by apiGet
      });
  }

  // ==================== CALL DETAIL (Status / Handoff / DNA) ====================
  function openCallDetail(call) {
    state.selectedCall = call;
    navigateTo('detail');
  }

  function renderDetailHeader() {
    var call = state.selectedCall;
    var nameEl = document.getElementById('detail-name');
    if (nameEl) nameEl.textContent = call ? call.name : 'Call';
  }

  function switchTab(tabName) {
    state.activeTab = tabName;

    document.querySelectorAll('.tab-item').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach(function(panel) {
      panel.classList.toggle('hidden', panel.id !== 'tab-' + tabName);
    });

    if (tabName === 'status') {
      renderStatusTab();
    } else if (tabName === 'handoff') {
      loadHandoffTab();
    }

    // refocus onto something visible in the new panel
    var panel = document.getElementById('tab-' + tabName);
    if (panel) focusFirst(screens['detail']);
  }

  function renderStatusTab() {
    var call = state.selectedCall;
    var stageEl = document.getElementById('status-current-stage');
    if (stageEl) stageEl.textContent = call ? (call.sub || '—') : '—';
  }

  function markCall(disposition) {
    var call = state.selectedCall;
    if (!call) return;
    var url = CONFIG.api.baseUrl + '/api/mark-call';
    showToast('Saving…');
    apiPost(url, { oppId: call.oppId, disposition: disposition })
      .then(function(data) {
        call.sub = data.newStage;
        renderStatusTab();
        state.cache = {}; // stale now — force a fresh /api/myday next time home loads
        showToast('Marked ' + disposition.replace('_', ' '), 'success');
      })
      .catch(function(err) {
        showToast('Failed: ' + err.message, 'error');
      });
  }

  function loadHandoffTab() {
    var call = state.selectedCall;
    if (!call) return;
    var loading = document.getElementById('handoff-loading');
    var content = document.getElementById('handoff-content');
    if (loading) loading.classList.remove('hidden');
    if (content) content.classList.add('hidden');

    var url = CONFIG.api.baseUrl + '/api/handoff-status?eventId=' + encodeURIComponent(call.id);
    apiGet(url, { cacheKey: 'handoff_' + call.id, noCache: true, silent: true })
      .then(function(data) {
        renderHandoffTab(data);
      })
      .catch(function() {
        renderHandoffTab({ handedOff: false });
      })
      .finally(function() {
        if (loading) loading.classList.add('hidden');
        if (content) content.classList.remove('hidden');
      });
  }

  function renderHandoffTab(data) {
    var title = document.getElementById('handoff-status-title');
    var sub = document.getElementById('handoff-status-sub');
    var btn = document.getElementById('handoff-btn');

    if (data.handedOff) {
      if (title) title.textContent = 'Handed off — in claimables';
      if (sub) {
        var when = data.handoffTimestamp ? new Date(data.handoffTimestamp).toLocaleString() : '';
        sub.textContent = (data.originalOwnerName ? 'From ' + data.originalOwnerName : '') +
          (when ? ' · ' + when : '');
      }
      if (btn) { btn.classList.add('hidden'); }
    } else {
      if (title) title.textContent = 'Not handed off';
      if (sub) sub.textContent = 'Owner stays with you until someone claims it.';
      if (btn) { btn.classList.remove('hidden'); }
    }
  }

  function handleHandoff() {
    var call = state.selectedCall;
    if (!call) return;
    var url = CONFIG.api.baseUrl + '/api/handoff';
    showToast('Handing off…');
    apiPost(url, { eventId: call.id })
      .then(function() {
        showToast('Call handed off', 'success');
        loadHandoffTab();
      })
      .catch(function(err) {
        showToast('Failed: ' + err.message, 'error');
      });
  }

  // ==================== ACTION HANDLING ====================
  function handleAction(action, element) {
    switch (action) {
      case 'back':
        navigateBack();
        break;
      case 'refresh':
        loadMyDay();
        break;
      case 'tab':
        switchTab(element.dataset.tab);
        break;
      case 'mark-call':
        markCall(element.dataset.disposition);
        break;
      case 'handoff':
        handleHandoff();
        break;
      default:
        handleAppAction(action, element);
        break;
    }
  }

  function handleAppAction(action, element) {
    console.log('[Action]', action);
  }

  function onScreenEnter(screenId) {
    if (screenId === 'home') {
      loadMyDay();
    } else if (screenId === 'detail') {
      renderDetailHeader();
      switchTab('status');
    }
  }

  // ==================== EVENT LISTENERS ====================
  function setupEvents() {
    document.addEventListener('click', function(e) {
      var actionEl = e.target.closest('[data-action]');
      if (actionEl) handleAction(actionEl.dataset.action, actionEl);
    });

    document.addEventListener('keydown', function(e) {
      switch (e.key) {
        case 'ArrowUp':
          moveFocus('up');
          e.preventDefault();
          break;
        case 'ArrowDown':
          moveFocus('down');
          e.preventDefault();
          break;
        case 'ArrowLeft':
          moveFocus('left');
          e.preventDefault();
          break;
        case 'ArrowRight':
          moveFocus('right');
          e.preventDefault();
          break;
        case 'Enter':
          if (document.activeElement && document.activeElement.classList.contains('focusable')) {
            document.activeElement.click();
          }
          e.preventDefault();
          break;
        case 'Escape':
          navigateBack();
          e.preventDefault();
          break;
      }
    });
  }

  // ==================== INITIALIZATION ====================
  function init() {
    collectScreens();
    setupEvents();

    setTimeout(function() {
      navigateTo('home', { addToHistory: false });
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
