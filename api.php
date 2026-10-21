<?php
// FotoGuesser – Server-API
// Alle Anfragen laufen über diese Datei: api.php?action=...

require __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const MAX_PLAYERS = 12;
const ONLINE_SECONDS = 20;   // so lange gilt ein Spieler ohne Lebenszeichen als online
const GRACE_SECONDS = 3;     // Puffer für langsame Verbindungen am Rundenende
const ROOM_TTL = 86400;      // Räume samt Fotos werden nach 24 Stunden gelöscht
const MAX_UPLOAD_BYTES = 10485760;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- Helfer ----------

function db()
{
    static $pdo = null;
    if ($pdo === null) {
        try {
            $pdo = new PDO(
                'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
                DB_USER,
                DB_PASS,
                [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES => false,
                ]
            );
        } catch (PDOException $e) {
            fail('Keine Verbindung zur Datenbank. Bitte config.php prüfen.', 500);
        }
    }
    return $pdo;
}

function q($sql, $params = [])
{
    $stmt = db()->prepare($sql);
    $stmt->execute($params);
    return $stmt;
}

function out($data)
{
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail($message, $code = 400)
{
    http_response_code($code);
    out(['error' => $message]);
}

function param($key, $default = '')
{
    if (isset($_POST[$key])) return $_POST[$key];
    if (isset($_GET[$key])) return $_GET[$key];
    return $default;
}

function floatParam($key)
{
    $v = param($key, null);
    if (!is_string($v) || !is_numeric($v)) fail('Ungültige Koordinaten.');
    return (float)$v;
}

function intParam($key, $default)
{
    $v = param($key, null);
    return (is_string($v) && is_numeric($v)) ? (int)$v : $default;
}

function clamp($v, $min, $max)
{
    return max($min, min($max, $v));
}

function cleanName($raw)
{
    $name = preg_replace('/[\p{C}]+/u', '', (string)$raw);
    $name = trim(preg_replace('/\s+/u', ' ', (string)$name));
    $name = mb_substr($name, 0, 20);
    if ($name === '') fail('Bitte gib einen Namen ein.');
    return $name;
}

function newToken()
{
    return bin2hex(random_bytes(16));
}

// Zufällige Geräte-Kennung aus dem Browser, damit ein wiederkommender Spieler erkannt wird.
function deviceParam()
{
    $d = (string)param('device');
    return preg_match('/^[a-f0-9]{32}$/', $d) ? $d : '';
}

// Ergänzt die Spalte für die Geräte-Kennung, falls die Datenbank mit einer älteren Version eingerichtet wurde.
function ensureSchema()
{
    $col = db()->query("SHOW COLUMNS FROM fg_players LIKE 'device'")->fetch();
    if (!$col) {
        db()->exec("ALTER TABLE fg_players ADD COLUMN device CHAR(32) NOT NULL DEFAULT '', ADD KEY device (room_id, device)");
    }
}

function validLatLng($lat, $lng)
{
    if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) fail('Ungültige Koordinaten.');
}

function distanceMeters($lat1, $lng1, $lat2, $lng2)
{
    $r = 6371000;
    $dLat = deg2rad($lat2 - $lat1);
    $dLng = deg2rad($lng2 - $lng1);
    $a = sin($dLat / 2) ** 2 + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLng / 2) ** 2;
    return 2 * $r * asin(min(1, sqrt($a)));
}

function points($distance, $scale)
{
    if ($distance <= 25) return 5000;
    return (int)round(5000 * exp(-$distance / $scale));
}

function photoUrl($id, $token)
{
    return 'api.php?action=photo&id=' . (int)$id . '&token=' . $token;
}

// ---------- Spieler & Raum ----------

