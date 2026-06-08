# Microsoft Teams Integration Test Portal

A premium prototype application designed to test the end-to-end integration lifecycle for scheduling Microsoft Teams interviews, subscribing to change notification webhooks, downloading meeting video recordings/transcripts, and playing them back on an interactive user interface.

---

## ⚡ Quick Start (Simulated Mode - No Microsoft Credentials Needed)

To test the frontend interactive player and backend webhook sync logic immediately without Azure Entra ID or ngrok:

1. **Install Dependencies**:
   Open a terminal in this directory and run:
   ```bash
   npm install
   ```

2. **Start the Express Server**:
   ```bash
   npm start
   ```

3. **Open the Dashboard**:
   Navigate to [http://localhost:3000](http://localhost:3000) in your web browser.

4. **Run the Automated Simulation**:
   - Click the purple **"Run Demo Flow"** button in the sidebar.
   - This will automatically:
     1. Schedule a simulated meeting.
     2. Simulates the Teams meeting ending and Graph Webhook sending a POST notification.
     3. Copies a sample transcript (WebVTT) and video (MP4) to your local downloads directory.
     4. Opens the **Playback Room** and autoplays the video.
     5. Syncs the transcript text to the video player (clicking text seeks video, playing video highlights text).

---

## 🛠️ Complete Microsoft Graph API Setup (Real End-to-End Testing)

To test the application with real Microsoft Office 365 calendars, meetings, and recordings:

### Phase 1: Azure Entra ID App Registration
1. Log in to the [Azure Portal](https://portal.azure.com) as a Tenant Administrator.
2. Go to **Microsoft Entra ID** → **App registrations** → **New registration**.
3. Name your app (e.g., `TeamsSyncPortal`) and register.
4. Go to **Certificates & Secrets** → **New client secret**. Copy the secret **Value** immediately.
5. Go to **API Permissions** → **Add a permission** → **Microsoft Graph**.
6. Select **Application Permissions** (essential - do not select Delegated).
7. Add the following permissions:
   - `Calendars.ReadWrite` (Allows the app to block calendars and generate meeting links)
   - `CallTranscript.Read.All` (Allows the app to fetch meeting transcripts)
   - `CallRecording.Read.All` (Allows the app to download meeting video files)
8. Click **"Grant admin consent for [Your Tenant Name]"** and ensure the status column shows green checkmarks.

---

### Phase 2: Expose Your Local Webhook Listener (ngrok)
Microsoft Graph sends change notifications to a public HTTPS URL. For local testing, you must tunnel your localhost port `3000` using ngrok:

1. Download and install [ngrok](https://ngrok.com/).
2. Run ngrok in a separate terminal:
   ```bash
   ngrok http 3000
   ```
3. Copy the forwarding **HTTPS** URL (e.g., `https://abcd-123.ngrok-free.app`).

---

### Phase 3: Configure and Test the Portal
1. Open the portal at `http://localhost:3000` and navigate to the **Graph Settings** tab.
2. Enter your:
   - **Directory (Tenant) ID**
   - **Application (Client) ID**
   - **Client Secret Value**
   - **Webhook Base URL** (Enter your ngrok HTTPS URL)
   - **Default Panelist Email** (Must be a real email address inside your M365 organization)
   - **Default Candidate Email** (An external email to receive the Outlook invite)
3. Click **Save Configurations**.
4. Click **Test Graph API Connection**. You should see a green notification: *Successfully authenticated with Microsoft Graph API.*
5. Click **Register Graph Webhooks** on the instructions panel to subscribe to Microsoft change notifications.

---

### Phase 4: Run a Real Live Interview
1. Navigate to the **Schedule Interview** tab.
2. Enter the subject, emails, and interview start/end times.
3. Click **Create Calendar Event**.
   - This blocks the panelist's calendar in Outlook.
   - An email invitation is sent to the candidate containing the Teams link.
   - The meeting appears on your dashboard with status **"Scheduled"**.
4. Click **Join** on the dashboard to start the Teams call.
5. **CRITICAL STEP**: Once inside the Teams meeting, click **More** → **Record and transcribe** → **Start recording**. Speak for at least 30-60 seconds so a transcript is generated.
6. End the meeting for all participants.
7. Within 2-8 minutes (Microsoft's processing delay), watch the **System Activity Log** on the dashboard.
   - The webhook will receive a notification.
   - The status updates to **"Fetching Assets"**, then **"Completed"**.
   - Click **View Media** next to the meeting in the table to review the recording and timestamp-synchronized transcript!
