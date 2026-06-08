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
        const eventId = "AAMkADYxODVhOTUxLWZhMTAtNDUyYi04ZDcwLWY4NmI5Mjk4YzE1ZABGAAAAAABq6VISmQN4TLrD7DbmiMDGBwCZu2YoNfYnT7TMQvhcgzpoAAAAAAENAACZu2YoNfYnT7TMQvhcgzpoAACaRAzmAAA=";
        const org = "nadeem.aehmad@kadellabs.com";
        
        console.log("Fetching event...");
        const res = await axios.get(
            `https://graph.microsoft.com/v1.0/users/${org}/events/${eventId}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        console.log("=== EVENT DETAILS ===");
        console.log(JSON.stringify(res.data, null, 2));
    } catch (e) {
        console.error("Error:", e.response ? e.response.data : e.message);
    }
}

run();
