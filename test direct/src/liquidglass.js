/*!
 * Liquid Glass — refraction engine (vanilla JS port).
 *
 * The refraction field is a port of the fragment shader in liquid-glass-js
 * (https://github.com/dashersw/liquid-glass-js) — Copyright (c) 2025 Armagan
 * Amcalar, MIT. Permission is hereby granted, free of charge, to any person
 * obtaining a copy of that software to deal in it without restriction,
 * provided this notice travels with it; it is provided "as is", without
 * warranty of any kind. Keep this header on any copy or port.
 *
 * Ported from the Angular directive shipped by the LiquidGlassSkill plugin
 * (https://github.com/stormaref/LiquidGlassSkill) to plain JS so it runs in
 * this Electron renderer without a framework. The mechanism is unchanged:
 * per element, bake a displacement map into a <canvas>, build a shared SVG
 * filter (feImage → feDisplacementMap → feGaussianBlur) and point the element
 * at it via `backdrop-filter: url(#…)`, so the panel refracts the LIVE
 * backdrop through its edge — tracking scroll, theme switches and content
 * updates for free.
 *
 * Pair with the `.liquid-glass` / `.liquid-glass--modal` classes from
 * style.css (the tint + rim layer). Elements opt in with `data-liquid-glass`.
 *
 * SVG-referenced backdrop filters are Chromium-only; elsewhere the engine is
 * inert and the stylesheet's plain `backdrop-filter: blur(...)` fallback stays
 * in effect. The engine only engages while `.theme-glass` is on <body>.
 */
