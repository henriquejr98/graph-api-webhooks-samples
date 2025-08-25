/**
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

var bodyParser = require('body-parser');
var express = require('express');
var xhub = require('express-x-hub');
var app = express();

// ------------------- FETCH CONFIGURATION -------------------
// Use global fetch (Node 18+) or fallback
const fetch = global.fetch || require('node-fetch');

// ------------------- CONFIG -------------------
var PORT = process.env.PORT || 5000;
app.set('port', PORT);

// Webhooks
app.use(xhub({ algorithm: 'sha1', secret: process.env.APP_SECRET }));
app.use(bodyParser.json());

var token = process.env.TOKEN || 'token';
var received_updates = [];

// OAuth / Graph
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET; // já usado no xhub também
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;

const SCOPES = [
  'instagram_basic',
  'instagram_manage_insights',
  'pages_show_list',
  'pages_read_engagement'
].join(',');

// Para DEV: guardar token em memória (troque por DB em prod)
let USER_TOKEN = null;

// ------------------- HELPERS -------------------
function buildUrl(base, params) {
  const u = new URL(base);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) u.searchParams.append(k, v);
  });
  return u.toString();
}

async function fbGet(url, params) {
  const res = await fetch(buildUrl(url, params));
  let json = {};
  try { json = await res.json(); } catch (e) {}
  if (!res.ok || (json && json.error)) {
    return { ok: false, status: res.status, data: json };
  }
  return { ok: true, status: res.status, data: json };
}

async function getIgUserId(userToken) {
  // 1) Páginas que o usuário gerencia
  const pages = await fbGet('https://graph.facebook.com/v19.0/me/accounts', {
    access_token: userToken
  });
  if (!pages.ok) return { err: pages };

  // 2) Para cada página, verifica IG vinculado
  for (const pg of pages.data.data || []) {
    const q = await fbGet(`https://graph.facebook.com/v19.0/${pg.id}`, {
      fields: 'instagram_business_account',
      access_token: userToken
    });
    const igb = q.ok && q.data && q.data.instagram_business_account;
    if (igb && igb.id) return { igUserId: igb.id };
  }
  return { err: { ok: false, error: 'Nenhuma conta IG vinculada às páginas desse usuário.' } };
}

// ------------------- ROTAS BÁSICAS -------------------
app.get('/health', (req, res) => res.send('ok'));

app.get('/', function(req, res) {
  res.send(
    `<pre>
Webhook updates (últimos ${received_updates.length}):
${JSON.stringify(received_updates, null, 2)}

Rotas úteis:
- GET /auth/login
- GET /profile
- GET /insights
    </pre>`
  );
});

// ------------------- VERIFICAÇÃO DE WEBHOOKS -------------------
app.get(['/facebook', '/instagram', '/threads'], function(req, res) {
  if (
    req.query['hub.mode'] == 'subscribe' &&
    req.query['hub.verify_token'] == token
  ) {
    return res.send(req.query['hub.challenge']);
  }
  return res.sendStatus(400);
});

app.post('/facebook', function(req, res) {
  console.log('Facebook request body:', req.body);

  if (!req.isXHubValid()) {
    console.log('Warning - request header X-Hub-Signature not present or invalid');
    return res.sendStatus(401);
  }

  console.log('request header X-Hub-Signature validated');
  received_updates.unshift(req.body);
  return res.sendStatus(200);
});

app.post('/instagram', function(req, res) {
  console.log('Instagram request body:', req.body);
  received_updates.unshift(req.body);
  return res.sendStatus(200);
});

app.post('/threads', function(req, res) {
  console.log('Threads request body:', req.body);
  received_updates.unshift(req.body);
  return res.sendStatus(200);
});

// ------------------- OAUTH: LOGIN + CALLBACK -------------------
app.get('/auth/login', (req, res) => {
  if (!APP_ID || !APP_SECRET) {
    return res.status(500).json({ ok:false, error: 'APP_ID/APP_SECRET ausentes nas variáveis de ambiente.' });
  }
  const url = buildUrl('https://www.facebook.com/v19.0/dialog/oauth', {
    client_id: APP_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    response_type: 'code'
  });
  return res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ ok:false, error: "Faltou 'code' no callback." });

  // Short-lived user token
  const t1 = await fbGet('https://graph.facebook.com/v19.0/oauth/access_token', {
    client_id: APP_ID,
    client_secret: APP_SECRET,
    redirect_uri: REDIRECT_URI,
    code
  });
  if (!t1.ok) return res.status(400).json(t1);

  USER_TOKEN = t1.data.access_token;

  // Troca por long-lived (opcional em DEV, útil pra não expirar rápido)
  const t2 = await fbGet('https://graph.facebook.com/v19.0/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: APP_ID,
    client_secret: APP_SECRET,
    fb_exchange_token: USER_TOKEN
  });
  if (t2.ok) USER_TOKEN = t2.data.access_token;

  return res.json({ ok: true, message: 'Login concluído', next: ['/profile','/insights'] });
});

// ------------------- PERFIL E INSIGHTS -------------------
app.get('/profile', async (req, res) => {
  if (!USER_TOKEN) return res.status(401).json({ ok:false, error: 'Faça login em /auth/login primeiro.' });

  const { igUserId, err } = await getIgUserId(USER_TOKEN);
  if (!igUserId) return res.status(400).json(err);

  const profile = await fbGet(`https://graph.facebook.com/v19.0/${igUserId}`, {
    fields: 'id,username,profile_picture_url',
    access_token: USER_TOKEN
  });
  if (!profile.ok) return res.status(400).json(profile);

  return res.json({ ok:true, ig_user_id: igUserId, profile: profile.data });
});

app.get('/insights', async (req, res) => {
  if (!USER_TOKEN) return res.status(401).json({ ok:false, error: 'Faça login em /auth/login primeiro.' });

  const { igUserId, err } = await getIgUserId(USER_TOKEN);
  if (!igUserId) return res.status(400).json(err);

  const now = Math.floor(Date.now() / 1000);
  const since = now - 7 * 24 * 60 * 60;

  const metrics = 'impressions,reach,profile_views';
  const ins = await fbGet(`https://graph.facebook.com/v19.0/${igUserId}/insights`, {
    metric: metrics,
    period: 'day',
    since: since.toString(),
    until: now.toString(),
    access_token: USER_TOKEN
  });
  if (!ins.ok) return res.status(400).json(ins);

  return res.json({ ok:true, ig_user_id: igUserId, insights_7d: ins.data });
});

// ------------------- START SERVER -------------------
app.listen(app.get('port'), () => {
  console.log(`Server listening on port ${app.get('port')}`);
});