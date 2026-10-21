<?php
// FotoGuesser – Einrichtung
// Einmal im Browser aufrufen, danach diese Datei vom Webspace löschen.

require __DIR__ . '/config.php';

$checks = [];
$checks[] = ['PHP 7.4 oder neuer', version_compare(PHP_VERSION, '7.4.0', '>='), 'Gefunden: ' . PHP_VERSION, true];
$checks[] = ['PDO MySQL', extension_loaded('pdo_mysql'), 'Für die Datenbank nötig', true];
$checks[] = ['mbstring', extension_loaded('mbstring'), 'Für Spielernamen nötig', true];
$checks[] = ['GD (Bildbearbeitung)', function_exists('imagecreatefromstring'), 'Empfohlen: Fotos werden serverseitig bereinigt und verkleinert', false];
$checks[] = ['Ordner uploads/ beschreibbar', is_dir(UPLOAD_DIR) && is_writable(UPLOAD_DIR), UPLOAD_DIR, true];

$ok = true;
foreach ($checks as $c) {
    if ($c[3] && !$c[1]) $ok = false;
}

$dbMessage = '';
if ($ok) {
    try {
        $pdo = new PDO(
            'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
            DB_USER,
            DB_PASS,
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
        );
        $pdo->exec("CREATE TABLE IF NOT EXISTS fg_rooms (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            code CHAR(4) NOT NULL,
            host_id INT UNSIGNED NULL,
            state VARCHAR(10) NOT NULL DEFAULT 'lobby',
            rounds INT NOT NULL DEFAULT 10,
            seconds INT NOT NULL DEFAULT 60,
            photos_per_player INT NOT NULL DEFAULT 3,
            rounds_actual INT NOT NULL DEFAULT 0,
            current_round INT NOT NULL DEFAULT 0,
            round_started_at INT NOT NULL DEFAULT 0,
            scale_m DOUBLE NOT NULL DEFAULT 2000,
            created_at INT NOT NULL,
            UNIQUE KEY code (code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        $pdo->exec("CREATE TABLE IF NOT EXISTS fg_players (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            room_id INT UNSIGNED NOT NULL,
            name VARCHAR(40) NOT NULL,
            token CHAR(32) NOT NULL,
            device CHAR(32) NOT NULL DEFAULT '',
            score INT NOT NULL DEFAULT 0,
            joined_at INT NOT NULL,
            last_seen INT NOT NULL,
            UNIQUE KEY token (token),
            KEY room (room_id),
            KEY device (room_id, device)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        $pdo->exec("CREATE TABLE IF NOT EXISTS fg_photos (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            room_id INT UNSIGNED NOT NULL,
            player_id INT UNSIGNED NOT NULL,
            file VARCHAR(64) NOT NULL,
            lat DOUBLE NOT NULL,
            lng DOUBLE NOT NULL,
            taken_at DATE NULL,
            round_no INT NULL,
            created_at INT NOT NULL,
            KEY room (room_id),
            KEY player (player_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        $pdo->exec("CREATE TABLE IF NOT EXISTS fg_guesses (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            room_id INT UNSIGNED NOT NULL,
            photo_id INT UNSIGNED NOT NULL,
            player_id INT UNSIGNED NOT NULL,
            lat DOUBLE NOT NULL,
            lng DOUBLE NOT NULL,
            distance_m DOUBLE NOT NULL,
            points INT NOT NULL,
            created_at INT NOT NULL,
            UNIQUE KEY one_guess (photo_id, player_id),
            KEY room (room_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        $dbMessage = 'Datenbank-Tabellen sind angelegt.';
    } catch (PDOException $e) {
        $ok = false;
        $dbMessage = 'Datenbank-Fehler: ' . $e->getMessage();
    }
}
?><!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FotoGuesser einrichten</title>
<style>
body { margin: 0; background: #fff; color: #111; font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 32px 16px; }
h1 { font-size: 26px; margin: 0 0 20px; }
table { width: 100%; border-collapse: collapse; }
td { padding: 10px 0; border-bottom: 1px solid #e2e2de; vertical-align: top; }
td:last-child { text-align: right; font-weight: 600; white-space: nowrap; padding-left: 12px; }
small { color: #5c5c58; display: block; }
.ok { color: #1a6b3c; } .no { color: #b3261e; } .warn { color: #9a3b00; }
.box { margin-top: 24px; padding: 16px; border: 1px solid #111; border-radius: 4px; }
</style>
</head>
<body>
<main>
<h1>FotoGuesser einrichten</h1>
<table>
<?php foreach ($checks as $c): ?>
<tr>
  <td><?= htmlspecialchars($c[0]) ?><small><?= htmlspecialchars($c[2]) ?></small></td>
  <td class="<?= $c[1] ? 'ok' : ($c[3] ? 'no' : 'warn') ?>"><?= $c[1] ? 'OK' : ($c[3] ? 'Fehlt' : 'Fehlt (optional)') ?></td>
</tr>
<?php endforeach; ?>
</table>
<div class="box">
<?php if ($ok): ?>
  <p class="ok"><strong><?= htmlspecialchars($dbMessage) ?></strong></p>
  <p>Fertig! Lösche jetzt <code>install.php</code> vom Webspace und öffne <a href="./">die Startseite</a>.</p>
<?php else: ?>
  <p class="no"><strong>Einrichtung noch nicht möglich.</strong></p>
  <p><?= $dbMessage !== '' ? htmlspecialchars($dbMessage) : 'Bitte behebe die rot markierten Punkte und lade die Seite neu.' ?></p>
<?php endif; ?>
</div>
</main>
</body>
</html>
