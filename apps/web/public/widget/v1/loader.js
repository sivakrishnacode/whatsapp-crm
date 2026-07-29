/**
 * converse360 web chat widget — loader.
 *
 * This is the ONLY file a customer pastes onto their site, and once it is
 * out there it is out there forever: pages get cached, snippets get
 * committed to templates, and some installations will never be touched
 * again. Hence `/widget/v1/` in the path — this file's contract can never
 * break. Anything new goes in v2 and both are served.
 *
 * WHY AN IFRAME AND NOT INLINE DOM
 *   Inline DOM means our CSS and the host page's CSS are in one cascade.
 *   In practice that is a permanent stream of "the chat button looks
 *   wrong on my site" — a global `button { }` rule, a `* { box-sizing }`
 *   reset, a z-index war, a Tailwind preflight. An iframe is a hard
 *   boundary in both directions: nothing we ship can break their layout,
 *   and nothing they ship can break ours.
 *
 *   The launcher button is deliberately in a *second*, small iframe
 *   rather than being real DOM. Keeping it out of the host page means
 *   there is no element for their CSS to touch at all.
 *
 * WHAT THIS FILE MUST NOT DO
 *   No dependencies, no build step, no ES module syntax, no optional
 *   chaining — this runs in whatever browser the customer's visitors use,
 *   including ones our dashboard does not support. Plain ES5-ish script.
 */
