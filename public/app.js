// STATE MANAGEMENT
let meetingsList = [];
let activeMeeting = null;
let transcriptCues = [];
let lastActiveCueIdx = -1;
let logHistory = [];

// DOM ELEMENTS
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.content-view');
const pageTitle = document.getElementById('page-title');
const pageSubtitle = document.getElementById('page-subtitle');
const webhookBadge = document.getElementById('webhook-badge');

// Forms
const scheduleForm = document.getElementById('schedule-form');
const settingsForm = document.getElementById('settings-form');

// Dashboard Elements
const statTotal = document.getElementById('stat-total');
const statCompleted = document.getElementById('stat-completed');
const statPending = document.getElementById('stat-pending');
const meetingsListTbody = document.getElementById('meetings-list-tbody');
const systemConsole = document.getElementById('system-console');
const btnRefreshMeetings = document.getElementById('btn-refresh-meetings');

// Player Elements
const playerPlaceholder = document.getElementById('player-placeholder');
const playerWorkspace = document.getElementById('player-workspace');
const playerTitle = document.getElementById('player-title');
const playerDetails = document.getElementById('player-details');
const teamsVideoPlayer = document.getElementById('teams-video-player');
const videoSource = document.getElementById('video-source');
const transcriptBody = document.getElementById('transcript-body');
const transcriptSearch = document.getElementById('transcript-search');
const auditTimeline = document.getElementById('audit-timeline');
const btnDownloadTranscript = document.getElementById('btn-download-transcript');
const btnDownloadVideo = document.getElementById('btn-download-video');

// Actions buttons
const btnQuickDemo = document.getElementById('btn-quick-demo');
const btnScheduleSim = document.getElementById('btn-schedule-sim');
const btnTestConnection = document.getElementById('btn-test-connection');
const btnRegisterSubscriptions = document.getElementById('btn-register-subscriptions');

// ==========================================
// 1. ROUTING & VIEWS SWITCHING
// ==========================================
function switchView(targetId) {
    views.forEach(view => {
        if (view.id === `view-${targetId}`) {
            view.classList.add('active');
        } else {
            view.classList.remove('active');
        }
    });

    navItems.forEach(item => {
        if (item.getAttribute('data-target') === targetId) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });

    // Update Titles
    switch (targetId) {
        case 'dashboard':
            pageTitle.innerText = 'Dashboard Overview';
            pageSubtitle.innerText = 'Monitor scheduled interviews and synced Graph media.';
            loadMeetings();
            break;
        case 'scheduler':
            pageTitle.innerText = 'Interview Scheduler';
            pageSubtitle.innerText = 'Schedule calendar blocks and Teams links for candidates.';
            break;
        case 'player':
            pageTitle.innerText = 'Meeting Playback Room';
            pageSubtitle.innerText = 'Analyze video recording and interactive transcript side-by-side.';
            break;
        case 'settings':
            pageTitle.innerText = 'Microsoft Graph Credentials';
            pageSubtitle.innerText = 'Configure Entra ID authentication and webhook listeners.';
            break;
    }
}

navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const target = item.getAttribute('data-target');
        switchView(target);
        window.location.hash = target;
    });
});

// Sync view with hash on load
if (window.location.hash) {
    const target = window.location.hash.substring(1);
    if (document.getElementById(`view-${target}`)) {
        switchView(target);
    }
}

// ==========================================
// 2. CONSOLE & TOAST UTILITIES
// ==========================================
function logToConsole(type, message) {
    const timestamp = new Date().toLocaleTimeString();
    let typeClass = 'system';
    let prefix = '[System]';

    if (type === 'success') { typeClass = 'success'; prefix = '[Success]'; }
    else if (type === 'webhook') { typeClass = 'webhook'; prefix = '[Webhook]'; }
    else if (type === 'error') { typeClass = 'error'; prefix = '[Error]'; }
    else if (type === 'warning') { typeClass = 'warning'; prefix = '[Warning]'; }

    const line = document.createElement('div');
    line.className = `console-line ${typeClass}`;
    line.innerText = `[${timestamp}] ${prefix} ${message}`;
    
    systemConsole.appendChild(line);
    systemConsole.scrollTop = systemConsole.scrollHeight;

    // Persist log history array
    logHistory.push({ time: timestamp, type, message });
}

