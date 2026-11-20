// Spider-Man Across New York
// Loads stops.json, draws the map, and moves Spider-Man between stops along a trail
// of little web "footprints". At each stop a clip of the fight pops up beside the pin.
(function () {
  'use strict';

  // Where the web trail leaves the New York map on the way to London (and comes back from).
  var OFFMAP_EXIT = L.latLng(40.64, -73.30);
  // A point near the east edge of the city, used to frame the map when heading off it.
  var VIEW_EDGE = L.latLng(40.66, -73.80);
  // Where Spider-Man comes in from on the small London map (just off its left edge).
  var LONDON_ENTRY = L.latLng(51.5072, -0.1010);
  var STOP_ZOOM = 13.5;
  var LONDON_ZOOM = 14;

  var state = {
    stops: [],
    series: {},
    index: -1,          // -1 = intro screen, 0..n-1 = a stop
    token: 0,           // bumps on every move, so a newer move cancels an older animation
    reduce: false,
    markers: [],
    layers: [],         // web trails currently drawn (on either map)
    londonMap: null
  };

  var el = {
    back: document.getElementById('btn-back'),
    next: document.getElementById('btn-next'),
    restart: document.getElementById('btn-restart'),
    listBtn: document.getElementById('btn-list'),
    reduce: document.getElementById('reduce-motion'),
    counter: document.getElementById('counter'),
    card: document.getElementById('card'),
    status: document.getElementById('status'),
    stage: document.getElementById('journey-stage'),
    legend: document.getElementById('legend'),
    hint: document.querySelector('.hint'),
    listView: document.getElementById('list-view'),
    stopList: document.getElementById('stop-list'),
    london: document.getElementById('london'),
    clip: document.getElementById('clip-pop'),
    clipFrame: document.getElementById('clip-frame'),
    clipTitle: document.getElementById('clip-title'),
    clipClose: document.getElementById('clip-close')
  };

  var map = L.map('map', {
    keyboard: false,          // the arrow keys move between stops instead
    scrollWheelZoom: false,   // don't trap the page scroll
    zoomSnap: 0.25
  });

  // Esri's free dark gray basemap: a base layer plus a separate layer of place labels.
  var ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
  function tiles(withCredit) {
    return L.layerGroup([
      L.tileLayer(ESRI + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 16,
        attribution: withCredit
          ? 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          : ''
      }),
      L.tileLayer(ESRI + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 })
    ]);
  }
  tiles(true).addTo(map);

  // ---------- Helpers ----------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function colorOf(stop) { return state.series[stop.series].color; }

  function pos(i) {
    var s = state.stops[i];
    return s.offMap ? OFFMAP_EXIT : L.latLng(s.lat, s.lng);
  }

  function isOffMapLeg(i) {
    return state.stops[i].offMap || (i > 0 && state.stops[i - 1].offMap);
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Resolves when the map finishes moving (with a timeout in case no move is needed).
  function moveDone(seconds) {
    return new Promise(function (resolve) {
      var done = false;
      function finish() { if (!done) { done = true; resolve(); } }
      map.once('moveend', finish);
      setTimeout(finish, seconds * 1000 + 400);
    });
  }

  // ---------- Web footprints ----------
  // A trip is a line of small web logos, like footprints. Each one sits a little above
  // the straight path (alternating high and low, like left and right feet) and is tilted
  // up and diagonally toward the next stop. Math is done in Web Mercator pixels at zoom 12.

  var CRS = L.CRS.EPSG3857, GZ = 12;
  function toPx(ll) { return CRS.latLngToPoint(L.latLng(ll), GZ); }
  function toLL(p) { return CRS.pointToLatLng(p, GZ); }

  function buildSteps(from, to, minSteps) {
    var p1 = toPx(from), p2 = toPx(to);
    var dx = p2.x - p1.x, dy = p2.y - p1.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len, uy = dy / len;
    // "Up" is the perpendicular that points toward the top of the screen.
    var nx = uy, ny = -ux;
    if (ny > 0 || (ny === 0 && nx > 0)) { nx = -nx; ny = -ny; }
    var count = Math.max(minSteps || 3, Math.min(24, Math.round(len / 22)));
    var gap = len / (count + 1);
    var heading = Math.atan2(dy, dx) * 180 / Math.PI;          // screen angle of travel
    var upTilt = (ux >= 0 ? 1 : -1) * 22;                       // rotate the web toward "up"
    var steps = [];
    for (var k = 1; k <= count; k++) {
      var t = k / (count + 1);
      var lift = gap * (k % 2 ? 0.55 : 0.2);                    // staggered like footprints
      steps.push({
        ll: toLL(L.point(p1.x + dx * t + nx * lift, p1.y + dy * t + ny * lift)),
        angle: heading - upTilt + (k % 2 ? -8 : 8)
      });
    }
    return steps;
  }

  // A corner spider web that fans out toward the upper right; it is rotated to face the travel direction.
  var WEB_SVG = (function () {
    var ox = 4, oy = 20, angles = [-90, -67.5, -45, -22.5, 0], rings = [6, 11, 16];
    function pt(r, a) { var t = a * Math.PI / 180; return [ox + r * Math.cos(t), oy + r * Math.sin(t)]; }
    var d = '';
    angles.forEach(function (a) { var p = pt(18, a); d += 'M' + ox + ' ' + oy + 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1); });
    rings.forEach(function (r) {
      for (var i = 0; i < angles.length - 1; i++) {
        var a = pt(r, angles[i]), b = pt(r, angles[i + 1]);
        var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        var cx = mx + (ox - mx) * 0.18, cy = my + (oy - my) * 0.18;   // strands sag toward the corner
        d += 'M' + a[0].toFixed(1) + ' ' + a[1].toFixed(1) + 'Q' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ' + b[0].toFixed(1) + ' ' + b[1].toFixed(1);
      }
    });
    return '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="' + d +
      '" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  })();

  // The web logo faces up-right (-45 degrees) as drawn, so rotate it by the difference.
  function webIcon(step, cls) {
    return L.divIcon({
      className: 'web-step-wrap',
      html: '<span class="web-step ' + cls + '" style="--r:' + (step.angle + 45).toFixed(1) + 'deg">' + WEB_SVG + '</span>',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
  }

  function track(layer) { state.layers.push(layer); return layer; }

  function clearLayers() {
    state.layers.forEach(function (l) { l.remove(); });
    state.layers = [];
  }

  function addStep(group, step, cls) {
    L.marker(step.ll, { icon: webIcon(step, cls), interactive: false, keyboard: false }).addTo(group);
  }

  // A finished trip drawn all at once.
  function drawStaticLeg(targetMap, from, to, bright, minSteps) {
    var group = track(L.layerGroup().addTo(targetMap));
    buildSteps(from, to, minSteps).forEach(function (s) { addStep(group, s, bright ? 'bright' : 'faint'); });
  }

  function drawStaticLegs(upto, brightLeg) {
    for (var k = 1; k <= upto; k++) drawStaticLeg(map, pos(k - 1), pos(k), k === brightLeg);
  }

  var SPIDER_SVG =
    '<svg width="30" height="30" viewBox="0 0 28 28" aria-hidden="true">' +
    '<circle cx="14" cy="14" r="12" fill="#C1121F" stroke="#F6F2EA" stroke-width="2"/>' +
    '<g stroke="#111" stroke-width="1.6" stroke-linecap="round" fill="none">' +
    '<path d="M12 11 8 7M16 11l4-4M11.5 13.5 6 12.5M16.5 13.5l5.5-1M11.5 15.5 6 17.5M16.5 15.5l5.5 2M12 17.5 8.5 21.5M16 17.5l3.5 4"/></g>' +
    '<ellipse cx="14" cy="12" rx="2" ry="2.2" fill="#111"/><ellipse cx="14" cy="16.3" rx="2.4" ry="3" fill="#111"/></svg>';

  // Spider-Man hops from web to web, stamping each one down as he lands on it.
  function animateSteps(targetMap, from, to, token, minSteps) {
    var steps = buildSteps(from, to, minSteps);
    var group = track(L.layerGroup().addTo(targetMap));
    var points = [L.latLng(from)].concat(steps.map(function (s) { return s.ll; })).concat([L.latLng(to)]);
    var hero = L.marker(points[0], {
      icon: L.divIcon({ className: 'swinger', html: SPIDER_SVG, iconSize: [30, 30], iconAnchor: [15, 15] }),
      interactive: false, keyboard: false, zIndexOffset: 2000
    }).addTo(group);

    var hops = points.length - 1;
    var perHop = Math.max(90, Math.min(240, 2200 / hops));
    var total = perHop * hops;
    var placed = 0;

    return new Promise(function (resolve) {
      var start = null;
      function frame(now) {
        if (token !== state.token) { resolve(false); return; }
        if (start === null) start = now;
        var elapsed = Math.min(total, now - start);
        var h = Math.min(hops - 1, Math.floor(elapsed / perHop));
        var t = elapsed >= total ? 1 : (elapsed - h * perHop) / perHop;

        // Stamp every web he has reached so far.
        var reached = elapsed >= total ? steps.length : Math.min(steps.length, h);
        while (placed < reached) { addStep(group, steps[placed], 'bright pop'); placed++; }

        // Move in a small hop (a little arc upward) between the two webs.
        var a = targetMap.project(points[h]), b = targetMap.project(points[h + 1]);
        var hop = Math.sin(Math.PI * t) * Math.min(18, a.distanceTo(b) * 0.4);
        var p = L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t - hop);
        hero.setLatLng(targetMap.unproject(p));

        if (elapsed < total) requestAnimationFrame(frame);
        else { hero.remove(); resolve(true); }
      }
      requestAnimationFrame(frame);
    });
  }

  function portalBurst(latlng) {
    if (state.reduce) return;
    var burst = L.marker(latlng, {
      icon: L.divIcon({ className: '', html: '<div class="portal-burst"></div>', iconSize: [220, 220], iconAnchor: [110, 110] }),
      interactive: false,
      keyboard: false
    }).addTo(map);
    setTimeout(function () { burst.remove(); }, 1300);
  }

  // ---------- Markers ----------

  function pinIcon(stop, i, active) {
    var cls = ['pin'];
    if (stop.approximate) cls.push('approx');
    if (stop.portal) cls.push('portal');
    if (active) cls.push('active');
    else if (i < state.index) cls.push('visited');
    return L.divIcon({
      className: 'pin-wrap',
      html: '<span class="' + cls.join(' ') + '" data-stop="' + i + '" style="--c:' + colorOf(stop) + '">' + (i + 1) + '</span>',
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });
  }

  function buildMarkers() {
    state.stops.forEach(function (stop, i) {
      if (stop.offMap) { state.markers.push(null); return; }
      var label = (i + 1) + '. ' + stop.title + ' (' + stop.year + '): ' + stop.place;
      var m = L.marker([stop.lat, stop.lng], {
        icon: pinIcon(stop, i, false),
        title: label,
        alt: label,
        keyboard: true,
        riseOnHover: true
      }).addTo(map);
      m.on('click', function () { go(i); });
      state.markers.push(m);
    });

    // Let keyboard users open a pin with Enter or Space.
    map.getContainer().addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var wrap = e.target.closest && e.target.closest('.leaflet-marker-icon');
      var pin = wrap && wrap.querySelector('[data-stop]');
      if (!pin) return;
      e.preventDefault();
      go(Number(pin.getAttribute('data-stop')));
    });
  }

  function updateMarkers() {
    state.markers.forEach(function (m, i) {
      if (!m) return;
      m.setIcon(pinIcon(state.stops[i], i, i === state.index));
      m.setZIndexOffset(i === state.index ? 1000 : 0);
    });
  }

  function nycBounds() {
    return L.latLngBounds(state.stops.filter(function (s) { return !s.offMap; })
      .map(function (s) { return [s.lat, s.lng]; }));
  }

  // Where to center the map on arrival so the pin sits off to one side, leaving room for the clip.
  function arrivalCenter(latlng) {
    var size = map.getSize();
    var p = map.project(latlng, STOP_ZOOM);
    if (size.x >= 700) p = p.add([size.x * 0.25, 0]);   // pin on the left, clip on the right
    else p = p.add([0, size.y * 0.28]);                 // small screens: pin near the top, clip below
    return map.unproject(p, STOP_ZOOM);
  }

  // ---------- London inset ----------

  function showLondon(stop) {
    el.london.hidden = false;
    var i = state.stops.indexOf(stop);
    if (!state.londonMap) {
      state.londonMap = L.map('london-map', {
        zoomControl: false, attributionControl: false, dragging: false,
        scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
        keyboard: false, touchZoom: false
      });
      tiles(false).addTo(state.londonMap);
      L.marker([stop.lat, stop.lng], { icon: pinIcon(stop, i, true), keyboard: false, interactive: false })
        .addTo(state.londonMap);
    }
    state.londonMap.invalidateSize();
    state.londonMap.setView([stop.lat, stop.lng], LONDON_ZOOM, { animate: false });
  }

  function hideLondon() { el.london.hidden = true; }

  // ---------- Fight clip pop-up ----------

  function openClip(autoplay) {
    var s = state.stops[state.index];
    if (!s) return;
    el.clipTitle.textContent = s.title + ' (' + s.year + ')';
    // Long clips stop after a few minutes (clipEnd, in seconds) so each one stays short.
    el.clipFrame.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(s.clip) +
      '?rel=0&playsinline=1' + (autoplay ? '&autoplay=1' : '') + (s.clipEnd ? '&end=' + Number(s.clipEnd) : '');
    el.clipFrame.title = 'Fight clip from ' + s.title + ' (' + s.year + ')';
    el.clip.hidden = false;
    placeClip();
  }

  function closeClip(returnFocus) {
    if (el.clip.hidden) return;
    el.clip.hidden = true;
    el.clipFrame.src = 'about:blank';   // stops the video
    if (returnFocus) {
      var btn = el.card.querySelector('[data-clip]');
      if (btn) btn.focus();
    }
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Put the clip beside the current pin (or beside the London box), with a pointer toward it.
  function placeClip() {
    if (el.clip.hidden || state.index < 0) return;
    var s = state.stops[state.index];
    var mw = map.getSize().x, mh = map.getSize().y;
    var W = mw < 600 ? mw - 24 : Math.round(clamp(mw * 0.46, 300, 520));
    el.clip.style.width = W + 'px';
    var H = el.clip.offsetHeight;
    var gap = 26, pt;

    if (s.offMap) {
      var stageBox = el.stage.getBoundingClientRect(), box = el.london.getBoundingClientRect();
      pt = L.point(box.right - stageBox.left, box.top - stageBox.top + box.height / 2);
      gap = 16;
    } else {
      pt = map.latLngToContainerPoint(pos(state.index));
    }

    var left, top, side;
    if (pt.x + gap + W <= mw - 10) { side = 'right'; left = pt.x + gap; }
    else if (pt.x - gap - W >= 10) { side = 'left'; left = pt.x - gap - W; }
    else { side = pt.y + gap + H <= mh - 10 ? 'below' : 'above'; left = clamp(pt.x - W / 2, 10, mw - W - 10); }

    if (side === 'right' || side === 'left') top = clamp(pt.y - H / 2, 10, mh - H - 10);
    else top = side === 'below' ? pt.y + gap : Math.max(10, pt.y - gap - H);

    el.clip.style.left = left + 'px';
    el.clip.style.top = top + 'px';
    el.clip.setAttribute('data-side', side);
    el.clip.style.setProperty('--py', clamp(pt.y - top, 18, H - 18) + 'px');
    el.clip.style.setProperty('--px', clamp(pt.x - left, 18, W - 18) + 'px');
  }

  map.on('move zoom resize', placeClip);
  window.addEventListener('resize', placeClip);
  el.clipClose.addEventListener('click', function () { closeClip(true); });

  // ---------- Card ----------

  var PIN_SVG = '<svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true"><path d="M8 0a8 8 0 0 0-8 8c0 6 8 12 8 12s8-6 8-12a8 8 0 0 0-8-8zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6z" fill="#FF8A8C"/></svg>';

  function renderIntro() {
    el.card.innerHTML =
      '<h2 id="card-title">How this works</h2>' +
      '<p>Each numbered pin is the spot where the biggest fight in a Spider-Man movie happens. Click <b>Start the journey</b> and Spider-Man will travel from the first movie to the newest one, leaving a trail of webs behind him.</p>' +
      '<p>When he gets to a stop, a clip of the fight pops up next to the pin and starts playing. All of the details about that movie will show up over here.</p>';
  }

  function renderStop(i) {
    var s = state.stops[i];
    var series = state.series[s.series];
    var approx = s.approximate
      ? '<p class="approx">I\'m not sure exactly where this is, either because the movie doesn\'t show it or because the place is made up, so this pin is my best guess.</p>'
      : '';
    el.card.innerHTML =
      '<p class="stop-meta"><span>Stop ' + (i + 1) + ' of ' + state.stops.length + '</span>' +
      '<span class="chip" style="--c:' + series.color + '"><span class="dot"></span>' + esc(series.name) + '</span></p>' +
      '<h2 id="card-title">' + esc(s.title) + ' <span style="font-weight:400">(' + s.year + ')</span></h2>' +
      '<p class="actor">Starring ' + esc(s.actor) + '</p>' +
      '<p class="place">' + PIN_SVG + '<span>' + esc(s.place) + '</span></p>' + approx +
      '<div class="clip-box"><button type="button" class="btn btn-quiet btn-clip" data-clip aria-controls="clip-pop">▶ Replay the fight clip</button>' +
      '<p class="clip-credit">Clip: ' + esc(s.clipChannel) + ' on YouTube</p></div>' +
      '<h3>The fight</h3><p>' + esc(s.fight) + '</p>' +
      '<h3>Why it matters</h3><p>' + esc(s.why) + '</p>' +
      '<h3>Fun fact</h3><p>' + esc(s.fact) + '</p>';
    el.card.scrollTop = 0;
  }

  el.card.addEventListener('click', function (e) {
    if (e.target.closest('[data-clip]')) openClip(true);
  });

  // ---------- Navigation ----------

  function updateControls() {
    var n = state.stops.length, i = state.index;
    el.back.disabled = i < 0;
    el.restart.disabled = i < 0;
    if (i < 0) { el.next.textContent = 'Start the journey →'; el.next.disabled = false; }
    else if (i === n - 1) { el.next.textContent = 'End of the journey'; el.next.disabled = true; }
    else { el.next.textContent = 'Next stop →'; el.next.disabled = false; }
    el.counter.textContent = i < 0 ? n + ' stops' : 'Stop ' + (i + 1) + ' of ' + n;
  }

  function announce() {
    if (state.index < 0) { el.status.textContent = 'Map overview. ' + state.stops.length + ' stops.'; return; }
    var s = state.stops[state.index];
    el.status.textContent = 'Stop ' + (state.index + 1) + ' of ' + state.stops.length + ': ' +
      s.title + ', ' + s.year + '. ' + s.place + '.';
  }

  // The clip plays by itself on arrival, unless the viewer asked for reduced motion.
  function arriveClip(token) {
    if (token !== state.token) return;
    openClip(!state.reduce);
  }

  function go(target) {
    var n = state.stops.length;
    if (target < -1 || target >= n) return;
    var prev = state.index;
    var token = ++state.token;
    state.index = target;

    var animate = !state.reduce && target >= 1 && target === prev + 1;

    closeClip(false);
    clearLayers();
    hideLondon();
    if (target >= 1) drawStaticLegs(animate ? target - 1 : target, animate ? -1 : target);

    if (target < 0) renderIntro(); else renderStop(target);
    updateMarkers();
    updateControls();
    announce();

    if (target < 0) {
      map.flyToBounds(nycBounds(), { padding: [40, 40], duration: state.reduce ? 0 : 0.9, animate: !state.reduce });
      return;
    }

    var stop = state.stops[target];
    if (animate) {
      runLeg(target, token);
    } else if (stop.offMap) {
      // Jump straight there: show the trail off the map and the finished trail into Tower Bridge.
      map.fitBounds(L.latLngBounds([pos(Math.max(0, target - 1)), VIEW_EDGE]), { padding: [60, 60], animate: false });
      showLondon(stop);
      drawStaticLeg(state.londonMap, LONDON_ENTRY, L.latLng(stop.lat, stop.lng), true, 5);
      arriveClip(token);
    } else {
      map.setView(arrivalCenter(pos(target)), STOP_ZOOM, { animate: false });
      if (stop.portal) portalBurst(pos(target));
      arriveClip(token);
    }
  }

  async function runLeg(i, token) {
    var stop = state.stops[i];
    var from = pos(i - 1), to = pos(i);

    // 1. Frame both ends of the trip (or the city edge, for London).
    var frame = isOffMapLeg(i)
      ? L.latLngBounds([stop.offMap ? from : to, VIEW_EDGE])
      : L.latLngBounds([from, to]);
    map.flyToBounds(frame, { padding: [70, 70], duration: 0.9, maxZoom: STOP_ZOOM });
    await moveDone(0.9);
    if (token !== state.token) return;

    // 2. Follow the web footprints.
    var finished = await animateSteps(map, from, to, token);
    if (!finished || token !== state.token) return;

    // 3. Arrive, then pop up the fight clip.
    if (stop.offMap) {
      showLondon(stop);
      await wait(300);
      if (token !== state.token) return;
      if (!(await animateSteps(state.londonMap, LONDON_ENTRY, L.latLng(stop.lat, stop.lng), token, 5))) return;
    } else {
      if (stop.portal) portalBurst(to);
      await wait(150);
      if (token !== state.token) return;
      map.flyTo(arrivalCenter(to), STOP_ZOOM, { duration: 0.9 });
      await moveDone(0.9);
    }
    arriveClip(token);
  }

  el.next.addEventListener('click', function () { go(state.index + 1); });
  el.back.addEventListener('click', function () { go(state.index - 1); });
  el.restart.addEventListener('click', function () { go(-1); });

  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape' && !el.clip.hidden) { closeClip(true); return; }
    if (!el.listView.hidden) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); if (state.index < state.stops.length - 1) go(state.index + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (state.index > -1) go(state.index - 1); }
  });

  // ---------- Reduce motion ----------

  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function setReduce(on) {
    state.reduce = on;
    el.reduce.checked = on;
    document.body.classList.toggle('reduce-motion', on);
  }
  setReduce(!!(mq && mq.matches));
  el.reduce.addEventListener('change', function () { setReduce(el.reduce.checked); });

  // ---------- List view ----------

  function buildList() {
    el.stopList.innerHTML = state.stops.map(function (s, i) {
      var series = state.series[s.series];
      return '<li style="--c:' + series.color + '">' +
        '<h3>' + (i + 1) + '. ' + esc(s.title) + ' (' + s.year + ')</h3>' +
        '<p class="meta">' + esc(series.name) + ' · Starring ' + esc(s.actor) + '</p>' +
        '<p><b>Where:</b> ' + esc(s.place) + (s.approximate ? ' (approximate location)' : '') + '</p>' +
        '<p><b>The fight:</b> ' + esc(s.fight) + '</p>' +
        '<p><b>Why it matters:</b> ' + esc(s.why) + '</p>' +
        '<p><b>Fun fact:</b> ' + esc(s.fact) + '</p>' +
        '<p><a href="https://www.youtube.com/watch?v=' + encodeURIComponent(s.clip) + '">Watch the fight from ' + esc(s.title) + ' on YouTube</a></p>' +
        '</li>';
    }).join('');
  }

  var navOnly = [el.back, el.next, el.counter, el.restart, el.reduce.parentNode];
  el.listBtn.addEventListener('click', function () {
    var showList = el.listBtn.getAttribute('aria-pressed') !== 'true';
    closeClip(false);
    el.listBtn.setAttribute('aria-pressed', String(showList));
    el.listBtn.textContent = showList ? 'View as a map' : 'View as a list';
    el.listView.hidden = !showList;
    el.stage.hidden = showList;
    el.legend.hidden = showList;
    el.hint.hidden = showList;
    navOnly.forEach(function (n) { n.hidden = showList; });
    if (showList) {
      var h = el.listView.querySelector('h2');
      h.setAttribute('tabindex', '-1');
      h.focus();
    } else {
      map.invalidateSize();
    }
  });

  // ---------- Legend ----------

  function buildLegend() {
    var items = Object.keys(state.series).map(function (k) {
      var s = state.series[k];
      return '<li><span class="dot" style="--c:' + s.color + '"></span>' + esc(s.name) + ' (' + s.years + ')</li>';
    });
    items.push('<li><span class="dot" style="--c:transparent;border-style:dashed"></span>Dashed outline: approximate location</li>');
    items.push('<li><span class="dot" style="--c:transparent;border-color:#49D6E8;box-shadow:0 0 6px #E84A9C"></span>Glowing ring: other universes</li>');
    el.legend.innerHTML = items.join('');
  }

  // ---------- Start ----------

  fetch('stops.json')
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (data) {
      state.stops = data.stops;
      state.series = data.series;
      buildMarkers();
      buildLegend();
      buildList();
      map.fitBounds(nycBounds(), { padding: [40, 40] });
      renderIntro();
      updateControls();
    })
    .catch(function (err) {
      if (window.console) console.error(err);
      el.card.innerHTML = '<h2 id="card-title">The map couldn\'t load</h2><p>Try refreshing the page. If you opened the file directly, run it from a web server instead.</p>';
    });
})();