function auth()
{
    $token = (string)param('token');
    if (!preg_match('/^[a-f0-9]{32}$/', $token)) fail('Nicht angemeldet.', 401);
    $me = q('SELECT * FROM fg_players WHERE token = ?', [$token])->fetch();
    if (!$me) fail('Deine Sitzung ist abgelaufen.', 401);
    $room = q('SELECT * FROM fg_rooms WHERE id = ?', [$me['room_id']])->fetch();
    if (!$room) fail('Diesen Raum gibt es nicht mehr.', 401);
    q('UPDATE fg_players SET last_seen = ? WHERE id = ?', [time(), $me['id']]);
    return [$me, $room];
}

function loadRoom($id)
{
    return q('SELECT * FROM fg_rooms WHERE id = ?', [$id])->fetch();
}

function requireState($room, $state)
{
    if ($room['state'] !== $state) fail('Das geht gerade nicht.', 409);
}

function requireHost($me, $room)
{
    if ((int)$room['host_id'] !== (int)$me['id']) fail('Das darf nur der Host.', 403);
}

function currentPhoto($room)
{
    return q('SELECT * FROM fg_photos WHERE room_id = ? AND round_no = ?', [$room['id'], $room['current_round']])->fetch();
}

function roundDeadline($room)
{
    if ((int)$room['seconds'] <= 0) return null;
    return (int)$room['round_started_at'] + (int)$room['seconds'];
}

// Löscht die Bilddatei eines Fotos. Die Koordinaten bleiben für Auflösung und Endstand erhalten.
function removePhotoFile($photo)
{
    if ($photo['file'] === '') return;
    $path = UPLOAD_DIR . '/' . basename($photo['file']);
    if (is_file($path)) @unlink($path);
    q("UPDATE fg_photos SET file = '' WHERE id = ?", [$photo['id']]);
}

// Wechselt zur Auflösung und löscht dabei das Foto der Runde.
function endRound($room, $photo)
{
    $changed = q(
        "UPDATE fg_rooms SET state = 'reveal' WHERE id = ? AND state = 'guessing' AND current_round = ?",
        [$room['id'], $room['current_round']]
    )->rowCount();
    if ($changed && $photo) removePhotoFile($photo);
}

// Beendet die Raterunde, wenn die Zeit um ist oder alle Online-Spieler getippt haben.
function advance($room)
{
    if ($room['state'] !== 'guessing') return $room;
    $photo = currentPhoto($room);
    if (!$photo) return $room;

    $deadline = roundDeadline($room);
    $timeUp = $deadline !== null && time() > $deadline + GRACE_SECONDS;

    $online = q(
        'SELECT id FROM fg_players WHERE room_id = ? AND id <> ? AND last_seen >= ?',
        [$room['id'], $photo['player_id'], time() - ONLINE_SECONDS]
    )->fetchAll(PDO::FETCH_COLUMN);
    $guessed = q('SELECT player_id FROM fg_guesses WHERE photo_id = ?', [$photo['id']])->fetchAll(PDO::FETCH_COLUMN);
    $missing = array_diff(array_map('intval', $online), array_map('intval', $guessed));
    $allIn = count($online) > 0 && count($missing) === 0;

    if ($timeUp || $allIn) {
        endRound($room, $photo);
        return loadRoom($room['id']);
    }
    return $room;
}

function deleteRoom($roomId)
{
    $files = q('SELECT file FROM fg_photos WHERE room_id = ?', [$roomId])->fetchAll(PDO::FETCH_COLUMN);
    foreach ($files as $file) {
        $path = UPLOAD_DIR . '/' . basename($file);
        if (is_file($path)) @unlink($path);
    }
    q('DELETE FROM fg_guesses WHERE room_id = ?', [$roomId]);
    q('DELETE FROM fg_photos WHERE room_id = ?', [$roomId]);
    q('DELETE FROM fg_players WHERE room_id = ?', [$roomId]);
    q('DELETE FROM fg_rooms WHERE id = ?', [$roomId]);
}

function cleanup()
{
    $old = q('SELECT id FROM fg_rooms WHERE created_at < ?', [time() - ROOM_TTL])->fetchAll(PDO::FETCH_COLUMN);
    foreach ($old as $id) deleteRoom((int)$id);
}

