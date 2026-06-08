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

    // Create Table Schema on startup
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS teams_meetings (
            id VARCHAR(255) PRIMARY KEY,
            event_id VARCHAR(255),
            subject VARCHAR(255),
            panelist_email VARCHAR(255),
            candidate_email VARCHAR(255),
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
        .then(() => console.log("PostgreSQL schema table 'teams_meetings' verified/created successfully."))
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
                    id, event_id, subject, panelist_email, candidate_email, 
                    start_time, end_time, join_url, status, created_at, is_simulated, logs
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `;
            const values = [
                m.id, m.eventId, m.subject, m.panelistEmail, m.candidateEmail,
                new Date(m.startTime), new Date(m.endTime), m.joinUrl, m.status,
                new Date(m.createdAt), m.isSimulated, JSON.stringify(m.logs)
            ];
            await pool.query(query, values);
            console.log(`Meeting record ${m.id} saved to PostgreSQL.`);
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

app.post('/api/schedule', async (req, res) => {
    const { panelistEmail, candidateEmail, subject, startTime, endTime } = req.body;

    if (!panelistEmail || !candidateEmail || !subject || !startTime || !endTime) {
        return res.status(400).json({ error: "Missing required scheduling fields." });
    }

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

        let organizerEmail = panelistEmail;
        let attendeesList = [
            {
                emailAddress: {
                    address: candidateEmail,
                    name: "Candidate"
                },
                type: "required"
            }
        ];

        const eventPayload = {
            subject: subject,
            body: {
                contentType: "HTML",
                content: `Hi, thank you for joining the interview loop. Please join the Microsoft Teams Meeting via the link below.`
            },
            start: {
                dateTime: formattedStart,
                timeZone: "India Standard Time"
            },
            end: {
                dateTime: formattedEnd,
                timeZone: "India Standard Time"
            },
            location: {
                displayName: "Microsoft Teams Meeting"
            },
            attendees: attendeesList,
            isOnlineMeeting: true,
            onlineMeetingProvider: "teamsForBusiness"
        };

        let response;
        let scheduledDirectly = true;
        const defaultOrganizer = process.env.DEFAULT_PANELIST_EMAIL;

        try {
            console.log(`Attempting to schedule event directly on panelist's calendar: ${panelistEmail}...`);
            response = await axios.post(`https://graph.microsoft.com/v1.0/users/${panelistEmail}/events`, eventPayload, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            organizerEmail = panelistEmail;
            scheduledDirectly = true;
            console.log(`Successfully scheduled event directly on panelist's calendar!`);
        } catch (apiErr) {
            console.warn(`Direct scheduling on panelist calendar ${panelistEmail} failed:`, apiErr.response ? apiErr.response.data : apiErr.message);
            
            if (defaultOrganizer && defaultOrganizer.toLowerCase() !== panelistEmail.toLowerCase()) {
                console.log(`Attempting fallback schedule via central organizer: ${defaultOrganizer}...`);
                organizerEmail = defaultOrganizer;
                scheduledDirectly = false;
                
                // Add panelist as attendee since we are scheduling via central organizer
                if (!attendeesList.some(a => a.emailAddress.address.toLowerCase() === panelistEmail.toLowerCase())) {
                    attendeesList.push({
                        emailAddress: { address: panelistEmail, name: "Interviewer" },
                        type: "required"
                    });
                }
                
                eventPayload.attendees = attendeesList;
                response = await axios.post(`https://graph.microsoft.com/v1.0/users/${defaultOrganizer}/events`, eventPayload, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });
                console.log(`Successfully scheduled via fallback organizer!`);
            } else {
                throw apiErr;
            }
        }

        const joinUrl = response.data.onlineMeeting.joinUrl;
        let onlineMeetingId = null;

        try {
            console.log(`Resolving joinUrl to get Teams onlineMeetingId...`);
            const filterUrl = `https://graph.microsoft.com/v1.0/users/${organizerEmail}/onlineMeetings?$filter=joinWebUrl eq '${encodeURIComponent(joinUrl)}'`;
            const filterRes = await axios.get(filterUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (filterRes.data.value && filterRes.data.value.length > 0) {
                onlineMeetingId = filterRes.data.value[0].id;
                console.log(`Resolved Teams onlineMeetingId: ${onlineMeetingId}`);
            }
        } catch (filterErr) {
            console.warn("Failed to resolve onlineMeetingId via filter:", filterErr.response ? filterErr.response.data : filterErr.message);
        }

        // Fallback to event ID if resolving failed, so the DB insert never crashes
        if (!onlineMeetingId) {
            onlineMeetingId = 'meet-' + response.data.id;
            console.log(`Using fallback meeting ID: ${onlineMeetingId}`);
        }

        const newMeeting = {
            id: onlineMeetingId,
            eventId: response.data.id, // Calendar Event ID
            subject: subject,
            panelistEmail: panelistEmail,
            candidateEmail: candidateEmail,
            startTime: formattedStart,
            endTime: formattedEnd,
            joinUrl: joinUrl,
            status: "Scheduled",
            createdAt: new Date().toISOString(),
            isSimulated: false,
            logs: [{ time: new Date().toISOString(), status: "Scheduled", message: "Meeting scheduled on Outlook calendar." }]
        };

        // Auto-accept meeting on behalf of panelist if scheduled via central organizer
        if (!scheduledDirectly) {
            try {
                const iCalUId = response.data.iCalUId;
                console.log(`Attempting to auto-accept meeting on behalf of panelist ${panelistEmail} (iCalUId: ${iCalUId})...`);
                // Wait a brief moment for Exchange to sync the event copy to the panelist's mailbox
                await new Promise(resolve => setTimeout(resolve, 2500));
                
                const findUrl = `https://graph.microsoft.com/v1.0/users/${panelistEmail}/events?$filter=iCalUId eq '${iCalUId}'`;
                const findRes = await axios.get(findUrl, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                if (findRes.data.value && findRes.data.value.length > 0) {
                    const panelistEventId = findRes.data.value[0].id;
                    const acceptUrl = `https://graph.microsoft.com/v1.0/users/${panelistEmail}/events/${panelistEventId}/accept`;
                    await axios.post(acceptUrl, {
                        comment: "Accepted automatically by SyncTeams platform.",
                        sendResponse: true
                    }, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    console.log(`Successfully auto-accepted event on behalf of panelist ${panelistEmail}. Calendar blocked!`);
                    newMeeting.logs.push({
                        time: new Date().toISOString(),
                        status: "Calendar Blocked",
                        message: `Successfully auto-accepted event on behalf of panelist ${panelistEmail} to block their calendar.`
                    });
                } else {
                    console.warn(`Could not find event copy on panelist ${panelistEmail}'s calendar to auto-accept.`);
                }
            } catch (acceptErr) {
                console.warn(`Auto-accept failed for panelist ${panelistEmail}:`, acceptErr.response ? acceptErr.response.data : acceptErr.message);
            }
        } else {
            console.log(`Event created directly on panelist's calendar. Calendar blocked!`);
            newMeeting.logs.push({
                time: new Date().toISOString(),
                status: "Calendar Blocked",
                message: `Successfully created event directly on panelist ${panelistEmail}'s calendar to block it.`
            });
        }

        // Attempt to configure auto-recording on Microsoft Graph onlineMeeting settings
        if (onlineMeetingId && !onlineMeetingId.startsWith('meet-')) {
            try {
                console.log(`Configuring recordAutomatically: true on Microsoft Graph for meeting ${onlineMeetingId}...`);
                const patchUrl = `https://graph.microsoft.com/v1.0/users/${organizerEmail}/onlineMeetings/${onlineMeetingId}`;
                await axios.patch(patchUrl, {
                    recordAutomatically: true
                }, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });
                console.log(`Successfully configured auto-recording/transcribing.`);
                newMeeting.logs.push({
                    time: new Date().toISOString(),
                    status: "Auto-Record Configured",
                    message: "Successfully enabled auto-recording settings for this Teams meeting on Microsoft Graph."
                });
            } catch (patchErr) {
                console.warn("Failed to patch onlineMeeting recordAutomatically settings:", patchErr.response ? patchErr.response.data : patchErr.message);
                newMeeting.logs.push({
                    time: new Date().toISOString(),
                    status: "Auto-Record Warning",
                    message: `Auto-record configuration failed: ${patchErr.response ? JSON.stringify(patchErr.response.data) : patchErr.message}`
                });
            }
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

            // Fire and forget email sends
            sendGraphEmail(token, senderEmail, panelistEmail, `Interview Scheduled: ${subject}`, panelistHtml);
            sendGraphEmail(token, senderEmail, candidateEmail, `Interview Scheduled: ${subject}`, candidateHtml);
            newMeeting.logs.push({
                time: new Date().toISOString(),
                status: "Notifications Sent",
                message: `Email notifications dispatched from ${senderEmail} to Panelist (${panelistEmail}) and Candidate (${candidateEmail}).`
            });
        } catch (emailErr) {
            console.warn("Failed during email notification dispatch:", emailErr.message);
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
        const expirationDateTime = new Date(Date.now() + 3600000 * 4).toISOString();

        // 1. Subscribe to Transcripts
        const transcriptPayload = {
            changeType: "updated",
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
            changeType: "updated",
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
    const meetingId = resourceData?.meetingId || resourceData?.id;
    const organizerId = resourceData?.organizerId;

    if (!meetingId || !organizerId) {
        console.log("Missing meetingId or organizerId in webhook. Cannot process.");
        return res.status(202).send("Missing IDs, cannot process yet");
    }

    const meetings = await getMeetings();
    const meeting = meetings.find(m => m.id === meetingId);
    
    if (meeting) {
        meeting.status = "Webhook Notification Received";
        meeting.logs.push({
            time: new Date().toISOString(),
            status: "Webhook Notification Received",
            message: `Graph Webhook notified of completed meeting artifacts. Organizer ID: ${organizerId}`
        });
        
        await updateMeeting(meetingId, {
            status: meeting.status,
            logs: meeting.logs
        });

        console.log(`Starting fetch of assets for meeting ID: ${meetingId}`);
        fetchArtifacts(organizerId, meetingId).catch(err => {
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
        const baseUrl = `https://graph.microsoft.com/v1.0/users/${organizerId}/onlineMeetings/${meetingId}`;

        // ---- A. Fetch Transcript ----
        console.log(`Listing transcripts for meeting: ${meetingId}`);
        const transcriptMeta = await axios.get(`${baseUrl}/transcripts`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        let transcriptSaved = false;
        let downloadedTranscriptText = null;
        let downloadedTranscriptPath = null;

        if (transcriptMeta.data.value && transcriptMeta.data.value.length > 0) {
            const transcriptId = transcriptMeta.data.value[0].id;
            console.log(`Downloading transcript: ${transcriptId}`);
            
            const contentUrl = `${baseUrl}/transcripts/${transcriptId}/content?format=text/vtt`;
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
        const recordingMeta = await axios.get(`${baseUrl}/recordings`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        let recordingSaved = false;
        let downloadedRecordingPath = null;

        if (recordingMeta.data.value && recordingMeta.data.value.length > 0) {
            const recordingId = recordingMeta.data.value[0].id;
            console.log(`Downloading recording binary stream: ${recordingId}`);
            
            const videoDownloadUrl = `${baseUrl}/recordings/${recordingId}/content`;
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

// Start Server
app.listen(PORT, () => {
    console.log(`========================================================`);
    console.log(`Teams Sync Interview App listening at http://localhost:${PORT}`);
    console.log(`========================================================`);
});
