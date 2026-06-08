const axios = require('axios');
require('dotenv').config();

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

async function run() {
    try {
        const token = await getGraphAccessToken();
        const joinUrl = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ODhmODRjZDUtNGYyZi00ZDkzLTkwMjQtNjJjMzlmOTlmZGVh%40thread.v2/0?context=%7b%22Tid%22%3a%2289bbc8b6-9f88-4e35-a3bd-15a8fa916d6d%22%2c%22Oid%22%3a%22c94e5553-3965-412a-b328-c9fa31d925e6%22%7d";
        
        console.log("Fetching onlineMeeting under /communications endpoint...");
        const res = await axios.get(
            `https://graph.microsoft.com/v1.0/communications/onlineMeetings?$filter=JoinWebUrl eq '${joinUrl}'`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        console.log("=== MEETING DETAILS ===");
        console.log(JSON.stringify(res.data, null, 2));
    } catch (e) {
        console.error("Error:", e.response ? e.response.data : e.message);
    }
}

run();