// Speichert das Foto als neues JPEG – dabei gehen alle Metadaten (auch GPS) verloren.
function saveCleanImage($tmp, $dest, $type)
{
    if (function_exists('imagecreatefromstring')) {
        $img = @imagecreatefromstring(file_get_contents($tmp));
        if (!$img) return false;
        $w = imagesx($img);
        $h = imagesy($img);
        $max = 2000;
        if ($w > $max || $h > $max) {
            $f = $max / max($w, $h);
            $scaled = imagescale($img, (int)round($w * $f), (int)round($h * $f));
            imagedestroy($img);
            if (!$scaled) return false;
            $img = $scaled;
        }
        imageinterlace($img, true);
        $ok = imagejpeg($img, $dest, 85);
        imagedestroy($img);
        return $ok;
    }
    // Ohne GD: Der Browser hat das Foto bereits ohne Metadaten neu gespeichert.
    if ($type !== IMAGETYPE_JPEG) return false;
    return move_uploaded_file($tmp, $dest);
}

// ---------- Spielstand für die Oberfläche ----------

function buildState($me, $room)
{
    $now = time();
    $token = $me['token'];
    $isHost = (int)$room['host_id'] === (int)$me['id'];

    // Punkte der laufenden Runde bleiben bis zur Auflösung geheim
    $pending = [];
    if ($room['state'] === 'guessing') {
        $open = q(
            'SELECT g.player_id, g.points FROM fg_guesses g JOIN fg_photos f ON f.id = g.photo_id
             WHERE f.room_id = ? AND f.round_no = ?',
            [$room['id'], $room['current_round']]
        )->fetchAll();
        foreach ($open as $g) $pending[(int)$g['player_id']] = (int)$g['points'];
    }
    $visibleScore = function ($player) use ($pending) {
        $id = (int)$player['id'];
        return (int)$player['score'] - (isset($pending[$id]) ? $pending[$id] : 0);
    };

    $rows = q(
        'SELECT p.id, p.name, p.score, p.last_seen,
                (SELECT COUNT(*) FROM fg_photos f WHERE f.player_id = p.id) AS photos
         FROM fg_players p WHERE p.room_id = ? ORDER BY p.joined_at, p.id',
        [$room['id']]
    )->fetchAll();
    $players = [];
    $names = [];
    $totalPhotos = 0;
    foreach ($rows as $p) {
        $players[] = [
            'id' => (int)$p['id'],
            'name' => $p['name'],
            'score' => $visibleScore($p),
            'photos' => (int)$p['photos'],
            'online' => (int)$p['last_seen'] >= $now - ONLINE_SECONDS,
            'isHost' => (int)$p['id'] === (int)$room['host_id'],
        ];
        $names[(int)$p['id']] = $p['name'];
        $totalPhotos += (int)$p['photos'];
    }

    $state = [
        'me' => [
            'id' => (int)$me['id'],
            'name' => $me['name'],
            'isHost' => $isHost,
            'score' => $visibleScore($me),
        ],
        'room' => [
            'code' => $room['code'],
            'state' => $room['state'],
            'rounds' => (int)$room['rounds'],
            'seconds' => (int)$room['seconds'],
            'photosPerPlayer' => (int)$room['photos_per_player'],
            'round' => (int)$room['current_round'],
            'roundsTotal' => (int)$room['rounds_actual'],
            'totalPhotos' => $totalPhotos,
        ],
        'players' => $players,
    ];

    if ($room['state'] === 'lobby') {
        $mine = q('SELECT * FROM fg_photos WHERE player_id = ? ORDER BY id', [$me['id']])->fetchAll();
        $state['myPhotos'] = array_map(function ($f) use ($token) {
            return [
                'id' => (int)$f['id'],
                'lat' => (float)$f['lat'],
                'lng' => (float)$f['lng'],
                'taken' => $f['taken_at'],
                'url' => photoUrl($f['id'], $token),
            ];
        }, $mine);
    }

    if ($room['state'] === 'guessing' || $room['state'] === 'reveal') {
        $photo = currentPhoto($room);
        if ($photo) {
            $ownerId = (int)$photo['player_id'];
            $guessRows = q(
                'SELECT player_id, lat, lng, distance_m, points FROM fg_guesses WHERE photo_id = ? ORDER BY distance_m',
                [$photo['id']]
            )->fetchAll();
            $myGuess = null;
            foreach ($guessRows as $g) {
                if ((int)$g['player_id'] === (int)$me['id']) {
                    $myGuess = ['lat' => (float)$g['lat'], 'lng' => (float)$g['lng']];
                    // Entfernung und Punkte erst bei der Auflösung, sonst könnte man den Ort ausrechnen
                    if ($room['state'] === 'reveal') {
                        $myGuess['distance'] = (float)$g['distance_m'];
                        $myGuess['points'] = (int)$g['points'];
                    }
                }
            }
            $deadline = roundDeadline($room);
            $round = [
                'no' => (int)$room['current_round'],
                'total' => (int)$room['rounds_actual'],
                'photoId' => (int)$photo['id'],
                'url' => photoUrl($photo['id'], $token),
                'ownerId' => $ownerId,
                'ownerName' => isset($names[$ownerId]) ? $names[$ownerId] : '?',
                'isMine' => $ownerId === (int)$me['id'],
                'duration' => (int)$room['seconds'],
                'remaining' => $deadline === null ? null : max(0, $deadline - $now),
                'guessed' => count($guessRows),
                'guessers' => max(0, count($players) - 1),
                'myGuess' => $myGuess,
            ];
            if ($room['state'] === 'reveal') {
                $round['answer'] = [
                    'lat' => (float)$photo['lat'],
                    'lng' => (float)$photo['lng'],
                    'taken' => $photo['taken_at'],
                ];
                $round['guesses'] = array_map(function ($g) use ($names) {
                    $pid = (int)$g['player_id'];
                    return [
                        'playerId' => $pid,
                        'name' => isset($names[$pid]) ? $names[$pid] : '?',
                        'lat' => (float)$g['lat'],
                        'lng' => (float)$g['lng'],
                        'distance' => (float)$g['distance_m'],
                        'points' => (int)$g['points'],
                    ];
                }, $guessRows);
            }
            $state['round'] = $round;
        }
    }

    if ($room['state'] === 'finished') {
        $photos = q(
            'SELECT id, player_id, lat, lng, round_no FROM fg_photos WHERE room_id = ? AND round_no IS NOT NULL ORDER BY round_no',
            [$room['id']]
        )->fetchAll();
        $state['summary'] = array_map(function ($f) use ($names) {
            $pid = (int)$f['player_id'];
            return [
                'round' => (int)$f['round_no'],
                'name' => isset($names[$pid]) ? $names[$pid] : '?',
                'lat' => (float)$f['lat'],
                'lng' => (float)$f['lng'],
            ];
        }, $photos);
    }

    return $state;
}

