require('dotenv').config();
const express = require('express');
const path = require('path');
const { log, error } = require('./utils/logger');

// Import modules
const skoolFreeInvite = require('./modules/skoolFreeInvite');
const skoolFreeJoin = require('./modules/skoolFreeJoin');
const skoolProInvite = require('./modules/skoolProInvite');
const skoolProJoin = require('./modules/skoolProJoin');
const skoolProVerify = require('./modules/skoolProVerify');
const zoomAttendance = require('./modules/zoomAttendance');
const commissionLogic = require('./modules/commissionLogic');
const captionGenerator = require('./modules/captionGenerator');
const performanceReporter = require('./modules/performanceReporter');

const app = express();
app.use(express.static(path.join(__dirname, './public')));
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
  const allowedOrigins = [
    'https://influencerfounder.com',
    'https://www.influencerfounder.com',
    'http://localhost:3000'
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─────────────────────────────────────────
// HELPER — clean location ID
// GHL sometimes appends garbage characters after the location ID
// Location IDs are alphanumeric only — strip anything else
// ─────────────────────────────────────────

function cleanLocationId(lid) {
  if (!lid) return null;
  // Keep only alphanumeric characters — GHL location IDs are always alphanumeric
  return lid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
}

// ─────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────

app.get('/', (req, res) => {
  log('SERVER', 'Health check ping received');
  res.json({
    status: 'ok',
    service: 'InfluencerFounder AI Service',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────
// STATIC PAGES
// ─────────────────────────────────────────

app.get('/onboarding.html', (req, res) => {
  res.sendFile(path.join(__dirname, './public/onboarding.html'));
});

app.get('/caption.html', (req, res) => {
  res.sendFile(path.join(__dirname, './public/caption.html'));
});

app.get('/upload.html', (req, res) => {
  res.sendFile(path.join(__dirname, './public/upload.html'));
});

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, './public/dashboard.html'));
});

app.get('/ai-influencer-generator.html', (req, res) => {
  res.sendFile(path.join(__dirname, './public/ai-influencer-generator.html'));
});

// ─────────────────────────────────────────
// KIE.AI PROXY
// Forwards requests to Kie.ai API to avoid browser CORS restrictions.
// Used by the AI Influencer Generator tool.
// ─────────────────────────────────────────

app.post('/api/kie/proxy', async (req, res) => {
  log('SERVER', 'Received: kie/proxy request');
  try {
    const axios = require('axios');
    const { endpoint, method = 'POST', body } = req.body;

    if (!endpoint) {
      return res.status(400).json({ success: false, error: 'Missing endpoint' });
    }

    // Only allow calls to Kie.ai API
    if (!endpoint.startsWith('https://api.kie.ai/')) {
      return res.status(403).json({ success: false, error: 'Endpoint not allowed' });
    }

    const KIE_API_KEY = process.env.KIE_API_KEY;
    if (!KIE_API_KEY) {
      return res.status(500).json({ success: false, error: 'KIE_API_KEY not configured' });
    }

    const axiosConfig = {
      method,
      url: endpoint,
      headers: {
        'Authorization': `Bearer ${KIE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    };

    // Only attach body for non-GET requests
    if (method.toUpperCase() !== 'GET' && body) {
      axiosConfig.data = body;
    }

    const response = await axios(axiosConfig);

    res.json({ success: true, data: response.data });

  } catch (err) {
    error('SERVER', 'Error in kie/proxy', err);
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

// ─────────────────────────────────────────
// KIE.AI FILE UPLOAD PROXY
// Handles multipart file uploads to Kie.ai (reference images)
// ─────────────────────────────────────────

app.post('/api/kie/upload', async (req, res) => {
  log('SERVER', 'Received: kie/upload request');
  try {
    const axios = require('axios');
    const FormData = require('form-data');
    const multer = require('multer');

    const KIE_API_KEY = process.env.KIE_API_KEY;
    if (!KIE_API_KEY) {
      return res.status(500).json({ success: false, error: 'KIE_API_KEY not configured' });
    }

    // Use multer to parse the incoming multipart form data
    const upload = multer({ storage: multer.memoryStorage() }).single('file');

    upload(req, res, async (err) => {
      if (err) {
        return res.status(400).json({ success: false, error: 'File upload error: ' + err.message });
      }

      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file provided' });
      }

      try {
        // Build a new FormData to forward to Kie.ai
        const form = new FormData();
        form.append('file', req.file.buffer, {
          filename: req.file.originalname || 'upload.png',
          contentType: req.file.mimetype || 'image/png',
        });

        const response = await axios.post('https://kieai.redpandaai.co/api/file-stream-upload', form, {
          headers: {
            'Authorization': `Bearer ${KIE_API_KEY}`,
            ...form.getHeaders()
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity
        });

        log('SERVER', 'File uploaded to Kie.ai successfully');
        // Return the downloadUrl which can be passed as input_urls to generation
        const fileUrl = response.data?.data?.downloadUrl || response.data?.data?.fileUrl;
        res.json({ success: true, url: fileUrl, data: response.data });

      } catch (uploadErr) {
        error('SERVER', 'Error forwarding upload to Kie.ai', uploadErr);
        const status = uploadErr.response?.status || 500;
        const message = uploadErr.response?.data?.message || uploadErr.message;
        res.status(status).json({ success: false, error: message });
      }
    });

  } catch (err) {
    error('SERVER', 'Error in kie/upload', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// OPT-IN FORM SUBMISSION
// ─────────────────────────────────────────

app.post('/api/contact/optin', async (req, res) => {
  log('SERVER', 'Received: contact optin form submission');
  try {
    const { first_name, email } = req.body;

    if (!email || !first_name) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const { createContact, addTags } = require('./clients/ghl');

    const contact = await createContact(process.env.GHL_LOCATION_ID, {
      firstName: first_name,
      email: email,
      source: 'Opt-in Page'
    });

    if (!contact) {
      return res.status(500).json({ success: false, error: 'Failed to create contact' });
    }

    await addTags(contact.id, ['beh_optin', 'src_website']);

    log('SERVER', `Contact created: ${contact.id} for ${email}`);
    res.json({ success: true, contactId: contact.id });

  } catch (err) {
    error('SERVER', 'Error in contact optin', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// WHATSAPP NUMBER CAPTURE
// ─────────────────────────────────────────

app.post('/api/contact/whatsapp', async (req, res) => {
  log('SERVER', 'Received: WhatsApp number capture');
  try {
    const { phone, email } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Missing phone number' });
    }

    const { getContactByEmail, updateContact, addTags } = require('./clients/ghl');

    let contactId = null;

    if (email) {
      const contact = await getContactByEmail(email, process.env.GHL_LOCATION_ID);
      if (contact) contactId = contact.id;
    }

    if (contactId) {
      await updateContact(contactId, { phone });
      await addTags(contactId, ['channel_whatsapp', 'beh_whatsapp_freebie_requested']);
      log('SERVER', `Updated contact ${contactId} with WhatsApp number`);
    }

    res.json({ success: true });

  } catch (err) {
    error('SERVER', 'Error in whatsapp capture', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// TRAINING UPDATE
// ─────────────────────────────────────────

app.post('/api/training/update', async (req, res) => {
  log('SERVER', 'Received: training update request');
  try {
    const { date, time, link, secret } = req.body;

    if (secret !== process.env.TRAINING_UPDATE_SECRET) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    if (!date || !time || !link) {
      return res.status(400).json({ success: false, error: 'Missing date, time or link' });
    }

    const { updateTrainingAcrossAllAccounts } = require('./clients/ghl');
    const results = await updateTrainingAcrossAllAccounts(date, time, link);

    log('SERVER', `Training updated across ${results.length} sub-accounts`);
    res.json({ success: true, updated: results.length, results });

  } catch (err) {
    error('SERVER', 'Error in training update', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// SKOOL ROUTES
// ─────────────────────────────────────────

app.post('/webhooks/skool/free-invite', async (req, res) => {
  log('SERVER', 'Received: skool/free-invite');
  try {
    await skoolFreeInvite.handle(req.body);
    res.json({ success: true });
  } catch (err) {
    error('SERVER', 'Error in skool/free-invite', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/webhooks/skool/free-join', async (req, res) => {
  log('SERVER', 'Received: skool/free-join');
  try {
    await skoolFreeJoin.handle(req.body);
    res.json({ success: true });
  } catch (err) {
    error('SERVER', 'Error in skool/free-join', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/webhooks/skool/pro-invite', async (req, res) => {
  log('SERVER', 'Received: skool/pro-invite');
  try {
    await skoolProInvite.handle(req.body);
    res.json({ success: true });
  } catch (err) {
    error('SERVER', 'Error in skool/pro-invite', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/webhooks/skool/pro-join', async (req, res) => {
  log('SERVER', 'Received: skool/pro-join');
  try {
    await skoolProJoin.handle(req.body);
    res.json({ success: true });
  } catch (err) {
    error('SERVER', 'Error in skool/pro-join', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/webhooks/skool/pro-verify', async (req, res) => {
  log('SERVER', 'Received: skool/pro-verify');
  try {
    const result = await skoolProVerify.handle(req.body);
    res.json({ success: true, action: result.action });
  } catch (err) {
    error('SERVER', 'Error in skool/pro-verify', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// ZOOM ROUTES
// ─────────────────────────────────────────

app.post('/webhooks/zoom/attendance', async (req, res) => {
  log('SERVER', 'Received: zoom/attendance');
  try {
    await zoomAttendance.handle(req.body);
    res.json({ success: true });
  } catch (err) {
    error('SERVER', 'Error in zoom/attendance', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// COMMISSION ROUTES
// ─────────────────────────────────────────

app.post('/webhooks/commission/new-sale', async (req, res) => {
  log('SERVER', 'Received: commission/new-sale');
  try {
    await commissionLogic.handleNewSale(req.body);
    res.json({ success: true });
  } catch (err) {
    error('SERVER', 'Error in commission/new-sale', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/webhooks/commission/refund', async (req, res) => {
  log('SERVER', 'Received: commission/refund');
  try {
    await commissionLogic.handleRefund(req.body);
    res.json({ success: true });
  } catch (err) {
    error('SERVER', 'Error in commission/refund', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// CAPTION GENERATOR
// ─────────────────────────────────────────

app.post('/api/caption/generate', async (req, res) => {
  log('SERVER', 'Received: caption/generate');
  try {
    const caption = await captionGenerator.generate(req.body);
    res.json({ success: true, caption });
  } catch (err) {
    error('SERVER', 'Error in caption/generate', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// PERFORMANCE REPORTER
// ─────────────────────────────────────────

app.post('/api/reports/weekly', async (req, res) => {
  log('SERVER', 'Received: reports/weekly');
  try {
    await performanceReporter.generate(req.body);
    res.json({ success: true });
  } catch (err) {
    error('SERVER', 'Error in reports/weekly', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// DEBUG — fetch social accounts
// ─────────────────────────────────────────

app.get('/api/debug/social-accounts', async (req, res) => {
  try {
    const locationId = cleanLocationId(req.query.lid) || process.env.GHL_LOCATION_ID;
    const axios = require('axios');
    const results = {};

    try {
      const r1 = await axios.get(
        `https://services.leadconnectorhq.com/social-media-posting/oauth/${locationId}/accounts`,
        { headers: { 'Authorization': `Bearer ${process.env.GHL_AGENCY_API_KEY}`, 'Version': '2021-07-28' } }
      );
      results.endpoint1 = r1.data;
    } catch (e) { results.endpoint1_error = e.response?.data || e.message; }

    try {
      const r2 = await axios.get(
        `https://services.leadconnectorhq.com/social-media-posting/${locationId}/accounts`,
        { headers: { 'Authorization': `Bearer ${process.env.GHL_AGENCY_API_KEY}`, 'Version': '2021-07-28' } }
      );
      results.endpoint2 = r2.data;
    } catch (e) { results.endpoint2_error = e.response?.data || e.message; }

    res.json({ locationId, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// DEBUG — fetch posts
// ─────────────────────────────────────────

app.get('/api/debug/posts', async (req, res) => {
  try {
    const locationId = cleanLocationId(req.query.lid) || process.env.GHL_LOCATION_ID;
    const axios = require('axios');
    const results = {};

    try {
      const r1 = await axios.get(
        `https://services.leadconnectorhq.com/social-media-posting/${locationId}/posts`,
        {
          headers: { 'Authorization': `Bearer ${process.env.GHL_AGENCY_API_KEY}`, 'Version': '2021-07-28' },
          params: { limit: 10, skip: 0 }
        }
      );
      results.endpoint1 = r1.data;
    } catch (e) { results.endpoint1_error = e.response?.data || e.message; }

    try {
      const r2 = await axios.get(
        `https://services.leadconnectorhq.com/social-media-posting/posts`,
        {
          headers: { 'Authorization': `Bearer ${process.env.GHL_AGENCY_API_KEY}`, 'Version': '2021-07-28' },
          params: { locationId, limit: 10, skip: 0 }
        }
      );
      results.endpoint2 = r2.data;
    } catch (e) { results.endpoint2_error = e.response?.data || e.message; }

    try {
      const r3 = await axios.get(
        `https://services.leadconnectorhq.com/social-media-posting/${locationId}/posts`,
        {
          headers: { 'Authorization': `Bearer ${process.env.GHL_AGENCY_API_KEY}`, 'Version': '2021-04-15' },
          params: { limit: 10, skip: 0 }
        }
      );
      results.endpoint3 = r3.data;
    } catch (e) { results.endpoint3_error = e.response?.data || e.message; }

    res.json({ locationId, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// VIDEO UPLOAD — signed URL, bypasses Vercel size limit
// ─────────────────────────────────────────

app.post('/api/upload/signed-url', async (req, res) => {
  log('SERVER', 'Received: upload/signed-url');
  try {
    const locationId = cleanLocationId(req.body.locationId) || process.env.GHL_LOCATION_ID;

    res.json({
      success: true,
      uploadUrl: `https://services.leadconnectorhq.com/medias/upload-file?locationId=${locationId}`,
      headers: {
        'Authorization': `Bearer ${process.env.GHL_AGENCY_API_KEY}`,
        'Version': '2021-07-28'
      }
    });

  } catch (err) {
    error('SERVER', 'Error in upload/signed-url', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// SCHEDULE — NEXT SLOT
// ─────────────────────────────────────────

app.post('/api/schedule/next-slot', async (req, res) => {
  log('SERVER', 'Received: schedule/next-slot');
  try {
    const locationId = cleanLocationId(req.body.locationId) || process.env.GHL_LOCATION_ID;
    const { category, timezone } = req.body;

    const { getScheduledPosts } = require('./clients/ghl');
    const scheduled = await getScheduledPosts(locationId);

    const eveningCategories = ['Community Invite', 'Webinar Invite'];
    const preferEvening = eveningCategories.includes(category);

    const slot = findNextSlot(scheduled || [], preferEvening, timezone);

    res.json({ success: true, slot });

  } catch (err) {
    error('SERVER', 'Error in schedule/next-slot', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// SCHEDULE — CONFIRM POST
// ─────────────────────────────────────────

app.post('/api/schedule/post', async (req, res) => {
  log('SERVER', 'Received: schedule/post');
  try {
    const locationId = cleanLocationId(req.body.locationId) || process.env.GHL_LOCATION_ID;
    const { mediaId, mediaUrl, caption, platforms, category, timezone } = req.body;

    log('SERVER', `schedule/post — locationId: ${locationId} mediaUrl: ${mediaUrl}`);

    const { getScheduledPosts, createSocialPost } = require('./clients/ghl');

    const scheduled = await getScheduledPosts(locationId);
    const eveningCategories = ['Community Invite', 'Webinar Invite'];
    const preferEvening = eveningCategories.includes(category);
    const slot = findNextSlot(scheduled || [], preferEvening, timezone);

    const post = await createSocialPost(locationId, {
      mediaId,
      mediaUrl,
      caption,
      platforms,
      scheduledAt: slot.isoDateTime,
      category
    });

    if (!post) {
      return res.status(500).json({ success: false, error: 'Failed to create scheduled post' });
    }

    log('SERVER', `Post scheduled for ${slot.date} at ${slot.time} (${timezone})`);
    res.json({ success: true, post, slot });

  } catch (err) {
    error('SERVER', 'Error in schedule/post', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// DASHBOARD DATA
// ─────────────────────────────────────────

app.get('/api/dashboard/data', async (req, res) => {
  log('SERVER', 'Received: dashboard/data');
  try {
    const locationId = cleanLocationId(req.query.lid) || process.env.GHL_LOCATION_ID;

    log('SERVER', `dashboard/data — locationId: ${locationId}`);

    const { getScheduledPosts, getLocationInfo } = require('./clients/ghl');

    const [posts, locationInfo] = await Promise.all([
      getScheduledPosts(locationId),
      getLocationInfo(locationId)
    ]);

    const allPosts = posts || [];
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 7);

    const scheduled = allPosts.filter(p => p.status === 'scheduled').length;
    const published = allPosts.filter(p => p.status === 'published').length;
    const thisWeek = allPosts.filter(p => {
      const d = new Date(p.scheduledAt);
      return d >= startOfWeek && d < endOfWeek;
    }).length;

    const streak = calculateStreak(allPosts);

    const upcoming = allPosts
      .filter(p => p.status === 'scheduled' && new Date(p.scheduledAt) > now)
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

    const nextPost = upcoming[0] ? formatPostForClient(upcoming[0]) : null;
    const weekSchedule = buildWeekSchedule(allPosts, startOfWeek);

    const recentPosts = allPosts
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
      .slice(0, 10)
      .map(formatPostForClient);

    res.json({
      success: true,
      aiName: locationInfo?.name || '',
      stats: { scheduled, published, thisWeek },
      streak,
      nextPost,
      weekSchedule,
      recentPosts
    });

  } catch (err) {
    error('SERVER', 'Error in dashboard/data', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// SLOT HELPER FUNCTIONS
// ─────────────────────────────────────────

function findNextSlot(scheduledPosts, preferEvening = false, timezone = 'Europe/Amsterdam') {
  const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));

  const takenSlots = new Set(
    scheduledPosts
      .filter(p => p.status === 'scheduled')
      .map(p => {
        const d = new Date(new Date(p.scheduledAt).toLocaleString('en-US', { timeZone: timezone }));
        return `${d.toDateString()}-${d.getHours()}`;
      })
  );

  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    const date = new Date(nowInTz);
    date.setDate(nowInTz.getDate() + dayOffset);

    const slots = preferEvening
      ? [{ hour: 18, label: '6:00 PM' }, { hour: 9, label: '9:00 AM' }]
      : [{ hour: 9, label: '9:00 AM' }, { hour: 18, label: '6:00 PM' }];

    for (const slot of slots) {
      const slotDate = new Date(date);
      slotDate.setHours(slot.hour, 0, 0, 0);

      const bufferTime = new Date(nowInTz.getTime() + 2 * 60 * 60 * 1000);
      if (slotDate <= bufferTime) continue;

      const key = `${slotDate.toDateString()}-${slot.hour}`;
      if (!takenSlots.has(key)) {
        const utcDate = new Date(slotDate.toLocaleString('en-US', { timeZone: 'UTC' }));
        return {
          date: slotDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
          time: slot.label,
          isoDateTime: utcDate.toISOString()
        };
      }
    }
  }

  const fallback = new Date(nowInTz);
  fallback.setDate(nowInTz.getDate() + 1);
  fallback.setHours(9, 0, 0, 0);
  const fallbackUtc = new Date(fallback.toLocaleString('en-US', { timeZone: 'UTC' }));
  return {
    date: fallback.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
    time: '9:00 AM',
    isoDateTime: fallbackUtc.toISOString()
  };
}

function calculateStreak(posts) {
  const publishedDates = new Set(
    posts
      .filter(p => p.status === 'published')
      .map(p => new Date(p.scheduledAt).toDateString())
  );

  let streak = 0;
  const today = new Date();

  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    if (publishedDates.has(d.toDateString())) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

function buildWeekSchedule(posts, startOfWeek) {
  const week = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(startOfWeek);
    day.setDate(startOfWeek.getDate() + i);

    const dayPosts = posts.filter(p => {
      const d = new Date(p.scheduledAt);
      return d.toDateString() === day.toDateString();
    });

    const morning = dayPosts.find(p => new Date(p.scheduledAt).getHours() < 12);
    const evening = dayPosts.find(p => new Date(p.scheduledAt).getHours() >= 12);

    week.push({
      morning: morning ? { posted: morning.status === 'published', category: morning.category } : null,
      evening: evening ? { posted: evening.status === 'published', category: evening.category } : null
    });
  }
  return week;
}

function formatPostForClient(post) {
  const d = new Date(post.scheduledAt);
  return {
    status: post.status || 'scheduled',
    category: post.category || 'Post',
    date: post.scheduledAt,
    time: d.getHours() < 12 ? '9:00 AM' : '6:00 PM',
    platforms: post.platforms || []
  };
}

// ─────────────────────────────────────────
// VIRAL LAB — ANALYSE VIDEO
// Sends video URL to Claude via Kie.ai and returns full deconstruction
// ─────────────────────────────────────────

app.post('/api/viral/analyse', async (req, res) => {
  log('SERVER', 'Received: viral/analyse request');
  try {
    const axios = require('axios');
    const { videoUrl } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ success: false, error: 'Missing videoUrl' });
    }

    const KIE_API_KEY = process.env.KIE_API_KEY;
    if (!KIE_API_KEY) {
      return res.status(500).json({ success: false, error: 'KIE_API_KEY not configured' });
    }

    const systemPrompt = `You are an expert viral content analyst and AI influencer video strategist. 
Your job is to deconstruct viral social media videos and produce actionable recreation blueprints.
Always respond in valid JSON format only. No markdown, no explanation outside the JSON.`;

    const userPrompt = `Analyse this viral video: ${videoUrl}

Return a JSON object with exactly these fields:

{
  "metadata": {
    "duration": "estimated duration",
    "format": "9:16 or 16:9",
    "platform": "TikTok/Instagram/YouTube",
    "content_type": "talking head/lifestyle/walk/tutorial/etc"
  },
  "virality_scorecard": {
    "curiosity": { "score": 0-10, "reason": "why" },
    "novelty": { "score": 0-10, "reason": "why" },
    "emotional_trigger": { "score": 0-10, "emotion": "what emotion", "reason": "why" },
    "relatability": { "score": 0-10, "reason": "why" },
    "visual_interest": { "score": 0-10, "reason": "why" },
    "shareability": { "score": 0-10, "reason": "why" },
    "rewatch_potential": { "score": 0-10, "reason": "why" },
    "overall_score": 0-10,
    "verdict": "one line verdict"
  },
  "hook_analysis": {
    "type": "open loop/curiosity gap/pattern interrupt/visual surprise/emotional trigger/relatability/contrarian/story setup/fast payoff/social proof",
    "formula": "the hook formula in plain language",
    "first_3_seconds": "describe exactly what happens",
    "why_it_works": "the psychological reason"
  },
  "retention_analysis": {
    "first_retention_spike": "timestamp and what caused it",
    "pattern_interrupts": ["list each one with timestamp"],
    "curiosity_loops": ["list open loops and when they close"],
    "payoff_timing": "when the viewer gets their reward",
    "completion_driver": "why they watched to the end"
  },
  "story_framework": {
    "structure": "Problem-Solution/Before-After/Contrarian/Listicle/Day-in-life/Tutorial/Confession/Reaction/Proof Stack",
    "core_idea": "one sentence",
    "unique_angle": "what makes this take different",
    "viewer_transformation": "what viewer thinks/feels after watching"
  },
  "script_transcription": "full verbatim transcript with timestamps. If silent video describe visual narrative beat by beat.",
  "content_identity": {
    "creator_archetype": "expert/peer/entertainer/storyteller/challenger/insider",
    "energy_level": 0-10,
    "tone": "conversational/authoritative/vulnerable/humorous/deadpan/urgent",
    "editing_style": "fast cuts/static/handheld/jump cuts/smooth/raw",
    "delivery_style": "direct to camera/voiceover/silent/narrated/reaction"
  },
  "hook_variations": [
    {"type": "curiosity gap", "hook": "variation text"},
    {"type": "social proof", "hook": "variation text"},
    {"type": "problem solution", "hook": "variation text"},
    {"type": "contrarian", "hook": "variation text"},
    {"type": "identity shift", "hook": "variation text"},
    {"type": "transformation", "hook": "variation text"},
    {"type": "urgency", "hook": "variation text"},
    {"type": "simplicity", "hook": "variation text"},
    {"type": "time specific", "hook": "variation text"},
    {"type": "future pacing", "hook": "variation text"}
  ],
  "recreation_blueprint": {
    "concept": "one paragraph — what to recreate and why it works",
    "script": "full adapted script for make money online / AI influencer niche. Replace [INFLUENCER] where the character speaks or appears.",
    "shot_list": [
      {"scene": 1, "duration": "Xs", "shot_type": "close-up/mid/full body", "angle": "eye level/above/below", "movement": "static/handheld/push-in", "description": "what happens"}
    ],
    "setting": "detailed environment description for Wan 2.6",
    "lighting": "lighting description for Wan 2.6",
    "camera": "camera movement and framing for Wan 2.6",
    "editing_rhythm": "cut timing and pacing notes",
    "audio": "music mood and sound design notes",
    "wan_prompt": "Complete ready-to-use Wan 2.6 generation prompt. Use [INFLUENCER] as placeholder for the character description. This prompt should be detailed enough to generate the video immediately."
  }
}`;

    // Use Anthropic API directly — runs server-side so no CORS issues
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });
    }

    const claudeResponse = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    });

    const rawText = claudeResponse.data?.content?.[0]?.text || '';
    if (!rawText) {
      return res.status(500).json({ success: false, error: 'Empty response from Claude' });
    }

    // Parse JSON from response — strip markdown fences first
    let analysis;
    try {
      // Remove markdown code fences if present
      let jsonStr = rawText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      // Extract JSON object
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) jsonStr = jsonMatch[0];
      analysis = JSON.parse(jsonStr);
    } catch(e) {
      log('SERVER', 'Failed to parse Claude response: ' + rawText.substring(0, 500));
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to parse analysis: ' + e.message,
        raw: rawText.substring(0, 2000)
      });
    }

    log('SERVER', 'Viral analysis complete');
    res.json({ success: true, analysis });

  } catch (err) {
    error('SERVER', 'Error in viral/analyse', err);
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────

app.listen(PORT, () => {
  log('SERVER', `InfluencerFounder AI Service running on port ${PORT}`);
});

module.exports = app;