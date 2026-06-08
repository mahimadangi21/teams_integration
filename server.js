const express = require('express');
const axios = require('axios');
const qs = require('qs');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files from 'public'
app.use(express.static(path.join(__dirname, 'public')));
// Serve downloaded recording videos and transcripts
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Redirect /admin to / so navigating to /admin loads the page correctly
app.get('/admin', (req, res) => {
    res.redirect('/');
});

// Ensure required directories exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}
const mockAssetsDir = path.join(__dirname, 'public', 'mock-assets');
if (!fs.existsSync(mockAssetsDir)) {
    fs.mkdirSync(mockAssetsDir, { recursive: true });
}

const dbPath = path.join(__dirname, 'meetings.json');

// ==========================================
// POSTGRESQL CONNECTION POOL SETUP (AWS RDS)
// ==========================================
const usePostgres = process.env.DB_PROVIDER === 'postgres' && process.env.DATABASE_URL;
let pool = null;

if (usePostgres) {
    console.log("========================================================");
    console.log("Connecting to AWS RDS PostgreSQL Database...");
    console.log(`URL: ${process.env.DATABASE_URL.split('@')[1]}`); // Log only host details, hide credentials
    console.log("========================================================");
    
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false // Necessary for standard AWS RDS SSL configurations
        }
    });

    // Handle unexpected idle database connection drops to prevent process crashes
    pool.on('error', (err, client) => {
        console.error('Unexpected database client connection error:', err.message);
    });

    // Create Table Schema on startup
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS teams_meetings (
            id VARCHAR(255) PRIMARY KEY,
            event_id VARCHAR(255),
            subject VARCHAR(255),
            panelist_email TEXT,
            candidate_email VARCHAR(255),
            organizer_email VARCHAR(255),
            start_time TIMESTAMP,
            end_time TIMESTAMP,
            join_url TEXT,
            status VARCHAR(100),
            created_at TIMESTAMP,
            is_simulated BOOLEAN DEFAULT FALSE,
            transcript_text TEXT,
            transcript_path VARCHAR(255),
            recording_path VARCHAR(255),
            logs JSONB DEFAULT '[]'::jsonb
        );
    `;

    pool.query(createTableQuery)
        .then(() => {
            console.log("PostgreSQL schema table 'teams_meetings' verified/created successfully.");
            return pool.query('ALTER TABLE teams_meetings ALTER COLUMN panelist_email TYPE TEXT');
        })
        .then(() => {
            console.log("PostgreSQL column 'panelist_email' altered/verified as TEXT.");
            // Add organizer_email column if it doesn't exist (safe migration)
            return pool.query(`ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS organizer_email VARCHAR(255)`);
        })
        .then(() => {
            console.log("PostgreSQL column 'organizer_email' verified/added.");
        })
        .catch(err => {
            console.error("FATAL: Failed to initialize PostgreSQL schema table:", err.message);
        });
} else {
    console.log("========================================================");
    console.log("Using local JSON file store (meetings.json) for storage.");
    console.log("========================================================");
}

// ==========================================
// DATABASE INTERACTION ADAPTERS (ASYNC CRUD)
// ==========================================

// Helper to get all meetings
async function getMeetings() {
    if (usePostgres) {
        try {
            const res = await pool.query('SELECT * FROM teams_meetings ORDER BY created_at DESC');
            return res.rows.map(row => ({
                id: row.id,
                eventId: row.event_id,
                subject: row.subject,
                panelistEmail: row.panelist_email,
                candidateEmail: row.candidate_email,
                organizerEmail: row.organizer_email,
                startTime: row.start_time ? new Date(row.start_time).toISOString() : null,
                endTime: row.end_time ? new Date(row.end_time).toISOString() : null,
                joinUrl: row.join_url,
                status: row.status,
                createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
                isSimulated: row.is_simulated,
                transcriptText: row.transcript_text,
                transcriptPath: row.transcript_path,
                recordingPath: row.recording_path,
                logs: typeof row.logs === 'string' ? JSON.parse(row.logs) : row.logs || []
            }));
        } catch (err) {
            console.error("Error reading meetings from PostgreSQL database:", err.message);
            return [];
        }
    } else {
        try {
            if (!fs.existsSync(dbPath)) {
                fs.writeFileSync(dbPath, JSON.stringify([]));
                return [];
            }
            const data = fs.readFileSync(dbPath, 'utf8');
            const meetings = JSON.parse(data || '[]');
            return meetings.map(m => ({
                ...m,
                startTime: m.startTime ? new Date(m.startTime).toISOString() : null,
                endTime: m.endTime ? new Date(m.endTime).toISOString() : null
            }));
        } catch (err) {
            console.error("Error reading local meetings.json:", err);
            return [];
        }
    }
}

// Helper to insert a meeting
async function insertMeeting(m) {
    if (usePostgres) {
        try {
            const query = `
                INSERT INTO teams_meetings (
                    id, event_id, subject, panelist_email, candidate_email, organizer_email,
                    start_time, end_time, join_url, status, created_at, is_simulated, logs
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            `;
            const values = [
                m.id, m.eventId, m.subject, m.panelistEmail, m.candidateEmail, m.organizerEmail || null,
                new Date(m.startTime), new Date(m.endTime), m.joinUrl, m.status,
                new Date(m.createdAt), m.isSimulated, JSON.stringify(m.logs)
            ];
            await pool.query(query, values);
            console.log(`Meeting record ${m.id} saved to PostgreSQL (organizer: ${m.organizerEmail}).`);
        } catch (err) {
            console.error(`Error inserting meeting ${m.id} in PostgreSQL:`, err.message);
            throw err;
        }
    } else {
        try {
            const meetings = await getMeetings();
            meetings.push(m);
            fs.writeFileSync(dbPath, JSON.stringify(meetings, null, 2));
        } catch (err) {
            console.error("Error writing to local JSON DB:", err);
            throw err;
        }
    }
}

// Helper to update a meeting
async function updateMeeting(id, updates) {
    if (usePostgres) {
        try {
            const keys = Object.keys(updates);
            if (keys.length === 0) return;
            
            const setClauses = [];
            const values = [];
            let index = 1;
            
            for (const key of keys) {
                let colName = key;
                if (key === 'eventId') colName = 'event_id';
                else if (key === 'panelistEmail') colName = 'panelist_email';
                else if (key === 'candidateEmail') colName = 'candidate_email';
                else if (key === 'startTime') colName = 'start_time';
                else if (key === 'endTime') colName = 'end_time';
                else if (key === 'joinUrl') colName = 'join_url';
                else if (key === 'isSimulated') colName = 'is_simulated';
                else if (key === 'organizerEmail') colName = 'organizer_email';
                else if (key === 'transcriptText') colName = 'transcript_text';
                else if (key === 'transcriptPath') colName = 'transcript_path';
                else if (key === 'recordingPath') colName = 'recording_path';
                
                setClauses.push(`${colName} = $${index}`);
                
                if (key === 'startTime' || key === 'endTime') {
                    values.push(new Date(updates[key]));
                } else if (key === 'logs') {
                    values.push(JSON.stringify(updates[key]));
                } else {
                    values.push(updates[key]);
                }
                index++;
            }
            
            values.push(id);
            const query = `UPDATE teams_meetings SET ${setClauses.join(', ')} WHERE id = $${index}`;
            await pool.query(query, values);
            console.log(`Meeting record ${id} updated in PostgreSQL.`);
        } catch (err) {
            console.error(`Error updating meeting ${id} in PostgreSQL:`, err.message);
        }
    } else {
        try {
            const meetings = await getMeetings();
            const idx = meetings.findIndex(m => m.id === id);
            if (idx !== -1) {
                meetings[idx] = { ...meetings[idx], ...updates };
                fs.writeFileSync(dbPath, JSON.stringify(meetings, null, 2));
            }
        } catch (err) {
            console.error("Error writing updates to local JSON DB:", err);
        }
    }
}

// Helper to delete a meeting
async function deleteMeetingFromDb(id) {
    if (usePostgres) {
        try {
            await pool.query('DELETE FROM teams_meetings WHERE id = $1', [id]);
            console.log(`Meeting record ${id} deleted from PostgreSQL.`);
        } catch (err) {
            console.error(`Error deleting meeting ${id} from PostgreSQL:`, err.message);
            throw err;
        }
    } else {
        try {
            let meetings = await getMeetings();
            meetings = meetings.filter(m => m.id !== id);
            fs.writeFileSync(dbPath, JSON.stringify(meetings, null, 2));
        } catch (err) {
            console.error("Error writing delete to local JSON DB:", err);
            throw err;
        }
    }
}

// Helper to update a meeting's primary ID (needed when mapping fallback calendar event ID to actual onlineMeetingId)
async function updateMeetingIdInDb(oldId, newId) {
    if (usePostgres) {
        try {
            await pool.query('UPDATE teams_meetings SET id = $1 WHERE id = $2', [newId, oldId]);
            console.log(`Meeting record ID updated from ${oldId} to ${newId} in PostgreSQL.`);
        } catch (err) {
            console.error(`Error updating meeting ID in PostgreSQL:`, err.message);
            throw err;
        }
    } else {
        try {
            const meetings = await getMeetings();
            const idx = meetings.findIndex(m => m.id === oldId);
            if (idx !== -1) {
                meetings[idx].id = newId;
                fs.writeFileSync(dbPath, JSON.stringify(meetings, null, 2));
                console.log(`Meeting record ID updated from ${oldId} to ${newId} in local JSON DB.`);
            }
        } catch (err) {
            console.error("Error writing ID update to local JSON DB:", err);
            throw err;
        }
    }
}

// ==========================================
// 1. ENVIRONMENT CONFIGURATION LOGIC
// ==========================================
app.get('/api/config', (req, res) => {
    res.json({
        MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID || '',
        MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID || '',
        MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET ? '••••••••••••••••' : '',
        WEBHOOK_BASE_URL: process.env.WEBHOOK_BASE_URL || '',
        DEFAULT_PANELIST_EMAIL: process.env.DEFAULT_PANELIST_EMAIL || '',
        DEFAULT_CANDIDATE_EMAIL: process.env.DEFAULT_CANDIDATE_EMAIL || '',
        DB_PROVIDER: process.env.DB_PROVIDER || 'json',
        DATABASE_URL: process.env.DATABASE_URL ? '••••••••••••••••' : ''
    });
});

app.post('/api/config', (req, res) => {
    const { tenantId, clientId, clientSecret, webhookUrl, panelistEmail, candidateEmail } = req.body;
    
    try {
        const envPath = path.join(__dirname, '.env');
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }

        const updates = {
            MICROSOFT_TENANT_ID: tenantId,
            MICROSOFT_CLIENT_ID: clientId,
            WEBHOOK_BASE_URL: webhookUrl,
            DEFAULT_PANELIST_EMAIL: panelistEmail,
            DEFAULT_CANDIDATE_EMAIL: candidateEmail
        };

        if (clientSecret && !clientSecret.startsWith('••')) {
            updates.MICROSOFT_CLIENT_SECRET = clientSecret;
        }

        const lines = envContent.split(/\r?\n/);
        const newLines = [];
        const processedKeys = new Set();

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                const parts = trimmed.split('=');
                const key = parts[0].trim();
                if (updates.hasOwnProperty(key)) {
                    newLines.push(`${key}=${updates[key]}`);
                    processedKeys.add(key);
                    continue;
                }
            }
            newLines.push(line);
        }

        for (const [key, value] of Object.entries(updates)) {
            if (!processedKeys.has(key)) {
                newLines.push(`${key}=${value}`);
            }
        }

        fs.writeFileSync(envPath, newLines.join('\n'));

        for (const [key, value] of Object.entries(updates)) {
            process.env[key] = value;
        }

        console.log("Environment variables updated successfully.");
        res.json({ message: "Configuration saved and loaded successfully. Please restart server manually if changing Database Provider." });
    } catch (error) {
        console.error("Failed to save config:", error);
        res.status(500).json({ error: "Failed to update configuration: " + error.message });
    }
});

// ==========================================
// 2. HELPER: FETCH MICROSOFT GRAPH ACCESS TOKEN
// ==========================================
async function getGraphAccessToken() {
    const tenantId = process.env.MICROSOFT_TENANT_ID;
    const clientId = process.env.MICROSOFT_CLIENT_ID;
    const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
        throw new Error("Missing Microsoft credentials. Please configure them in Settings.");
    }

    const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const data = qs.stringify({
        'client_id': clientId,
        'scope': 'https://graph.microsoft.com/.default',
        'client_secret': clientSecret,
        'grant_type': 'client_credentials'
    });

    const response = await axios.post(url, data, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return response.data.access_token;
}

// Test Connection Endpoint
app.get('/api/test-token', async (req, res) => {
    try {
        const token = await getGraphAccessToken();
        res.json({ success: true, message: "Successfully authenticated with Microsoft Graph API." });
    } catch (error) {
        console.error("Graph Token Test Failed:", error.response ? error.response.data : error.message);
        res.status(401).json({
            success: false,
            error: error.response ? JSON.stringify(error.response.data) : error.message
        });
    }
});

// ==========================================
// 3. ENDPOINT: SCHEDULE EVENT ON TEAMS
// ==========================================
// Helper: Format date/time for premium email template
function formatEmailDate(dateStr) {
    try {
        const d = new Date(dateStr);
        return d.toLocaleString('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'Asia/Kolkata'
        });
    } catch (e) {
        return dateStr;
    }
}

// Helper: Send email notification via Microsoft Graph
async function sendGraphEmail(token, senderEmail, recipientEmail, subject, htmlContent) {
    try {
        console.log(`Sending Graph email notification to ${recipientEmail} from ${senderEmail}...`);
        const url = `https://graph.microsoft.com/v1.0/users/${senderEmail}/sendMail`;
        const payload = {
            message: {
                subject: subject,
                body: {
                    contentType: "HTML",
                    content: htmlContent
                },
                toRecipients: [
                    {
                        emailAddress: {
                            address: recipientEmail
                        }
                    }
                ]
            },
            saveToSentItems: false
        };
        await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`Successfully sent email notification to ${recipientEmail}`);
        return true;
    } catch (err) {
        console.warn(`Failed to send email to ${recipientEmail}:`, err.response ? err.response.data : err.message);
        return false;
    }
}