(function () {
  'use strict';

  // Idempotent: a customer with the snippet in both a layout template and
  // a page body would otherwise get two widgets.
  if (window.__converse360WidgetLoaded) return;
  window.__converse360WidgetLoaded = true;

  var settings = window.converse360Settings || {};
  var widgetKey = settings.widgetKey;

  if (!widgetKey) {
    // Console rather than silence: this is the one error a developer
    // installing the snippet will actually hit, and a silent no-op sends
    // them to support instead of to their own typo.
    if (window.console && console.warn) {
      console.warn(
        '[converse360] window.converse360Settings.widgetKey is missing — the chat widget will not load.',
      );
    }
    return;
  }

  // Derived from this script's own src, so a self-hosted or
  // white-labelled deployment works with no extra configuration.
  var origin = (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      var src = scripts[i].src || '';
      if (src.indexOf('/widget/v1/loader.js') !== -1) {
        return src.split('/widget/v1/loader.js')[0];
      }
    }
    // document.currentScript is unavailable in the async case above but
    // works when the script is inlined; try it before giving up.
    if (document.currentScript && document.currentScript.src) {
      return document.currentScript.src.split('/widget/v1/')[0];
    }
    return '';
  })();

  var LAUNCHER_SIZE = 56;
  var LAUNCHER_MARGIN = 20;
  var PANEL_WIDTH = 400;
  var PANEL_HEIGHT = 620;

  var state = { open: false, unread: 0, position: 'right', mobile: isMobile() };

  function isMobile() {
    return window.innerWidth < 480;
  }

  function frameUrl(view) {
    var params =
      '?key=' +
      encodeURIComponent(widgetKey) +
      '&view=' +
      view +
      '&host=' +
      encodeURIComponent(location.origin) +
      '&page=' +
      encodeURIComponent(location.href.slice(0, 500));
    if (settings.locale) params += '&locale=' + encodeURIComponent(settings.locale);
    if (settings.identity && settings.identity.externalId) {
      params +=
        '&uid=' +
        encodeURIComponent(settings.identity.externalId) +
        '&uhmac=' +
        encodeURIComponent(settings.identity.hmac || '');
    }
    return origin + '/widget/v1/frame' + params;
  }

  function baseStyle(el) {
    var s = el.style;
    s.position = 'fixed';
    s.border = '0';
    s.outline = 'none';
    s.overflow = 'hidden';
    s.zIndex = '2147483000';
    s.colorScheme = 'normal';
    s.background = 'transparent';
    el.setAttribute('scrolling', 'no');
    return el;
  }

  var launcher = baseStyle(document.createElement('iframe'));
  launcher.title = 'Open chat';
  launcher.setAttribute('aria-label', 'Open chat');
  launcher.allowTransparency = 'true';
  launcher.src = frameUrl('launcher');

  var panel = baseStyle(document.createElement('iframe'));
  panel.title = 'Chat';
  panel.src = frameUrl('panel');
  panel.style.display = 'none';
  panel.style.borderRadius = '16px';
  panel.style.boxShadow = '0 12px 48px rgba(0,0,0,0.18)';
  panel.style.overflow = 'hidden';

  function layout() {
    state.mobile = isMobile();
    var side = state.position === 'left' ? 'left' : 'right';
    var other = side === 'left' ? 'right' : 'left';

    launcher.style[side] = LAUNCHER_MARGIN + 'px';
    launcher.style[other] = 'auto';
    launcher.style.bottom = LAUNCHER_MARGIN + 'px';
    launcher.style.width = LAUNCHER_SIZE + 'px';
    launcher.style.height = LAUNCHER_SIZE + 'px';

    if (state.mobile) {
      // Full-screen on phones. A 400px panel on a 375px viewport is
      // unusable, and the launcher has to hide or it covers the composer.
      panel.style.left = '0';
      panel.style.right = '0';
      panel.style.top = '0';
      panel.style.bottom = '0';
      panel.style.width = '100%';
      panel.style.height = '100%';
      panel.style.borderRadius = '0';
      launcher.style.display = state.open ? 'none' : 'block';
    } else {
      panel.style[side] = LAUNCHER_MARGIN + 'px';
      panel.style[other] = 'auto';
      panel.style.top = 'auto';
      panel.style.bottom = LAUNCHER_MARGIN + LAUNCHER_SIZE + 12 + 'px';
      panel.style.width = PANEL_WIDTH + 'px';
      // Never taller than the viewport — a 620px panel in a 500px window
      // puts the composer off-screen with no way to scroll to it.
      panel.style.height =
        Math.min(PANEL_HEIGHT, window.innerHeight - LAUNCHER_MARGIN * 2 - LAUNCHER_SIZE - 12) +
        'px';
      panel.style.borderRadius = '16px';
      launcher.style.display = 'block';
    }
  }

  function setOpen(open) {
    state.open = open;
    panel.style.display = open ? 'block' : 'none';
    layout();
    post(launcher, { type: 'state', open: open });
    if (open) post(panel, { type: 'opened' });
  }

  function post(frame, message) {
    if (!frame.contentWindow || !origin) return;
    // Targeted origin, never '*': a '*' target broadcasts to whatever is
    // in that frame, which on a compromised or redirected frame means
    // leaking whatever we put in the message.
    try {
      frame.contentWindow.postMessage(message, origin);
    } catch (e) {
      /* frame not ready yet; it re-announces on load */
    }
  }

  window.addEventListener('message', function (event) {
    // BOTH checks are required. Without the origin check any page could
    // postMessage us and drive the widget; without the source check
    // another frame from our own origin could.
    if (event.origin !== origin) return;
    if (event.source !== launcher.contentWindow && event.source !== panel.contentWindow) {
      return;
    }

    var data = event.data || {};
    if (data.type === 'toggle') setOpen(!state.open);
    else if (data.type === 'open') setOpen(true);
    else if (data.type === 'close') setOpen(false);
    else if (data.type === 'unread') {
      state.unread = data.count || 0;
      post(launcher, { type: 'unread', count: state.unread });
    } else if (data.type === 'config') {
      // The frame has bootstrapped and knows the account's appearance.
      // Position can only be applied here, in the host page.
      if (data.position) state.position = data.position;
      layout();
    }
  });

  function mount() {
    document.body.appendChild(launcher);
    document.body.appendChild(panel);
    layout();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    // Debounced: a mobile browser fires resize on every scroll as the URL
    // bar collapses, and re-laying out on each one janks the page we are
    // a guest on.
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 120);
  });

  /**
   * The public API. Small on purpose — every method here is a promise we
   * can never break.
   */
  window.converse360 = {
    open: function () {
      setOpen(true);
    },
    close: function () {
      setOpen(false);
    },
    toggle: function () {
      setOpen(!state.open);
    },
    isOpen: function () {
      return state.open;
    }
  };
})();
