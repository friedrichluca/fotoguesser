/* FotoGuesser – Oberfläche */
(function () {
  'use strict';

  var CONFIG = {
    api: 'api.php',
    pollMs: 1500,
    // Satellit (Standard): Esri World Imagery plus Orts- und Ländernamen, kein API-Key nötig
    satTiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    satLabels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    satAttribution: 'Bilder &copy; Esri, Maxar, Earthstar Geographics',
    // Karte: OpenStreetMap (kostenlos, kein API-Key nötig)
    tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
    // Startausschnitt: Deutschland
    startBounds: [[47.27, 5.87], [55.06, 15.04]],
    // Ortssuche beim manuellen Setzen: Nominatim (OpenStreetMap, kein API-Key, max. 1 Anfrage/Sekunde)
    geocoder: 'https://nominatim.openstreetmap.org/search',
    maxImageSide: 1600,
    jpegQuality: 0.82
  };

  // ---------- kleine Helfer ----------

  function $(id) { return document.getElementById(id); }

  function el(tag, props) {
    var e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      if (arguments[i] != null) e.append(arguments[i]);
    }
    return e;
  }

  // Speichert im Browser-Speicher und zusätzlich als Cookie: Manche Handy-Browser
  // (z. B. in WhatsApp oder Instagram geöffnet) verlieren sonst beim Zurück/Vor die Anmeldung.
  function cookieGet(k) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function cookieSet(k, v) {
    document.cookie = k + '=' + encodeURIComponent(v) + '; path=/; max-age=2592000; SameSite=Lax' +
      (location.protocol === 'https:' ? '; Secure' : '');
  }
  function cookieDel(k) {
    document.cookie = k + '=; path=/; max-age=0; SameSite=Lax';
  }

  var store = {
    get: function (k) {
      var v = null;
      try { v = localStorage.getItem(k); } catch (e) { /* privat */ }
      return v !== null ? v : cookieGet(k);
    },
    set: function (k, v) {
      try { localStorage.setItem(k, v); } catch (e) { /* privat */ }
      cookieSet(k, v);
    },
    del: function (k) {
      try { localStorage.removeItem(k); } catch (e) { /* privat */ }
      cookieDel(k);
    }
  };

  function deviceId() {
    var id = store.get('fg_device');
    if (!id || !/^[a-f0-9]{32}$/.test(id)) {
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      id = Array.prototype.map.call(bytes, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
    }
    store.set('fg_device', id);
    return id;
  }

  // Leaflet-Tooltips setzen Text als HTML – Namen deshalb immer maskieren.
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtDistance(m) {
    if (m < 1000) return Math.round(m) + ' m';
    if (m < 10000) return (m / 1000).toFixed(1).replace('.', ',') + ' km';
    return Math.round(m / 1000).toLocaleString('de-DE') + ' km';
  }

  function fmtPoints(n) { return n.toLocaleString('de-DE'); }

  function fmtCoords(lat, lng) {
    return Math.abs(lat).toFixed(4) + (lat >= 0 ? ' N' : ' S') + ' · ' +
      Math.abs(lng).toFixed(4) + (lng >= 0 ? ' O' : ' W');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var p = iso.split('-');
    return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso;
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return Math.floor(sec / 60) + ':' + pad2(sec % 60);
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }

  // ---------- Server ----------

  var token = store.get('fg_token');

  function formData(action, data, file) {
    var fd = new FormData();
    fd.append('action', action);
    if (token) fd.append('token', token);
    if (data) Object.keys(data).forEach(function (k) { fd.append(k, data[k]); });
    if (file) fd.append('photo', file, file.name || 'photo.jpg');
    return fd;
  }

  function apiResult(status, json) {
    if (status < 200 || status >= 300 || !json || json.error) {
      var err = new Error((json && json.error) || 'Unbekannter Fehler.');
      err.status = status;
      throw err;
    }
    return json;
  }

  function api(action, data, file) {
    return fetch(CONFIG.api, { method: 'POST', body: formData(action, data, file), cache: 'no-store' }).then(function (res) {
      return res.json().catch(function () { return { error: 'Ungültige Antwort vom Server.' }; }).then(function (json) {
        return apiResult(res.status, json);
      });
    });
  }

  // ---------- Bildschirme ----------

  var current = null;
  var maps = {};

  function show(name) {
    if (current === name) return;
    current = name;
    document.querySelectorAll('.screen').forEach(function (s) {
      s.hidden = s.id !== 'screen-' + name;
    });
    $('app').classList.toggle('is-wide', name === 'guess' || name === 'reveal');
    window.scrollTo(0, 0);
    Object.keys(maps).forEach(function (k) { maps[k].invalidateSize(); });
  }

  function makeMap(id) {
    if (maps[id]) {
      maps[id].invalidateSize();
      return maps[id];
    }
    var map = L.map(id, { zoomControl: false, worldCopyJump: true, maxZoom: 19 }).fitBounds(CONFIG.startBounds);
    var layers = {
      sat: L.layerGroup([
        L.tileLayer(CONFIG.satTiles, { attribution: CONFIG.satAttribution, maxZoom: 19, maxNativeZoom: 18 }),
        L.tileLayer(CONFIG.satLabels, { maxZoom: 19, maxNativeZoom: 18, zIndex: 2 })
      ]),
      street: L.tileLayer(CONFIG.tiles, { attribution: CONFIG.attribution, maxZoom: 19, className: 'tiles-street' })
    };
    layers[baseName].addTo(map);
    mapLayers[id] = layers;
    L.control.zoom({ position: 'topright', zoomInTitle: 'Hineinzoomen', zoomOutTitle: 'Herauszoomen' }).addTo(map);
    new BaseToggle().addTo(map);
    maps[id] = map;
    return map;
  }

  function showStart(map) {
    map.invalidateSize();
    map.fitBounds(CONFIG.startBounds);
  }

  // ---------- Satellit / Karte umschalten (gilt für alle Karten) ----------

  var baseName = store.get('fg_base') === 'street' ? 'street' : 'sat';
  var mapLayers = {};
  var toggleButtons = [];

  function toggleLabel() { return baseName === 'sat' ? 'Karte' : 'Satellit'; }

  var BaseToggle = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      var btn = L.DomUtil.create('button', 'map-toggle');
      btn.type = 'button';
      btn.textContent = toggleLabel();
      btn.setAttribute('aria-label', 'Kartenansicht wechseln');
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, 'click', function () { setBase(baseName === 'sat' ? 'street' : 'sat'); });
      toggleButtons.push(btn);
      return btn;
    }
  });

  function setBase(name) {
    var old = baseName;
    baseName = name;
    store.set('fg_base', name);
    Object.keys(maps).forEach(function (id) {
      maps[id].removeLayer(mapLayers[id][old]);
      mapLayers[id][name].addTo(maps[id]);
    });
    toggleButtons.forEach(function (b) { b.textContent = toggleLabel(); });
  }

  var pinIcon = L.divIcon({ className: 'pin', html: '<span class="pin-head"></span>', iconSize: [24, 32], iconAnchor: [12, 32] });
  var flagIcon = L.divIcon({ className: 'flag', iconSize: [16, 16], iconAnchor: [8, 8] });

  // ---------- Spielstand abfragen ----------

  var state = null;
  var view = 'lobby';           // innerhalb der Lobby: 'lobby' oder 'upload'
  var pollTimer = null;
  var polling = false;
  var pollAgain = false;
  var failures = 0;

  function poll() {
    if (polling) { pollAgain = true; return; }
    clearTimeout(pollTimer);
    if (!token) return;
    polling = true;
    api('state').then(function (s) {
      failures = 0;
      render(s);
    }).catch(function (err) {
      if (err.status === 401) { leave(err.message); return; }
      failures++;
      if (!state && failures >= 2) show('home');
      if (failures === 3) toast('Verbindung wackelt … es wird weiter versucht.');
    }).then(function () {
      polling = false;
      if (!token) return;
      if (pollAgain) { pollAgain = false; poll(); return; }
      pollTimer = setTimeout(poll, CONFIG.pollMs);
    });
  }

  function render(s) {
    // „Noch eine Runde“: vom Endstand zurück in die Lobby
    if (state && state.room.state !== 'lobby' && s.room.state === 'lobby') {
      resetGameUi();
      view = 'lobby';
    }
    state = s;
    var st = s.room.state;
    if (st !== 'lobby') editingName = false;
    if (st === 'lobby') {
      if (view === 'upload') { show('upload'); renderUpload(s); }
      else { show('lobby'); renderLobby(s); }
    } else if (st === 'guessing') {
      show('guess'); renderGuess(s);
    } else if (st === 'reveal') {
      show('reveal'); renderReveal(s);
    } else if (st === 'finished') {
      show('final'); renderFinal(s);
    }
  }

  function enterRoom(res) {
    token = res.token;
    store.set('fg_token', token);
    view = 'lobby';
    try { history.replaceState(null, '', '?r=' + res.code); } catch (e) { /* egal */ }
    poll();
  }

  function leave(message) {
    token = null;
    state = null;
    store.del('fg_token');
    clearTimeout(pollTimer);
    resetGameUi();
    view = 'lobby';
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* egal */ }
    show('home');
    if (message) toast(message);
  }

  // ---------- Start ----------

  function initHome() {
    var nameInput = $('input-name');
    var codeInput = $('input-code');
    nameInput.value = store.get('fg_name') || '';
    var m = /[?&]r=([A-Za-z0-9]{4})/.exec(location.search);
    if (m) codeInput.value = m[1].toUpperCase();

    codeInput.addEventListener('input', function () {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    });

    $('form-home').addEventListener('submit', function (e) {
      e.preventDefault();
      var intent = document.activeElement === codeInput ? 'join'
        : (e.submitter && e.submitter.getAttribute('data-intent')) || 'create';
      var name = nameInput.value.trim();
      if (!name) { toast('Bitte gib zuerst deinen Namen ein.'); nameInput.focus(); return; }
      store.set('fg_name', name);
      var buttons = this.querySelectorAll('button');
      buttons.forEach(function (b) { b.disabled = true; });
      var req;
      if (intent === 'join') {
        if (codeInput.value.length !== 4) {
          buttons.forEach(function (b) { b.disabled = false; });
          toast('Der Raumcode hat 4 Zeichen.');
          codeInput.focus();
          return;
        }
        req = api('join', { name: name, code: codeInput.value, device: deviceId() });
      } else {
        req = api('create', { name: name, device: deviceId() });
      }
      req.then(enterRoom).catch(function (err) { toast(err.message); }).then(function () {
        buttons.forEach(function (b) { b.disabled = false; });
      });
    });
  }

  // ---------- Lobby ----------

  function roomLink(code) {
    return location.origin + location.pathname + '?r=' + code;
  }

  function renderLobby(s) {
    var r = s.room;
    $('lobby-code').textContent = r.code;
    $('lobby-link').textContent = roomLink(r.code).replace(/^https?:\/\//, '');
    $('lobby-count').textContent = s.players.length + ' / 12';

    var list = $('lobby-players');
    if (!editingName) list.replaceChildren.apply(list, s.players.map(function (p, i) {
      var status, ok = false;
      var open = r.photosPerPlayer - p.photos;
      if (!p.online) status = 'offline';
      else if (open <= 0) { status = 'bereit'; ok = true; }
      else if (p.photos === 0) status = 'noch keine Fotos';
      else status = 'noch ' + open + ' Foto' + (open === 1 ? '' : 's');
      var isMe = p.id === s.me.id;
      var label = p.name + (p.isHost ? ' (Host)' : '') + (isMe ? ' · du' : '');
      var canKick = s.me.isHost && !p.online && !p.isHost;
      var nameWrap = el('span', { class: 'row-name-wrap' }, el('span', { class: 'row-name', text: label }));
      if (isMe) {
        nameWrap.append(el('button', {
          class: 'row-edit', type: 'button', 'aria-label': 'Namen ändern', title: 'Namen ändern',
          onclick: function () { startRename(nameWrap, p.name); }
        }, pencilIcon()));
      }
      return el('li', { class: 'row' },
        el('span', { class: 'row-no', text: pad2(i + 1) }),
        nameWrap,
        el('span', { class: 'row-status' + (ok ? ' is-ok' : ''), text: status }),
        canKick
          ? el('button', {
            class: 'link-btn small row-kick', type: 'button', text: 'Entfernen',
            'aria-label': p.name + ' entfernen',
            onclick: function () { kickPlayer(p); }
          })
          : el('span', { class: 'row-count', text: p.photos + '/' + r.photosPerPlayer })
      );
    }));

    setSelect('set-photos', r.photosPerPlayer, s.me.isHost);
    setSelect('set-seconds', r.seconds, s.me.isHost);
    $('rules-hint').textContent = s.me.isHost ? 'Tippen zum Ändern' : 'legt der Host fest';
    // Gespielt werden alle Fotos: Runden = Spieler × Fotos pro Person
    $('rule-rounds').textContent = String(s.players.length * r.photosPerPlayer);

    var mine = s.myPhotos ? s.myPhotos.length : 0;
    $('lobby-myphotos').textContent = mine + ' / ' + r.photosPerPlayer;

    var start = $('btn-start');
    start.hidden = !s.me.isHost;
    var missing = missingPhotos(s);
    var hint;
    if (s.players.length < 2) hint = 'Warten auf Mitspieler – teile den Raumcode.';
    else if (r.totalPhotos === 0) hint = 'Noch hat niemand Fotos hochgeladen.';
    else if (missing.length) hint = 'Es fehlen noch Fotos von ' + missing.map(function (p) { return p.name; }).join(', ') + '.';
    else hint = 'Alle Fotos sind da · ' + playedPhotos(s) + ' Runden';
    if (!s.me.isHost) hint = 'Der Host startet das Spiel. ' + hint;
    start.disabled = s.players.length < 2 || r.totalPhotos === 0;
    $('lobby-hint').textContent = hint;
  }

  function missingPhotos(s) {
    return s.players.filter(function (p) { return p.photos < s.room.photosPerPlayer; });
  }

  // So viele Fotos kommen ins Spiel (pro Person höchstens „Fotos p. P.“)
  function playedPhotos(s) {
    return s.players.reduce(function (sum, p) { return sum + Math.min(p.photos, s.room.photosPerPlayer); }, 0);
  }

  // ---------- Umbenennen in der Lobby ----------

  var editingName = false;

  function pencilIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'square');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4');
    svg.append(path);
    return svg;
  }

  function startRename(wrap, current) {
    editingName = true;
    var input = el('input', {
      class: 'input input-inline', value: current, maxlength: '20',
      autocomplete: 'nickname', 'aria-label': 'Neuer Name', enterkeyhint: 'done'
    });
    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      var name = input.value.trim();
      if (!save || !name || name === current) {
        editingName = false;
        poll();
        return;
      }
      input.disabled = true;
      api('rename', { name: name }).then(function (res) {
        store.set('fg_name', res.name);
      }).catch(function (err) {
        toast(err.message);
      }).then(function () {
        editingName = false;
        poll();
      });
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
    wrap.replaceChildren(input);
    input.focus();
    input.select();
  }

  function kickPlayer(p) {
    var photos = p.photos === 1 ? ' Das hochgeladene Foto wird gelöscht.'
      : p.photos > 1 ? ' Die ' + p.photos + ' hochgeladenen Fotos werden gelöscht.' : '';
    if (!confirm(p.name + ' aus dem Raum entfernen?' + photos)) return;
    api('kick', { id: p.id }).then(poll).catch(function (err) { toast(err.message); poll(); });
  }

  function setSelect(id, value, enabled) {
    var sel = $(id);
    sel.disabled = !enabled;
    if (document.activeElement === sel) return;
    var v = String(value);
    if (!Array.prototype.some.call(sel.options, function (o) { return o.value === v; })) {
      sel.append(el('option', { value: v, text: v }));
    }
    sel.value = v;
  }

  function initLobby() {
    ['set-seconds', 'set-photos'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        api('settings', {
          seconds: $('set-seconds').value,
          photos: $('set-photos').value
        }).then(poll).catch(function (err) { toast(err.message); });
      });
    });

    $('btn-share').addEventListener('click', function () {
      if (!state) return;
      var url = roomLink(state.room.code);
      if (navigator.share) {
        navigator.share({ title: 'FotoGuesser', text: 'Spiel mit! Raumcode ' + state.room.code, url: url }).catch(function () {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () { toast('Link kopiert.'); }, function () { toast(url); });
      } else {
        toast(url);
      }
    });

    $('btn-leave').addEventListener('click', function () {
      if (confirm('Spiel wirklich verlassen?')) leave();
    });

    $('btn-to-upload').addEventListener('click', function () {
      view = 'upload';
      if (state) render(state);
    });

    $('btn-start').addEventListener('click', function () {
      var btn = this;
      var missing = state ? missingPhotos(state) : [];
      if (missing.length) {
        var names = missing.map(function (p) { return p.name + ' (' + p.photos + '/' + state.room.photosPerPlayer + ')'; }).join(', ');
        if (!confirm('Noch nicht alle Fotos da: ' + names + '. Trotzdem mit ' + playedPhotos(state) + ' Runden starten?')) return;
      }
      btn.disabled = true;
      api('start').then(poll).catch(function (err) { toast(err.message); btn.disabled = false; });
    });
  }

  // ---------- Fotos hochladen ----------

  var photoKey = '';
  var uploading = false;

  function renderUpload(s) {
    $('upload-code').textContent = s.room.code;
    var photos = s.myPhotos || [];
    var key = photos.map(function (p) { return p.id; }).join(',');
    if (key !== photoKey) {
      photoKey = key;
      var list = $('my-photos');
      if (photos.length === 0) {
        list.replaceChildren(el('li', { class: 'photo-empty', text: 'Noch keine Fotos.' }));
      } else {
        list.replaceChildren.apply(list, photos.map(function (p, i) {
          var label = 'Foto ' + (i + 1);
          return el('li', { class: 'photo-row' },
            el('img', { class: 'photo-thumb', src: p.url, alt: 'Dein ' + label, loading: 'lazy' }),
            el('div', { class: 'photo-meta' },
              el('span', { class: 'strong', text: label }),
              el('span', { class: 'mono', text: fmtCoords(p.lat, p.lng) }),
              p.taken ? el('span', { class: 'mono muted', text: fmtDate(p.taken) }) : null
            ),
            el('button', {
              class: 'link-btn small', type: 'button', text: 'Entfernen',
              onclick: function () { deletePhoto(p.id); }
            })
          );
        }));
      }
    }
    var full = photos.length >= s.room.photosPerPlayer;
    $('btn-add-photo').classList.toggle('is-disabled', full || uploading);
    $('input-photos').disabled = full || uploading;
    $('add-photo-label').textContent = full ? 'Alle ' + s.room.photosPerPlayer + ' Fotos hochgeladen' : 'Foto aus Galerie wählen';
    $('btn-upload-done').textContent = 'Fertig · ' + photos.length + ' von ' + s.room.photosPerPlayer;
  }

  function deletePhoto(id) {
    api('delete_photo', { id: id }).then(poll).catch(function (err) { toast(err.message); });
  }

  function setStatus(text, warn) {
    var s = $('upload-status');
    s.textContent = text || '';
    s.classList.toggle('is-warn', !!warn);
  }

  function readMeta(file) {
    var meta = { gps: null, date: '' };
    if (typeof exifr === 'undefined') return Promise.resolve(meta);
    return exifr.gps(file).then(function (g) {
      if (g && isFinite(g.latitude) && isFinite(g.longitude) && !(g.latitude === 0 && g.longitude === 0)) {
        meta.gps = { lat: g.latitude, lng: g.longitude };
      }
    }).catch(function () {}).then(function () {
      return exifr.parse(file, ['DateTimeOriginal', 'CreateDate']).then(function (d) {
        var dt = d && (d.DateTimeOriginal || d.CreateDate);
        if (dt instanceof Date && !isNaN(dt)) {
          meta.date = dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
        }
      }).catch(function () {});
    }).then(function () { return meta; });
  }

  // Zeichnet das Foto neu als JPEG: verkleinert es und entfernt dabei alle Metadaten.
  function toCleanJpeg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, CONFIG.maxImageSide / Math.max(img.naturalWidth, img.naturalHeight));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('Das Foto konnte nicht verarbeitet werden.'));
        }, 'image/jpeg', CONFIG.jpegQuality);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Dein Browser kann dieses Bildformat nicht öffnen. Speichere das Foto bitte als JPG.'));
      };
      img.src = url;
    });
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length || !state) return;
    var free = state.room.photosPerPlayer - (state.myPhotos ? state.myPhotos.length : 0);
    if (files.length > free) {
      toast('Es passen nur noch ' + free + ' Foto' + (free === 1 ? '' : 's') + '.');
      files = files.slice(0, free);
    }
    uploading = true;
    renderUpload(state);
    var skipped = 0;

    var chain = Promise.resolve();
    files.forEach(function (file, i) {
      var noun = 'Foto ' + (i + 1) + ' von ' + files.length;
      chain = chain.then(function () {
        setStatus(noun + ' wird vorbereitet …');
        return Promise.all([readMeta(file), toCleanJpeg(file)]);
      }).then(function (res) {
        var meta = res[0], jpeg = res[1];
        var loc = meta.gps ? Promise.resolve(meta.gps) : pickLocation(jpeg);
        return loc.then(function (gps) {
          if (!gps) { skipped++; return null; }
          setStatus(noun + ' wird hochgeladen …');
          return api('upload', { lat: gps.lat, lng: gps.lng, taken: meta.date }, jpeg);
        });
      }).catch(function (err) {
        skipped++;
        toast(err.message);
      });
    });

    chain.then(function () {
      uploading = false;
      $('input-photos').value = '';
      setStatus(skipped ? skipped + (skipped === 1 ? ' Foto' : ' Fotos') + ' nicht hochgeladen.' : '', skipped > 0);
      photoKey = '';
      poll();
    });
  }

  function initUpload() {
    $('input-photos').addEventListener('change', function () { handleFiles(this.files); });
    $('btn-upload-back').addEventListener('click', backToLobby);
    $('btn-upload-done').addEventListener('click', backToLobby);
  }

  function backToLobby() {
    view = 'lobby';
    setStatus('');
    if (state) render(state);
  }

  // ---------- Ort manuell setzen ----------

  var lastGeocode = 0;

  function geocode(q) {
    // Nominatim erlaubt höchstens eine Anfrage pro Sekunde
    var wait = Math.max(0, lastGeocode + 1000 - Date.now());
    lastGeocode = Date.now() + wait;
    return new Promise(function (r) { setTimeout(r, wait); }).then(function () {
      var url = CONFIG.geocoder + '?format=jsonv2&limit=6&accept-language=de&q=' + encodeURIComponent(q);
      return fetch(url, { headers: { Accept: 'application/json' } });
    }).then(function (res) {
      if (!res.ok) throw new Error('Suche gerade nicht möglich.');
      return res.json();
    });
  }

  function pickLocation(thumb) {
    return new Promise(function (resolve) {
      var overlay = $('pick-overlay');
      var thumbUrl = URL.createObjectURL(thumb);
      $('pick-thumb').src = thumbUrl;
      overlay.hidden = false;
      var map = makeMap('pick-map');
      showStart(map);
      var marker = null;
      var ok = $('btn-pick-ok');
      ok.disabled = true;

      var form = $('pick-search');
      var input = $('input-pick-search');
      var list = $('pick-results');
      var searchId = 0;
      input.value = '';
      list.hidden = true;

      function setPin(latlng) {
        if (marker) marker.setLatLng(latlng);
        else marker = L.marker(latlng, { icon: pinIcon }).addTo(map);
        ok.disabled = false;
      }
      function onClick(e) {
        list.hidden = true;
        setPin(e.latlng);
      }
      function choose(hit) {
        list.hidden = true;
        var ll = L.latLng(+hit.lat, +hit.lon);
        setPin(ll);
        var b = hit.boundingbox;
        if (b) map.fitBounds([[+b[0], +b[2]], [+b[1], +b[3]]], { maxZoom: 17 });
        else map.setView(ll, 16);
      }
      function onSearch(e) {
        e.preventDefault();
        var q = input.value.trim();
        if (!q) return;
        input.blur();
        var id = ++searchId;
        list.replaceChildren(el('li', { class: 'pick-empty', text: 'Suche läuft …' }));
        list.hidden = false;
        geocode(q).then(function (hits) {
          if (id !== searchId) return;
          if (!hits.length) {
            list.replaceChildren(el('li', { class: 'pick-empty', text: 'Nichts gefunden. Anders schreiben oder auf die Karte tippen.' }));
            return;
          }
          if (hits.length === 1) { choose(hits[0]); return; }
          list.replaceChildren.apply(list, hits.map(function (hit) {
            var parts = String(hit.display_name).split(', ');
            return el('li', null, el('button', { class: 'pick-result', type: 'button', onclick: function () { choose(hit); } },
              // Adressen haben keinen Namen: dann Hausnummer + Straße als Titel
              el('span', { class: 'pick-result-name', text: hit.name || parts.slice(0, 2).join(' ') }),
              el('span', { class: 'pick-result-sub', text: parts.slice(hit.name ? 1 : 2).join(', ') })
            ));
          }));
        }).catch(function (err) {
          if (id !== searchId) return;
          list.replaceChildren(el('li', { class: 'pick-empty', text: err.message || 'Suche gerade nicht möglich.' }));
        });
      }
      function finish(result) {
        searchId++;
        map.off('click', onClick);
        if (marker) map.removeLayer(marker);
        ok.removeEventListener('click', onOk);
        $('btn-pick-cancel').removeEventListener('click', onCancel);
        form.removeEventListener('submit', onSearch);
        list.hidden = true;
        overlay.hidden = true;
        URL.revokeObjectURL(thumbUrl);
        $('pick-thumb').removeAttribute('src');
        resolve(result);
      }
      function onOk() {
        var ll = marker.getLatLng().wrap();
        finish({ lat: ll.lat, lng: ll.lng });
      }
      function onCancel() { finish(null); }

      map.on('click', onClick);
      ok.addEventListener('click', onOk);
      $('btn-pick-cancel').addEventListener('click', onCancel);
      form.addEventListener('submit', onSearch);
    });
  }

  // ---------- Raten ----------

  var game = { guessRound: null, pick: null, pickMarker: null, deadline: null, duration: 0, autoSent: false, revealRound: null, revealLayer: null, finalDrawn: false };

  function resetGameUi() {
    if (game.pickMarker && maps['guess-map']) maps['guess-map'].removeLayer(game.pickMarker);
    if (game.revealLayer && maps['reveal-map']) maps['reveal-map'].removeLayer(game.revealLayer);
    if (maps['final-map']) {
      maps['final-map'].eachLayer(function (l) { if (!(l instanceof L.TileLayer)) maps['final-map'].removeLayer(l); });
    }
    game = { guessRound: null, pick: null, pickMarker: null, deadline: null, duration: 0, autoSent: false, revealRound: null, revealLayer: null, finalDrawn: false };
    photoKey = '';
  }

  function renderGuess(s) {
    var r = s.round;
    if (!r) return;
    var map = makeMap('guess-map');

    if (game.guessRound !== r.no) {
      game.guessRound = r.no;
      game.pick = null;
      game.autoSent = false;
      if (game.pickMarker) { map.removeLayer(game.pickMarker); game.pickMarker = null; }
      showStart(map);
      $('guess-photo').src = r.url;
      $('lightbox-img').src = r.url;
    }

    if (r.myGuess && !game.pickMarker) {
      game.pickMarker = L.marker([r.myGuess.lat, r.myGuess.lng], { icon: pinIcon }).addTo(map);
    }

    $('guess-round').textContent = pad2(r.no) + '/' + pad2(r.total);
    $('guess-score').textContent = fmtPoints(s.me.score) + ' P';
    var progress = r.guessed + ' von ' + r.guessers + ' haben getippt';

    game.duration = r.duration;
    game.deadline = r.remaining == null ? null : Date.now() + r.remaining * 1000;
    $('guess-timebar').hidden = game.deadline === null;
    if (game.deadline === null) $('guess-timer').textContent = 'ohne Zeit';
    tick();

    var btn = $('btn-guess');
    if (r.isMine) {
      $('guess-owner').textContent = 'Dein Foto';
      $('guess-progress').textContent = 'Die anderen raten gerade · ' + progress;
      btn.hidden = true;
    } else if (r.myGuess) {
      $('guess-owner').textContent = 'Tipp abgegeben';
      $('guess-progress').textContent = 'Warten auf die anderen · ' + progress;
      btn.hidden = true;
    } else {
      $('guess-owner').textContent = 'Foto von ' + r.ownerName;
      $('guess-progress').textContent = progress;
      btn.hidden = false;
      updateGuessButton();
    }
    $('btn-force-reveal').hidden = !s.me.isHost;
  }

  function updateGuessButton() {
    var btn = $('btn-guess');
    btn.disabled = !game.pick;
    btn.textContent = game.pick ? 'Tipp abgeben' : 'Ort wählen';
  }

  function canGuess() {
    return state && state.room.state === 'guessing' && state.round && !state.round.isMine && !state.round.myGuess;
  }

  function submitGuess() {
    if (!canGuess() || !game.pick) return;
    var btn = $('btn-guess');
    btn.disabled = true;
    var ll = game.pick.wrap();
    api('guess', { lat: ll.lat, lng: ll.lng }).then(poll).catch(function (err) {
      toast(err.message);
      btn.disabled = false;
      poll();
    });
  }

  function tick() {
    if (current !== 'guess' || game.deadline === null) return;
    var rem = Math.max(0, (game.deadline - Date.now()) / 1000);
    $('guess-timer').textContent = fmtClock(rem);
    var bar = $('guess-timebar');
    var frac = game.duration > 0 ? rem / game.duration : 0;
    bar.style.transform = 'scaleX(' + Math.min(1, frac).toFixed(4) + ')';
    bar.classList.toggle('is-low', rem <= 10);
    // Kurz vor Schluss einen gesetzten, aber nicht abgeschickten Tipp automatisch abgeben
    if (rem <= 0.5 && game.pick && !game.autoSent && canGuess()) {
      game.autoSent = true;
      submitGuess();
    }
  }

  function initGuess() {
    var map = makeMap('guess-map');
    map.on('click', function (e) {
      if (!canGuess()) return;
      game.pick = e.latlng;
      if (game.pickMarker) game.pickMarker.setLatLng(e.latlng);
      else game.pickMarker = L.marker(e.latlng, { icon: pinIcon }).addTo(map);
      updateGuessButton();
    });
    $('btn-guess').addEventListener('click', submitGuess);
    $('btn-force-reveal').addEventListener('click', function () {
      if (!confirm('Runde jetzt beenden und auflösen?')) return;
      api('reveal').then(poll).catch(function (err) { toast(err.message); });
    });
    $('btn-photo-zoom').addEventListener('click', function () { $('lightbox').hidden = false; });
    $('guess-photo').addEventListener('click', function () { $('lightbox').hidden = false; });
    $('btn-lightbox-close').addEventListener('click', function () { $('lightbox').hidden = true; });
    $('lightbox').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
    setInterval(tick, 250);
  }

  // ---------- Auflösung ----------

  function renderReveal(s) {
    var r = s.round;
    if (!r || !r.answer) return;
    var map = makeMap('reveal-map');

    if (game.revealRound !== r.no) {
      game.revealRound = r.no;
      if (game.revealLayer) map.removeLayer(game.revealLayer);
      var layer = L.layerGroup().addTo(map);
      var answer = L.latLng(r.answer.lat, r.answer.lng);
      var bounds = L.latLngBounds([answer]);

      r.guesses.forEach(function (g) {
        var isMe = g.playerId === s.me.id;
        var ll = L.latLng(g.lat, g.lng);
        bounds.extend(ll);
        L.polyline([answer, ll], {
          color: isMe ? '#d7261e' : '#77776f', weight: isMe ? 2 : 1.5, dashArray: isMe ? '6 5' : '3 5', interactive: false
        }).addTo(layer);
        L.circleMarker(ll, {
          radius: isMe ? 8 : 6, color: '#111111', weight: isMe ? 2 : 1.5,
          fillColor: isMe ? '#d7261e' : '#1f4fd1', fillOpacity: 1
        }).bindTooltip(isMe ? 'Du' : escapeHtml(g.name), {
          permanent: true, direction: 'right', offset: [8, 0], className: 'map-label'
        }).addTo(layer);
      });

      L.marker(answer, { icon: flagIcon, zIndexOffset: 1000 }).bindTooltip('Hier war’s', {
        permanent: true, direction: 'right', offset: [10, 0], className: 'map-label is-dark'
      }).addTo(layer);

      game.revealLayer = layer;
      map.invalidateSize();
      if (r.guesses.length) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
      else map.setView(answer, 12);

      $('reveal-streetview').href = 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' +
        r.answer.lat.toFixed(6) + ',' + r.answer.lng.toFixed(6);
    }

    $('reveal-round').textContent = pad2(r.no) + '/' + pad2(r.total);
    $('reveal-score').textContent = fmtPoints(s.me.score) + ' P';
    $('reveal-meta').textContent = (r.isMine ? 'Dein Foto' : 'Foto von ' + r.ownerName) +
      (r.answer.taken ? ' · ' + fmtDate(r.answer.taken) : '');

    if (r.myGuess) {
      $('reveal-distance').textContent = fmtDistance(r.myGuess.distance);
      $('reveal-points').textContent = '+' + fmtPoints(r.myGuess.points);
    } else {
      $('reveal-distance').textContent = r.isMine ? 'Dein Foto' : 'Kein Tipp';
      $('reveal-points').textContent = r.isMine ? '' : '+0';
    }

    var rows = r.guesses.map(function (g, i) {
      return el('tr', { class: g.playerId === s.me.id ? 'is-me' : null },
        el('td', { class: 'col-no', text: String(i + 1) }),
        el('td', { text: g.playerId === s.me.id ? 'Du' : g.name }),
        el('td', { class: 'num', text: fmtDistance(g.distance) }),
        el('td', { class: 'num', text: fmtPoints(g.points) })
      );
    });
    var guessedIds = r.guesses.map(function (g) { return g.playerId; });
    s.players.forEach(function (p) {
      if (p.id === r.ownerId || guessedIds.indexOf(p.id) !== -1) return;
      rows.push(el('tr', null,
        el('td', { class: 'col-no', text: '–' }),
        el('td', { class: 'dim', text: p.id === s.me.id ? 'Du' : p.name }),
        el('td', { class: 'num dim', text: 'kein Tipp' }),
        el('td', { class: 'num dim', text: '0' })
      ));
    });
    var tbody = $('reveal-table');
    tbody.replaceChildren.apply(tbody, rows);

    var next = $('btn-next');
    next.hidden = !s.me.isHost;
    next.disabled = false;
    next.textContent = r.no < r.total ? 'Nächstes Foto' : 'Zum Endstand';
    $('reveal-wait').hidden = s.me.isHost;
  }

  function initReveal() {
    $('btn-next').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      api('next').then(poll).catch(function (err) { toast(err.message); btn.disabled = false; });
    });
  }

  // ---------- Endstand ----------

  function renderFinal(s) {
    $('final-code').textContent = s.room.code;
    var ranking = s.players.slice().sort(function (a, b) { return b.score - a.score; });
    var top = ranking[0];
    var tie = ranking.length > 1 && ranking[1].score === top.score;
    $('final-winner').textContent = tie ? 'Unentschieden' : (top.id === s.me.id ? 'Du gewinnst' : top.name + ' gewinnt');
    $('btn-again').hidden = !s.me.isHost;
    $('final-wait').hidden = s.me.isHost;

    var tbody = $('final-table');
    tbody.replaceChildren.apply(tbody, ranking.map(function (p, i) {
      return el('tr', { class: p.id === s.me.id ? 'is-me' : null },
        el('td', { class: 'col-no', text: String(i + 1) }),
        el('td', { text: p.id === s.me.id ? p.name + ' · du' : p.name }),
        el('td', { class: 'num', text: fmtPoints(p.score) })
      );
    }));

    if (!game.finalDrawn && s.summary && s.summary.length) {
      game.finalDrawn = true;
      var map = makeMap('final-map');
      var bounds = L.latLngBounds([]);
      s.summary.forEach(function (f) {
        var ll = L.latLng(f.lat, f.lng);
        bounds.extend(ll);
        L.marker(ll, { icon: flagIcon }).bindTooltip(f.round + ' · ' + escapeHtml(f.name), {
          permanent: true, direction: 'right', offset: [10, 0], className: 'map-label'
        }).addTo(map);
      });
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
    }
  }

  function initFinal() {
    $('btn-new-game').addEventListener('click', function () { leave(); });
    $('btn-again').addEventListener('click', function () {
      var btn = this;
      if (!confirm('Noch eine Runde im selben Raum? Punkte und Fotos werden zurückgesetzt, alle laden neue Fotos hoch.')) return;
      btn.disabled = true;
      api('again').then(poll).catch(function (err) { toast(err.message); }).then(function () { btn.disabled = false; });
    });
  }

  // ---------- Los geht's ----------

  initHome();
  initLobby();
  initUpload();
  initGuess();
  initReveal();
  initFinal();
  // Mit gespeicherter Anmeldung direkt zurück ins Spiel, ohne kurz die Startseite zu zeigen
  if (token) poll();
  else show('home');
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && token) poll();
  });
  // Seite kommt per Zurück/Vor aus dem Browser-Zwischenspeicher: Stand sofort aktualisieren
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && token) poll();
  });
})();
