// Dashboard motion: the same small effects as the website (assets/js/ae-motion.js),
// trimmed to what the dashboard uses. Plain JavaScript, no framework, no inline code (CSP).
//   1. Reveal      [data-reveal] fades up 12px once, 400ms; siblings stagger 60ms
//   2. Header      .topbar becomes dark frosted glass after 8px of scroll
//   3. Nav pill    a glass pill glides between jump bar links, rests on the section in view
//   4. Magnetic    buttons lean toward a fine pointer (up to 6px)
//   5. Glow        a faint white light trails a fine pointer
//   6. Card light  a faint spotlight follows the pointer across cards (CSS reads --sx, --sy)
// Reduced motion: html.ae-calm, content is shown at once. Every effect is decoration:
// if anything here fails, the page still works.
(function () {
  'use strict';
  var doc = document;
  var html = doc.documentElement;
  var calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var finePointer = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  if (calm) html.classList.add('ae-calm');
  html.classList.add('ae-js');

  function onScroll(fn) {
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; fn(); });
    }, { passive: true });
  }

  /* 1. REVEAL */
  function reveal(el) {
    el.classList.add('is-revealed');
    // The stagger delay is only for the entrance: drop it so hover lifts respond at once.
    if (el.style.getPropertyValue('--delay')) setTimeout(function () { el.style.removeProperty('--delay'); }, 1200);
  }
  var io = (!calm && 'IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      io.unobserve(entry.target);
      reveal(entry.target);
    });
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.01 }) : null;

  /**
   * Reveals [data-reveal] inside root. animate=false shows them at once (used when the
   * dashboard redraws its data every minute, so nothing fades in twice).
   */
  function observe(root, animate) {
    root = root || doc;
    var els = Array.prototype.slice.call(root.querySelectorAll('[data-reveal]'));
    if (root.matches && root.matches('[data-reveal]')) els.unshift(root);
    if (!animate || !io) { els.forEach(function (el) { el.classList.add('is-revealed'); }); return; }
    // Siblings that appear together arrive one after another, 60ms apart (max 4 steps).
    Array.prototype.forEach.call(root.querySelectorAll('[data-stagger]'), function (parent) {
      Array.prototype.forEach.call(parent.children, function (child, i) {
        if (child.hasAttribute('data-reveal')) child.style.setProperty('--delay', (i % 4) * 0.06 + 's');
      });
    });
    els.forEach(function (el) { io.observe(el); });
    // Backstop: whatever has not revealed after 3s is shown.
    setTimeout(function () { els.forEach(function (el) { if (!el.classList.contains('is-revealed')) reveal(el); }); }, 3000);
  }

  /* 2. HEADER */
  function initHeader() {
    var header = doc.querySelector('.topbar');
    if (!header) return;
    function update() { header.classList.toggle('is-scrolled', window.scrollY > 8); }
    onScroll(update);
    update();
  }

  /* 3. NAV PILL */
  var pill = null;
  function initPill() {
    var box = doc.querySelector('.jump__inner');
    if (!box) return;
    var links = Array.prototype.slice.call(box.querySelectorAll('.jump__link'));
    if (!links.length) return;
    var el = doc.createElement('span');
    el.className = 'jump__pill is-still';
    el.setAttribute('aria-hidden', 'true');
    box.insertBefore(el, box.firstChild);
    html.classList.add('ae-pill-on');
    var state = { hover: null, rest: links[0], shown: null };

    function place(still) {
      var target = state.hover || state.rest;
      if (!target || !box.offsetWidth || !target.offsetWidth) { el.classList.remove('is-on'); state.shown = null; return; }
      var jump = still || !state.shown;
      if (jump) el.classList.add('is-still');
      el.style.setProperty('--px', target.offsetLeft + 'px');
      el.style.setProperty('--py', target.offsetTop + 'px');
      el.style.setProperty('--pw', target.offsetWidth + 'px');
      el.style.setProperty('--ph', target.offsetHeight + 'px');
      el.classList.add('is-on');
      links.forEach(function (a) { a.classList.toggle('is-lit', a === target); });
      state.shown = target;
      if (jump) { void el.offsetWidth; el.classList.remove('is-still'); }
    }

    links.forEach(function (a) {
      a.addEventListener('pointerover', function (e) {
        if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
        state.hover = a; place();
      });
      a.addEventListener('focus', function () {
        var vis = true;
        try { vis = a.matches(':focus-visible'); } catch (err) { /* old browser */ }
        if (vis) { state.hover = a; place(); }
      });
      a.addEventListener('blur', function () { if (state.hover === a) { state.hover = null; place(); } });
      a.addEventListener('click', function () {
        state.rest = a; state.hover = null;
        links.forEach(function (l) { if (l === a) l.setAttribute('aria-current', 'true'); else l.removeAttribute('aria-current'); });
        place();
      });
    });
    box.addEventListener('pointerleave', function () { state.hover = null; place(); });

    // Rest on the section in view (sections are looked up by the link's #hash, so
    // sections drawn later by app.js count too).
    function updateSection() {
      // The reading line sits just under the sticky bars (with room for scroll-padding rounding).
      var bar = doc.querySelector('.jump');
      var line = (bar ? bar.getBoundingClientRect().bottom : 110) + 48;
      var found = null;
      links.forEach(function (a) {
        var id = (a.getAttribute('href') || '').replace(/^#/, '');
        var s = id && doc.getElementById(id);
        if (!s) return;
        var r = s.getBoundingClientRect();
        if (r.top <= line && r.bottom > line) found = a;
      });
      // At the very bottom of the page the last short section may never cross the line.
      // (Only after a scroll: a page short enough to fit the screen starts on its first link.)
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= doc.documentElement.scrollHeight - 4) {
        for (var i = links.length - 1; i >= 0; i--) {
          var last = doc.getElementById((links[i].getAttribute('href') || '').replace(/^#/, ''));
          if (last) { found = links[i]; break; }
        }
      }
      found = found || links[0];
      if (found === state.rest) return;
      state.rest = found;
      links.forEach(function (a) { if (a === found) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
      place();
    }
    var queued = false;
    function relayout() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; place(true); updateSection(); });
    }
    onScroll(updateSection);
    window.addEventListener('resize', relayout);
    window.addEventListener('load', relayout);
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(relayout);
    if ('ResizeObserver' in window) new ResizeObserver(relayout).observe(box);
    pill = { relayout: relayout };
    place(true);
    updateSection();
  }

  /* 4. MAGNETIC BUTTONS */
  function initMagnetic() {
    if (calm || !finePointer) return;
    var RANGE = 6;
    doc.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      var b = e.target.closest && e.target.closest('.btn');
      if (!b || b.disabled) return;
      var r = b.getBoundingClientRect();
      var dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      var dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      b.classList.remove('is-magnet-out');
      b.style.setProperty('--mx', (dx * RANGE).toFixed(1) + 'px');
      b.style.setProperty('--my', (dy * RANGE).toFixed(1) + 'px');
    }, { passive: true });
    doc.addEventListener('pointerout', function (e) {
      var b = e.target.closest && e.target.closest('.btn');
      if (!b || (e.relatedTarget && b.contains(e.relatedTarget))) return;
      b.classList.add('is-magnet-out');
      b.style.removeProperty('--mx');
      b.style.removeProperty('--my');
    }, { passive: true });
  }

  /* 5. CURSOR GLOW */
  function initGlow() {
    if (calm || !finePointer) return;
    var g = doc.createElement('div');
    g.className = 'ae-glow';
    g.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(g);
    var x = -999, y = -999, tx = -999, ty = -999, raf = 0;
    function step() {
      x += (tx - x) * 0.14; y += (ty - y) * 0.14;
      g.style.setProperty('--gx', x.toFixed(1) + 'px');
      g.style.setProperty('--gy', y.toFixed(1) + 'px');
      raf = (Math.abs(tx - x) + Math.abs(ty - y) > 0.5) ? requestAnimationFrame(step) : 0;
    }
    window.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      if (!g.classList.contains('is-on')) { x = tx = e.clientX; y = ty = e.clientY; g.classList.add('is-on'); }
      tx = e.clientX; ty = e.clientY;
      if (!raf) raf = requestAnimationFrame(step);
    }, { passive: true });
    doc.addEventListener('pointerleave', function () { g.classList.remove('is-on'); });
  }

  /* 6. CARD LIGHT */
  function initCardLight() {
    if (calm || !finePointer) return;
    doc.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      var c = e.target.closest && e.target.closest('.card');
      if (!c) return;
      var r = c.getBoundingClientRect();
      c.style.setProperty('--sx', (e.clientX - r.left).toFixed(0) + 'px');
      c.style.setProperty('--sy', (e.clientY - r.top).toFixed(0) + 'px');
    }, { passive: true });
  }

  // Public hooks for app.js (the dashboard draws its content after load).
  window.AEMotion = {
    calm: calm,
    observe: observe,
    relayout: function () { if (pill) pill.relayout(); },
  };

  function init() {
    [initHeader, initPill, initMagnetic, initGlow, initCardLight].forEach(function (fn) {
      try { fn(); } catch (err) { /* decoration only: never break the page */ }
    });
    try { observe(doc, true); } catch (err) { html.classList.remove('ae-js'); }
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
