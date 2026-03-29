require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const NOTES_FILE = path.join(__dirname, 'notes.json');
const REMINDERS_FILE = path.join(__dirname, 'reminders.json');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── OAuth ─────────────────────────────────────────────────
function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function loadTokens() {
  if (fs.existsSync(TOKENS_FILE)) return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  return null;
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function getAuthClient() {
  const auth = getOAuth2Client();
  // I molnet: använd refresh_token från env
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return auth;
  }
  const tokens = loadTokens();
  if (!tokens) return null;
  auth.setCredentials(tokens);
  auth.on('tokens', (newTokens) => saveTokens({ ...loadTokens(), ...newTokens }));
  return auth;
}

// ── Notes ─────────────────────────────────────────────────
function loadNotes() {
  if (fs.existsSync(NOTES_FILE)) return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
  return [];
}

function saveNote(text) {
  const notes = loadNotes();
  const note = { id: Date.now(), text, skapad: new Date().toISOString() };
  notes.unshift(note);
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
  return note;
}

// ── Reminders ─────────────────────────────────────────────
function loadReminders() {
  if (fs.existsSync(REMINDERS_FILE)) return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
  return [];
}

function saveReminders(reminders) {
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
}

async function tolkaNoteringMedClaude(text) {
  const nu = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `Nuvarande tid (Stockholm): ${nu}

Analysera följande notering och svara BARA med JSON, inget annat.

Om noteringen innehåller en påminnelse (t.ex. "påminn mig om X kl 14", "ring Y imorgon", "glöm inte Z om 2 timmar"):
{"typ":"påminnelse","meddelande":"<kort beskrivning av vad påminnelsen gäller>","tidpunkt":"<ISO 8601 datetime i Europe/Stockholm>"}

Annars:
{"typ":"notering"}

Notering: "${text}"`
    }]
  });

  try {
    return JSON.parse(msg.content[0].text.trim());
  } catch {
    return { typ: 'notering' };
  }
}

// ── Routes ────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const auth = getOAuth2Client();
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
  });
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const auth = getOAuth2Client();
  const { tokens } = await auth.getToken(req.query.code);
  saveTokens(tokens);
  res.redirect('/');
});

app.get('/api/status', (req, res) => {
  res.json({ inloggad: !!(loadTokens() || process.env.GOOGLE_REFRESH_TOKEN) });
});

app.get('/api/debug', (req, res) => {
  res.json({
    har_client_id: !!process.env.GOOGLE_CLIENT_ID,
    har_client_secret: !!process.env.GOOGLE_CLIENT_SECRET,
    har_refresh_token: !!process.env.GOOGLE_REFRESH_TOKEN,
    har_anthropic: !!process.env.ANTHROPIC_API_KEY,
    client_id_start: process.env.GOOGLE_CLIENT_ID?.slice(0, 20),
    client_secret_start: process.env.GOOGLE_CLIENT_SECRET?.slice(0, 8),
  });
});

app.get('/api/notes', (req, res) => res.json(loadNotes()));

app.post('/api/notes', async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Tom notering' });
  const note = saveNote(text.trim());

  // Tolka noteringen i bakgrunden
  tolkaNoteringMedClaude(text.trim()).then(resultat => {
    if (resultat.typ === 'påminnelse' && resultat.tidpunkt) {
      const reminders = loadReminders();
      reminders.push({
        id: note.id,
        meddelande: resultat.meddelande || text.trim(),
        tidpunkt: resultat.tidpunkt,
        skickad: false,
      });
      saveReminders(reminders);
      console.log('Påminnelse skapad:', resultat.meddelande, '@', resultat.tidpunkt);
    }
  }).catch(e => console.error('Tolkningsfel:', e.message));

  res.json(note);
});

app.get('/api/reminders', (req, res) => res.json(loadReminders()));

app.delete('/api/notes/:id', (req, res) => {
  const notes = loadNotes().filter(n => n.id !== parseInt(req.params.id));
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
  res.json({ ok: true });
});