(function (global) {
  'use strict';

  /* Mirrors the shader uniforms of liquid-glass-js; distances are exponential
     falloff rates per pixel from the shape edge, intensities are in
     page-texture fraction units. */
  var GLASS_PRESET = {
    edgeIntensity: 0.015,
    rimIntensity: 0.028,
    baseIntensity: 0.05,
    edgeDistance: 0.5,
    rimDistance: 1.7,
    baseDistance: 0.2,
    cornerBoost: 0.06,
    rippleEffect: 0.26,
    blurRadius: 2,
    warp: false // center distortion off keeps the middle legible
  };

  /* Render the map at 2x the CSS size: the rim refraction lives in a 1-2px
     band, and a 1x map would smear it. */
  var SUPERSAMPLE = 2;
  /* Cap the baked map's longest (supersampled) edge; refraction is edge-local,
     so a wide topbar doesn't need a full 2x map through its neutral middle. */
  var MAX_MAP_EDGE = 1400;
  /* Cap the total map area as well — the bake is pure math on the main thread,
     so a big square panel must not blow past ~1.2M samples even when both its
     edges sit under MAX_MAP_EDGE. */
  var MAX_MAP_PIXELS = 1200000;
  /* feGaussianBlur stdDeviation per unit of blurRadius; fit so blurRadius 2
     matches the library's 13-tap page-texture kernel. */
  var BLUR_STD_PER_RADIUS = 0.35;

  var filters = new Map(); // key -> { id, node, refs }
  var defs = null;
  var nextId = 0;
  var instances = new Map(); // el -> { raf, key }
  var domObserver = null;
  // One ResizeObserver + one debounced window-resize listener shared by every
  // instance (the old per-element observers/listeners were correct but O(n) at
  // boot and on every drag-resize).
  var sharedRO = null;
  var windowResizeHandler = null;
  var windowResizeDebounce = 0;

  function isSupported() {
    var uaData = navigator.userAgentData;
    var brands = uaData && uaData.brands;
    if (brands) {
      for (var i = 0; i < brands.length; i++) {
        if (/Chromium|Google Chrome|Microsoft Edge/i.test(brands[i].brand)) return true;
      }
      // userAgentData exists but carries no matching brand — fall through to
      // the UA string so the engine isn't silently disabled on Chromium forks.
    }
    return /Chrome\//.test(navigator.userAgent);
  }

  /* SVG-referenced backdrop filters are rasterized on the GPU; on a software
     rasterizer (SwiftShader / llvmpipe) every frame of a moving panel costs
     CPU. Detect it and fall back to the stylesheet's plain blur — the skill's
     own stance (refraction is progressive enhancement, not a requirement). */
  var softwareGL = null;
  function isSoftwareRenderer() {
    if (softwareGL !== null) return softwareGL;
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      var dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
      softwareGL = !name || /swiftshader|llvmpipe|software/i.test(name);
    } catch (_) {
      softwareGL = true;
    }
    return softwareGL;
  }

  function isGlassActive() {
    return document.body.classList.contains('theme-glass');
  }

  function clampByte(v) {
    return Math.max(0, Math.min(255, Math.round(v)));
  }

  /* Resolve a computed border-radius (px or %) to CSS pixels. */
  function resolveRadius(computed, w, h) {
    var value = parseFloat(computed) || 0;
    return computed.trim().endsWith('%') ? (value / 100) * Math.min(w, h) : value;
  }

  /* Bake the shader's refraction field into a displacement map: R/G encode the
     x/y sample offset around neutral 128, scaled so the extremes span the
     feDisplacementMap `scale`. Formulas transcribed 1:1 from container.js. */
  function buildDisplacementMap(w, h, radius, pageW, pageH, cfg) {
    var ss = Math.min(
      SUPERSAMPLE,
      MAX_MAP_EDGE / Math.max(w, h),
      Math.sqrt(MAX_MAP_PIXELS / (w * h))
    );
    ss = Math.max(0.25, ss);
    var bw = Math.max(1, Math.round(w * ss));
    var bh = Math.max(1, Math.round(h * ss));
    // Hard cap on the total sample count: the 0.25 ss floor can round a
    // near-fullscreen surface up past MAX_MAP_PIXELS, so clamp the pixel
    // counts down proportionally after rounding rather than trusting the
    // pre-round formula alone.
    var maxPx = MAX_MAP_PIXELS;
    if (bw * bh > maxPx) {
      var k = Math.sqrt(maxPx / (bw * bh));
      bw = Math.max(1, Math.round(bw * k));
      bh = Math.max(1, Math.round(bh * k));
    }
    var r = radius * ss;
    var minDim = Math.min(w, h);
    var dx = new Float32Array(bw * bh);
    var dy = new Float32Array(bw * bh);
    var maxAbs = 0;

    for (var py = 0; py < bh; py++) {
      for (var px = 0; px < bw; px++) {
        var cx = (px + 0.5) / bw;
        var cy = (py + 0.5) / bh;

        // Signed distance to the rounded-rect edge (supersampled px -> CSS px).
        var tx = Math.abs(px + 0.5 - bw / 2) - (bw / 2 - r);
        var ty = Math.abs(py + 0.5 - bh / 2) - (bh / 2 - r);
        var outside = Math.hypot(Math.max(tx, 0), Math.max(ty, 0));
        var inside = Math.min(Math.max(tx, ty), 0);
        var distPx = Math.max(-(outside + inside - r), 0) / ss;

        var edgeFall = Math.exp(-distPx * cfg.edgeDistance);
        var rimFall = Math.exp(-distPx * cfg.rimDistance);
        var baseFall = 1 - Math.exp(-distPx * cfg.baseDistance);
        var baseComponent = cfg.warp ? baseFall * cfg.baseIntensity : 0;
        var total = baseComponent + edgeFall * cfg.edgeIntensity + rimFall * cfg.rimIntensity;

        // The shader's rounded-rect normal, taken in texcoord space.
        var nx = cx - 0.5;
        var ny = cy - 0.5;
        var len = Math.hypot(nx, ny);
        if (len > 0) { nx /= len; ny /= len; }

        var cornerNorm = Math.max(Math.min(cx, 1 - cx), Math.min(cy, 1 - cy)) * minDim;
        var corner = Math.exp(-cornerNorm * 0.3) * cfg.cornerBoost;

        var ripple = Math.sin((distPx / minDim) * 25) * cfg.rippleEffect * rimFall;

        // normal * (refraction + corner boost) + perpendicular * ripple,
        // converted from page-texture fractions to pixels.
        var fx = (nx * (total + corner) - ny * ripple) * pageW;
        var fy = (ny * (total + corner) + nx * ripple) * pageH;

        var i = py * bw + px;
        dx[i] = fx;
        dy[i] = fy;
        maxAbs = Math.max(maxAbs, Math.abs(fx), Math.abs(fy));
      }
    }

    var scale = Math.max(maxAbs * 2, 1e-4);
    // feDisplacementMap decodes byte b as scale*(b/255 - 0.5); since 128/255
    // != 0.5, a naive neutral would drift the interior by scale/510 px.
    // Pre-subtract the decode bias so zero displacement stays put.
    var bias = scale * (128 / 255 - 0.5);
    var canvas = document.createElement('canvas');
    canvas.width = bw;
    canvas.height = bh;
    var ctx = canvas.getContext('2d');
    var image = ctx.createImageData(bw, bh);
    var data = image.data;
    for (var k = 0; k < bw * bh; k++) {
      data[k * 4] = clampByte(255 * (0.5 + (dx[k] - bias) / scale));
      data[k * 4 + 1] = clampByte(255 * (0.5 + (dy[k] - bias) / scale));
      data[k * 4 + 2] = 128;
      data[k * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return { mapUrl: canvas.toDataURL('image/png'), scale: scale };
  }

  function ensureDefs() {
    if (!defs || !defs.isConnected) {
      var NS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.position = 'fixed';
      svg.setAttribute('aria-hidden', 'true');
      svg.appendChild(document.createElementNS(NS, 'defs'));
      document.body.appendChild(svg);
      defs = svg;
    }
    return defs;
  }

  function releaseFilter(key) {
    if (!key) return;
    var entry = filters.get(key);
    if (entry && --entry.refs <= 0) {
      filters.delete(key);
      entry.node.remove();
    }
  }

  /* Same-size surfaces (the common case: a list of cards) share one filter. */
  function acquireFilter(key, w, h, radius, pageW, pageH, cfg) {
    var entry = filters.get(key);
    // Reuse only if the cached node is still in the live document — if the
    // shared defs <svg> was ever detached, its url(#id) no longer resolves.
    if (entry && entry.node.isConnected) {
      entry.refs++;
      return entry;
    }
    if (entry) filters.delete(key);

    var built = buildDisplacementMap(w, h, radius, pageW, pageH, cfg);
    var id = 'liquid-glass-' + nextId++;
    var NS = 'http://www.w3.org/2000/svg';

    var filter = document.createElementNS(NS, 'filter');
    filter.setAttribute('id', id);
    // Edge pixels sample the backdrop up to `scale/2` away, plus the blur
    // spread; the region must extend past the box or the refraction clips to
    // transparent at the corners. Size it from the actual field.
    var marginPx = built.scale / 2 + 3 * cfg.blurRadius * BLUR_STD_PER_RADIUS;
    var mx = (marginPx / w) * 100;
    var my = (marginPx / h) * 100;
    filter.setAttribute('x', (-mx) + '%');
    filter.setAttribute('y', (-my) + '%');
    filter.setAttribute('width', (100 + 2 * mx) + '%');
    filter.setAttribute('height', (100 + 2 * my) + '%');
    filter.setAttribute('color-interpolation-filters', 'sRGB');

    var feImage = document.createElementNS(NS, 'feImage');
    feImage.setAttribute('href', built.mapUrl);
    feImage.setAttribute('x', '0');
    feImage.setAttribute('y', '0');
    feImage.setAttribute('width', String(w));
    feImage.setAttribute('height', String(h));
    feImage.setAttribute('preserveAspectRatio', 'none');
    feImage.setAttribute('result', 'map');

    var feDisplacement = document.createElementNS(NS, 'feDisplacementMap');
    feDisplacement.setAttribute('in', 'SourceGraphic');
    feDisplacement.setAttribute('in2', 'map');
    feDisplacement.setAttribute('scale', String(built.scale));
    feDisplacement.setAttribute('xChannelSelector', 'R');
    feDisplacement.setAttribute('yChannelSelector', 'G');
    feDisplacement.setAttribute('result', 'displaced');

    // Frosting on the refracted sample (see BLUR_STD_PER_RADIUS).
    var feBlur = document.createElementNS(NS, 'feGaussianBlur');
    feBlur.setAttribute('in', 'displaced');
    feBlur.setAttribute('stdDeviation', String(cfg.blurRadius * BLUR_STD_PER_RADIUS));
    feBlur.setAttribute('result', 'frosted');

    // Restore the saturate(1.4) that the CSS backdrop-filter provides; the
    // CSS's `backdrop-filter: url(#…)` replaces the property entirely, so we
    // bake it into the SVG chain.
    var feSat = document.createElementNS(NS, 'feColorMatrix');
    feSat.setAttribute('in', 'frosted');
    feSat.setAttribute('type', 'saturate');
    feSat.setAttribute('values', '1.4');

    filter.append(feImage, feDisplacement, feBlur, feSat);
    ensureDefs().querySelector('defs').appendChild(filter);

    entry = { id: id, node: filter, refs: 1 };
    filters.set(key, entry);
    return entry;
  }

  function rebuild(el) {
    var state = instances.get(el);
    if (!state) return;
    if (!isGlassActive()) return;
    var w = Math.round(el.offsetWidth);
    var h = Math.round(el.offsetHeight);
    if (w < 2 || h < 2) return;

    var radius = Math.min(
      resolveRadius(getComputedStyle(el).borderTopLeftRadius, w, h),
      Math.min(w, h) / 2
    );
    // The shader displaces in fractions of the page snapshot; the live
    // equivalent is the viewport.
    var pageW = window.innerWidth;
    var pageH = window.innerHeight;
    var cfg = GLASS_PRESET;
    var key = [w, h, radius, pageW, pageH].join('|');

    if (key === state.key) return;
    releaseFilter(state.key);
    var entry = acquireFilter(key, w, h, radius, pageW, pageH, cfg);
    state.key = key;
    el.style.backdropFilter = 'url(#' + entry.id + ')';
  }

  function schedule(el) {
    var state = instances.get(el);
    if (!state) return;
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(function () {
      state.raf = 0; // fired — a later cancelAnimationFrame(0) is a no-op
      rebuild(el);
    });
  }

  function observe(el) {
    if (instances.has(el)) return;
    if (!isSupported()) return;
    if (!isGlassActive()) return;
    // Conservative default (lowPerf=true): plain CSS blur, same perf as the
    // dark theme. The SVG engine engages only after the probe proves the
    // machine is fast — see startPerfProbe().
    if (lowPerf) return;
    // Software renderers (SwiftShader in Electron) choke on backdrop-filter
    // url(#…) nodes — drop to the cheap blur for the whole theme.
    if (isSoftwareRenderer()) {
      setLowPerf();
      return;
    }

    var state = { raf: 0, key: null };
    if (!sharedRO) {
      sharedRO = new ResizeObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) schedule(entries[i].target);
      });
    }
    sharedRO.observe(el);
    ensureWindowResize();
    instances.set(el, state);
    schedule(el);
  }

  function unobserve(el) {
    var state = instances.get(el);
    if (!state) return;
    cancelAnimationFrame(state.raf);
    if (sharedRO) sharedRO.unobserve(el);
    releaseFilter(state.key);
    el.style.backdropFilter = '';
    instances.delete(el);
    releaseWindowResize();
  }

  /* A viewport resize changes pageW/pageH for every instance at once; debounce
     so a drag-resize doesn't rebake every map every frame. Registered once,
     released when the last instance goes away. */
  function ensureWindowResize() {
    if (windowResizeHandler) return;
    windowResizeHandler = function () {
      clearTimeout(windowResizeDebounce);
      windowResizeDebounce = setTimeout(function () {
        var all = Array.from(instances.keys());
        for (var i = 0; i < all.length; i++) schedule(all[i]);
      }, 180);
    };
    window.addEventListener('resize', windowResizeHandler, { passive: true });
  }

  function releaseWindowResize() {
    if (windowResizeHandler && instances.size === 0) {
      window.removeEventListener('resize', windowResizeHandler);
      windowResizeHandler = null;
      clearTimeout(windowResizeDebounce);
    }
  }

  function scanAndAttach() {
    if (!isSupported()) return;
    if (!isGlassActive()) {
      // Dark theme: stop the engine entirely (incl. the DOM observer, which
      // would otherwise churn on every app mutation).
      var all = Array.from(instances.keys());
      for (var i = 0; i < all.length; i++) unobserve(all[i]);
      stopDomObserver();
      return;
    }
    startDomObserver();
    var targets = document.querySelectorAll('[data-liquid-glass]');
    var set = new Set(targets);
    // Drop instances whose element is gone or no longer opted in.
    var current = Array.from(instances.keys());
    for (var j = 0; j < current.length; j++) {
      if (!set.has(current[j]) || !current[j].isConnected) unobserve(current[j]);
    }
    for (var k = 0; k < targets.length; k++) observe(targets[k]);
  }

  /* Watch for dynamically inserted `[data-liquid-glass]` elements (e.g. a
     modal re-created by the renderer). Additions are observed live; removals
     release the instance immediately so a short-lived glass element can't leak
     its ResizeObserver entry or filter refs until the next theme toggle. The
     observer runs only while the glass theme is active (started/stopped from
     scanAndAttach); in dark mode it would just churn on every app mutation. */
  function startDomObserver() {
    if (domObserver || !global.MutationObserver) return;
    domObserver = new MutationObserver(function (muts) {
      if (!isSupported() || !isGlassActive()) return;
      for (var m = 0; m < muts.length; m++) {
        var added = muts[m].addedNodes;
        for (var a = 0; a < added.length; a++) {
          var node = added[a];
          if (node.nodeType !== 1) continue;
          if (node.hasAttribute && node.hasAttribute('data-liquid-glass')) observe(node);
          var inner = node.querySelectorAll && node.querySelectorAll('[data-liquid-glass]');
          if (inner) {
            for (var q = 0; q < inner.length; q++) observe(inner[q]);
          }
        }
        var removed = muts[m].removedNodes;
        for (var r = 0; r < removed.length; r++) {
          var gone = removed[r];
          if (gone.nodeType !== 1) continue;
          // A same-parent move coalesces removal+insertion into one record
          // whose removedNodes lists a node that is still in the document —
          // don't tear down a live surface on a reorder.
          if (gone.isConnected) continue;
          if (instances.has(gone)) unobserve(gone);
          var goneInner = gone.querySelectorAll && gone.querySelectorAll('[data-liquid-glass]');
          if (goneInner) {
            for (var q2 = 0; q2 < goneInner.length; q2++) {
              if (instances.has(goneInner[q2])) unobserve(goneInner[q2]);
            }
          }
        }
      }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopDomObserver() {
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
  }

  /* --- Low-performance mode ---
     Electron on this machine reports ~60fps with the metal mesh but the SVG
     displacement + backdrop-filter stack still costs real frames — the web
     preview in a normal Chrome is fine, the packaged app is not. So instead of
     trusting a renderer-name sniff, measure actual frames: after glass first
     engages, sample rAF for a second. If we can't hold ~50fps with the effect
     attached, tear it all down and drop to the cheap CSS blur. */
  var lowPerf = true; // FORCED ON (user reports intermittent jank in glass).
  // The SVG displacement + backdrop-filter stack re-resolves filters on every
  // scroll/resize burst; even when the idle probe passes it stutters under
  // real interaction on this machine. The plain CSS blur is the same perf
  // class as the dark theme, which never lags. Refraction stays available in
  // the code for fast machines but the probe below no longer lifts it.
  var probeRunning = false;
  var probeDone = true; // probe disabled — never enable refraction

  function setLowPerf() {
    if (lowPerf === true) return;
    lowPerf = true;
    var all = Array.from(instances.keys());
    for (var i = 0; i < all.length; i++) unobserve(all[i]);
    document.body.classList.add('liquid-glass-lowperf');
  }

  function enableRefraction() {
    if (lowPerf === false) return;
    lowPerf = false;
    document.body.classList.remove('liquid-glass-lowperf');
    scanAndAttach();
  }

  function sampleFps(ms) {
    return new Promise(function (resolve) {
      var frames = 0;
      var t0 = performance.now();
      function tick() {
        frames++;
        var el = performance.now() - t0;
        if (el < ms) { requestAnimationFrame(tick); return; }
        resolve((frames * 1000) / el);
      }
      requestAnimationFrame(tick);
    });
  }

  /* Probe machinery kept for reference but permanently disabled: probeDone
     starts true so startPerfProbe() returns immediately and refraction never
     engages. The cheap CSS blur is the shipping behaviour. */
  function startPerfProbe() {
    if (probeDone) return;
    if (probeRunning) return;
    probeRunning = true;
    (async function () {
      var fps1 = await sampleFps(1000);
      var fps2 = await sampleFps(1000);
      probeRunning = false;
      if (!isSoftwareRenderer() && fps1 >= 50 && fps2 >= 50) enableRefraction();
      else setLowPerf();
      probeDone = true;
    })();
  }

  function init() {
    if (!isSupported()) return;
    if (isGlassActive()) {
      // Conservative default: cheap blur NOW (the same perf class as the dark
      // theme). The probe may lift it to full refraction if the machine is
      // fast — but the user never waits through a laggy first paint.
      document.body.classList.add('liquid-glass-lowperf');
      startPerfProbe();
    }
    // scanAndAttach() starts the DOM observer itself when the glass theme is
    // active, so boot with a saved glass theme scans exactly once. In the
    // conservative default (lowPerf=true) observe() no-ops and the plain CSS
    // blur applies; the probe may lift it if the machine is fast.
    scanAndAttach();
  }

  function refresh() {
    if (!isSupported()) return;
    if (isGlassActive() && lowPerf) document.body.classList.add('liquid-glass-lowperf');
    scanAndAttach();
    if (isGlassActive()) startPerfProbe();
  }

  function destroy() {
    stopDomObserver();
    var all = Array.from(instances.keys());
    for (var i = 0; i < all.length; i++) unobserve(all[i]);
    // unobserve() already releases the shared RO / resize listener once the
    // last instance is gone; belt-and-braces for the empty-instances case.
    if (sharedRO) { sharedRO.disconnect(); sharedRO = null; }
    releaseWindowResize();
  }

  global.LiquidGlass = { init: init, refresh: refresh, destroy: destroy };
})(window);
