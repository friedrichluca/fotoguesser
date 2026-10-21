# FotoGuesser

Wie GeoGuessr, nur mit euren eigenen Fotos: Jeder lädt Fotos hoch, die anderen raten auf der Karte, wo sie aufgenommen wurden.

## Voraussetzungen

- Webspace mit **PHP 7.4 oder neuer** und einer **MySQL/MariaDB-Datenbank**
- **HTTPS** (bei den meisten Hostern kostenlos per Let's Encrypt einschaltbar)
- Empfohlen: PHP-Erweiterung **GD**, dann bereinigt und verkleinert auch der Server jedes Foto

## Auf den Webspace bringen

1. Lege im Kundenbereich deines Hosters eine Datenbank an und notiere Host, Name, Benutzer und Passwort.
2. Kopiere `config.example.php` nach `config.php` und trage diese Daten dort ein.
   `config.php` steht in der `.gitignore` und landet so nie im Repository.
3. Lade den **gesamten Ordner** per FTP hoch, z. B. nach `/fotoguesser/`.
   Wichtig: Der Ordner `uploads/` mit der Datei `.htaccess` muss mit hochgeladen werden.
   Manche FTP-Programme blenden Dateien mit Punkt am Anfang aus, die musst du dann sichtbar schalten.
4. Der Ordner `uploads/` muss beschreibbar sein. Meistens ist er das schon, sonst im FTP-Programm die Rechte auf `755` setzen (notfalls `775`).
5. Öffne `https://deine-domain.de/fotoguesser/install.php` im Browser.
   Die Seite prüft alles und legt die Datenbank-Tabellen an (Name mit `fg_` am Anfang).
6. Wenn alles grün ist: **`install.php` vom Webspace löschen.**
7. Fertig: `https://deine-domain.de/fotoguesser/` öffnen.

## So läuft ein Spiel

1. Einer erstellt ein Spiel und teilt den Link oder den 4-stelligen Raumcode.
2. Alle laden ihre Fotos hoch. Den Standort liest der Browser aus der Datei.
   Fehlt er (z. B. bei WhatsApp-Bildern), sucht man den Ort oder setzt ihn selbst auf der Karte.
3. Der Host legt Fotos pro Person und Zeit pro Foto fest und startet. Gespielt werden alle Fotos,
   also Runden = Spieler × Fotos pro Person. Die Fotografen wechseln sich dabei ab.
4. Pro Runde wird ein Foto gezeigt, alle außer dem Fotografen tippen auf der Karte.
   Je näher, desto mehr Punkte (max. 5.000). Die Punkteskala passt sich an:
   Liegen alle Fotos in einer Stadt, zählen schon wenige hundert Meter.
5. Nach jeder Runde gibt es die Auflösung mit Street-View-Link, am Ende den Endstand mit allen Orten.
6. Mit „Noch eine Runde“ holt der Host alle zurück in die Lobby desselben Raums.
   Punkte und Fotos werden zurückgesetzt, alle laden neue Fotos hoch.

## Datenschutz

- Bevor ein Foto hochgeladen wird, speichert der Browser es neu als JPEG. Dabei gehen **alle Metadaten verloren**, auch das GPS.
  Die Koordinaten werden separat gespeichert und erst nach dem Tipp gezeigt.
- Fotos liegen in `uploads/` und sind dort nicht direkt abrufbar. Sie werden nur über `api.php` an Mitspieler im selben Raum ausgeliefert, und erst ab ihrer Runde.
- Jedes Foto wird **bei der Auflösung seiner Runde vom Webspace gelöscht**. Fotos, die nicht ins Spiel kommen,
  werden beim Start gelöscht. Übrig bleiben nur die Koordinaten für Auflösung und Endstand.
- Räume samt Koordinaten und Fotos, die nie gespielt wurden, werden **nach 24 Stunden automatisch gelöscht**
  (jeweils beim Erstellen eines neuen Raums).
- Schriften und Bibliotheken liegen lokal auf deinem Webspace. Nur die Kartenkacheln kommen von außen:
  Satellit von Esri (server.arcgisonline.com), Karte von OpenStreetMap (tile.openstreetmap.org).
  Die Ortssuche beim manuellen Setzen des Standorts nutzt Nominatim (nominatim.openstreetmap.org),
  aber nur, wenn jemand dort etwas sucht.
  Google wird erst beim Klick auf „Street View“ aufgerufen.
- Wenn die Seite öffentlich erreichbar ist, brauchst du in Deutschland ein Impressum und eine Datenschutzerklärung.

## Dateien

| Datei | Zweck |
| --- | --- |
| `index.html` | Die App-Oberfläche |
| `assets/app.js`, `assets/app.css` | Logik und Aussehen |
| `assets/vendor/` | Leaflet 1.9.4 (Karte), exifr 7.1.3 (Fotodaten) |
| `assets/fonts/` | Archivo, IBM Plex Mono (SIL Open Font License) |
| `api.php` | Server: Räume, Uploads, Tipps, Punkte |
| `config.example.php` | Vorlage für `config.php` (Datenbank-Zugang, nicht im Repo) |
| `install.php` | Einmalige Einrichtung, danach löschen |
| `uploads/` | Hochgeladene Fotos |

## Anpassen

- **Andere Karte:** In `assets/app.js` ganz oben `satTiles`/`tiles` und die Quellenangaben ändern.
- **Anderer Startausschnitt:** In `assets/app.js` ganz oben `startBounds` ändern (Südwest- und Nordost-Ecke).
- **Fotos länger behalten:** In `api.php` den Wert `ROOM_TTL` (in Sekunden) erhöhen.
- **Mehr Spieler:** In `api.php` den Wert `MAX_PLAYERS` erhöhen.