app.post('/api/briefing', async (req, res) => {
  try {
    await körBriefing();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Google Calendar ───────────────────────────────────────
async function getCalendarEvents(auth) {
  const calendar = google.calendar({ version: 'v3', auth });
  const now = new Date();
  const tvåDagar = new Date(now);
  tvåDagar.setDate(tvåDagar.getDate() + 2);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: tvåDagar.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 20,
  });
  return res.data.items || [];
}

// ── Gmail ─────────────────────────────────────────────────
async function getGmailMessages(auth) {
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread newer_than:1d',
    maxResults: 15,
  });
  if (!res.data.messages) return [];

  return Promise.all(res.data.messages.map(async (m) => {
    const msg = await gmail.users.messages.get({
      userId: 'me', id: m.id, format: 'metadata',
      metadataHeaders: ['Subject', 'From'],
    });
    const h = msg.data.payload.headers;
    return {
      subject: h.find(x => x.name === 'Subject')?.value || '(inget ämne)',
      from: h.find(x => x.name === 'From')?.value || '',
      snippet: msg.data.snippet,
    };
  }));
}

// ── Claude ────────────────────────────────────────────────
async function generateBriefing(events, emails, notes) {
  const idag = new Date().toLocaleDateString('sv-SE', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const eventsText = events.length
    ? events.map(e => {
        const tid = e.start?.dateTime
          ? new Date(e.start.dateTime).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
          : 'Heldag';
        return `- ${tid}: ${e.summary || '(namnlöst)'}`;
      }).join('\n')
    : 'Inga möten.';

  const emailsText = emails.length
    ? emails.map(e => `- Från: ${e.from}\n  Ämne: ${e.subject}\n  "${e.snippet}"`).join('\n')
    : 'Inga olästa mejl.';

  const notesText = notes.length
    ? notes.slice(0, 10).map(n => `- ${n.text}`).join('\n')
    : 'Inga noteringar.';

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Du är en personlig assistent för Mats Hedman, VD och senior kreatör på designbyrån Tegel och Hatt.
Skriv en kort, varm och personlig morgonbriefing på svenska för ${idag}.

KALENDER (närmaste 48h):
${eventsText}

OLÄSTA MEJL:
${emailsText}

NOTERINGAR OCH PÅMINNELSER:
${notesText}

Håll det kortfattat — max 200 ord. Lyft det viktigaste. Avsluta med vad Mats bör prioritera idag.`
    }]
  });

  return msg.content[0].text;
}

// ── Skicka mejl ───────────────────────────────────────────
async function sendBriefingEmail(auth, text) {
  const gmail = google.gmail({ version: 'v1', auth });
  const idag = new Date().toLocaleDateString('sv-SE', { weekday: 'long', month: 'long', day: 'numeric' });
  const tid = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });

  const html = `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;color:#222;">
    <p style="font-size:0.85rem;color:#999;margin-bottom:24px;text-transform:uppercase;letter-spacing:0.05em;">Tegel och Hatt Assistent</p>
    <div style="white-space:pre-wrap;line-height:1.8;font-size:1rem;">${text.replace(/\n/g, '<br>')}</div>
    <hr style="border:none;border-top:1px solid #eee;margin:32px 0;">
    <p style="font-size:0.78rem;color:#bbb;">Skickat ${idag} kl ${tid}</p>
  </div>`;

  const raw = Buffer.from(
    `To: ${process.env.EMAIL_TO}\r\nSubject: Morgonbriefing — ${idag}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`
  ).toString('base64url');

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// ── Kör briefing ──────────────────────────────────────────
async function körBriefing() {
  const auth = getAuthClient();
  if (!auth) { console.log('Inte inloggad'); return; }

  console.log('Hämtar kalender och mejl...');
  const [events, emails] = await Promise.all([getCalendarEvents(auth), getGmailMessages(auth)]);
  const notes = loadNotes();

  console.log('Genererar briefing...');
  const briefing = await generateBriefing(events, emails, notes);

  console.log('Skickar mejl till', process.env.EMAIL_TO);
  await sendBriefingEmail(auth, briefing);
  console.log('Klart!');
}

// ── Dagliga checks ────────────────────────────────────────
async function körDagskoll(typ) {
  const auth = getAuthClient();
  if (!auth) return;

  const events = await getCalendarEvents(auth);
  const emails = await getGmailMessages(auth);
  const notes = loadNotes();

  const idag = new Date().toLocaleDateString('sv-SE', { weekday: 'long', month: 'long', day: 'numeric' });
  const prompt = typ === 'lunch'
    ? `Det är lunch. Ge Mats en kort koll (max 100 ord) på vad som händer i eftermiddag och om det finns viktiga mejl att agera på. Datum: ${idag}.

KALENDER:\n${events.map(e => `- ${e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('sv-SE', {hour:'2-digit',minute:'2-digit'}) : 'Heldag'}: ${e.summary}`).join('\n') || 'Inga fler möten idag.'}

OLÄSTA MEJL:\n${emails.slice(0,5).map(e => `- ${e.from}: ${e.subject}`).join('\n') || 'Inga.'}`
    : `Det är 16.00. Ge Mats en kort avslutningskoll (max 100 ord): vad är kvar idag, och finns det noteringar att agera på? Datum: ${idag}.

KALENDER:\n${events.map(e => `- ${e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('sv-SE', {hour:'2-digit',minute:'2-digit'}) : 'Heldag'}: ${e.summary}`).join('\n') || 'Inga fler möten.'}

NOTERINGAR:\n${notes.slice(0,5).map(n => `- ${n.text}`).join('\n') || 'Inga.'}`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{ role: 'user', content: `Du är Mats Hedmans personliga assistent på Tegel och Hatt. ${prompt}` }]
  });

  await sendBriefingEmail(auth, msg.content[0].text);
  console.log(`${typ}-koll skickad`);
}

// ── Mötes-påminnelser ─────────────────────────────────────
const skickadePåminnelser = new Set();

async function kollaMöten() {
  const auth = getAuthClient();
  if (!auth) return;

  const calendar = google.calendar({ version: 'v3', auth });
  const nu = new Date();
  const om20 = new Date(nu.getTime() + 20 * 60000);
  const om10 = new Date(nu.getTime() + 10 * 60000);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: om10.toISOString(),
    timeMax: om20.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 5,
  });

  for (const event of res.data.items || []) {
    const nyckel = event.id + '_' + event.start.dateTime;
    if (skickadePåminnelser.has(nyckel)) continue;

    skickadePåminnelser.add(nyckel);
    const tid = new Date(event.start.dateTime).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    const plats = event.location ? ` · ${event.location}` : '';
    const deltagare = event.attendees?.length ? ` · ${event.attendees.length} deltagare` : '';

    const text = `Du har ett möte om ungefär 15 minuter.\n\n📅 ${event.summary || 'Möte'}\n🕐 Kl ${tid}${plats}${deltagare}${event.description ? '\n\n' + event.description.slice(0, 200) : ''}`;
    await sendBriefingEmail(auth, text);
    console.log('Mötespåminnelse skickad:', event.summary);
  }
}

// Varje morgon 07:30
cron.schedule('30 7 * * *', körBriefing, { timezone: 'Europe/Stockholm' });

// Lunchkoll 12:00
cron.schedule('0 12 * * *', () => körDagskoll('lunch'), { timezone: 'Europe/Stockholm' });

// Avslutningskoll 16:00
cron.schedule('0 16 * * *', () => körDagskoll('avslutning'), { timezone: 'Europe/Stockholm' });

// Kolla möten var 5:e minut
cron.schedule('*/5 * * * *', kollaMöten, { timezone: 'Europe/Stockholm' });

// Kolla påminnelser varje minut
cron.schedule('* * * * *', async () => {
  const nu = new Date();
  const reminders = loadReminders();
  let ändrad = false;

  for (const r of reminders) {
    if (r.skickad) continue;
    if (new Date(r.tidpunkt) <= nu) {
      try {
        const auth = getAuthClient();
        if (auth) await sendBriefingEmail(auth, `🔔 Påminnelse\n\n${r.meddelande}`);
        r.skickad = true;
        ändrad = true;
        console.log('Påminnelse skickad:', r.meddelande);
      } catch (e) {
        console.error('Fel vid påminnelse:', e.message);
      }
    }
  }

  if (ändrad) saveReminders(reminders);
}, { timezone: 'Europe/Stockholm' });

// ── Start ─────────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () => {
  console.log('Assistent körs på http://localhost:3000');
  if (!loadTokens()) console.log('→ Logga in: http://localhost:3000/login');
});