// ---------- Aktionen ----------

try {
    // Ist der Upload größer als post_max_size, verwirft PHP die ganze Anfrage (auch die Anmeldung).
    if ($_SERVER['REQUEST_METHOD'] === 'POST' && empty($_POST) && (int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
        fail('Die Datei ist zu groß für den Server.', 413);
    }
    $action = (string)param('action');

    switch ($action) {

        case 'create':
            $name = cleanName(param('name'));
            ensureSchema();
            cleanup();
            $code = null;
            for ($i = 0; $i < 30 && $code === null; $i++) {
                $c = '';
                for ($j = 0; $j < 4; $j++) $c .= CODE_CHARS[random_int(0, strlen(CODE_CHARS) - 1)];
                if (!q('SELECT id FROM fg_rooms WHERE code = ?', [$c])->fetch()) $code = $c;
            }
            if ($code === null) fail('Gerade ist kein Raumcode frei. Bitte nochmal versuchen.', 503);
            $now = time();
            q('INSERT INTO fg_rooms (code, created_at) VALUES (?, ?)', [$code, $now]);
            $roomId = (int)db()->lastInsertId();
            $token = newToken();
            q(
                'INSERT INTO fg_players (room_id, name, token, device, joined_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
                [$roomId, $name, $token, deviceParam(), $now, $now]
            );
            q('UPDATE fg_rooms SET host_id = ? WHERE id = ?', [(int)db()->lastInsertId(), $roomId]);
            out(['token' => $token, 'code' => $code]);

        case 'join':
            $code = strtoupper(trim((string)param('code')));
            if (!preg_match('/^[A-Z0-9]{4}$/', $code)) fail('Der Raumcode hat 4 Zeichen.');
            $name = cleanName(param('name'));
            ensureSchema();
            $device = deviceParam();
            $room = q('SELECT * FROM fg_rooms WHERE code = ?', [$code])->fetch();
            if (!$room) fail('Diesen Raum gibt es nicht.', 404);

            // Wiederkommender Spieler: gleiches Gerät, oder gleicher Name eines Spielers, der gerade offline ist.
            // Er bekommt seinen alten Platz zurück (auch mitten im Spiel) statt eines zweiten Eintrags.
            $back = null;
            if ($device !== '') {
                $back = q('SELECT * FROM fg_players WHERE room_id = ? AND device = ?', [$room['id'], $device])->fetch();
            }
            if (!$back) {
                $offline = q(
                    'SELECT * FROM fg_players WHERE room_id = ? AND last_seen < ?',
                    [$room['id'], time() - ONLINE_SECONDS]
                )->fetchAll();
                foreach ($offline as $p) {
                    if (mb_strtolower($p['name']) === mb_strtolower($name)) { $back = $p; break; }
                }
            }
            if ($back) {
                q('UPDATE fg_players SET last_seen = ?, device = ? WHERE id = ?', [time(), $device !== '' ? $device : $back['device'], $back['id']]);
                out(['token' => $back['token'], 'code' => $code]);
            }

            if ($room['state'] !== 'lobby') fail('In diesem Raum läuft das Spiel schon.', 409);
            $taken = q('SELECT name FROM fg_players WHERE room_id = ?', [$room['id']])->fetchAll(PDO::FETCH_COLUMN);
            if (count($taken) >= MAX_PLAYERS) fail('Der Raum ist voll.', 409);
            $lower = array_map('mb_strtolower', $taken);
            $base = $name;
            for ($n = 2; in_array(mb_strtolower($name), $lower, true); $n++) {
                $name = mb_substr($base, 0, 17) . ' ' . $n;
            }
            $now = time();
            $token = newToken();
            q(
                'INSERT INTO fg_players (room_id, name, token, device, joined_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
                [$room['id'], $name, $token, $device, $now, $now]
            );
            out(['token' => $token, 'code' => $code]);

        case 'state':
            list($me, $room) = auth();
            $room = advance($room);
            $me = q('SELECT * FROM fg_players WHERE id = ?', [$me['id']])->fetch();
            out(buildState($me, $room));

        case 'settings':
            list($me, $room) = auth();
            requireHost($me, $room);
            requireState($room, 'lobby');
            $rounds = clamp(intParam('rounds', (int)$room['rounds']), 1, 30);
            $seconds = intParam('seconds', (int)$room['seconds']);
            if (!in_array($seconds, [0, 30, 60, 90, 120, 180], true)) $seconds = 60;
            $photos = clamp(intParam('photos', (int)$room['photos_per_player']), 1, 10);
            q(
                'UPDATE fg_rooms SET rounds = ?, seconds = ?, photos_per_player = ? WHERE id = ?',
                [$rounds, $seconds, $photos, $room['id']]
            );
            out(['ok' => true]);

        case 'upload':
            list($me, $room) = auth();
            requireState($room, 'lobby');
            $count = (int)q('SELECT COUNT(*) FROM fg_photos WHERE player_id = ?', [$me['id']])->fetchColumn();
            if ($count >= (int)$room['photos_per_player']) fail('Du hast schon alle Fotos hochgeladen.', 409);
            $lat = floatParam('lat');
            $lng = floatParam('lng');
            validLatLng($lat, $lng);
            $taken = (string)param('taken');
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $taken)) $taken = null;

            if (empty($_FILES['photo']) || !is_array($_FILES['photo'])) fail('Es kam keine Datei an.');
            $f = $_FILES['photo'];
            if ($f['error'] === UPLOAD_ERR_INI_SIZE || $f['error'] === UPLOAD_ERR_FORM_SIZE) fail('Das Foto ist zu groß.');
            if ($f['error'] !== UPLOAD_ERR_OK) fail('Der Upload ist fehlgeschlagen.');
            if ($f['size'] > MAX_UPLOAD_BYTES) fail('Das Foto ist zu groß.');
            $info = @getimagesize($f['tmp_name']);
            if (!$info || !in_array($info[2], [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_WEBP], true)) {
                fail('Dieses Format wird nicht unterstützt.');
            }
            $file = bin2hex(random_bytes(12)) . '.jpg';
            if (!saveCleanImage($f['tmp_name'], UPLOAD_DIR . '/' . $file, $info[2])) {
                fail('Das Foto konnte nicht gespeichert werden.', 500);
            }
            q(
                'INSERT INTO fg_photos (room_id, player_id, file, lat, lng, taken_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [$room['id'], $me['id'], $file, $lat, $lng, $taken, time()]
            );
            out(['ok' => true]);

        case 'rename':
            list($me, $room) = auth();
            requireState($room, 'lobby');
            $name = cleanName(param('name'));
            $others = q('SELECT name FROM fg_players WHERE room_id = ? AND id <> ?', [$room['id'], $me['id']])->fetchAll(PDO::FETCH_COLUMN);
            foreach ($others as $other) {
                if (mb_strtolower($other) === mb_strtolower($name)) fail('Diesen Namen hat schon jemand.', 409);
            }
            q('UPDATE fg_players SET name = ? WHERE id = ?', [$name, $me['id']]);
            out(['ok' => true, 'name' => $name]);

        case 'kick':
            list($me, $room) = auth();
            requireHost($me, $room);
            requireState($room, 'lobby');
            $target = q('SELECT * FROM fg_players WHERE id = ? AND room_id = ?', [intParam('id', 0), $room['id']])->fetch();
            if (!$target) fail('Spieler nicht gefunden.', 404);
            if ((int)$target['id'] === (int)$me['id']) fail('Du kannst dich nicht selbst entfernen.', 409);
            if ((int)$target['last_seen'] >= time() - ONLINE_SECONDS) fail('Nur Spieler, die offline sind, können entfernt werden.', 409);
            $files = q('SELECT file FROM fg_photos WHERE player_id = ?', [$target['id']])->fetchAll(PDO::FETCH_COLUMN);
            foreach ($files as $file) {
                $path = UPLOAD_DIR . '/' . basename($file);
                if (is_file($path)) @unlink($path);
            }
            q('DELETE FROM fg_photos WHERE player_id = ?', [$target['id']]);
            q('DELETE FROM fg_players WHERE id = ?', [$target['id']]);
            out(['ok' => true]);

        case 'delete_photo':
            list($me, $room) = auth();
            requireState($room, 'lobby');
            $photo = q('SELECT * FROM fg_photos WHERE id = ? AND player_id = ?', [intParam('id', 0), $me['id']])->fetch();
            if (!$photo) fail('Foto nicht gefunden.', 404);
            $path = UPLOAD_DIR . '/' . basename($photo['file']);
            if (is_file($path)) @unlink($path);
            q('DELETE FROM fg_photos WHERE id = ?', [$photo['id']]);
            out(['ok' => true]);

        case 'photo':
            list($me, $room) = auth();
            $photo = q('SELECT * FROM fg_photos WHERE id = ? AND room_id = ?', [intParam('id', 0), $room['id']])->fetch();
            if (!$photo) fail('Foto nicht gefunden.', 404);
            $isOwner = (int)$photo['player_id'] === (int)$me['id'];
            $isPlayed = $room['state'] !== 'lobby' && $photo['round_no'] !== null
                && (int)$photo['round_no'] <= (int)$room['current_round'];
            if (!$isOwner && !$isPlayed) fail('Dieses Foto ist noch geheim.', 403);
            if ($photo['file'] === '') fail('Dieses Foto wurde nach seiner Runde gelöscht.', 410);
            $path = UPLOAD_DIR . '/' . basename($photo['file']);
            if (!is_file($path)) fail('Foto nicht gefunden.', 404);
            while (ob_get_level()) ob_end_clean();
            header('Content-Type: image/jpeg');
            header('Cache-Control: private, max-age=86400');
            header('Content-Length: ' . filesize($path));
            readfile($path);
            exit;

        case 'start':
            list($me, $room) = auth();
            requireHost($me, $room);
            requireState($room, 'lobby');
            $playerCount = (int)q('SELECT COUNT(*) FROM fg_players WHERE room_id = ?', [$room['id']])->fetchColumn();
            if ($playerCount < 2) fail('Ihr braucht mindestens 2 Spieler.', 409);
            $all = q('SELECT id, player_id, file, lat, lng FROM fg_photos WHERE room_id = ? ORDER BY id', [$room['id']])->fetchAll();
            if (count($all) === 0) fail('Es wurden noch keine Fotos hochgeladen.', 409);

            // Alle Fotos kommen dran (pro Person höchstens „Fotos pro Person“).
            // Reihenfolge: Die Fotografen wechseln sich ab, damit nie zweimal hintereinander
            // dieselbe Person ihr Foto zeigt, solange andere noch Fotos haben.
            $limit = (int)$room['photos_per_player'];
            $byPlayer = [];
            foreach ($all as $p) {
                $pid = (int)$p['player_id'];
                if (!isset($byPlayer[$pid])) $byPlayer[$pid] = [];
                if (count($byPlayer[$pid]) < $limit) $byPlayer[$pid][] = $p;
            }
            foreach ($byPlayer as $pid => $list) {
                shuffle($list);
                $byPlayer[$pid] = $list;
            }
            $owners = array_keys($byPlayer);
            shuffle($owners);
            $photos = [];
            for ($i = 0; $i < $limit; $i++) {
                foreach ($owners as $pid) {
                    if (isset($byPlayer[$pid][$i])) $photos[] = $byPlayer[$pid][$i];
                }
            }

            // Punkteskala an die Verteilung der Fotos anpassen:
            // Fotos aus einer Stadt werden strenger bewertet als Fotos aus ganz Europa.
            $lats = array_map(function ($p) { return (float)$p['lat']; }, $photos);
            $lngs = array_map(function ($p) { return (float)$p['lng']; }, $photos);
            $diag = distanceMeters(min($lats), min($lngs), max($lats), max($lngs));
            // Größerer Teiler bzw. kleineres Minimum = strengere Wertung
            $scale = clamp($diag / 12, 1000, 2000000);

            // Fotos, die nicht drankommen (mehr als „Fotos pro Person“), gleich löschen
            $usedIds = array_map(function ($p) { return (int)$p['id']; }, $photos);
            foreach ($all as $p) {
                if (!in_array((int)$p['id'], $usedIds, true)) {
                    removePhotoFile($p);
                    q('DELETE FROM fg_photos WHERE id = ?', [$p['id']]);
                }
            }

            db()->beginTransaction();
            q('UPDATE fg_photos SET round_no = NULL WHERE room_id = ?', [$room['id']]);
            foreach ($photos as $i => $p) {
                q('UPDATE fg_photos SET round_no = ? WHERE id = ?', [$i + 1, $p['id']]);
            }
            q('DELETE FROM fg_guesses WHERE room_id = ?', [$room['id']]);
            q('UPDATE fg_players SET score = 0 WHERE room_id = ?', [$room['id']]);
            q(
                "UPDATE fg_rooms SET state = 'guessing', current_round = 1, rounds_actual = ?, round_started_at = ?, scale_m = ? WHERE id = ?",
                [count($photos), time(), $scale, $room['id']]
            );
            db()->commit();
            out(['ok' => true]);

        case 'guess':
            list($me, $room) = auth();
            $room = advance($room);
            if ($room['state'] !== 'guessing') fail('Die Runde ist schon vorbei.', 409);
            $photo = currentPhoto($room);
            if (!$photo) fail('Keine aktive Runde.', 409);
            if ((int)$photo['player_id'] === (int)$me['id']) fail('Das ist dein eigenes Foto.', 409);
            $lat = floatParam('lat');
            $lng = floatParam('lng');
            validLatLng($lat, $lng);
            $distance = distanceMeters($lat, $lng, (float)$photo['lat'], (float)$photo['lng']);
            $pts = points($distance, (float)$room['scale_m']);
            try {
                q(
                    'INSERT INTO fg_guesses (room_id, photo_id, player_id, lat, lng, distance_m, points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [$room['id'], $photo['id'], $me['id'], $lat, $lng, $distance, $pts, time()]
                );
            } catch (PDOException $e) {
                if ($e->getCode() === '23000') fail('Du hast schon getippt.', 409);
                throw $e;
            }
            q('UPDATE fg_players SET score = score + ? WHERE id = ?', [$pts, $me['id']]);
            advance($room);
            out(['ok' => true]);

        case 'reveal':
            list($me, $room) = auth();
            requireHost($me, $room);
            endRound($room, $room['state'] === 'guessing' ? currentPhoto($room) : null);
            out(['ok' => true]);

        case 'next':
            list($me, $room) = auth();
            requireHost($me, $room);
            requireState($room, 'reveal');
            if ((int)$room['current_round'] < (int)$room['rounds_actual']) {
                q(
                    "UPDATE fg_rooms SET state = 'guessing', current_round = current_round + 1, round_started_at = ? WHERE id = ? AND state = 'reveal' AND current_round = ?",
                    [time(), $room['id'], $room['current_round']]
                );
            } else {
                q("UPDATE fg_rooms SET state = 'finished' WHERE id = ? AND state = 'reveal'", [$room['id']]);
            }
            out(['ok' => true]);

        case 'again':
            // Noch eine Runde im selben Raum: zurück in die Lobby, alle laden neue Fotos hoch.
            list($me, $room) = auth();
            requireHost($me, $room);
            requireState($room, 'finished');
            $files = q('SELECT file FROM fg_photos WHERE room_id = ?', [$room['id']])->fetchAll(PDO::FETCH_COLUMN);
            foreach ($files as $file) {
                if ($file === '') continue;
                $path = UPLOAD_DIR . '/' . basename($file);
                if (is_file($path)) @unlink($path);
            }
            db()->beginTransaction();
            q('DELETE FROM fg_guesses WHERE room_id = ?', [$room['id']]);
            q('DELETE FROM fg_photos WHERE room_id = ?', [$room['id']]);
            q('UPDATE fg_players SET score = 0 WHERE room_id = ?', [$room['id']]);
            q(
                "UPDATE fg_rooms SET state = 'lobby', current_round = 0, rounds_actual = 0, round_started_at = 0, created_at = ? WHERE id = ?",
                [time(), $room['id']]
            );
            db()->commit();
            out(['ok' => true]);

        default:
            fail('Unbekannte Aktion.', 404);
    }
} catch (Throwable $e) {
    if (db()->inTransaction()) db()->rollBack();
    error_log('FotoGuesser: ' . $e->getMessage());
    fail('Auf dem Server ist ein Fehler aufgetreten.', 500);
}
