(function() {
  'use strict';

  // ==================== CONFIG ====================
  var CONFIG = {
    appName: 'My Day',
    storageKey: 'mdg_myday',
    api: {
      baseUrl: 'http://localhost:8787',
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
    );
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

    setLoading(true);
    clearError();

    return fetch(url)
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        state.cache[cacheKey] = { data: data, timestamp: Date.now() };
        setLoading(false);
        return data;
      })
      .catch(function(err) {
        setLoading(false);
        setError(err.message || 'Failed to load data');
        throw err;
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

  // ==================== ACTION HANDLING ====================
  function handleAction(action, element) {
    switch (action) {
      case 'back':
        navigateBack();
        break;
      case 'refresh':
        loadMyDay();
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
