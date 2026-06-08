const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const tenantId = process.env.MICROSOFT_TENANT_ID;
const clientId = process.env.MICROSOFT_CLIENT_ID;
const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

async function getGraphAccessToken() {
    const qs = require('qs');
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const tokenPayload = {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope: 'https://graph.microsoft.com/.default'
    };

    const response = await axios.post(tokenUrl, qs.stringify(tokenPayload), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return response.data.access_token;
}

const fs = require('fs');
const path = require('path');
const downloadsDir = path.join(__dirname, '..', 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

async function syncAll() {
    try {
        const token = await getGraphAccessToken();
        console.log("Token acquired successfully.");
        
        const dbRes = await pool.query("SELECT id, subject, join_url, organizer_email, panelist_email, logs FROM teams_meetings WHERE status = 'Scheduled'");
        console.log(`Found ${dbRes.rows.length} scheduled meetings to sync.`);
        
        for (const row of dbRes.rows) {
            const joinUrl = row.join_url;
            const orgEmail = row.organizer_email || row.panelist_email || process.env.DEFAULT_PANELIST_EMAIL;
            console.log(`Processing: "${row.subject}" (ID: ${row.id}, Organizer Email: ${orgEmail})`);
            
            try {
                // Parse Oid from joinUrl
                let orgOid = null;
                const oidMatch = joinUrl.match(/Oid%22%3a%22([^%"]+)/i) || joinUrl.match(/"Oid"\s*:\s*"([^"]+)"/i) || joinUrl.match(/Oid=([^&]+)/i);
                if (oidMatch) {
                    orgOid = oidMatch[1];
                    console.log(`Parsed organizer Oid from joinUrl: ${orgOid}`);
                }
                
                const targetOrg = orgOid || orgEmail;
                const searchUrl = `https://graph.microsoft.com/v1.0/users/${targetOrg}/onlineMeetings?$filter=joinWebUrl eq '${joinUrl}'`;
                
                const searchRes = await axios.get(searchUrl, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                const onlineMeetings = searchRes.data.value || [];
                if (onlineMeetings.length === 0) {
                    console.log(`Could not find onlineMeeting matching joinUrl on Graph for ${targetOrg}.`);
                    continue;
                }
                
                const realMeetingId = onlineMeetings[0].id;
                console.log(`Real onlineMeeting ID: ${realMeetingId}`);
                
                await pool.query('UPDATE teams_meetings SET id = $1 WHERE id = $2', [realMeetingId, row.id]);
                console.log(`Updated ID in DB from ${row.id} to ${realMeetingId}`);
                
                const meetingBaseUrl = `https://graph.microsoft.com/v1.0/users/${targetOrg}/onlineMeetings/${realMeetingId}`;
                
                // A. Transcript
                let transcriptText = null;
                let transcriptPath = null;
                try {
                    const trMeta = await axios.get(`${meetingBaseUrl}/transcripts`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    const transcriptsList = trMeta.data.value || [];
                    if (transcriptsList.length > 0) {
                        const trId = transcriptsList[0].id;
                        const contentRes = await axios.get(`${meetingBaseUrl}/transcripts/${trId}/content?format=text/vtt`, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        transcriptText = contentRes.data;
                        const trFileName = `transcript_${realMeetingId}.vtt`;
                        transcriptPath = `/downloads/${trFileName}`;
                        fs.writeFileSync(path.join(downloadsDir, trFileName), transcriptText);
                        console.log(`✅ Saved transcript: ${trFileName}`);
                    } else {
                        console.log(`No transcripts available yet.`);
                    }
                } catch (trErr) {
                    console.warn(`Transcript fetch failed:`, trErr.response ? trErr.response.data : trErr.message);
                }
                
                // B. Recording
                let recordingPath = null;
                try {
                    const recMeta = await axios.get(`${meetingBaseUrl}/recordings`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    const recordingsList = recMeta.data.value || [];
                    if (recordingsList.length > 0) {
                        const recId = recordingsList[0].id;
                        const recFileName = `recording_${realMeetingId}.mp4`;
                        recordingPath = `/downloads/${recFileName}`;
                        const videoPath = path.join(downloadsDir, recFileName);
                        
                        console.log(`Downloading recording stream to ${recFileName}...`);
                        const streamRes = await axios({
                            method: 'get',
                            url: `${meetingBaseUrl}/recordings/${recId}/content`,
                            headers: { 'Authorization': `Bearer ${token}` },
                            responseType: 'stream'
                        });
                        const writer = fs.createWriteStream(videoPath);
                        streamRes.data.pipe(writer);
                        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
                        console.log(`✅ Saved recording: ${recFileName}`);
                    } else {
                        console.log(`No recordings available yet.`);
                    }
                } catch (recErr) {
                    console.warn(`Recording fetch failed:`, recErr.response ? recErr.response.data : recErr.message);
                }
                
                const finalStatus = (transcriptPath || recordingPath) ? "Completed (Synced)" : "Scheduled";
                const logs = row.logs || [];
                logs.push({
                    time: new Date().toISOString(),
                    status: finalStatus,
                    message: `Manual sync completed. Transcript: ${transcriptPath ? 'Yes' : 'No'}, Recording: ${recordingPath ? 'Yes' : 'No'}`
                });
                
                await pool.query(
                    "UPDATE teams_meetings SET status = $1, transcript_text = $2, transcript_path = $3, recording_path = $4, logs = $5 WHERE id = $6",
                    [finalStatus, transcriptText, transcriptPath, recordingPath, JSON.stringify(logs), realMeetingId]
                );
                console.log(`✅ Sync complete for: "${row.subject}"!`);
                
            } catch (err) {
                console.error(`Error processing row:`, err.response ? err.response.data : err.message);
            }
        }
    } catch (e) {
        console.error("Fatal:", e);
    } finally {
        pool.end();
    }
}

syncAll();