function showToast(type, message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    // Choose icon
    let icon = '';
    if (type === 'success') icon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    else if (type === 'error') icon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
    else icon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';

    toast.innerHTML = `${icon}<span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ==========================================
// 3. MEETINGS FETCH & POLL LOGIC
// ==========================================
async function loadMeetings() {
    try {
        const res = await fetch('/api/meetings');
        const data = await res.json();
        
        // Check for state changes to log in console
        data.forEach(meeting => {
            const oldMeet = meetingsList.find(m => m.id === meeting.id);
            if (oldMeet && oldMeet.status !== meeting.status) {
                const logType = meeting.status.toLowerCase().includes('failed') ? 'error' : 
                                meeting.status.toLowerCase().includes('complete') ? 'success' : 'webhook';
                logToConsole(logType, `Meeting "${meeting.subject}" status changed: ${oldMeet.status} → ${meeting.status}`);
                
                // Trigger visual and browser notifications when a meeting is completed
                if (meeting.status.includes('Completed')) {
                    showToast('success', `🎉 Sync Complete! "${meeting.subject}" transcript & video pushed to RDS.`);
                    
                    if ("Notification" in window && Notification.permission === "granted") {
                        new Notification(`Interview Complete: ${meeting.subject}`, {
                            body: "Recording video and transcript have been synced to the database.",
                            tag: meeting.id
                        });
                    }
                }
            }
        });

        meetingsList = data;
        renderMeetingsTable();
        updateStats();
    } catch (err) {
        console.error("Failed to load meetings", err);
    }
}

function updateStats() {
    statTotal.innerText = meetingsList.length;
    const completed = meetingsList.filter(m => m.status.includes('Completed')).length;
    const pending = meetingsList.length - completed;
    
    statCompleted.innerText = completed;
    statPending.innerText = pending;
}

function renderMeetingsTable() {
    if (meetingsList.length === 0) {
        meetingsListTbody.innerHTML = `
            <tr>
                <td colspan="6" class="text-center text-muted py-4">No scheduled interviews. Schedule one or run the Simulator!</td>
            </tr>
        `;
        return;
    }

    meetingsListTbody.innerHTML = meetingsList.map(meeting => {
        const isSim = meeting.isSimulated;
        const statusClass = meeting.status.includes('Completed') ? 'badge-completed' :
                            meeting.status.includes('Failed') ? 'badge-failed' :
                            meeting.status.includes('Processing') ? 'badge-processing' :
                            meeting.status.includes('Webhook') ? 'badge-webhook' :
                            isSim ? 'badge-simulated' : 'badge-scheduled';

        const joinBtn = meeting.joinUrl ? 
            `<a href="${meeting.joinUrl}" target="_blank" class="btn btn-outline btn-sm">Join</a>` : '';
            
        const playbackBtn = (meeting.recordingPath || meeting.transcriptPath) ? 
            `<button class="btn btn-primary btn-sm" onclick="openPlaybackRoom('${meeting.id}')">View Media</button>` : '';

        const simulateWebhookBtn = (isSim && !meeting.recordingPath) ?
            `<button class="btn btn-danger btn-sm" onclick="triggerSimulatedWebhook('${meeting.id}')" title="Simulate Webhook event to download video and transcript">Trigger Webhook</button>` : '';

        const deleteBtn = `<button class="btn btn-outline btn-danger btn-sm" onclick="deleteMeeting('${meeting.id}')" style="padding: 0.25rem 0.5rem;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>`;

        const dateFormatted = new Date(meeting.startTime).toLocaleString('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short'
        });

        return `
            <tr>
                <td><strong>${meeting.subject}</strong></td>
                <td><code class="text-muted" title="${meeting.panelistEmail}">${meeting.panelistEmail}</code></td>
                <td><code class="text-muted" title="${meeting.candidateEmail}">${meeting.candidateEmail}</code></td>
                <td>${dateFormatted}</td>
                <td>
                    <span class="badge ${statusClass}">${meeting.status}</span>
                </td>
                <td>
                    <div class="table-btn-group">
                        ${joinBtn}
                        ${playbackBtn}
                        ${simulateWebhookBtn}
                        ${deleteBtn}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// Global scope actions handlers
window.deleteMeeting = async function(id) {
    if (!confirm("Are you sure you want to delete this meeting? This will clean up local databases and downloaded media files.")) return;
    try {
        const res = await fetch(`/api/meetings/${id}`, { method: 'DELETE' });
        if (res.ok) {
            logToConsole('system', `Meeting ID ${id} deleted.`);
            showToast('success', 'Meeting record deleted.');
            loadMeetings();
            if (activeMeeting && activeMeeting.id === id) {
                closePlaybackRoom();
            }
        }
    } catch (e) {
        showToast('error', 'Delete failed.');
    }
};

window.triggerSimulatedWebhook = async function(id) {
    try {
        logToConsole('webhook', `Simulating webhook callback request for meeting: ${id}`);
        const res = await fetch(`/api/simulate/webhook/${id}`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('info', 'Webhook simulation triggered. Fetching assets...');
            loadMeetings();
        }
    } catch (err) {
        showToast('error', 'Webhook trigger failed.');
    }
};

// ==========================================
// 4. MEETINGS SCHEDULER LOGIC
// ==========================================
scheduleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const subject = document.getElementById('meet-subject').value;
    const panelistEmail = document.getElementById('meet-panelist').value;
    const candidateEmail = document.getElementById('meet-candidate').value;
    const startTime = document.getElementById('meet-start').value;
    const endTime = document.getElementById('meet-end').value;

    // Client-side date range validation
    if (new Date(startTime) >= new Date(endTime)) {
        showToast('error', 'End time must be strictly after the start time.');
        logToConsole('error', 'Validation failed: End time is set before or equal to start time.');
        return;
    }

    try {
        logToConsole('system', `Scheduling calendar event for: "${subject}"...`);
        showToast('info', 'Contacting Microsoft Graph...');
        
        const res = await fetch('/api/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ panelistEmail, candidateEmail, subject, startTime, endTime })
        });

        if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.details ? JSON.stringify(errData.details) : 'Server returned error');
        }

        const newMeeting = await res.json();
        logToConsole('success', `Scheduled meeting: ${newMeeting.subject} (ID: ${newMeeting.id})`);
        showToast('success', 'Calendar invite and Teams link created!');
        scheduleForm.reset();
        switchView('dashboard');
    } catch (error) {
        logToConsole('error', `Scheduling failed: ${error.message}`);
        showToast('error', `Scheduling Failed. Check credentials status.`);
    }
});

btnScheduleSim.addEventListener('click', async () => {
    const subject = document.getElementById('meet-subject').value || 'Simulated Technical Interview';
    const panelistEmail = document.getElementById('meet-panelist').value || 'interviewer@mycompany.org';
    const candidateEmail = document.getElementById('meet-candidate').value || 'candidate@gmail.com';

    try {
        logToConsole('system', `Creating Simulated meeting...`);
        const res = await fetch('/api/simulate/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ panelistEmail, candidateEmail, subject })
        });

        const newMeeting = await res.json();
        logToConsole('success', `Simulated Meeting created. Click 'Trigger Webhook' in Dashboard to run the mockup callback!`);
        showToast('success', 'Simulated Interview added to timeline.');
        scheduleForm.reset();
        switchView('dashboard');
    } catch (e) {
        showToast('error', 'Simulator event creation failed.');
    }
});

// Auto fill date/times in form on load
function initScheduleTimes() {
    const now = new Date();
    const start = new Date(now.getTime() + 10 * 60000); // 10 min from now
    const end = new Date(now.getTime() + 40 * 60000);  // 40 min from now

    // Format YYYY-MM-DDTHH:MM
    const format = (d) => {
        const offset = d.getTimezoneOffset();
        const local = new Date(d.getTime() - (offset*60*1000));
        return local.toISOString().substring(0, 16);
    };

    document.getElementById('meet-start').value = format(start);
    document.getElementById('meet-end').value = format(end);
}

// ==========================================
// 5. GRAPH SETTINGS LOGIC
// ==========================================
async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const data = await res.json();
        
        document.getElementById('config-tenant-id').value = data.MICROSOFT_TENANT_ID || '';
        document.getElementById('config-client-id').value = data.MICROSOFT_CLIENT_ID || '';
        document.getElementById('config-client-secret').value = data.MICROSOFT_CLIENT_SECRET || '';
        document.getElementById('config-webhook-url').value = data.WEBHOOK_BASE_URL || '';
        document.getElementById('config-default-panelist').value = data.DEFAULT_PANELIST_EMAIL || '';
        document.getElementById('config-default-candidate').value = data.DEFAULT_CANDIDATE_EMAIL || '';

        // Auto-fill schedule form with defaults if present
        if (data.DEFAULT_PANELIST_EMAIL) {
            document.getElementById('meet-panelist').value = data.DEFAULT_PANELIST_EMAIL;
            const pastEmailInput = document.getElementById('past-recordings-email');
            if (pastEmailInput) pastEmailInput.value = data.DEFAULT_PANELIST_EMAIL;
        }
        if (data.DEFAULT_CANDIDATE_EMAIL) document.getElementById('meet-candidate').value = data.DEFAULT_CANDIDATE_EMAIL;

        if (data.WEBHOOK_BASE_URL) {
            webhookBadge.className = 'webhook-indicator online';
            webhookBadge.querySelector('.indicator-text').innerText = 'Webhook Registered';
        } else {
            webhookBadge.className = 'webhook-indicator offline';
            webhookBadge.querySelector('.indicator-text').innerText = 'Webhook Missing';
        }
    } catch (e) {
        console.error("Failed to load configs:", e);
    }
}

settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tenantId = document.getElementById('config-tenant-id').value;
    const clientId = document.getElementById('config-client-id').value;
    const clientSecret = document.getElementById('config-client-secret').value;
    const webhookUrl = document.getElementById('config-webhook-url').value;
    const panelistEmail = document.getElementById('config-default-panelist').value;
    const candidateEmail = document.getElementById('config-default-candidate').value;

    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenantId, clientId, clientSecret, webhookUrl, panelistEmail, candidateEmail })
        });
        
        if (res.ok) {
            logToConsole('success', 'Graph settings updated.');
            showToast('success', 'Configurations saved successfully!');
            loadConfig();
        } else {
            throw new Error('Save config failed');
        }
    } catch (error) {
        showToast('error', error.message);
    }
});

btnTestConnection.addEventListener('click', async () => {
    logToConsole('system', 'Initiating token exchange with Microsoft Identity Platform...');
    showToast('info', 'Requesting Graph access token...');
    
    try {
        const res = await fetch('/api/test-token');
        const data = await res.json();
        
        if (data.success) {
            logToConsole('success', 'Microsoft Graph connection TEST SUCCESSFUL! Application permissions and Client Credentials flow verified.');
            showToast('success', 'Connection test passed!');
        } else {
            throw new Error(data.error || 'Access Token fetch rejected.');
        }
    } catch (error) {
        logToConsole('error', `Connection test FAILED: ${error.message}`);
        showToast('error', 'Connection test failed. Review credentials.');
    }
});

btnRegisterSubscriptions.addEventListener('click', async () => {
    logToConsole('system', 'Registering subscriptions for transcripts and recordings on MS Graph...');
    showToast('info', 'Subscribing to Graph change notifications...');

    try {
        const res = await fetch('/api/subscribe', { method: 'POST' });
        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.details ? JSON.stringify(data.details) : 'Subscription registration error');
        }

        logToConsole('success', `Graph subscriptions registered! Transcripts Subscription ID: ${data.transcriptionSubscriptionId} | Recordings Subscription ID: ${data.recordingSubscriptionId}`);
        showToast('success', 'Graph Webhook Subscriptions Registered!');
    } catch (error) {
        logToConsole('error', `Graph subscription FAILED: ${error.message}`);
        showToast('error', 'Webhook registration failed. Verify Webhook URL.');
    }
});

// ==========================================
// 6. PLAYBACK ROOM & TRANSCRIPT SYNC LOGIC
// ==========================================
window.openPlaybackRoom = function(id) {
    const meeting = meetingsList.find(m => m.id === id);
    if (!meeting) return;

    activeMeeting = meeting;
    switchView('player');
    
    playerPlaceholder.classList.add('hidden');
    playerWorkspace.classList.remove('hidden');

    playerTitle.innerText = meeting.subject;
    playerDetails.innerText = `Panelist(s): ${meeting.panelistEmail} | Candidate: ${meeting.candidateEmail} | Status: ${meeting.status}`;

    // Setup Download Links
    if (meeting.transcriptPath) {
        btnDownloadTranscript.href = meeting.transcriptPath;
        btnDownloadTranscript.classList.remove('hidden');
    } else {
        btnDownloadTranscript.removeAttribute('href');
        btnDownloadTranscript.classList.add('hidden');
    }

    if (meeting.recordingPath) {
        btnDownloadVideo.href = meeting.recordingPath;
        btnDownloadVideo.classList.remove('hidden');
        
        // Load Video Player Source
        videoSource.src = meeting.recordingPath;
        teamsVideoPlayer.load();
    } else {
        btnDownloadVideo.removeAttribute('href');
        btnDownloadVideo.classList.add('hidden');
        videoSource.src = '';
        teamsVideoPlayer.load();
    }

    // Render Transcript
    if (meeting.transcriptText) {
        transcriptCues = parseVtt(meeting.transcriptText);
        renderTranscript();
    } else {
        transcriptCues = [];
        transcriptBody.innerHTML = `<p class="text-center text-muted py-4">No transcript text associated with this meeting.</p>`;
    }

    // Render Audit logs
    renderAuditTimeline(meeting.logs);
};

function closePlaybackRoom() {
    activeMeeting = null;
    transcriptCues = [];
    lastActiveCueIdx = -1;
    playerWorkspace.classList.add('hidden');
    playerPlaceholder.classList.remove('hidden');
}

// WebVTT Parser
function parseVtt(vttString) {
    const lines = vttString.split(/\r?\n/);
    const cues = [];
    let currentCue = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Check if timestamp cue definition line
        if (line.includes('-->')) {
            const parts = line.split('-->');
            const startSec = parseVttTimestamp(parts[0].trim());
            const endSec = parseVttTimestamp(parts[1].trim());
            currentCue = { start: startSec, end: endSec, text: '' };
            cues.push(currentCue);
        } else if (currentCue) {
            if (currentCue.text) {
                currentCue.text += '\n' + line;
            } else {
                currentCue.text = line;
            }
        }
    }

    // Post-process cues to extract speaker and clean text
    cues.forEach(cue => {
        let text = cue.text;
        let speaker = 'Speaker';

        const speakerMatch = text.match(/<v\s+([^>]+)>(.*)/);
        if (speakerMatch) {
            speaker = speakerMatch[1];
            text = speakerMatch[2].replace(/<\/v>/g, '');
        } else {
            // Check if it starts with SpeakerName: or SpeakerName [00:00]
            const colonIdx = text.indexOf(':');
            if (colonIdx > 0 && colonIdx < 30) {
                speaker = text.substring(0, colonIdx).trim();
                text = text.substring(colonIdx + 1).trim();
            }
        }
        cue.speaker = speaker;
        cue.cleanText = text;
    });

    return cues;
}

function parseVttTimestamp(tStr) {
    const parts = tStr.split(':');
    let hrs = 0;
    let mins = 0;
    let secs = 0;

    if (parts.length === 3) {
        hrs = parseInt(parts[0], 10);
        mins = parseInt(parts[1], 10);
        secs = parseFloat(parts[2]);
    } else if (parts.length === 2) {
        mins = parseInt(parts[0], 10);
        secs = parseFloat(parts[1]);
    } else {
        secs = parseFloat(parts[0]);
    }
    return hrs * 3600 + mins * 60 + secs;
}

function formatSeconds(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) {
        return `${pad(h)}:${pad(m)}:${pad(s)}`;
    }
    return `${pad(m)}:${pad(s)}`;
}

function renderTranscript() {
    if (transcriptCues.length === 0) {
        transcriptBody.innerHTML = `<p class="text-muted text-center py-4">No dialogues found.</p>`;
        return;
    }

    transcriptBody.innerHTML = transcriptCues.map((cue, idx) => {
        const timeStr = formatSeconds(cue.start);
        return `
            <div class="transcript-row" data-idx="${idx}" onclick="seekVideo(${cue.start})">
                <div class="transcript-meta">
                    <span class="transcript-speaker">${cue.speaker}</span>
                    <span class="transcript-time">${timeStr}</span>
                </div>
                <div class="transcript-text">${cue.cleanText}</div>
            </div>
        `;
    }).join('');
}

window.seekVideo = function(seconds) {
    teamsVideoPlayer.currentTime = seconds;
    teamsVideoPlayer.play();
    logToConsole('system', `Seeking video to timestamp ${formatSeconds(seconds)}`);
};

// Video Timeupdate Event Listener - Highlights active cue row and scrolls it
teamsVideoPlayer.addEventListener('timeupdate', () => {
    const time = teamsVideoPlayer.currentTime;
    
    // Find active cue
    const activeIdx = transcriptCues.findIndex(cue => time >= cue.start && time <= cue.end);
    
    if (activeIdx !== -1 && activeIdx !== lastActiveCueIdx) {
        // Remove previous active classes
        const previousActive = transcriptBody.querySelector('.transcript-row.active');
        if (previousActive) previousActive.classList.remove('active');

        // Add class to current active
        const newActiveRow = transcriptBody.querySelector(`.transcript-row[data-idx="${activeIdx}"]`);
        if (newActiveRow) {
            newActiveRow.classList.add('active');
            newActiveRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        lastActiveCueIdx = activeIdx;
    }
});

// Transcript Text Search
transcriptSearch.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const rows = transcriptBody.querySelectorAll('.transcript-row');
    
    rows.forEach(row => {
        const speaker = row.querySelector('.transcript-speaker').innerText.toLowerCase();
        const text = row.querySelector('.transcript-text').innerText.toLowerCase();
        
        if (query === '') {
            row.classList.remove('hidden');
            row.classList.remove('highlighted');
        } else if (text.includes(query) || speaker.includes(query)) {
            row.classList.remove('hidden');
            row.classList.add('highlighted');
        } else {
            row.classList.add('hidden');
            row.classList.remove('highlighted');
        }
    });
});

function renderAuditTimeline(logs) {
    if (!logs || logs.length === 0) {
        auditTimeline.innerHTML = '<p class="text-muted">No audit events logged.</p>';
        return;
    }

    auditTimeline.innerHTML = logs.map(log => {
        let logClass = 'system';
        const status = log.status || log.type || 'System';
        const message = log.message || '';
        const logTime = log.time || log.timestamp || new Date().toISOString();
        
        if (status.toLowerCase().includes('fail') || status.toLowerCase().includes('error')) logClass = 'error';
        else if (status.toLowerCase().includes('complete') || status.toLowerCase().includes('fetch')) logClass = 'success';
        else if (status.toLowerCase().includes('webhook') || status.toLowerCase().includes('received')) logClass = 'warning';

        return `
            <div class="timeline-item ${logClass}">
                <span class="timeline-time">${new Date(logTime).toLocaleTimeString()}</span>
                <span class="timeline-message"><strong>${status}</strong>: ${message}</span>
            </div>
        `;
    }).join('');
}

// ==========================================
// 7. SIMULATOR DEMO WALKTHROUGH FLOW
// ==========================================
btnQuickDemo.addEventListener('click', async () => {
    switchView('dashboard');
    logToConsole('system', '----------------------------------------');
    logToConsole('system', 'STARTING AUTOMATED SIMULATION WORKFLOW...');
    logToConsole('system', '----------------------------------------');
    showToast('info', 'Starting demo loop...');

    try {
        // Step 1: Create Simulated Event
        logToConsole('system', 'Step 1: Scheduling simulated interview panel event...');
        const scheduleRes = await fetch('/api/simulate/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                subject: "Design Sync: Senior UI Architect",
                panelistEmail: "design-lead@elasticrew.com",
                candidateEmail: "candidate-jane@gmail.com"
            })
        });
        const meeting = await scheduleRes.json();
        logToConsole('success', `Simulated Meeting created successfully. ID: ${meeting.id}`);
        await loadMeetings();

        // Step 2: Trigger Webhook Callback
        setTimeout(async () => {
            logToConsole('webhook', `Step 2: Meeting ended. Simulating Microsoft Teams webhook notification...`);
            const webhookRes = await fetch(`/api/simulate/webhook/${meeting.id}`, { method: 'POST' });
            await loadMeetings();

            // Step 3: Open playback room once loaded
            setTimeout(async () => {
                await loadMeetings();
                logToConsole('success', `Step 3: Webhook parsed, sample.mp4 and sample.vtt assets populated in downloads directory.`);
                logToConsole('success', `Opening Interactive Playback room...`);
                showToast('success', 'Demo Asset Sync Complete!');
                
                openPlaybackRoom(meeting.id);
                
                // Auto play and seek to show off the visual transcript scroll sync!
                setTimeout(() => {
                    if (teamsVideoPlayer) {
                        teamsVideoPlayer.play().then(() => {
                            logToConsole('success', 'Sync active. Watch the transcript scroll automatically as the video plays!');
                        }).catch(e => {
                            console.warn("Autoplay blocked, user click required", e);
                        });
                    }
                }, 1000);
            }, 3000); // Wait for mock asset processing
        }, 2000); // Let the scheduled card display first

    } catch (e) {
        logToConsole('error', `Simulator failure: ${e.message}`);
        showToast('error', 'Simulator walkthrough encountered an error.');
    }
});

// ==========================================
// 7b. ONEDRIVE PAST RECORDINGS LOGIC
// ==========================================
const btnLoadPastRecordings = document.getElementById('btn-load-past-recordings');
const pastRecordingsEmail = document.getElementById('past-recordings-email');
const pastRecordingsLoading = document.getElementById('past-recordings-loading');
const pastRecordingsEmpty = document.getElementById('past-recordings-empty');
const pastRecordingsPanel = document.getElementById('past-recordings-panel');
const pastRecordingsDropdown = document.getElementById('past-recordings-dropdown');
const pastRecordingInfo = document.getElementById('past-recording-info');
const prInfoName = document.getElementById('pr-info-name');
const prInfoSize = document.getElementById('pr-info-size');
const prInfoDate = document.getElementById('pr-info-date');
const prInfoSource = document.getElementById('pr-info-source');
const btnFetchPastRecording = document.getElementById('btn-fetch-past-recording');
const btnOpenOnedrive = document.getElementById('btn-open-onedrive');
const pastRecordingProgress = document.getElementById('past-recording-progress');
const prProgressText = document.getElementById('pr-progress-text');

function formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

if (btnLoadPastRecordings) {
    btnLoadPastRecordings.addEventListener('click', async () => {
        const email = pastRecordingsEmail ? pastRecordingsEmail.value.trim() : '';
        if (!email) {
            showToast('warning', 'Please enter a panelist email first.');
            return;
        }

        btnLoadPastRecordings.disabled = true;
        if (pastRecordingsEmail) pastRecordingsEmail.disabled = true;
        pastRecordingsLoading.style.display = 'block';
        pastRecordingsEmpty.style.display = 'none';
        pastRecordingsPanel.style.display = 'none';
        pastRecordingInfo.style.display = 'none';
        btnFetchPastRecording.disabled = true;

        try {
            const res = await fetch(`/api/past-recordings?email=${encodeURIComponent(email)}`);
            const data = await res.json();
            
            if (data.error) {
                throw new Error(data.error);
            }

            pastRecordingsDropdown.innerHTML = '<option value="" disabled selected>-- Select an MP4 file --</option>';

            if (!data.recordings || data.recordings.length === 0) {
                pastRecordingsEmpty.style.display = 'block';
                const emptyText = pastRecordingsEmpty.querySelector('p');
                if (emptyText) {
                    emptyText.innerText = `No recordings found on OneDrive for ${email}.`;
                }
            } else {
                data.recordings.forEach(rec => {
                    const opt = document.createElement('option');
                    opt.value = rec.id;
                    opt.textContent = rec.name;
                    opt.dataset.size = rec.size || 0;
                    opt.dataset.date = rec.lastModified || '';
                    opt.dataset.webUrl = rec.webUrl || '';
                    opt.dataset.source = rec.source || 'OneDrive';
                    pastRecordingsDropdown.appendChild(opt);
                });
                pastRecordingsPanel.style.display = 'flex';
            }
            logToConsole('success', `Loaded ${data.recordings?.length || 0} past recordings from ${data.organizer}'s OneDrive.`);
        } catch (err) {
            console.error("Failed to load past recordings:", err);
            logToConsole('error', `Failed to load past recordings: ${err.message}`);
            showToast('error', `OneDrive error: ${err.message}`);
            pastRecordingsEmpty.style.display = 'block';
            const emptyText = pastRecordingsEmpty.querySelector('p');
            if (emptyText) {
                emptyText.innerText = `Error loading recordings: ${err.message}`;
            }
        } finally {
            pastRecordingsLoading.style.display = 'none';
            btnLoadPastRecordings.disabled = false;
            if (pastRecordingsEmail) pastRecordingsEmail.disabled = false;
        }
    });
}

