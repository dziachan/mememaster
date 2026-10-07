# Meme-Master

Stream-Show für Twitch: Zuschauer schicken Memes ein (TikTok, YouTube Shorts, Insta Reels), du und der Chat bewerten jedes Meme von 1 bis 10. Nach jedem Meme gibt es eine animierte Rangliste, am Ende ein Finale mit Podium.

**Wertung:** Gesamt = 50 % deine Note + 50 % Chat-Durchschnitt. Ohne Chat-Stimmen zählt nur deine Note. Bei Gleichstand gewinnt der höhere Chat-Schnitt.

## Die drei Seiten

| Seite | Adresse | Wofür |
|---|---|---|
| Einsenden | `/` | Diesen Link gibst du dem Chat. |
| Show | `/show` | Kommt in den Stream (Video, Voting, Ranking, Finale). |
| Regie | `/admin` | Nur für dich: freigeben, starten, bewerten. Passwort = `ADMIN_KEY`. |

## Online stellen (Render, kostenlos)

1. Auf [github.com](https://github.com) ein neues, **privates** Repository anlegen und den Inhalt dieses Ordners hochladen ("Add file" > "Upload files"). `node_modules` und `data` nicht mit hochladen.
2. Auf [render.com](https://render.com) anmelden, **New > Web Service**, das Repository verbinden.
3. Einstellungen:
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: Free
4. Unter **Environment** diese Variablen setzen:

   | Variable | Wert |
   |---|---|
   | `ADMIN_KEY` | dein Regie-Passwort (lang und nicht erratbar) |
   | `TWITCH_CHANNEL` | `dschann_` |
   | `STREAMER_NAME` | `Nico` |

5. Deploy starten. Danach hast du eine Adresse wie `https://meme-master-xxxx.onrender.com`.

Statt Schritt 2–4 geht auch **New > Blueprint**: Die `render.yaml` in diesem Ordner trägt alles ein und fragt nur nach dem `ADMIN_KEY`.

Jeder andere Node-Hoster funktioniert genauso (Railway, Fly.io, eigener Server): `npm install`, dann `node server.js`. Der Port kommt aus der Variable `PORT`.

## Stream-Setup

- `/show` in einem **normalen Browserfenster** öffnen (Chrome/Edge), einmal hineinklicken (damit Videos mit Ton starten), mit F11 auf Vollbild und in OBS als **Fensteraufnahme** einbinden. Die Bühne ist 16:9 und skaliert sich selbst.
- Ton: den Browser in OBS als Audioquelle aufnehmen (Anwendungs-Audioaufnahme oder Desktop-Audio).
- `/admin` auf dem zweiten Monitor oder Handy öffnen.
- Eine OBS-Browserquelle geht auch (`/show?obs=1`), aber dort lassen sich Videos nicht anklicken, falls eines nicht von selbst startet. Die Fensteraufnahme ist zuverlässiger.

## Ablauf

1. **Sammeln:** Link in den Chat posten. Einsendungen erscheinen in der Regie unter "Zur Prüfung". Mit "Vorschau" ansehen, dann freigeben oder ablehnen.
2. **Meme starten:** "Nächstes Meme starten". Das Video läuft in der Show, und der Chat kann **sofort** abstimmen: eine Zahl von 1 bis 10 schreiben. Pro Person zählt die letzte Zahl. Der Einsender selbst und dein eigener Account zählen nicht mit.
3. **Deine Wertung:** Knöpfe 1–10 in der Regie oder Zifferntasten (0 = 10). Sie bleibt bis zur Auflösung geheim.
4. **Auflösen:** beendet das Voting und zeigt deine Note, den Chat-Schnitt, das Gesamtergebnis und wer das Meme geschickt hat. Es gibt kein Zeitlimit; das Voting läuft, bis du auflöst. Mit "Voting schließen" kannst du es vorher von Hand beenden.
5. **Ranking zeigen:** Das neue Meme fährt unten ein und sortiert sich an seinen Platz.
6. Wiederholen. Wenn die Warteschlange leer ist: **Finale starten** (Platz 3, 2, 1 mit Konfetti), danach optional "Sieger-Meme abspielen".

**Lautstärke:** Der Regler in der Regie stellt die Lautstärke des laufenden Videos ein und gilt auch für die folgenden. Bei YouTube Shorts stufenlos, bei TikTok nur Ton an/aus (mehr lässt der TikTok-Player von außen nicht zu), bei Instagram gar nicht. Für diese beiden: Regler im Video selbst oder in OBS.

Zum Proben ohne Chat: Während ein Meme läuft auf "+25 Testvotes" klicken.

## Design anpassen

In der Regie gibt es links den Bereich **Design**. Alles dort wirkt sofort in der Show und auf der Einsende-Seite.

- **Schriften:** je eine für Überschriften und für Text, aus 17 mitgelieferten Schriften oder aus eigenen Schriftdateien (.woff2, .woff, .ttf, .otf, bis 1,5 MB, maximal 4). Breite Schriften werden automatisch so verkleinert, dass das Layout passt; mit **Größe der Überschriften** stellst du nach.
- **Hintergrundbild der Show:** PNG, JPG oder WebP bis 4 MB, am besten 1920 × 1080. Mit **Bild abdunkeln** bleibt die Schrift lesbar.
- **Farben:** Hauptfarbe (statt Neon-Gelbgrün) und Zweitfarbe, per Klick auf einen Vorschlag oder frei über den Farbwähler. Die Schrift auf farbigen Flächen wird automatisch dunkel oder hell, je nachdem, was besser lesbar ist. Die Regie selbst behält ihre Farben.
- **Platz rechts frei lassen:** So viel Prozent der Bildbreite bleiben in jeder Szene rechts leer, damit Facecam und Chat-Overlay nichts verdecken. Voreinstellung 30 %, 0 % nutzt das ganze Bild.
- **Logo:** PNG, JPG, WebP oder SVG bis 1,5 MB. Es ersetzt den Schriftzug „Meme Master“ oben links, in der Lobby und auf der Einsende-Seite.

**Damit das Design bleibt:** Gratis-Hoster vergessen hochgeladene Dateien bei jedem Neustart. Der Browser, in dem du das Design eingestellt hast, merkt es sich und lädt es von selbst wieder hoch, sobald du die Regie öffnest. Dauerhaft und unabhängig vom Browser geht es so: In der Regie **Design als Datei speichern**, die Datei `design.json` bei GitHub neben `server.js` hochladen. Der Server lädt sie dann bei jedem Start.

## Wichtig zu wissen

- **Gratis-Hosting vergisst Daten.** Render Free schläft nach 15 Minuten ohne Besucher ein und verliert dabei alle Einsendungen und Wertungen; der erste Aufruf danach dauert etwa eine Minute. Solange `/admin` oder `/show` offen ist, bleibt der Dienst wach. Die Regie-Seite sichert den Stand zusätzlich alle 30 Sekunden im Browser und bietet nach einem Neustart "Wiederherstellen" an. Für Einsendungen über mehrere Tage: vorher "Backup speichern" (Einstellungen) oder einen bezahlten Tarif mit Festplatte nutzen und `DATA_DIR` auf deren Pfad setzen.
- **Videolänge wird nicht automatisch geprüft.** Beim Einsenden steht die Regel da. In der Show läuft unten eine Uhr mit, und bei YouTube und TikTok erscheint die echte Länge mit Warnung über 1 Minute, sobald der Player sie meldet. Zu lange Videos sortierst du bei der Freigabe aus oder überspringst sie.
- **Twitch-Namen werden nicht überprüft.** Wer einsendet, tippt seinen Namen selbst ein. Pro Name, pro Browser und pro Video ist nur eine Einsendung möglich.
- **Instagram-Reels** starten im eingebetteten Player nicht von selbst, du musst im Video auf Play klicken. Manche Reels und TikToks lassen sich gar nicht einbetten (privat, Altersbeschränkung). Deshalb vorher in der Vorschau prüfen.
- **TikTok-Kurzlinks** (`vm.tiktok.com/...`) löst der Server selbst auf. Falls TikTok das beim Hoster blockiert, bekommt der Zuschauer den Hinweis, den vollen Link zu nehmen.
- **Twitch-Regeln:** Du bist für alles verantwortlich, was im Stream läuft. Die Freigabe ist dafür da.

## Lokal testen

Benötigt [Node.js](https://nodejs.org) ab Version 18.

```
npm install
ADMIN_KEY=geheim node server.js        (Windows PowerShell: $env:ADMIN_KEY="geheim"; node server.js)
```

Dann `http://localhost:3000/admin` öffnen.

## Variablen

| Variable | Standard | Bedeutung |
|---|---|---|
| `ADMIN_KEY` | zufällig, steht beim Start im Log | Passwort für die Regie |
| `TWITCH_CHANNEL` | `dschann_` | Kanal, dessen Chat mitgelesen wird (auch in der Regie änderbar) |
| `STREAMER_NAME` | `Nico` | Anzeigename in der Show |
| `PORT` | `3000` | Port |
| `DATA_DIR` | `./data` | Speicherort für den Spielstand |

Der Chat wird anonym mitgelesen. Es ist kein Bot-Account, kein Token und keine Twitch-App nötig.

Schriften: Die 17 mitgelieferten Schriften liegen in `public/fonts` und sind frei nutzbar (SIL Open Font License, Luckiest Guy und Permanent Marker unter Apache 2.0). Sie werden vom eigenen Server geladen, nicht von Google.
