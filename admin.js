/* admin.js — Admin-Seite: Touren per GitHub-API hinzufügen, umbenennen, löschen.
   Läuft komplett im Browser. Passwort + GitHub-Token werden zusammen am Anfang abgefragt.
   Das Token wird NIE ins Repo geschrieben, optional nur in sessionStorage (nur dieser Tab). */

(function () {
  'use strict';

  var OWNER = '8myjwj4zvx-gif';
  var REPO = 'MyOwnWebsite';
  var BRANCH = 'main';
  var API = 'https://api.github.com';
  var PASSWORD = 'ballern';

  // ---------- GPX-Parsing ----------

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000.0;
    var toRad = Math.PI / 180;
    var p1 = lat1 * toRad, p2 = lat2 * toRad;
    var dphi = (lat2 - lat1) * toRad;
    var dlambda = (lon2 - lon1) * toRad;
    var a = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlambda / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function smooth(vals, windowSize) {
    windowSize = windowSize || 9;
    var n = vals.length;
    var out = new Array(n);
    var half = Math.floor(windowSize / 2);
    for (var i = 0; i < n; i++) {
      var lo = Math.max(0, i - half);
      var hi = Math.min(n, i + half + 1);
      var sum = 0;
      for (var j = lo; j < hi; j++) sum += vals[j];
      out[i] = sum / (hi - lo);
    }
    return out;
  }

  function slugify(name) {
    return String(name)
      .toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function parseGpxFile(xmlText) {
    var xml = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) {
      throw new Error('GPX konnte nicht gelesen werden (ungültiges XML).');
    }
    var typeEl = xml.querySelector('trk > type');
    var sportType = typeEl ? typeEl.textContent.trim() : null;

    var trkpts = xml.getElementsByTagName('trkpt');
    var pts = [];
    for (var i = 0; i < trkpts.length; i++) {
      var el = trkpts[i];
      var lat = parseFloat(el.getAttribute('lat'));
      var lon = parseFloat(el.getAttribute('lon'));
      var eleEl = el.getElementsByTagName('ele')[0];
      var ele = eleEl ? parseFloat(eleEl.textContent) : null;
      pts.push({ lat: lat, lon: lon, ele: ele });
    }
    if (pts.length < 2) throw new Error('GPX enthält zu wenige Trackpunkte.');

    var distM = 0;
    for (var k = 1; k < pts.length; k++) distM += haversine(pts[k - 1].lat, pts[k - 1].lon, pts[k].lat, pts[k].lon);

    var eles = pts.map(function (p) { return p.ele; }).filter(function (e) { return e !== null && !isNaN(e); });
    var gain = 0;
    if (eles.length > 2) {
      var sm = smooth(eles, 9);
      for (var m = 1; m < sm.length; m++) { var d = sm[m] - sm[m - 1]; if (d > 0) gain += d; }
    }

    var target = 180;
    var stride = Math.max(1, Math.floor(pts.length / target));
    var sampled = [];
    for (var s = 0; s < pts.length; s += stride) sampled.push(pts[s]);
    if (sampled[sampled.length - 1] !== pts[pts.length - 1]) sampled.push(pts[pts.length - 1]);
    var latlonPoints = sampled.map(function (p) { return [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5]; });

    return {
      sportType: sportType,
      distanceKm: Math.round(distM / 1000 * 10) / 10,
      elevationGainM: Math.round(gain),
      latlonPoints: latlonPoints
    };
  }

  // ---------- Base64 (UTF-8 sicher) ----------

  function toBase64Utf8(str) {
    var bytes = new TextEncoder().encode(str);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function fromBase64Utf8(b64) {
    var binary = atob(b64.replace(/\n/g, ''));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ---------- GitHub Contents API ----------

  function ghHeaders(token) {
    return {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  async function safeJson(res) { try { return await res.json(); } catch (e) { return null; } }

  async function ghGetFile(path, token) {
    var res = await fetch(API + '/repos/' + OWNER + '/' + REPO + '/contents/' + path + '?ref=' + BRANCH, {
      headers: ghHeaders(token)
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      var body = await safeJson(res);
      throw new Error('GitHub-Fehler beim Laden von ' + path + ': ' + res.status + ' ' + (body && body.message ? body.message : res.statusText));
    }
    var json = await res.json();
    return { sha: json.sha, text: fromBase64Utf8(json.content) };
  }

  async function ghPutFile(path, text, message, token, sha) {
    var body = { message: message, content: toBase64Utf8(text), branch: BRANCH };
    if (sha) body.sha = sha;
    var res = await fetch(API + '/repos/' + OWNER + '/' + REPO + '/contents/' + path, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(token)),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      var errBody = await safeJson(res);
      throw new Error('GitHub-Fehler beim Speichern von ' + path + ': ' + res.status + ' ' + (errBody && errBody.message ? errBody.message : res.statusText));
    }
    return res.json();
  }

  async function ghDeleteFile(path, message, token, sha) {
    var res = await fetch(API + '/repos/' + OWNER + '/' + REPO + '/contents/' + path, {
      method: 'DELETE',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(token)),
      body: JSON.stringify({ message: message, sha: sha, branch: BRANCH })
    });
    if (!res.ok) {
      var errBody = await safeJson(res);
      throw new Error('GitHub-Fehler beim Löschen von ' + path + ': ' + res.status + ' ' + (errBody && errBody.message ? errBody.message : res.statusText));
    }
    return res.json();
  }

  // Liest touren.html immer frisch, wendet transformFn an und schreibt zurück.
  // Bei 409 (sha veraltet, z.B. weil kurz zuvor eine andere Änderung gespeichert wurde)
  // wird automatisch mit frisch geladenem Stand erneut versucht.
  async function updateTourenHtml(token, transformFn, commitMessage) {
    var attempts = 0, lastErr = null;
    while (attempts < 3) {
      attempts++;
      var current = await ghGetFile('touren.html', token);
      if (!current) throw new Error('touren.html nicht gefunden.');
      var updated = transformFn(current.text);
      try {
        await ghPutFile('touren.html', updated, commitMessage, token, current.sha);
        return updated;
      } catch (e) {
        lastErr = e;
        if (!/\b409\b/.test(e.message)) throw e;
      }
    }
    throw lastErr;
  }

  // ---------- Text-Bausteine & Marker-Splicing für touren.html ----------

  function renderCardHtml(cat, name, slug, distanceKm, elevationGainM) {
    var label = cat === 'rennrad' ? 'Rennrad' : 'Wandern';
    return '      <div class="tour-card" data-distance="' + distanceKm.toFixed(1) + '">\n' +
      '        <h3>' + escapeHtml(name) + '</h3>\n' +
      '        <div class="tour-meta">' + label + '</div>\n' +
      '        <div class="tour-map" id="map-' + slug + '"></div>\n' +
      '        <div class="tour-stats">\n' +
      '          <span><strong>' + distanceKm.toFixed(1) + ' km</strong>Distanz</span>\n' +
      '          <span><strong>' + elevationGainM + ' Hm</strong>Anstieg</span>\n' +
      '        </div>\n' +
      '        <a class="gpx-link" href="gpx/' + slug + '.gpx" download>GPX herunterladen</a>\n' +
      '      </div>';
  }

  function renderRouteEntry(slug, points) {
    return '    { id: \'map-' + slug + '\', points: ' + JSON.stringify(points) + ' }';
  }

  function findUniqueSlug(tourenHtmlText, baseSlug) {
    var slug = baseSlug, n = 2;
    while (tourenHtmlText.indexOf('id="map-' + slug + '"') !== -1) { slug = baseSlug + '-' + n; n++; }
    return slug;
  }

  function insertBetweenMarkers(text, startMarker, endMarker, joiner, newItemText) {
    var startIdx = text.indexOf(startMarker);
    var endIdx = text.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1) throw new Error('Marker nicht gefunden: ' + startMarker + ' / ' + endMarker);
    var afterStart = startIdx + startMarker.length;
    var existing = text.slice(afterStart, endIdx);
    var trimmed = existing.trim();
    var newBlock = trimmed.length ? (existing.replace(/\s*$/, '') + joiner + newItemText + '\n') : ('\n' + newItemText + '\n');
    return text.slice(0, afterStart) + newBlock + text.slice(endIdx);
  }

  function insertCard(tourenHtmlText, category, cardHtml) {
    return insertBetweenMarkers(tourenHtmlText, '<!-- CARDS:' + category + ':START -->', '<!-- CARDS:' + category + ':END -->', '\n', cardHtml);
  }

  function insertRoute(tourenHtmlText, routeEntryText) {
    return insertBetweenMarkers(tourenHtmlText, '/* ROUTES:START */', '/* ROUTES:END */', ',\n', routeEntryText);
  }

  // Findet die Grenzen genau EINER Tour-Karte anhand ihrer map-<slug> id.
  // Nutzt aus, dass .tour-card und ihr schließendes </div> immer mit 6 Leerzeichen
  // eingerückt sind, innere divs (tour-map, tour-stats) dagegen mit 8 – dadurch
  // ist die Grenzsuche robust, ohne einen vollen HTML-Parser für den Schreibpfad zu brauchen.
  function findCardBlock(html, slug) {
    var idMarker = 'id="map-' + slug + '"';
    var idPos = html.indexOf(idMarker);
    if (idPos === -1) return null;
    var cardStart = html.lastIndexOf('      <div class="tour-card"', idPos);
    var closeTag = '\n      </div>';
    var cardEnd = html.indexOf(closeTag, idPos);
    if (cardStart === -1 || cardEnd === -1) return null;
    cardEnd += closeTag.length;
    return { start: cardStart, end: cardEnd };
  }

  function renameCard(html, slug, newName) {
    var block = findCardBlock(html, slug);
    if (!block) throw new Error('Tour nicht gefunden: ' + slug);
    var section = html.slice(block.start, block.end);
    var renamed = section.replace(/<h3>[\s\S]*?<\/h3>/, '<h3>' + escapeHtml(newName) + '</h3>');
    return html.slice(0, block.start) + renamed + html.slice(block.end);
  }

  function deleteCard(html, slug) {
    var block = findCardBlock(html, slug);
    if (!block) throw new Error('Tour nicht gefunden: ' + slug);
    var s = block.start, e = block.end;
    if (html[e] === '\n') e += 1;
    return html.slice(0, s) + html.slice(e);
  }

  function stripTrailingComma(line) { return line.replace(/,\s*$/, ''); }

  function removeRoute(html, slug) {
    var startMarker = '/* ROUTES:START */', endMarker = '/* ROUTES:END */';
    var startIdx = html.indexOf(startMarker) + startMarker.length;
    var endIdx = html.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1) throw new Error('ROUTES-Marker nicht gefunden.');
    var block = html.slice(startIdx, endIdx);
    var lines = block.split('\n').filter(function (l) { return l.trim().length > 0; });
    var kept = lines.filter(function (l) { return l.indexOf("id: 'map-" + slug + "'") === -1; });
    var normalized = kept.map(stripTrailingComma);
    var rebuilt = normalized.map(function (l, i) { return i < normalized.length - 1 ? l + ',' : l; });
    var newBlock = rebuilt.length ? ('\n' + rebuilt.join('\n') + '\n') : '\n';
    return html.slice(0, startIdx) + newBlock + html.slice(endIdx);
  }

  // ---------- Bestehende Touren aus einem touren.html-Text extrahieren (nur lesend, per DOM) ----------

  function extractTours(tourenHtmlText) {
    var doc = new DOMParser().parseFromString(tourenHtmlText, 'text/html');
    var cards = doc.querySelectorAll('.tour-card');
    var tours = [];
    cards.forEach(function (card) {
      var mapDiv = card.querySelector('.tour-map');
      if (!mapDiv) return;
      var slug = mapDiv.id.replace(/^map-/, '');
      var name = card.querySelector('h3') ? card.querySelector('h3').textContent : slug;
      var metaText = card.querySelector('.tour-meta') ? card.querySelector('.tour-meta').textContent.trim() : '';
      var category = metaText === 'Rennrad' ? 'rennrad' : 'wandern';
      var distance = card.getAttribute('data-distance');
      var strongEls = card.querySelectorAll('.tour-stats strong');
      var elevation = strongEls.length > 1 ? strongEls[1].textContent : '';
      tours.push({ slug: slug, name: name, category: category, distanceKm: distance, elevation: elevation });
    });
    return tours;
  }

  // ---------- UI ----------

  var lastParsed = null;
  var previewMapInstance = null;

  function $(id) { return document.getElementById(id); }
  function getToken() { return $('ghToken').value.trim(); }

  function setStatus(msg, kind) {
    var el = $('statusArea');
    el.textContent = msg;
    el.className = 'status-box' + (kind ? ' status-' + kind : '');
    el.style.display = msg ? 'block' : 'none';
  }

  // Sperrt alle Schreib-Buttons waehrend eine Aenderung an touren.html laeuft,
  // damit nicht zwei Speichervorgaenge gleichzeitig um denselben sha konkurrieren.
  function setBusy(busy) {
    document.querySelectorAll('.route-row button').forEach(function (b) { b.disabled = busy; });
    var publishBtn = $('publishBtn');
    if (publishBtn) publishBtn.disabled = busy ? true : !lastParsed;
  }

  function setupGate() {
    var gate = $('gate'), content = $('content'), pwInput = $('pwInput'), tokenInput = $('ghToken'), pwError = $('pwError'), remember = $('rememberToken');

    var savedToken = sessionStorage.getItem('adminToken');
    if (savedToken) { tokenInput.value = savedToken; remember.checked = true; }

    function unlock() {
      gate.style.display = 'none';
      content.style.display = 'block';
      sessionStorage.setItem('adminUnlocked', '1');
      if (remember.checked) sessionStorage.setItem('adminToken', tokenInput.value);
      loadOverview();
    }

    function tryUnlock() {
      if (pwInput.value !== PASSWORD) { pwError.style.display = 'block'; return; }
      if (!tokenInput.value.trim()) { pwError.textContent = 'Bitte auch ein GitHub-Token eingeben.'; pwError.style.display = 'block'; return; }
      pwError.style.display = 'none';
      unlock();
    }

    $('unlockBtn').addEventListener('click', tryUnlock);
    [pwInput, tokenInput].forEach(function (el) {
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryUnlock(); });
    });

    if (sessionStorage.getItem('adminUnlocked') === '1' && savedToken) unlock();
  }

  // ---------- Übersicht bestehender Touren ----------

  async function loadOverview() {
    var listEl = $('overviewList');
    listEl.innerHTML = '<p class="empty-state">Lade …</p>';
    var token = getToken();
    try {
      var current = await ghGetFile('touren.html', token);
      if (!current) throw new Error('touren.html nicht gefunden.');
      var tours = extractTours(current.text);
      if (!tours.length) { listEl.innerHTML = '<p class="empty-state">Noch keine Touren online.</p>'; return; }
      listEl.innerHTML = '';
      tours.forEach(function (t) { listEl.appendChild(renderOverviewRow(t)); });
    } catch (e) {
      listEl.innerHTML = '';
      setStatus('Konnte Touren-Übersicht nicht laden: ' + e.message, 'error');
    }
  }

  function renderOverviewRow(t) {
    var row = document.createElement('div');
    row.className = 'route-row';

    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = t.name;

    var meta = document.createElement('span');
    meta.className = 'route-meta';
    meta.textContent = (t.category === 'rennrad' ? 'Rennrad' : 'Wandern') + ' · ' + t.distanceKm + ' km';

    var saveBtn = document.createElement('button');
    saveBtn.className = 'save';
    saveBtn.textContent = 'Speichern';
    saveBtn.addEventListener('click', function () { renameTour(t.slug, nameInput.value.trim(), row); });

    var delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = 'Löschen';
    delBtn.addEventListener('click', function () { deleteTour(t.slug, t.name, row); });

    row.appendChild(nameInput);
    row.appendChild(meta);
    row.appendChild(saveBtn);
    row.appendChild(delBtn);
    return row;
  }

  async function renameTour(slug, newName, row) {
    if (!newName) { setStatus('Name darf nicht leer sein.', 'error'); return; }
    var token = getToken();
    setBusy(true);
    try {
      setStatus('Speichere neuen Namen …', 'info');
      await updateTourenHtml(token, function (html) {
        return renameCard(html, slug, newName);
      }, 'Rename tour: ' + slug + ' -> ' + newName);
      setStatus('Name geändert.', 'success');
    } catch (e) {
      setStatus('Fehler beim Umbenennen: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function deleteTour(slug, name, row) {
    if (!confirm('"' + name + '" wirklich löschen? Das entfernt die Karte von der Seite und die GPX-Datei aus dem Repository.')) return;
    var token = getToken();
    setBusy(true);
    try {
      setStatus('Lösche "' + name + '" …', 'info');
      await updateTourenHtml(token, function (html) {
        var updated = deleteCard(html, slug);
        return removeRoute(updated, slug);
      }, 'Delete tour: ' + slug);

      var gpxPath = 'gpx/' + slug + '.gpx';
      var gpxFile = await ghGetFile(gpxPath, token);
      if (gpxFile) await ghDeleteFile(gpxPath, 'Delete GPX: ' + slug, token, gpxFile.sha);

      setStatus('"' + name + '" gelöscht.', 'success');
      loadOverview();
    } catch (e) {
      setStatus('Fehler beim Löschen: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---------- Neue Tour hinzufügen ----------

  function renderPreview(name, category, stats) {
    var area = $('previewArea');
    area.style.display = 'block';
    var label = category === 'rennrad' ? 'Rennrad' : 'Wandern';
    $('previewTitle').textContent = name || '(ohne Namen)';
    $('previewMeta').textContent = label;
    $('previewStats').innerHTML =
      '<span><strong>' + stats.distanceKm.toFixed(1) + ' km</strong>Distanz</span>' +
      '<span><strong>' + stats.elevationGainM + ' Hm</strong>Anstieg</span>';

    if (previewMapInstance) { previewMapInstance.remove(); previewMapInstance = null; }
    var map = L.map('previewMap', { scrollWheelZoom: false, zoomControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19
    }).addTo(map);
    var line = L.polyline(stats.latlonPoints, { color: '#fc4c02', weight: 3.5, lineJoin: 'round' }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [12, 12] });
    L.circleMarker(stats.latlonPoints[0], { radius: 5, color: '#16a34a', weight: 2, fillColor: '#16a34a', fillOpacity: 1 }).addTo(map);
    L.circleMarker(stats.latlonPoints[stats.latlonPoints.length - 1], { radius: 5, color: '#1d1d1f', weight: 2, fillColor: '#1d1d1f', fillOpacity: 1 }).addTo(map);
    previewMapInstance = map;
  }

  async function handlePreview() {
    setStatus('', null);
    var name = $('tourName').value.trim();
    var category = $('tourCategory').value;
    var fileInput = $('gpxFile');
    if (!name) { setStatus('Bitte einen Tournamen eingeben.', 'error'); return; }
    if (!fileInput.files || !fileInput.files[0]) { setStatus('Bitte eine GPX-Datei auswählen.', 'error'); return; }

    try {
      var text = await fileInput.files[0].text();
      var stats = parseGpxFile(text);
      lastParsed = {
        name: name, category: category,
        distanceKm: stats.distanceKm, elevationGainM: stats.elevationGainM,
        latlonPoints: stats.latlonPoints, gpxText: text, slugBase: slugify(name)
      };
      renderPreview(name, category, stats);
      $('publishBtn').disabled = false;
      setStatus('Vorschau erstellt. Prüfen und dann veröffentlichen.', 'info');
    } catch (e) {
      $('publishBtn').disabled = true;
      setStatus('Fehler beim Lesen der GPX-Datei: ' + e.message, 'error');
    }
  }

  async function handlePublish() {
    var token = getToken();
    if (!token) { setStatus('Kein GitHub-Token vorhanden – bitte Seite neu entsperren.', 'error'); return; }
    if (!lastParsed) { setStatus('Bitte zuerst eine Vorschau erstellen.', 'error'); return; }

    setBusy(true);
    try {
      setStatus('Lade aktuelle touren.html …', 'info');
      var current = await ghGetFile('touren.html', token);
      if (!current) throw new Error('touren.html nicht gefunden im Repository.');
      var slug = findUniqueSlug(current.text, lastParsed.slugBase);

      setStatus('Lade GPX-Datei hoch …', 'info');
      await ghPutFile('gpx/' + slug + '.gpx', lastParsed.gpxText, 'Add GPX: ' + lastParsed.name, token, null);

      setStatus('Aktualisiere touren.html …', 'info');
      var cardHtml = renderCardHtml(lastParsed.category, lastParsed.name, slug, lastParsed.distanceKm, lastParsed.elevationGainM);
      var routeEntry = renderRouteEntry(slug, lastParsed.latlonPoints);
      await updateTourenHtml(token, function (html) {
        var updated = insertCard(html, lastParsed.category, cardHtml);
        return insertRoute(updated, routeEntry);
      }, 'Add tour: ' + lastParsed.name);

      setStatus('Veröffentlicht! "' + lastParsed.name + '" ist in 1-2 Minuten live (Slug: ' + slug + ').', 'success');
      lastParsed = null;
      loadOverview();
    } catch (e) {
      setStatus('Fehler: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    setupGate();
    $('previewBtn').addEventListener('click', handlePreview);
    $('publishBtn').addEventListener('click', handlePublish);
    $('refreshOverviewBtn').addEventListener('click', loadOverview);
  });
})();
