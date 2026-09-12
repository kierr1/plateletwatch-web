require('dotenv').config();
const express     = require('express');
const fetch       = require('node-fetch');
const path        = require('path');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const { exec }    = require('child_process');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase admin client (SERVICE ROLE key — server-side only, never
// exposed to the browser). Used to verify logged-in users and to read/
// write their per-user chat quota. Get this key from:
// Supabase Dashboard → Project Settings → API → service_role key
// ────────────────────────────────────────────────────────────────────
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEFAULT_DAILY_LIMIT = 30; // messages/day per user if no row exists yet

// Verifies the user's Supabase access token (sent from the frontend as
// "Authorization: Bearer <token>") and checks/deducts their daily quota.
// Returns { ok: true, userId } or { ok: false, status, error }.
async function checkAndConsumeQuota(authHeader) {
  const token = (authHeader || '').replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, status: 401, error: 'Not signed in.' };

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) {
    // TEMPORARY: log the real reason so we can see it in Render's logs.
    // Remove this console.error once the issue is fixed.
    console.error('Auth check failed:', authErr?.message || 'no user returned', {
      hasToken: !!token,
      tokenLength: token.length,
      supabaseUrlSet: !!process.env.SUPABASE_URL,
      serviceKeySet: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    return { ok: false, status: 401, error: 'Invalid or expired session.' };
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let { data: usage, error: fetchErr } = await supabaseAdmin
    .from('chat_usage')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (fetchErr) return { ok: false, status: 500, error: 'Quota lookup failed.' };

  // No row yet -> create one with defaults
  if (!usage) {
    const { data: created, error: insertErr } = await supabaseAdmin
      .from('chat_usage')
      .insert({ user_id: user.id, messages_used: 0, daily_limit: DEFAULT_DAILY_LIMIT, last_reset_date: today })
      .select()
      .single();
    if (insertErr) return { ok: false, status: 500, error: 'Could not create quota record.' };
    usage = created;
  }

  // Reset counter if it's a new day
  if (usage.last_reset_date !== today) {
    usage.messages_used = 0;
    usage.last_reset_date = today;
  }

  if (usage.messages_used >= usage.daily_limit) {
    // Persist the reset even if they're over limit, so tomorrow starts clean
    await supabaseAdmin.from('chat_usage').update({
      messages_used: usage.messages_used,
      last_reset_date: usage.last_reset_date,
    }).eq('user_id', user.id);
    return {
      ok: false,
      status: 429,
      error: `You've used all ${usage.daily_limit} chat messages for today. Resets tomorrow.`,
    };
  }

  // Consume one message from their quota
  const { error: updateErr } = await supabaseAdmin
    .from('chat_usage')
    .update({
      messages_used: usage.messages_used + 1,
      last_reset_date: usage.last_reset_date,
    })
    .eq('user_id', user.id);

  if (updateErr) return { ok: false, status: 500, error: 'Could not update quota.' };

  return {
    ok: true,
    userId: user.id,
    remaining: usage.daily_limit - (usage.messages_used + 1),
  };
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Trust proxy (required when running behind Cloudflare Tunnel) ──────
// Cloudflare Tunnel adds X-Forwarded-For headers with the real client IP.
// Setting trust proxy = 1 tells Express to trust the first proxy hop (Cloudflare),
// which allows express-rate-limit to correctly identify users by their real IP
// instead of treating all tunnel traffic as the same IP address.
// This is safe because Cloudflare is a legitimate, controlled proxy.
app.set('trust proxy', 1);

// ── Security Headers ──────────────────────────────────────────────────
// CSP is disabled because the app uses inline onclick handlers and inline
// scripts throughout the HTML. Helmet still adds all other security headers:
// X-Frame-Options, X-Content-Type-Options, Referrer-Policy, etc.
app.use(helmet({
  contentSecurityPolicy: false,  // would break inline onclick handlers in HTML
  crossOriginEmbedderPolicy: false,
}));

// ── Block ONLY the .env file — nothing else ───────────────────────────
// supabase.config.js is intentionally served (it's a public anon key)
app.use((req, res, next) => {
  const basename = path.basename(req.path);
  if (basename === '.env' || basename === '_env') {
    return res.status(403).send('Forbidden');
  }
  next();
});

// ── Clean page routes (hide .html extensions from the address bar) ────
const PAGE_ROUTES = {
  '/':               'index.html',
  '/signin':         'signin.html',
  '/register':       'Register.html',
  '/forgotpassword': 'Forgotpassword.html',
  '/dashboard':      'all-tab.html',
};
for (const [route, file] of Object.entries(PAGE_ROUTES)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
}

// ── Redirect direct .html hits back to their clean URL ──────────────────
const HTML_REDIRECTS = {
  '/index.html':          '/',
  '/signin.html':         '/signin',
  '/Register.html':       '/register',
  '/register.html':       '/register',
  '/Forgotpassword.html': '/forgotpassword',
  '/forgotpassword.html': '/forgotpassword',
  '/all-tab.html':        '/dashboard',
};
app.get(Object.keys(HTML_REDIRECTS), (req, res) => {
  res.redirect(301, HTML_REDIRECTS[req.path]);
});

// ── Static files ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname), { dotfiles: 'deny', index: false }));
app.use(express.json({ limit: '10mb' }));

// ── Rate Limiters ─────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI request limit reached. Please wait before trying again.' },
});

app.use('/api/', generalLimiter);

// ── YOLOv8 Image Analysis (local inference server on port 8000) ───────
// Requires inference_server.py to be running: python inference_server.py
const INFERENCE_URL = process.env.INFERENCE_URL || "https://plateletwatch-infer.xyz";

// ── Live queue status (so the frontend can show real position/wait time
// instead of generic "processing..." text during a busy period) ────────
app.get('/api/queue-status', async (req, res) => {
  try {
    const response = await fetch(`${INFERENCE_URL}/queue-status`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('Inference server queue-status not ok');
    const data = await response.json();
    res.json(data);
  } catch (err) {
    // Non-fatal -- the frontend just won't show live queue info if this fails.
    res.status(503).json({ error: 'Queue status unavailable.' });
  }
});

app.post('/api/analyze-image', aiLimiter, async (req, res) => {
  const { image, mediaType, zoom, confidence } = req.body;

  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid image data.' });
  }
  if (image.length > 8_000_000) {
    return res.status(413).json({ error: 'Image too large. Please use an image under 6 MB.' });
  }

  // Check inference server is reachable first
  try {
    const health = await fetch(`${INFERENCE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error('Inference server not healthy');
  } catch {
    return res.status(503).json({
      error: 'YOLOv8 inference server is not running. Start it with: python inference_server.py'
    });
  }

  try {
    const response = await fetch(`${INFERENCE_URL}/api/analyze-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Forward the zoom level the user actually selected (10x/40x/100x) —
      // inference_server.py uses this to pick the correct calibration factor.
      // Previously this was never forwarded, so it silently defaulted to 40x.
      body: JSON.stringify({
        image,
        mediaType,
        zoom: zoom || '40x',
        confidence: confidence || 0.25,
      }),
      signal: AbortSignal.timeout(30000), // 30s timeout for large images
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.detail || 'Inference failed.' });
    }

    const data = await response.json();

    // The smear-gate classifier in inference_server.py can reject an image
    // before any detection ever runs, returning just:
    //   { not_blood_sample: true, reason: "..." }
    // This must be forwarded to the frontend as-is -- it does NOT have
    // platelets/rbc/wbc/etc fields, so reshaping it below would silently
    // strip the rejection flag and reason, making every rejected image
    // look like a normal (empty) result to the browser.
    if (data.not_blood_sample) {
      return res.json({
        not_blood_sample: true,
        reason: data.reason || 'This image does not appear to be a valid blood smear.',
      });
    }

    // Real response shape from inference_server.py:
    // { platelets, rbc, wbc, est_per_ul, calib_factor, zoom, zoom_note,
    //   severity, severity_label, severity_color, clinical_note, note,
    //   detections, total_objects, image_size }
    // severity is already one of NORMAL/LOW/DANGER/CRITICAL/HIGH/UNKNOWN,
    // matching what the frontend expects directly — no relabeling needed.
    res.json({
      platelets:   data.platelets   || 0,
      rbc:         data.rbc         || 0,
      wbc:         data.wbc         || 0,
      est_per_ul:  data.est_per_ul  || 0,
      severity:    data.severity    || 'UNKNOWN',
      detections:  data.detections  || [],
      note:        data.note || data.clinical_note || '',
      zoom:        data.zoom || null,
    });

  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ error: 'Image analysis failed. Please try again.' });
  }
});