// Helper: Send a 1:1 Teams chat notification to a user via Microsoft Graph API
// Requires Chat.Create and ChatMessage.Send application permissions with Admin Consent.
async function sendTeamsNotification(token, senderEmail, recipientEmail, messageHtml) {
    try {
        console.log(`Sending Teams chat notification to ${recipientEmail}...`);

        // Step 1: Create or find a 1:1 chat between sender and recipient
        const chatPayload = {
            chatType: "oneOnOne",
            members: [
                {
                    "@odata.type": "#microsoft.graph.aadUserConversationMember",
                    roles: ["owner"],
                    "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${senderEmail}')`
                },
                {
                    "@odata.type": "#microsoft.graph.aadUserConversationMember",
                    roles: ["owner"],
                    "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${recipientEmail}')`
                }
            ]
        };

        const chatRes = await axios.post('https://graph.microsoft.com/v1.0/chats', chatPayload, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        const chatId = chatRes.data.id;
        console.log(`Teams 1:1 chat created/found with ID: ${chatId}`);

        // Step 2: Send a message to the chat
        const msgPayload = {
            body: {
                contentType: "html",
                content: messageHtml
            }
        };

        await axios.post(`https://graph.microsoft.com/v1.0/chats/${chatId}/messages`, msgPayload, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`Successfully sent Teams chat notification to ${recipientEmail}`);
        return true;
    } catch (err) {
        console.warn(`Failed to send Teams notification to ${recipientEmail}:`, err.response ? JSON.stringify(err.response.data) : err.message);
        return false;
    }
}

app.post('/api/schedule', async (req, res) => {
    const { panelistEmail, candidateEmail, subject, startTime, endTime } = req.body;

    if (!panelistEmail || !candidateEmail || !subject || !startTime || !endTime) {
        return res.status(400).json({ error: "Missing required scheduling fields." });
    }

    // Parse panelistEmail as a comma-separated list
    const panelists = panelistEmail.split(',').map(e => e.trim()).filter(Boolean);
    if (panelists.length === 0) {
        return res.status(400).json({ error: "At least one valid panelist email must be provided." });
    }

    const primaryPanelist = panelists[0];

    // Format times to YYYY-MM-DDTHH:MM:SS (Graph API requires seconds)
    let formattedStart = startTime;
    if (formattedStart.includes('T') && formattedStart.split(':').length === 2) {
        formattedStart += ':00';
    }
    let formattedEnd = endTime;
    if (formattedEnd.includes('T') && formattedEnd.split(':').length === 2) {
        formattedEnd += ':00';
    }

    try {
        console.log(`Fetching access token for calendar block...`);
        const token = await getGraphAccessToken();

        const defaultOrganizer = process.env.DEFAULT_PANELIST_EMAIL;

        // STRATEGY: Always schedule via the central organizer (DEFAULT_PANELIST_EMAIL).
        // This ensures ALL panelists receive a real meeting INVITATION from Exchange,
        // which automatically triggers a Teams Activity notification for each panelist.
        // If no DEFAULT_PANELIST_EMAIL is configured, fall back to the primary panelist.
        const organizerEmail = defaultOrganizer || primaryPanelist;

        console.log(`Using central organizer: ${organizerEmail} to ensure Teams Activity notifications are sent to all panelists.`);

        // All panelists + candidate are added as REQUIRED ATTENDEES.
        // This is the key change: even the primary panelist is an attendee (not the organizer),
        // so they receive an invitation and get a Teams Activity notification.
        const attendeesList = [
            {
                emailAddress: { address: candidateEmail, name: "Candidate" },
                type: "required"
            },
            ...panelists.map(email => ({
                emailAddress: { address: email, name: "Interviewer" },
                type: "required"
            }))
        ];


        let response;

        let onlineMeetingId = null;
        let joinUrl = null;
        let calendarEventId = null;

        // ============================================================
        // STEP 1: Create Teams Online Meeting with auto-recording ON
        // Creating via /onlineMeetings first gives us the real meeting ID
        // immediately, and lets us set recordAutomatically + allowTranscription.
        // ============================================================
        try {
            console.log(`Creating Teams online meeting via Graph API for organizer: ${organizerEmail}...`);
            const onlineMeetingPayload = {
                subject: subject,
                startDateTime: formattedStart,
                endDateTime: formattedEnd,
                recordAutomatically: true,
                allowTranscription: true,
                participants: {
                    organizer: {
                        upn: organizerEmail,
                        role: "presenter"
                    },
                    attendees: [
                        { upn: candidateEmail, role: "attendee" },
                        ...panelists.map(email => ({ upn: email, role: "presenter" }))
                    ]
                }
            };

            const omRes = await axios.post(
                `https://graph.microsoft.com/v1.0/users/${organizerEmail}/onlineMeetings`,
                onlineMeetingPayload,
                { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
            );

            onlineMeetingId = omRes.data.id;
            joinUrl = omRes.data.joinWebUrl || omRes.data.joinUrl;
            console.log(`✅ Teams online meeting created! ID: ${onlineMeetingId}`);
            console.log(`✅ Auto-recording: ${omRes.data.recordAutomatically}, Auto-transcription: ${omRes.data.allowTranscription}`);
        } catch (omErr) {
            console.warn(`Could not create standalone onlineMeeting (will fall back to calendar event):`, omErr.response ? JSON.stringify(omErr.response.data) : omErr.message);
        }

        // ============================================================
        // STEP 2: Create the Calendar Event (sends invitations to attendees)
        // If we got a joinUrl from Step 1, embed it. Otherwise let Graph
        // generate a new Teams link via isOnlineMeeting: true.
        // ============================================================
        const eventBody = `
        <div style="font-family: Segoe UI, sans-serif; padding: 20px;">
            <h2 style="color: #6264A7;">📅 Interview Scheduled</h2>
            <p>You have been invited to a Microsoft Teams interview.</p>
            <table style="border-collapse: collapse; width: 100%;">
                <tr><td style="padding: 6px; font-weight: bold; color: #555;">Subject:</td><td style="padding: 6px;">${subject}</td></tr>
                <tr><td style="padding: 6px; font-weight: bold; color: #555;">Candidate:</td><td style="padding: 6px;">${candidateEmail}</td></tr>
                <tr><td style="padding: 6px; font-weight: bold; color: #555;">Interviewer(s):</td><td style="padding: 6px;">${panelists.join(', ')}</td></tr>
            </table>
            <p style="margin-top: 16px;">⚠️ <strong>Recording and transcription will start automatically</strong> when the meeting begins.</p>
            <p style="color: #888; font-size: 12px;">Scheduled by Elasticrew ATS</p>
        </div>`;

        const eventPayload = {
            subject: subject,
            body: { contentType: "HTML", content: eventBody },
            start: { dateTime: formattedStart, timeZone: "India Standard Time" },
            end: { dateTime: formattedEnd, timeZone: "India Standard Time" },
            location: { displayName: "Microsoft Teams Meeting" },
            attendees: attendeesList,
            isOnlineMeeting: true,
            onlineMeetingProvider: "teamsForBusiness"
        };

        try {
            response = await axios.post(
                `https://graph.microsoft.com/v1.0/users/${organizerEmail}/events`,
                eventPayload,
                { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
            );
            calendarEventId = response.data.id;
            // If Step 1 failed, fall back to the calendar event's join URL
            if (!joinUrl) {
                joinUrl = response.data.onlineMeeting?.joinUrl || response.data.onlineMeetingInfo?.joinUrl;
            }
            // If Step 1 failed, fall back to a placeholder meeting ID
            if (!onlineMeetingId) {
                onlineMeetingId = 'meet-' + calendarEventId;
                console.log(`Using fallback meeting ID from calendar event: ${onlineMeetingId}`);
            }
            console.log(`✅ Calendar event created (${calendarEventId}). All ${panelists.length} panelist(s) will receive Teams Activity notifications.`);
        } catch (apiErr) {
            console.error(`Failed to create calendar event via organizer ${organizerEmail}:`, apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }

        // ============================================================
        // STEP 3: If we have the real onlineMeetingId from Step 1,
        // PATCH it to confirm auto-recording & transcription settings.
        // ============================================================
        if (onlineMeetingId && !onlineMeetingId.startsWith('meet-')) {
            try {
                console.log(`Confirming auto-recording/transcription via PATCH on onlineMeeting ${onlineMeetingId}...`);
                await axios.patch(
                    `https://graph.microsoft.com/v1.0/users/${organizerEmail}/onlineMeetings/${onlineMeetingId}`,
                    { recordAutomatically: true, allowTranscription: true },
                    { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
                );
                console.log(`✅ Auto-recording and auto-transcription confirmed ON for meeting ${onlineMeetingId}.`);
            } catch (patchErr) {
                console.warn(`PATCH onlineMeeting settings warning (non-fatal):`, patchErr.response ? JSON.stringify(patchErr.response.data) : patchErr.message);
            }
        }

        const newMeeting = {
            id: onlineMeetingId,
            eventId: calendarEventId || response.data.id,
            subject: subject,
            panelistEmail: panelistEmail,
            candidateEmail: candidateEmail,
            organizerEmail: organizerEmail,
            startTime: formattedStart,
            endTime: formattedEnd,
            joinUrl: joinUrl,
            status: "Scheduled",
            createdAt: new Date().toISOString(),
            isSimulated: false,
            logs: [{
                time: new Date().toISOString(),
                status: "Scheduled",
                message: `Meeting created by ${organizerEmail}. Auto-recording & transcription: ON. Invitations sent to ${panelists.length} panelist(s).`
            }]
        };

        // AUTO-ACCEPT: Accept invitations on behalf of all panelists so their calendars are blocked.
        // sendResponse: false keeps invitation visible in Teams Activity feed.
        try {
            const iCalUId = response.data.iCalUId;
            console.log(`Auto-accepting invites for all panelists: ${panelists.join(', ')} ...`);
            // Wait for Exchange to sync invites to attendee mailboxes
            await new Promise(resolve => setTimeout(resolve, 4000));

            for (const email of panelists) {
                try {
                    const findUrl = `https://graph.microsoft.com/v1.0/users/${email}/events?$filter=iCalUId eq '${iCalUId}'`;
                    const findRes = await axios.get(findUrl, { headers: { 'Authorization': `Bearer ${token}` } });

                    if (findRes.data.value && findRes.data.value.length > 0) {
                        const panelistEventId = findRes.data.value[0].id;
                        await axios.post(
                            `https://graph.microsoft.com/v1.0/users/${email}/events/${panelistEventId}/accept`,
                            { sendResponse: false },
                            { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
                        );
                        console.log(`✅ Calendar blocked for panelist ${email}.`);
                        newMeeting.logs.push({
                            time: new Date().toISOString(),
                            status: "Calendar Blocked",
                            message: `Calendar blocked for ${email}. Teams Activity notification preserved.`
                        });
                    } else {
                        console.warn(`Could not find invite for panelist ${email} — may not be in the same tenant.`);
                        newMeeting.logs.push({
                            time: new Date().toISOString(),
                            status: "Calendar Block Skipped",
                            message: `No invite found for ${email} (may be external/different tenant).`
                        });
                    }
                } catch (singleAcceptErr) {
                    console.warn(`Auto-accept failed for ${email}:`, singleAcceptErr.response ? singleAcceptErr.response.data : singleAcceptErr.message);
                }
            }
        } catch (acceptErr) {
            console.warn(`Auto-accept process failed:`, acceptErr.message);
        }

        // Send Email Notifications
        try {
            const senderEmail = defaultOrganizer || organizerEmail;
            const startTimeFormatted = formatEmailDate(startTime);
            const endTimeFormatted = formatEmailDate(endTime);

            // A. Panelist Email Content
            const panelistHtml = `
                <div style="font-family: 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 40px; border-radius: 12px; max-width: 600px; margin: 0 auto; border: 1px solid #1e293b; box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5);">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <span style="font-family: 'Outfit', sans-serif; font-size: 24px; font-weight: 800; color: #8B5CF6; display: inline-block;">SyncTeams Portal</span>
                        <div style="font-size: 14px; color: #94a3b8; margin-top: 5px;">Interview Notification</div>
                    </div>
                    
                    <h2 style="font-size: 20px; font-weight: 600; color: #ffffff; border-bottom: 1px solid #334155; padding-bottom: 12px; margin-bottom: 20px;">Interview Confirmed & Calendar Blocked</h2>
                    
                    <p style="font-size: 15px; color: #cbd5e1; line-height: 1.6;">Hello,</p>
                    <p style="font-size: 15px; color: #cbd5e1; line-height: 1.6;">An interview has been scheduled and your calendar has been successfully blocked.</p>
                    
                    <div style="background-color: rgba(30, 41, 59, 0.5); border: 1px solid #334155; padding: 20px; border-radius: 8px; margin: 25px 0;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 6px 0; font-size: 14px; color: #94a3b8; width: 120px; font-weight: 500;">Subject:</td>
                                <td style="padding: 6px 0; font-size: 14px; color: #f1f5f9; font-weight: 600;">${subject}</td>
                            </tr>
                            <tr>
                                <td style="padding: 6px 0; font-size: 14px; color: #94a3b8; font-weight: 500;">Candidate:</td>
                                <td style="padding: 6px 0; font-size: 14px; color: #3b82f6; font-weight: 600;"><a href="mailto:${candidateEmail}" style="color: #3b82f6; text-decoration: none;">${candidateEmail}</a></td>
                            </tr>
                            <tr>
                                <td style="padding: 6px 0; font-size: 14px; color: #94a3b8; font-weight: 500;">Panelists:</td>
                                <td style="padding: 6px 0; font-size: 14px; color: #f1f5f9;">${panelists.join(', ')}</td>
                            </tr>
                            <tr>
                                <td style="padding: 6px 0; font-size: 14px; color: #94a3b8; font-weight: 500;">Start Time:</td>
                                <td style="padding: 6px 0; font-size: 14px; color: #f1f5f9;">${startTimeFormatted} (IST)</td>
                            </tr>
                            <tr>
                                <td style="padding: 6px 0; font-size: 14px; color: #94a3b8; font-weight: 500;">End Time:</td>
                                <td style="padding: 6px 0; font-size: 14px; color: #f1f5f9;">${endTimeFormatted} (IST)</td>
                            </tr>
                        </table>
                    </div>
                    
                    <p style="font-size: 14px; color: #94a3b8; line-height: 1.5; margin-bottom: 25px;">
                        Note: Recording and transcription have been configured to start automatically once you join the Teams call. After completion, the recording and transcript will be synced to the SyncTeams Portal.
                    </p>
                    
                    <div style="text-align: center; margin-top: 30px; margin-bottom: 10px;">
                        <a href="${joinUrl}" style="background: linear-gradient(135deg, #8B5CF6 0%, #3B82F6 100%); color: #ffffff; text-decoration: none; padding: 12px 30px; font-size: 15px; font-weight: 600; border-radius: 6px; display: inline-block;">Join Teams Interview</a>
                    </div>
                </div>
            `;

            // B. Candidate Email Content
            const candidateHtml = `
                <div style="font-family: 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 40px; border-radius: 12px; max-width: 600px; margin: 0 auto; border: 1px solid #1e293b; box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5);">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <span style="font-family: 'Outfit', sans-serif; font-size: 24px; font-weight: 800; color: #3B82F6; display: inline-block;">SyncTeams Portal</span>
                        <div style="font-size: 14px; color: #94a3b8; margin-top: 5px;">Interview Invitation</div>
                    </div>
                    
                    <h2 style="font-size: 20px; font-weight: 600; color: #ffffff; border-bottom: 1px solid #334155; padding-bottom: 12px; margin-bottom: 20px;">Your Interview has been Scheduled</h2>
                    
                    <p style="font-size: 15px; color: #cbd5e1; line-height: 1.6;">Hello,</p>
                    <p style="font-size: 15px; color: #cbd5e1; line-height: 1.6;">You have been invited to a Microsoft Teams interview. Please find the details below:</p>
                    
                    <div style="background-color: rgba(30, 41, 59, 0.5); border: 1px solid #334155; padding: 20px; border-radius: 8px; margin: 25px 0;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 6px 0; font-size: 14px; color: #94a3b8; width: 120px; font-weight: 500;">Position/Subject:</td>
                                <td style="padding: 6px 0; font-size: 14px; color: #f1f5f9; font-weight: 600;">${subject}</td>
                            </tr>
                            <tr>
                                <td style="padding: 6px 0; font-size: 14px; color: #94a3b8; font-weight: 500;">Interviewer(s):</td>
                                <td style="padding: 6px 0; font-size: 14px; color: #f1f5f9;">${panelists.join(', ')}</td>
                            </tr>
                            <tr>
                                <td style="padding: 6px 0; font-size: 14px; color: #94a3b8; font-weight: 500;">Start Time:</td>
                                <td style="padding: 6px 0; font-size: 14px; color: #f1f5f9;">${startTimeFormatted} (IST)</td>
                            </tr>
                            <tr>
                                <td style="padding: 6px 0; font-size: 14px; color: #94a3b8; font-weight: 500;">End Time:</td>
                                <td style="padding: 6px 0; font-size: 14px; color: #f1f5f9;">${endTimeFormatted} (IST)</td>
                            </tr>
                        </table>
                    </div>
                    
                    <p style="font-size: 14px; color: #94a3b8; line-height: 1.5; margin-bottom: 25px;">
                        Please make sure to join the meeting on time using the button below.
                    </p>
                    
                    <div style="text-align: center; margin-top: 30px; margin-bottom: 10px;">
                        <a href="${joinUrl}" style="background: linear-gradient(135deg, #8B5CF6 0%, #3B82F6 100%); color: #ffffff; text-decoration: none; padding: 12px 30px; font-size: 15px; font-weight: 600; border-radius: 6px; display: inline-block;">Join Interview Meeting</a>
                    </div>
                </div>
            `;

            // Fire and forget email sends to all panelists and candidate
            for (const email of panelists) {
                sendGraphEmail(token, senderEmail, email, `Interview Scheduled: ${subject}`, panelistHtml);
            }
            sendGraphEmail(token, senderEmail, candidateEmail, `Interview Scheduled: ${subject}`, candidateHtml);

            newMeeting.logs.push({
                time: new Date().toISOString(),
                status: "Notifications Sent",
                message: `Email notifications dispatched from ${senderEmail} to Panelists (${panelists.join(', ')}) and Candidate (${candidateEmail}).`
            });

            // ---- Teams Activity Notifications ----
            // Build a rich Teams chat message (HTML) for panelists
            const teamsMessageHtml = `
<b>🗓️ Interview Scheduled — ${subject}</b><br><br>
<table>
  <tr><td><b>Candidate:</b></td><td>${candidateEmail}</td></tr>
  <tr><td><b>Panelist(s):</b></td><td>${panelists.join(', ')}</td></tr>
  <tr><td><b>Start:</b></td><td>${startTimeFormatted} (IST)</td></tr>
  <tr><td><b>End:</b></td><td>${endTimeFormatted} (IST)</td></tr>
</table><br>
Your calendar has been blocked automatically. Click below to join the meeting when the time comes.<br><br>
<a href="${joinUrl}"><b>▶ Join Teams Interview</b></a>
            `.trim();

            // Send Teams 1:1 message to each panelist (fire and forget)
            for (const email of panelists) {
                // Skip if sender and recipient are the same — Teams cannot 1:1 message itself
                if (email.toLowerCase() !== senderEmail.toLowerCase()) {
                    sendTeamsNotification(token, senderEmail, email, teamsMessageHtml);
                }
            }

            // Build a rich Teams chat message (HTML) for the candidate
            const candidateTeamsMessageHtml = `
<b>🗓️ Interview Scheduled — ${subject}</b><br><br>
<table>
  <tr><td><b>Interviewer(s):</b></td><td>${panelists.join(', ')}</td></tr>
  <tr><td><b>Start:</b></td><td>${startTimeFormatted} (IST)</td></tr>
  <tr><td><b>End:</b></td><td>${endTimeFormatted} (IST)</td></tr>
</table><br>
Please click below to join the meeting when the time comes.<br><br>
<a href="${joinUrl}"><b>▶ Join Teams Interview</b></a>
            `.trim();

            // Send Teams 1:1 message to the candidate
            if (candidateEmail.toLowerCase() !== senderEmail.toLowerCase()) {
                sendTeamsNotification(token, senderEmail, candidateEmail, candidateTeamsMessageHtml);
            }

            newMeeting.logs.push({
                time: new Date().toISOString(),
                status: "Teams Notification Sent",
                message: `Teams Activity notifications dispatched to Panelists (${panelists.filter(e => e.toLowerCase() !== senderEmail.toLowerCase()).join(', ')}) and Candidate (${candidateEmail}).`
            });
        } catch (emailErr) {
            console.warn("Failed during email/Teams notification dispatch:", emailErr.message);
        }

        await insertMeeting(newMeeting);
        res.status(200).json(newMeeting);
    } catch (error) {
        console.error("Graph API Calendar Block failed:", error.response ? error.response.data : error.message);
        res.status(500).json({
            error: "Failed to schedule Teams meeting",
            details: error.response ? error.response.data : error.message
        });
    }
});

// ==========================================
// 3b. ENDPOINT: LIST PAST RECORDINGS FROM ONEDRIVE
// ==========================================
app.get('/api/past-recordings', async (req, res) => {
    try {
        const organizerEmail = req.query.email || process.env.DEFAULT_PANELIST_EMAIL;
        if (!organizerEmail) {
            return res.status(400).json({ error: "No panelist email provided and DEFAULT_PANELIST_EMAIL is not configured." });
        }

        console.log(`Listing past recordings from OneDrive for email: ${organizerEmail}`);
        const token = await getGraphAccessToken();
        const allRecordings = [];

        // Primary: list from OneDrive/Recordings folder (Teams saves here)
        try {
            const driveRes = await axios.get(
                `https://graph.microsoft.com/v1.0/users/${organizerEmail}/drive/root:/Recordings:/children?$orderby=lastModifiedDateTime desc&$top=50`,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            if (driveRes.data.value) {
                for (const item of driveRes.data.value) {
                    if (item.file && (item.name.endsWith('.mp4') || item.name.endsWith('.mp3'))) {
                        allRecordings.push({
                            id: item.id,
                            name: item.name,
                            size: item.size,
                            lastModified: item.lastModifiedDateTime,
                            webUrl: item.webUrl,
                            source: 'OneDrive/Recordings'
                        });
                    }
                }
            }
        } catch (driveErr) {
            console.warn(`Could not list /Recordings folder for ${organizerEmail}:`, driveErr.response?.data?.error?.message || driveErr.message);
        }

        // Fallback: search entire OneDrive for .mp4 files
        try {
            const searchRes = await axios.get(
                `https://graph.microsoft.com/v1.0/users/${organizerEmail}/drive/search(q='.mp4')?$orderby=lastModifiedDateTime desc&$top=30`,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            if (searchRes.data.value) {
                for (const item of searchRes.data.value) {
                    if (!allRecordings.find(r => r.id === item.id) && item.file && item.name.endsWith('.mp4')) {
                        allRecordings.push({
                            id: item.id,
                            name: item.name,
                            size: item.size,
                            lastModified: item.lastModifiedDateTime,
                            webUrl: item.webUrl,
                            source: 'OneDrive (Search)'
                        });
                    }
                }
            }
        } catch (searchErr) {
            console.warn(`Drive search fallback failed for ${organizerEmail}:`, searchErr.response?.data?.error?.message || searchErr.message);
        }

        console.log(`Found ${allRecordings.length} past recordings for ${organizerEmail}`);
        res.json({ organizer: organizerEmail, recordings: allRecordings });

    } catch (error) {
        console.error("Failed to list past recordings:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to list past recordings", details: error.response ? error.response.data : error.message });
    }
});

// ==========================================
// 3c. ENDPOINT: GET DIRECT PLAYBACK URL
// Fetches pre-signed downloadUrl directly from OneDrive for streaming
// ==========================================
app.post('/api/fetch-past-recording', async (req, res) => {
    const { fileId, fileName, email } = req.body;
    if (!fileId || !fileName) return res.status(400).json({ error: "fileId and fileName are required." });

    const organizerEmail = email || process.env.DEFAULT_PANELIST_EMAIL;
    if (!organizerEmail) {
        return res.status(400).json({ error: "No panelist email provided." });
    }

    try {
        const token = await getGraphAccessToken();
        console.log(`Generating pre-signed URL for past recording: ${fileName} from ${organizerEmail}'s OneDrive...`);

        const metaRes = await axios.get(
            `https://graph.microsoft.com/v1.0/users/${organizerEmail}/drive/items/${fileId}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );

        const downloadUrl = metaRes.data['@microsoft.graph.downloadUrl'];
        if (!downloadUrl) return res.status(404).json({ error: "Could not get streaming download URL for this file." });

        console.log(`✅ Direct pre-signed stream URL generated successfully.`);
        res.json({ success: true, downloadUrl, fileName });

    } catch (error) {
        console.error("Failed to generate stream URL:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to generate play URL", details: error.response ? error.response.data : error.message });
    }
});

// ==========================================
// 4. ENDPOINT: REGISTER GRAPH WEBHOOK SUBSCRIPTIONS
// ==========================================
app.post('/api/subscribe', async (req, res) => {
    const webhookBase = process.env.WEBHOOK_BASE_URL;
    if (!webhookBase) {
        return res.status(400).json({ error: "WEBHOOK_BASE_URL is not set. Please set it in Settings." });
    }

    try {
        const token = await getGraphAccessToken();
        const subUrl = 'https://graph.microsoft.com/v1.0/subscriptions';
        const expirationDateTime = new Date(Date.now() + 60000 * 50).toISOString();

        // 1. Subscribe to Transcripts
        const transcriptPayload = {
            changeType: "created",
            notificationUrl: `${webhookBase}/teams-webhook`,
            resource: "communications/onlineMeetings/getAllTranscripts",
            expirationDateTime: expirationDateTime,
            clientState: "TeamsIntegrationSyncSecretState"
        };

        console.log("Registering Transcript Webhook...");
        const transRes = await axios.post(subUrl, transcriptPayload, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });

        // 2. Subscribe to Recordings
        const recordingPayload = {
            changeType: "created",
            notificationUrl: `${webhookBase}/teams-webhook`,
            resource: "communications/onlineMeetings/getAllRecordings",
            expirationDateTime: expirationDateTime,
            clientState: "TeamsIntegrationSyncSecretState"
        };

        console.log("Registering Recording Webhook...");
        const recRes = await axios.post(subUrl, recordingPayload, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });

        res.json({
            success: true,
            transcriptionSubscriptionId: transRes.data.id,
            recordingSubscriptionId: recRes.data.id,
            expiresAt: expirationDateTime
        });
    } catch (error) {
        console.error("Subscription registration failed:", error.response ? error.response.data : error.message);
        res.status(500).json({
            error: "Subscription failed",
            details: error.response ? error.response.data : error.message
        });
    }
});

// ==========================================
// 5. TEAMS WEBHOOK RECEIVER
// ==========================================
app.post('/teams-webhook', async (req, res) => {
    if (req.query.validationToken) {
        console.log("Received Webhook validation request. Token:", req.query.validationToken);
        return res.status(200).send(req.query.validationToken);
    }

    console.log("Received a Webhook notification from Microsoft Graph!");

    const notification = req.body.value?.[0];
    if (!notification) {
        return res.status(200).send("No notification data");
    }

    const clientState = notification.clientState;
    if (clientState !== "TeamsIntegrationSyncSecretState" && clientState !== "TestingState123") {
        console.warn("Unauthorized webhook payload. ClientState mismatch:", clientState);
        return res.status(403).send("Forbidden");
    }
    const resourceData = notification.resourceData;
    
    // Extract real Teams meetingId from resource URI
    // e.g. communications/onlineMeetings('MSpkM2...')/transcripts('...')
    const resource = notification.resource || resourceData?.['@odata.id'] || '';
    const meetingIdMatch = resource.match(/onlineMeetings\('([^']+)'\)/);
    const meetingId = meetingIdMatch ? meetingIdMatch[1] : (resourceData?.meetingId || resourceData?.id);

    if (!meetingId) {
        console.warn("Could not extract meetingId from webhook notification resource:", resource);
        return res.status(202).send("Missing meeting ID, cannot process");
    }

    let organizerId = resourceData?.organizerId;
    const meetings = await getMeetings();
    let meeting = meetings.find(m => m.id === meetingId);
    let resolvedOrganizer = organizerId;

    if (!resolvedOrganizer) {
        // Smart UPN/Email resolution for the organizer
        if (meeting && (meeting.organizerEmail || meeting.panelistEmail)) {
            resolvedOrganizer = meeting.organizerEmail || meeting.panelistEmail;
            console.log(`Resolved organizer from database: ${resolvedOrganizer} for meeting ID: ${meetingId}`);
        } else {
            // Collect all possible organizers in our tenant (default email and any scheduled organizers/panelists)
            const dbOrganizers = meetings.map(m => m.organizerEmail || m.panelistEmail).filter(Boolean);
            
            // Also parse Oids from scheduled meetings in the database
            const dbOids = [];
            const scheduledMeetings = meetings.filter(m => m.status === 'Scheduled');
            for (const sm of scheduledMeetings) {
                if (sm.joinUrl) {
                    const oidMatch = sm.joinUrl.match(/Oid%22%3a%22([^%"]+)/i) || sm.joinUrl.match(/"Oid"\s*:\s*"([^"]+)"/i) || sm.joinUrl.match(/Oid=([^&]+)/i);
                    if (oidMatch) {
                        dbOids.push(oidMatch[1]);
                    }
                }
            }

            const candidates = [...new Set([
                process.env.DEFAULT_PANELIST_EMAIL,
                ...dbOids,
                ...dbOrganizers,
                'nadeem.aehmad@kadellabs.com',
                'mahima.dangi@kadellabs.com',
                'achyut.pancholi@kadellabs.com'
            ])].filter(Boolean);

            console.log(`Organizer UPN/Oid not present in webhook. Scanning candidate organizers to locate meeting: ${candidates.join(', ')}`);
            const token = await getGraphAccessToken();
            
            for (const org of candidates) {
                try {
                    const testUrl = `https://graph.microsoft.com/v1.0/users/${org}/onlineMeetings/${meetingId}`;
                    const onlineMeetRes = await axios.get(testUrl, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    
                    const joinWebUrl = onlineMeetRes.data?.joinWebUrl;
                    if (joinWebUrl) {
                        resolvedOrganizer = org;
                        console.log(`✅ Webhook resolved organizer: ${resolvedOrganizer} for meeting ID: ${meetingId}`);
                        
                        // Check if we can find a matching scheduled meeting with a fallback ID in the database
                        const matchedMeeting = meetings.find(m => m.joinUrl && m.joinUrl.toLowerCase() === joinWebUrl.toLowerCase());
                        if (matchedMeeting) {
                            const oldId = matchedMeeting.id;
                            console.log(`Found matching scheduled meeting! Previous ID: ${oldId}. Mapping to real Teams onlineMeetingId: ${meetingId}`);
                            
                            await updateMeetingIdInDb(oldId, meetingId);
                            matchedMeeting.id = meetingId;
                            matchedMeeting.logs.push({
                                time: new Date().toISOString(),
                                status: "ID Resolved",
                                message: `Mapped fallback ID ${oldId} to real Teams onlineMeetingId ${meetingId} via webhook resolution.`
                            });
                            await updateMeeting(meetingId, { logs: matchedMeeting.logs });
                            meeting = matchedMeeting;
                        }
                        break;
                    }
                } catch (err) {
                    // Fail silently, try next candidate
                }
            }
        }
    }

    if (!resolvedOrganizer) {
        console.warn(`Could not resolve organizer for meeting ID: ${meetingId}. Cannot fetch artifacts.`);
        return res.status(202).send("Missing organizer, cannot process yet");
    }

    if (meeting) {
        meeting.status = "Webhook Notification Received";
        meeting.logs.push({
            time: new Date().toISOString(),
            status: "Webhook Notification Received",
            message: `Graph Webhook notified of completed meeting artifacts. Organizer UPN: ${resolvedOrganizer}`
        });
        
        await updateMeeting(meetingId, {
            status: meeting.status,
            logs: meeting.logs
        });

        console.log(`Starting fetch of assets for meeting ID: ${meetingId} via organizer: ${resolvedOrganizer}`);
        fetchArtifacts(resolvedOrganizer, meetingId).catch(err => {
            console.error(`Error in fetchArtifacts for meeting ${meetingId}:`, err);
        });
    } else {
        console.log(`Webhook received for meeting ID ${meetingId} but it's not tracked in our database.`);
    }

    res.status(202).send("Notification accepted");
});

// ==========================================
// 6. FUNCTION: DOWNLOAD METADATA AND FILES
// ==========================================
async function fetchArtifacts(organizerId, meetingId) {
    const meetings = await getMeetings();
    const meeting = meetings.find(m => m.id === meetingId);
    if (!meeting) return;

    meeting.status = "Fetching Assets";
    meeting.logs.push({
        time: new Date().toISOString(),
        status: "Fetching Assets",
        message: "Fetching transcript and video recording streams from Microsoft Graph..."
    });
    await updateMeeting(meetingId, {
        status: meeting.status,
        logs: meeting.logs
    });

    try {
        const token = await getGraphAccessToken();

        // Smart organizer resolution:
        // 1. Use stored organizerEmail from DB (most reliable — set when meeting was scheduled)
        // 2. Fallback to webhook organizerId GUID
        // 3. Last resort: DEFAULT_PANELIST_EMAIL from env
        const candidateOrganizers = [
            meeting.organizerEmail,
            process.env.DEFAULT_PANELIST_EMAIL,
            organizerId  // GUID from webhook — works if it matches a user in the tenant
        ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i); // deduplicate

        console.log(`Attempting to fetch artifacts for meeting ${meetingId}. Will try organizers: ${candidateOrganizers.join(', ')}`);

        let baseUrl = null;
        let resolvedOrganizer = null;

        // Find the first organizer that can access this meeting
        for (const org of candidateOrganizers) {
            try {
                const testUrl = `https://graph.microsoft.com/v1.0/users/${org}/onlineMeetings/${meetingId}`;
                await axios.get(testUrl, { headers: { 'Authorization': `Bearer ${token}` } });
                baseUrl = testUrl;
                resolvedOrganizer = org;
                console.log(`✅ Successfully accessed meeting via organizer: ${resolvedOrganizer}`);
                break;
            } catch (testErr) {
                console.warn(`Organizer ${org} cannot access meeting ${meetingId}: ${testErr.response?.status || testErr.message}`);
            }
        }

        if (!baseUrl) {
            throw new Error(`None of the candidate organizers [${candidateOrganizers.join(', ')}] could access meeting ${meetingId}.`);
        }

        const meetingBaseUrl = `https://graph.microsoft.com/v1.0/users/${resolvedOrganizer}/onlineMeetings/${meetingId}`;



        // ---- A. Fetch Transcript ----
        console.log(`Listing transcripts for meeting: ${meetingId}`);
        const transcriptMeta = await axios.get(`${meetingBaseUrl}/transcripts`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        let transcriptSaved = false;
        let downloadedTranscriptText = null;
        let downloadedTranscriptPath = null;

        if (transcriptMeta.data.value && transcriptMeta.data.value.length > 0) {
            const transcriptId = transcriptMeta.data.value[0].id;
            console.log(`Downloading transcript: ${transcriptId}`);
            
            const contentUrl = `${meetingBaseUrl}/transcripts/${transcriptId}/content?format=text/vtt`;
            const contentResponse = await axios.get(contentUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            // Save raw VTT locally
            const vttFileName = `transcript_${meetingId}.vtt`;
            const vttPath = path.join(downloadsDir, vttFileName);
            fs.writeFileSync(vttPath, contentResponse.data);

            downloadedTranscriptText = contentResponse.data;
            downloadedTranscriptPath = `/downloads/${vttFileName}`;
            transcriptSaved = true;

            const mLogs = [...meeting.logs, {
                time: new Date().toISOString(),
                status: "Transcript Fetched",
                message: "WebVTT transcript downloaded successfully."
            }];
            await updateMeeting(meetingId, {
                transcriptText: downloadedTranscriptText,
                transcriptPath: downloadedTranscriptPath,
                logs: mLogs
            });
            meeting.logs = mLogs; // Sync logs locally in function
        } else {
            console.log("No transcripts available for this meeting yet.");
            const mLogs = [...meeting.logs, {
                time: new Date().toISOString(),
                status: "Fetch Warning",
                message: "No transcript found. Ensure Recording & Transcription was started during the Teams meeting."
            }];
            await updateMeeting(meetingId, { logs: mLogs });
            meeting.logs = mLogs;
        }

        // ---- B. Fetch Recording ----
        console.log(`Listing recordings for meeting: ${meetingId}`);
        const recordingMeta = await axios.get(`${meetingBaseUrl}/recordings`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        let recordingSaved = false;
        let downloadedRecordingPath = null;

        if (recordingMeta.data.value && recordingMeta.data.value.length > 0) {
            const recordingId = recordingMeta.data.value[0].id;
            console.log(`Downloading recording binary stream: ${recordingId}`);
            
            const videoDownloadUrl = `${meetingBaseUrl}/recordings/${recordingId}/content`;
            const videoFileName = `recording_${meetingId}.mp4`;
            const videoPath = path.join(downloadsDir, videoFileName);

            const videoStreamResponse = await axios({
                method: 'get',
                url: videoDownloadUrl,
                headers: { 'Authorization': `Bearer ${token}` },
                responseType: 'stream'
            });

            const writer = fs.createWriteStream(videoPath);
            videoStreamResponse.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            downloadedRecordingPath = `/downloads/${videoFileName}`;
            recordingSaved = true;

            const mLogs = [...meeting.logs, {
                time: new Date().toISOString(),
                status: "Recording Fetched",
                message: "Meeting MP4 recording downloaded and stored locally."
            }];
            await updateMeeting(meetingId, {
                recordingPath: downloadedRecordingPath,
                logs: mLogs
            });
            meeting.logs = mLogs;
        } else {
            console.log("No recordings available for this meeting yet.");
            const mLogs = [...meeting.logs, {
                time: new Date().toISOString(),
                status: "Fetch Warning",
                message: "No recording found. Ensure Recording & Transcription was started during the Teams meeting."
            }];
            await updateMeeting(meetingId, { logs: mLogs });
            meeting.logs = mLogs;
        }

        // Update overall status
        let finalStatus = "No Assets Found";
        if (transcriptSaved || recordingSaved) {
            finalStatus = "Completed";
        }
        
        const finalLogs = [...meeting.logs, {
            time: new Date().toISOString(),
            status: finalStatus,
            message: finalStatus === "Completed" ? "Asset sync operation finished successfully." : "Sync finished but no assets found on Microsoft Graph."
        }];

        await updateMeeting(meetingId, {
            status: finalStatus,
            logs: finalLogs
        });

    } catch (error) {
        console.error(`Failed to fetch artifacts for meeting ${meetingId}:`, error.response ? error.response.data : error.message);
        
        const mLogs = [...meeting.logs, {
            time: new Date().toISOString(),
            status: "Fetch Failed",
            message: `Retrieval error: ${error.response ? JSON.stringify(error.response.data) : error.message}`
        }];
        await updateMeeting(meetingId, {
            status: "Fetch Failed",
            logs: mLogs
        });
    }
}

// ==========================================
// 7. SIMULATED TESTING / DEMO WORKFLOW ENDPOINTS
// ==========================================

// Create a simulated meeting
app.post('/api/simulate/schedule', async (req, res) => {
    const { panelistEmail, candidateEmail, subject } = req.body;
    const meetingId = 'sim-' + Math.random().toString(36).substr(2, 9) + '-' + Math.random().toString(36).substr(2, 9);
    
    const startTime = new Date(Date.now() + 5 * 60000).toISOString().split('.')[0];
    const endTime = new Date(Date.now() + 15 * 60000).toISOString().split('.')[0];

    const simulatedMeeting = {
        id: meetingId,
        eventId: 'sim-event-' + Math.random().toString(36).substr(2, 5),
        subject: subject || "Simulated Tech Interview - Frontend Developer",
        panelistEmail: panelistEmail || "interviewer@company.org",
        candidateEmail: candidateEmail || "candidate@external.com",
        startTime: startTime,
        endTime: endTime,
        joinUrl: "https://teams.microsoft.com/l/meetup-join/mock-simulated-meeting-link",
        status: "Scheduled (Simulated)",
        createdAt: new Date().toISOString(),
        isSimulated: true,
        logs: [
            { time: new Date().toISOString(), status: "Scheduled", message: "Mock meeting created in local database." }
        ]
    };

    await insertMeeting(simulatedMeeting);
    res.json(simulatedMeeting);
});

// Trigger mock webhook callback to populate mock data
app.post('/api/simulate/webhook/:meetingId', async (req, res) => {
    const { meetingId } = req.params;
    const meetings = await getMeetings();
    const meeting = meetings.find(m => m.id === meetingId);

    if (!meeting) {
        return res.status(404).json({ error: "Simulated meeting not found." });
    }

    meeting.status = "Processing Webhook (Simulated)";
    meeting.logs.push({
        time: new Date().toISOString(),
        status: "Processing Webhook",
        message: "Simulating Graph Webhook POST notification."
    });
    
    await updateMeeting(meetingId, {
        status: meeting.status,
        logs: meeting.logs
    });

    // Run simulated download in a timeout to mimic API lag
    setTimeout(async () => {
        const m = await getMeetings();
        const meet = m.find(meet => meet.id === meetingId);
        if (!meet) return;

        meet.status = "Completed (Simulated)";
        meet.logs.push({
            time: new Date().toISOString(),
            status: "Simulated Downloads",
            message: "Simulating copying from Cloud Storage/Graph APIs."
        });

        const updates = {
            status: meet.status,
            logs: meet.logs,
            transcriptText: null,
            transcriptPath: null,
            recordingPath: null
        };

        try {
            const sampleVttPath = path.join(mockAssetsDir, 'sample.vtt');
            const destVttPath = path.join(downloadsDir, `transcript_${meetingId}.vtt`);
            if (fs.existsSync(sampleVttPath)) {
                fs.copyFileSync(sampleVttPath, destVttPath);
                updates.transcriptText = fs.readFileSync(destVttPath, 'utf8');
                updates.transcriptPath = `/downloads/transcript_${meetingId}.vtt`;
            }

            const sampleMp4Path = path.join(mockAssetsDir, 'sample.mp4');
            const destMp4Path = path.join(downloadsDir, `recording_${meetingId}.mp4`);
            if (fs.existsSync(sampleMp4Path)) {
                fs.copyFileSync(sampleMp4Path, destMp4Path);
                updates.recordingPath = `/downloads/recording_${meetingId}.mp4`;
            }

            updates.logs.push({
                time: new Date().toISOString(),
                status: "Assets Populated",
                message: "Mock transcript and recording loaded into playback room."
            });
        } catch (e) {
            console.error("Simulator copy error:", e);
        }

        await updateMeeting(meetingId, updates);
    }, 1500);

    res.json({ success: true, message: "Webhook simulation triggered successfully." });
});

// Get meetings list
app.get('/api/meetings', async (req, res) => {
    res.json(await getMeetings());
});

// Delete a meeting from DB
app.delete('/api/meetings/:id', async (req, res) => {
    const { id } = req.params;
    const meetings = await getMeetings();
    const item = meetings.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: "Meeting not found" });

    // Try deleting associated files
    try {
        if (item.transcriptPath) {
            const p = path.join(__dirname, item.transcriptPath);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        if (item.recordingPath) {
            const p = path.join(__dirname, item.recordingPath);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
    } catch (e) {
        console.error("Error deleting files:", e);
    }

    await deleteMeetingFromDb(id);
    res.json({ success: true });
});

// ==========================================
// AUTO-RENEW WEBHOOK SUBSCRIPTIONS (every 45 min)
// ==========================================
async function autoRenewWebhookSubscriptions() {
    const webhookBase = process.env.WEBHOOK_BASE_URL;
    if (!webhookBase) {
        console.log('[AutoRenew] WEBHOOK_BASE_URL not set — skipping subscription renewal.');
        return;
    }
    try {
        console.log('[AutoRenew] Renewing Microsoft Graph webhook subscriptions...');
        const token = await getGraphAccessToken();
        const subUrl = 'https://graph.microsoft.com/v1.0/subscriptions';
        const expirationDateTime = new Date(Date.now() + 60000 * 50).toISOString();

        // Step 1: List all existing subscriptions and delete them to avoid 'limit reached' errors
        try {
            const listRes = await axios.get(subUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const existing = listRes.data.value || [];
            console.log(`[AutoRenew] Found ${existing.length} existing subscription(s). Deleting...`);
            for (const sub of existing) {
                try {
                    await axios.delete(`${subUrl}/${sub.id}`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    console.log(`[AutoRenew] Deleted subscription: ${sub.id} (${sub.resource})`);
                } catch (delErr) {
                    console.warn(`[AutoRenew] Could not delete subscription ${sub.id}:`, delErr.response ? delErr.response.data : delErr.message);
                }
            }
        } catch (listErr) {
            console.warn('[AutoRenew] Could not list existing subscriptions:', listErr.response ? listErr.response.data : listErr.message);
        }

        // Step 2: Create fresh subscriptions
        const subscriptions = [
            {
                changeType: "created",
                notificationUrl: `${webhookBase}/teams-webhook`,
                resource: "communications/onlineMeetings/getAllTranscripts",
                expirationDateTime,
                clientState: "TeamsIntegrationSyncSecretState"
            },
            {
                changeType: "created",
                notificationUrl: `${webhookBase}/teams-webhook`,
                resource: "communications/onlineMeetings/getAllRecordings",
                expirationDateTime,
                clientState: "TeamsIntegrationSyncSecretState"
            }
        ];

        for (const payload of subscriptions) {
            await axios.post(subUrl, payload, {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
            });
            console.log(`[AutoRenew] ✅ Subscribed to: ${payload.resource}`);
        }
        console.log(`[AutoRenew] ✅ All webhook subscriptions renewed. Expires ~${expirationDateTime}. Next renewal in 45 min.`);
    } catch (err) {
        console.warn('[AutoRenew] ⚠️ Failed to renew webhook subscriptions:', err.response ? JSON.stringify(err.response.data) : err.message);
    }
}

// Renew subscriptions every 45 minutes (subscriptions last 50 min max)
setInterval(autoRenewWebhookSubscriptions, 45 * 60 * 1000);
// Also subscribe immediately 10 seconds after server starts (gives server time to fully initialize)
setTimeout(autoRenewWebhookSubscriptions, 10 * 1000);

// Start Server
app.listen(PORT, () => {
    console.log(`========================================================`);
    console.log(`Teams Sync Interview App listening at http://localhost:${PORT}`);
    console.log(`========================================================`);
});
