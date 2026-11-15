# CoChat – Setup-Anleitung (nur mit Handy)

WhatsApp-inspirierter Web-Messenger ohne Telefonnummer. Nutzer-zu-Nutzer-Chats sind Ende-zu-Ende-verschlüsselt, der Kontakt **CoChatAI** nutzt Gemini (Google AI Studio).

Du brauchst nur einen Handy-Browser. Tipp: In Supabase und bei den Hostern die „Desktop-Ansicht" einschalten.

Ordner im Projekt:
- `web/` – die App (statisch, kein Build nötig)
- `supabase/schema.sql` – Datenbank
- `supabase/functions/cochat-ai/index.ts` – KI-Funktion

## 1. Datenbank einrichten
1. Auf supabase.com dein Projekt öffnen.
2. **SQL Editor** → neues Query → kompletten Inhalt von `supabase/schema.sql` einfügen → **Run**.
   - Hast du `schema.sql` schon früher ausgeführt? Dann stattdessen den Inhalt von `supabase/migration_recovery.sql` ausführen (ergänzt den Wiederherstellungsschlüssel, ohne Daten zu löschen).
3. Project URL und Publishable-Key sind in `web/config.js` bereits eingetragen, hier ist nichts mehr zu tun.

## 2. CoChatAI (Gemini) ohne Computer einrichten
1. Auf aistudio.google.com/apikey einen API-Schlüssel erzeugen und kopieren.
2. Supabase → **Edge Functions → Secrets** → neues Secret:
   - `GEMINI_API_KEY` = dein Schlüssel
   - optional `GEMINI_MODEL` = `gemini-3.6-flash` (oder `gemini-3.5-flash-lite` für schneller/günstiger)
3. Supabase → **Edge Functions → Deploy a new function → Via Editor**:
   - Name: `cochat-ai`
   - Beispielcode löschen, Inhalt von `supabase/functions/cochat-ai/index.ts` einfügen
   - **Deploy** tippen, „Verify JWT" angeschaltet lassen.

## 3. App online stellen (GitHub Pages, ohne Terminal)
1. Auf github.com ein **öffentliches** Repository anlegen.
2. **Add file → Create new file**, Name `.github/workflows/unpack.yml`, Inhalt der mitgelieferten Datei `unpack.yml` einfügen, committen.
3. **Settings → Pages → Source** auf **GitHub Actions** stellen.
4. **Add file → Upload files** → `cochat.zip` hochladen und committen.
5. Im Reiter **Actions** läuft der Workflow: Er entpackt die ZIP-Datei und veröffentlicht `web/`. Die Adresse steht danach im Schritt „deploy".

Für Updates lädst du einfach wieder eine `cochat.zip` mit demselben Namen hoch.

## 4. Adresse in Supabase eintragen
Supabase → **Authentication → URL Configuration**:
- **Site URL** = deine App-Adresse aus Schritt 3
- **Redirect URLs** = dieselbe Adresse hinzufügen

## 5. E-Mail-Bestätigung über Gmail
1. Im Google-Konto 2-Faktor-Authentifizierung aktivieren, dann **App-Passwörter** → ein Passwort erzeugen.
2. Supabase → **Authentication → Emails → SMTP Settings** → Custom SMTP an:
   - Host `smtp.gmail.com`, Port `465`
   - Benutzer = deine Gmail-Adresse, Passwort = das App-Passwort
   - Absender = deine Gmail-Adresse, Name `CoChat`
3. **Authentication → Providers → Email**: „Confirm email" angeschaltet lassen.

## 6. „Mit Google fortfahren" (optional)
1. console.cloud.google.com → **APIs & Dienste → Anmeldedaten** → OAuth-Client-ID (Webanwendung).
2. Als Weiterleitungs-URI die Callback-URL eintragen, die Supabase unter **Authentication → Providers → Google** anzeigt.
3. Client-ID und Secret dort in Supabase einfügen und Google aktivieren.
4. Beim ersten Google-Login legst du in der App Benutzername, Sicherheitscode und ein Verschlüsselungs-Passwort fest.

## 7. Als App aufs Handy
Adresse im Browser öffnen → Menü → **Zum Startbildschirm hinzufügen**.

## So funktioniert die Verschlüsselung
- Beim Registrieren entsteht im Browser ein RSA-Schlüsselpaar. Der private Schlüssel wird zweimal verschlüsselt gespeichert: mit deinem Passwort und mit einem zufälligen **Wiederherstellungsschlüssel**.
- Jede Nachricht bekommt einen eigenen AES-256-GCM-Schlüssel, der für Empfänger und Absender mit RSA verpackt wird. Supabase sieht nur Chiffretext.
- Nach einem Neuladen der Seite musst du dein Passwort erneut eingeben.

## Passwort vergessen
- Beim Registrieren (oder erstem Google-Login) zeigt CoChat einmalig deinen **Wiederherstellungsschlüssel** an, z. B. `K7QP-2MXZ-4RWD-9HFA-3TBC-8NVE`. Speichere ihn sicher (Passwort-Manager, Notiz-App, Ausdruck).
- Auf der Anmeldeseite **„Passwort vergessen?"** antippen → Link per E-Mail → neues Passwort + Wiederherstellungsschlüssel eingeben. Deine alten Chats bleiben lesbar.
- Ehrlicher Hinweis: Bei Ende-zu-Ende-Verschlüsselung kennt der Server deinen Schlüssel nicht. Wer **Passwort und Wiederherstellungsschlüssel** verliert, kann alte Chats nicht mehr lesen. Neue Chats sind mit einem neuen Konto weiter möglich.

## Wichtige Hinweise
- **CoChatAI-Chats sind nicht Ende-zu-Ende-verschlüsselt**, weil Google sie verarbeiten muss. Der Verlauf lässt sich im Profil löschen.
- Benutzername, E-Mail und Sicherheitscode sind eindeutig. Der Sicherheitscode ist kein Passwort, nur ein Kontakt-Identifikator.
- Den Secret-Key von Supabase (`sb_secret_…`) niemals in die App oder weitergeben.
- Dein Logo ist `web/logo.png` und dient auch als Favicon.