// ── Main Chat Proxy (Groq, with per-user daily quota) ─────────────────
app.post('/api/chat', aiLimiter, async (req, res) => {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server.' });
  }

  // Every logged-in user gets their own daily message quota, tracked in
  // Supabase (see chat_usage_migration.sql). Anonymous requests are rejected.
  const quota = await checkAndConsumeQuota(req.headers.authorization);
  if (!quota.ok) {
    return res.status(quota.status).json({ error: quota.error });
  }

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid messages array.' });
  }
  if (messages.length > 50) {
    return res.status(400).json({ error: 'Too many messages in conversation.' });
  }

  // Groq-hosted free models. Adjust to whatever's current in your Groq console.
  const safeModel = 'openai/gpt-oss-120b';

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({ messages, model: safeModel }),
    });

    const data = await response.json();
    // Let the frontend show a "X messages left today" indicator if you want.
    res.status(response.status).json({ ...data, _quota_remaining: quota.remaining });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Chat request failed. Please try again.' });
  }
});

// ── 404 fallback ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  // Find local LAN IP for phone access
  let lanIp = 'localhost';
  try {
    const nets = os.networkInterfaces();
    for (const ifaces of Object.values(nets)) {
      for (const iface of ifaces) {
        if (iface.family === 'IPv4' && !iface.internal) { lanIp = iface.address; break; }
      }
      if (lanIp !== 'localhost') break;
    }
  } catch (_) {}

  console.log(`\n✅  PlateletWatch is running!\n`);
  console.log(`   💻  Laptop  →  http://localhost:${PORT}/`);
  console.log(`   📱  Phone   →  http://${lanIp}:${PORT}/`);
  console.log(`   🔬  AI API  →  http://localhost:${PORT}/api/chat\n`);

  // ── Cloudflare Tunnel for remote testers ─────────────────────────────
  // Exposes port 3000 publicly so testers outside your WiFi can connect.
  // No account needed. Download cloudflared.exe from:
  // github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
  // Put it in the same folder as server.js.
  //
  // To enable:  set USE_TUNNEL=1 && node server.js
  // To disable: just run node server.js (default, tunnel off)
  if (process.env.USE_TUNNEL === '1') {
    const { spawn } = require('child_process');
    const path = require('path');
    const cloudflared = path.join(__dirname, 'cloudflared.exe');

    const fs = require('fs');
    if (!fs.existsSync(cloudflared)) {
      console.log('   ⚠️   cloudflared.exe not found in project folder.');
      console.log('   📥  Download from:');
      console.log('        github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe');
      console.log('        Put it in the same folder as server.js\n');
    } else {
      const tunnel = spawn(cloudflared, ['tunnel', '--url', `http://localhost:${PORT}`], {
        cwd: __dirname,
      });

      tunnel.stdout.on('data', (data) => {
        const line = data.toString();
        const match = line.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
        if (match) {
          console.log(`\n${'='.repeat(60)}`);
          console.log(`   🌐  PUBLIC URL FOR REMOTE TESTERS:`);
          console.log(`   🔗  ${match[0]}`);
          console.log(`${'='.repeat(60)}`);
          console.log(`   Share this URL with testers outside your WiFi.`);
          console.log(`   Local WiFi testers still use: http://${lanIp}:${PORT}/\n`);
        }
      });

      tunnel.stderr.on('data', (data) => {
        const line = data.toString();
        const match = line.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
        if (match) {
          console.log(`\n${'='.repeat(60)}`);
          console.log(`   🌐  PUBLIC URL FOR REMOTE TESTERS:`);
          console.log(`   🔗  ${match[0]}`);
          console.log(`${'='.repeat(60)}`);
          console.log(`   Share this URL with testers outside your WiFi.`);
          console.log(`   Local WiFi testers still use: http://${lanIp}:${PORT}/\n`);
        }
      });

      tunnel.on('error', (err) => {
        console.log(`   ⚠️   Tunnel error: ${err.message}`);
      });

      console.log('   🌐  Starting Cloudflare Tunnel... (URL will appear above in a moment)\n');
    }
  } else {
    console.log('   ℹ️   Remote access disabled (tunnel off).');
    console.log('   💡  To enable: set USE_TUNNEL=1 && node server.js\n');
  }

  // Auto-open browser (cross-platform)
  const url = `http://localhost:${PORT}/`;
  const opener =
    process.platform === 'win32'  ? `start ""  "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
                                    `xdg-open "${url}"`;
  exec(opener, err => {
    if (err) console.log(`   ℹ️   Could not auto-open browser. Open manually: ${url}`);
  });
});