if (pastRecordingsDropdown) {
    pastRecordingsDropdown.addEventListener('change', () => {
        const selectedOpt = pastRecordingsDropdown.selectedOptions[0];
        if (!selectedOpt || selectedOpt.value === "") {
            pastRecordingInfo.style.display = 'none';
            btnFetchPastRecording.disabled = true;
            btnOpenOnedrive.style.display = 'none';
            return;
        }

        const name = selectedOpt.textContent;
        const size = parseInt(selectedOpt.dataset.size);
        const dateStr = selectedOpt.dataset.date;
        const webUrl = selectedOpt.dataset.webUrl;
        const source = selectedOpt.dataset.source;

        prInfoName.textContent = name;
        prInfoSize.textContent = formatBytes(size);
        prInfoDate.textContent = dateStr ? new Date(dateStr).toLocaleString() : '-';
        prInfoSource.textContent = source;
        pastRecordingInfo.style.display = 'block';

        btnFetchPastRecording.disabled = false;

        if (webUrl) {
            btnOpenOnedrive.href = webUrl;
            btnOpenOnedrive.style.display = 'inline-flex';
        } else {
            btnOpenOnedrive.style.display = 'none';
        }
    });
}

if (btnFetchPastRecording) {
    btnFetchPastRecording.addEventListener('click', async () => {
        const selectedOpt = pastRecordingsDropdown.selectedOptions[0];
        if (!selectedOpt) return;

        const fileId = selectedOpt.value;
        const fileName = selectedOpt.textContent;
        const source = selectedOpt.dataset.source;
        const email = pastRecordingsEmail ? pastRecordingsEmail.value.trim() : '';

        btnFetchPastRecording.disabled = true;
        pastRecordingsDropdown.disabled = true;
        btnLoadPastRecordings.disabled = true;
        if (pastRecordingsEmail) pastRecordingsEmail.disabled = true;
        pastRecordingProgress.style.display = 'flex';
        prProgressText.textContent = `Generating temporary direct playback stream URL...`;

        try {
            logToConsole('system', `Requesting pre-signed URL for: ${fileName}...`);
            const res = await fetch('/api/fetch-past-recording', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileId, fileName, email })
            });
            const data = await res.json();

            if (data.error) {
                throw new Error(data.error);
            }

            logToConsole('success', `Direct stream URL generated successfully.`);
            showToast('success', 'Playback starting!');

            switchView('player');
            
            playerPlaceholder.classList.add('hidden');
            playerWorkspace.classList.remove('hidden');

            playerTitle.innerText = fileName;
            playerDetails.innerText = `Source: OneDrive Recording (${source}) | User: ${email}`;

            btnDownloadTranscript.classList.add('hidden');
            btnDownloadVideo.href = data.downloadUrl;
            btnDownloadVideo.classList.remove('hidden');
            
            videoSource.src = data.downloadUrl;
            teamsVideoPlayer.load();

            transcriptCues = [];
            transcriptBody.innerHTML = `<p class="text-center text-muted py-4">No transcript text associated with this past recording.</p>`;
            renderAuditTimeline([
                { time: new Date().toISOString(), status: 'Success', message: `Pre-signed stream link acquired from OneDrive. Starting video stream.` }
            ]);

            setTimeout(() => {
                if (teamsVideoPlayer) {
                    teamsVideoPlayer.play().catch(e => {
                        console.warn("Autoplay blocked, user click required", e);
                    });
                }
            }, 500);

        } catch (err) {
            console.error("Failed to generate direct play URL:", err);
            logToConsole('error', `Playback error: ${err.message}`);
            showToast('error', `Playback failed: ${err.message}`);
        } finally {
            pastRecordingProgress.style.display = 'none';
            btnFetchPastRecording.disabled = false;
            pastRecordingsDropdown.disabled = false;
            btnLoadPastRecordings.disabled = false;
            if (pastRecordingsEmail) pastRecordingsEmail.disabled = false;
        }
    });
}

