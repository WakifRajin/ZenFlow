# Calendar, reminders and Google Calendar: server setup

Everything below is one-time setup for the `zenflow-pro` Firebase project. Until it's done, the calendar still works fully **in the browser**: events, repeats, reminders and alarms all run while ZenFlow is open. The server adds:

- **Push reminders:** they arrive even when ZenFlow is closed or the phone is locked.
- **Google Calendar sync:** two-way, in the background every 5 minutes, and immediately after you edit.

## 1. Upgrade to the Blaze plan

Cloud Functions and Cloud Scheduler need billing enabled. In the [Firebase console](https://console.firebase.google.com/project/zenflow-pro/usage/details), go to **Usage and billing** → **Modify plan** → **Blaze**. Personal use normally stays inside the free tier. Set a budget alert while you're there.

## 2. Google Calendar API and OAuth client

In the [Google Cloud console](https://console.cloud.google.com/apis/dashboard?project=zenflow-pro) for project `zenflow-pro`:

1. **APIs & Services → Library** → enable **Google Calendar API**.
2. **APIs & Services → OAuth consent screen**:
   - User type **External**. Fill in the app name (ZenFlow), support email and developer email.
   - **Scopes:** add `openid`, `.../auth/userinfo.email` and `.../auth/calendar`.
   - **Test users:** add the Google accounts that should connect while the app is in *Testing* (up to 100). A public launch needs Google's verification, because `calendar` is a sensitive scope.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URI: `https://asia-southeast1-zenflow-pro.cloudfunctions.net/googleOAuthCallback`
   - Keep the **Client ID** and **Client secret** for step 4.

## 3. Web push key

Firebase console → **Project settings → Cloud Messaging → Web Push certificates → Generate key pair**. Copy the **public** key into `js/firebase-config.js`:

```js
export const vapidKey = 'BK...your public key...';
```

The public key is meant to be in the page. Firebase keeps the private half.

## 4. Configure the functions

Store the client secret in Secret Manager. You'll be prompted for it; it never goes in the repository:

```bash
firebase functions:secrets:set GOOGLE_CLIENT_SECRET --project zenflow-pro
```

Create `functions/.env.zenflow-pro` with the non-secret settings:

```bash
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
APP_ORIGINS=https://wakifrajin.github.io,http://localhost:8765
```

`APP_ORIGINS` lists the sites allowed to start the Google connection flow; use your real site origin. The OAuth result is only ever sent to one of these origins.

## 5. Deploy

```bash
firebase deploy --only functions,firestore:rules --project zenflow-pro
```

The first deploy may ask to enable Cloud Functions, Cloud Build, Artifact Registry, Cloud Scheduler, Eventarc and Secret Manager; accept. It deploys:

| Function | What it does |
|---|---|
| `googleConnectStart`, `googleOAuthCallback` | Google sign-in with offline access; stores the refresh token server-side (`zenflow_google/{uid}`, never readable by clients) |
| `googleSyncNow`, `syncGoogleCalendars` (every 5 min) | Two-way sync |
| `googleDisconnect` | Revokes access and removes Google events from ZenFlow; nothing is deleted in Google |
| `scheduleReminders`, `refreshReminderHorizons` (hourly) | Plan the next 48 hours of reminders |
| `deliverReminders` (every minute) | Sends due reminders by Firebase Cloud Messaging, then deletes them |

Bump the `?v=` version in `index.html` whenever you change front-end files.

## 6. Check it works

1. Open ZenFlow, log in, then go to **Settings → Calendar and reminders → Reminders when ZenFlow is closed → Turn on**.
2. Create a reminder a few minutes ahead, then close the tab. A system notification should arrive at that time.
3. Go to **Calendar → Connect Google Calendar**, approve, and your primary calendar's events appear. Create an event in ZenFlow on that Google calendar: it shows up in Google within seconds. An edit made in Google shows up in ZenFlow within 5 minutes, or straight away with **Sync now**.

Troubleshooting: `firebase functions:log --project zenflow-pro`, or in the browser console, `zenflowDiagnostics()`.

## Limitations

- **iPhone and iPad:** web push only works after **Add to Home Screen** (iOS 16.4 or later).
- **Custom repeat rules:** Google repeat rules outside the supported set (`FREQ`/`INTERVAL`/`COUNT`/`UNTIL`/`BYDAY`/`BYMONTHDAY`/`BYMONTH`), for example `BYSETPOS`, show only their first occurrence and are read-only in ZenFlow.
- **Sync window:** Google sync covers events from 90 days ago onward. One-off Google events older than 180 days are dropped from ZenFlow, but not from Google.
- **Alarm type:** "Alarm" (ringing) is a ZenFlow reminder type. In Google it appears as a normal popup reminder.
