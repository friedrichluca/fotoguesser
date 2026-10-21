<?php
// FotoGuesser – Konfiguration
// Diese Datei nach config.php kopieren und die Zugangsdaten deiner MySQL-Datenbank eintragen
// (zu finden im Kundenbereich deines Webhosters). config.php wird nicht ins Git-Repository übernommen.

define('DB_HOST', 'localhost');
define('DB_NAME', 'datenbankname');
define('DB_USER', 'benutzername');
define('DB_PASS', 'passwort');

// Ordner für hochgeladene Fotos (muss beschreibbar sein)
define('UPLOAD_DIR', __DIR__ . '/uploads');