// 8. INITIALIZATION
// ==========================================
initScheduleTimes();
loadConfig();
loadMeetings();

// Request desktop notification permission from user
if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().then(permission => {
        if (permission === "granted") {
            console.log("Desktop notifications enabled by user.");
        }
    });
}

// Poll meetings list for changes every 4 seconds to catch webhook files updates
setInterval(loadMeetings, 4000);

// ==========================================
// 9. THEME TOGGLE LOGIC
// ==========================================
const btnThemeToggle = document.getElementById('btn-theme-toggle');
if (btnThemeToggle) {
    const sunIcon = btnThemeToggle.querySelector('.sun-icon');
    const moonIcon = btnThemeToggle.querySelector('.moon-icon');
    const themeText = document.getElementById('theme-text');

    // Default to dark theme if not set
    const savedTheme = localStorage.getItem('theme') || 'dark';
    if (savedTheme === 'light') {
        document.body.classList.add('light-theme');
        document.body.classList.remove('dark-theme');
        if (sunIcon) sunIcon.classList.remove('hidden');
        if (moonIcon) moonIcon.classList.add('hidden');
        if (themeText) themeText.innerText = 'Dark Theme';
    } else {
        document.body.classList.add('dark-theme');
        document.body.classList.remove('light-theme');
        if (sunIcon) sunIcon.classList.add('hidden');
        if (moonIcon) moonIcon.classList.remove('hidden');
        if (themeText) themeText.innerText = 'Light Theme';
    }

    btnThemeToggle.addEventListener('click', () => {
        if (document.body.classList.contains('light-theme')) {
            document.body.classList.replace('light-theme', 'dark-theme');
            if (sunIcon) sunIcon.classList.add('hidden');
            if (moonIcon) moonIcon.classList.remove('hidden');
            if (themeText) themeText.innerText = 'Light Theme';
            localStorage.setItem('theme', 'dark');
            logToConsole('system', 'Theme changed to Dark Mode.');
        } else {
            document.body.classList.replace('dark-theme', 'light-theme');
            if (sunIcon) sunIcon.classList.remove('hidden');
            if (moonIcon) moonIcon.classList.add('hidden');
            if (themeText) themeText.innerText = 'Dark Theme';
            localStorage.setItem('theme', 'light');
            logToConsole('system', 'Theme changed to Light Mode.');
        }
    });
}
