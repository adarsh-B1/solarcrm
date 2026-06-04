require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const JWT_SECRET = process.env.JWT_SECRET;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth Middleware ──
async function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.vendor = decoded;
    // Check plan
    const { data: vendor } = await supabase.from('vendors').select('*').eq('id', decoded.id).single();
    if (!vendor) return res.status(401).json({ error: 'Vendor not found' });
    // Check trial/subscription
    const now = new Date();
    if (vendor.plan === 'trial' && new Date(vendor.trial_ends_at) < now) {
      await supabase.from('vendors').update({ plan: 'expired' }).eq('id', vendor.id);
      vendor.plan = 'expired';
    }
    req.vendor = vendor;
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── REGISTER ──
app.post('/api/register', async (req, res) => {
  const { email, password, company, name, phone } = req.body;
  if (!email || !password || !company || !name) return res.status(400).json({ error: 'All fields required' });

  const { data: existing } = await supabase.from('vendors').select('id').eq('email', email.toLowerCase()).single();
  if (existing) return res.status(400).json({ error: 'Email already registered' });

  const hash = await bcrypt.hash(password, 12);
  const { data: vendor, error } = await supabase.from('vendors').insert({
    email: email.toLowerCase(), password_hash: hash, company, name, phone,
    plan: 'trial', trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  const token = jwt.sign({ id: vendor.id, email: vendor.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    vendor: { id: vendor.id, email: vendor.email, company: vendor.company, name: vendor.name, plan: vendor.plan, trial_ends_at: vendor.trial_ends_at }
  });
});

// ── LOGIN ──
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data: vendor } = await supabase.from('vendors').select('*').eq('email', email.toLowerCase()).single();
  if (!vendor) return res.status(401).json({ error: 'Invalid email or password' });

  const valid = await bcrypt.compare(password, vendor.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  // Check trial expiry
  if (vendor.plan === 'trial' && new Date(vendor.trial_ends_at) < new Date()) {
    await supabase.from('vendors').update({ plan: 'expired' }).eq('id', vendor.id);
    vendor.plan = 'expired';
  }

  const token = jwt.sign({ id: vendor.id, email: vendor.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    vendor: { id: vendor.id, email: vendor.email, company: vendor.company, name: vendor.name, plan: vendor.plan, trial_ends_at: vendor.trial_ends_at, subscription_ends_at: vendor.subscription_ends_at }
  });
});

// ── GET VENDOR INFO ──
app.get('/api/me', auth, (req, res) => {
  const v = req.vendor;
  res.json({ id: v.id, email: v.email, company: v.company, name: v.name, plan: v.plan, trial_ends_at: v.trial_ends_at, subscription_ends_at: v.subscription_ends_at });
});

// ── GET CUSTOMERS ──
app.get('/api/customers', auth, async (req, res) => {
  if (req.vendor.plan === 'expired') return res.status(403).json({ error: 'SUBSCRIPTION_EXPIRED' });
  const { data, error } = await supabase.from('customers').select('*').eq('vendor_id', req.vendor.id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── SAVE ALL CUSTOMERS (bulk upsert) ──
app.post('/api/customers/sync', auth, async (req, res) => {
  if (req.vendor.plan === 'expired') return res.status(403).json({ error: 'SUBSCRIPTION_EXPIRED' });
  const customers = req.body.customers;
  if (!Array.isArray(customers)) return res.status(400).json({ error: 'customers must be array' });

  // Map to DB columns
  const rows = customers.map(c => ({
    id: c.id, vendor_id: req.vendor.id,
    name: c.name || 'Unknown', phone: c.phone || '', kw: parseFloat(c.kw) || 0,
    loc: c.loc || '', agr: c.agr || 'pending', fin: c.fin || 'pending',
    dcr: c.dcr || 'pending', insp: c.insp || 'pending', inst: c.inst || 'pending',
    sub_req: c.subReq || 'pending', sub_disb: c.subDisb || 'pending',
    sub: c.sub || 'pending', sub_amt: parseFloat(c.subAmt) || 0,
    sub_recv: parseFloat(c.subRecv) || 0, loan: parseFloat(c.loan) || 0,
    bank: c.bank || '', dcr_no: c.dcrNo || '', dcr_date: c.dcrDate || '',
    inst_date: c.instDate || '', consumer_acc: c.consumerAcc || '',
    sanctioned_load: parseFloat(c.sanctionedLoad) || 0,
    status_raw: c.statusRaw || '', app_no: c.appNo || '',
    discom: c.discom || '', submitted_on: c.submittedOn || '',
    notes: c.notes || '', remind: c.remind || '', remind_time: c.remindTime || '10:00',
    docs: c.docs || {}, doc_inputs: c.docInputs || {}, panel_serials: c.panelSerials || {},
    updated_at: new Date()
  }));

  const { error } = await supabase.from('customers').upsert(rows, { onConflict: 'id,vendor_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, count: rows.length });
});

// ── DELETE CUSTOMER ──
app.delete('/api/customers/:id', auth, async (req, res) => {
  const { error } = await supabase.from('customers').delete().eq('id', req.params.id).eq('vendor_id', req.vendor.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── DELETE ALL CUSTOMERS ──
app.delete('/api/customers', auth, async (req, res) => {
  const { error } = await supabase.from('customers').delete().eq('vendor_id', req.vendor.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── SUBSCRIPTION (placeholder for Razorpay) ──
app.post('/api/subscribe', auth, async (req, res) => {
  // TODO: Razorpay integration
  // For now, manually activate subscription
  const ends = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await supabase.from('vendors').update({ plan: 'pro', subscription_ends_at: ends }).eq('id', req.vendor.id);
  res.json({ success: true, message: 'Subscription activated' });
});

// ── Serve frontend for all other routes ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SolarCRM running on port ${PORT}`));

// ── Store portal token ──
app.post('/api/portal-token', auth, async (req, res) => {
  let { portalToken } = req.body;
  if (!portalToken) return res.status(400).json({ error: 'No token provided' });
  // Strip Bearer prefix if present
  portalToken = portalToken.replace(/^Bearer\s+/i, '').trim();
  
  // Store token for this vendor
  await supabase.from('vendors').update({ 
    portal_token: portalToken,
    portal_token_updated_at: new Date()
  }).eq('id', req.vendor.id);
  
  // Immediately fetch customers with this token
  const customers = await fetchPortalCustomers(portalToken, req.vendor.id);
  res.json({ success: true, count: customers });
});

// ── Fetch customers from portal API ──
async function fetchPortalCustomers(portalToken, vendorId) {
  try {
    let allCustomers = [];
    let pageNo = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await fetch(
        `https://vendor.pmsuryaghar.gov.in/authenticate/api/verifyAccess/vendor/api/myapplication/getMyApplicationList?pageNo=${pageNo}&pageSize=25`,
        {
          headers: {
            'Authorization': portalToken.startsWith('Bearer ') ? portalToken : 'Bearer ' + portalToken,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) break;
      const data = await response.json();
      
      const list = data.data || data.applicationList || data.content || data.list || [];
      if (!list.length) { hasMore = false; break; }
      
      allCustomers = allCustomers.concat(list);
      
      const total = data.totalCount || data.totalElements || data.total || 0;
      if (allCustomers.length >= total || list.length < 25) hasMore = false;
      else pageNo++;
    }

    if (!allCustomers.length) return 0;

    // Map portal fields to our schema
    const { data: existing } = await supabase.from('customers').select('*').eq('vendor_id', vendorId);
    const existingMap = {};
    (existing || []).forEach(c => {
      if (c.consumer_acc) existingMap[c.consumer_acc] = c;
      if (c.app_no) existingMap[c.app_no] = c;
    });

    const { data: vendor } = await supabase.from('vendors').select('company').eq('id', vendorId).single();
    const prefix = (vendor?.company || 'SOL').slice(0, 3).toUpperCase();
    let counter = (existing || []).length;

    const rows = allCustomers.map(p => {
      const consumerAcc = String(p.consumerNumber || p.consumer_number || p.caNumber || '');
      const appNo = String(p.applicationNumber || p.application_number || p.appNo || '');
      const existing_c = existingMap[consumerAcc] || existingMap[appNo];
      
      // Parse status
      const statusRaw = (p.status || p.applicationStatus || '').replace(/\n/g, ' ').trim();
      const s = statusRaw.toLowerCase();
      const isDone = /\(disbursed\)|\(completed\)|disbursed/.test(s);
      const isProgress = /\(in progress\)|in progress/.test(s);
      const st = isDone ? 'done' : isProgress ? 'in-progress' : 'pending';

      let agr='pending', fin='pending', dcr='pending', inst='pending', insp='pending', subReq='pending', subDisb='pending';
      if (/upload agreement/.test(s))      { agr=st; }
      else if (/^installation/.test(s))    { agr='done';fin='done';dcr=st==='done'?'done':'in-progress';inst=st; }
      else if (/^inspection/.test(s))      { agr='done';fin='done';dcr='done';inst='done';insp=st; }
      else if (/project commission/.test(s)){ agr='done';fin='done';dcr='done';inst='done';insp='done'; }
      else if (/subsidy request/.test(s))  { agr='done';fin='done';dcr='done';inst='done';insp='done';subReq=st; }
      else if (/subsidy disbursal/.test(s)){ agr='done';fin='done';dcr='done';inst='done';insp='done';subReq='done';subDisb=st; }

      counter++;
      const id = existing_c ? existing_c.id : prefix + '-' + String(counter).padStart(3, '0');

      return {
        id,
        vendor_id: vendorId,
        name: (p.consumerName || p.consumer_name || p.name || 'Unknown').trim(),
        phone: String(p.mobileNumber || p.mobile || p.phone || '').replace(/\D/g, '').slice(-10),
        kw: parseFloat(p.proposedCapacity || p.capacity || p.kw || 0),
        consumer_acc: consumerAcc,
        app_no: appNo,
        discom: p.discomName || p.discom || '',
        submitted_on: p.submittedOn || p.applicationDate || '',
        status_raw: statusRaw,
        agr, fin, dcr, inst, insp, sub_req: subReq, sub_disb: subDisb, sub: subDisb,
        sanctioned_load: parseFloat(p.sanctionedLoad || p.sanctioned_load || 0),
        loc: p.district || p.city || '',
        notes: [appNo ? 'App No: '+appNo : '', p.discomName ? 'Discom: '+p.discomName : ''].filter(Boolean).join(' | '),
        updated_at: new Date()
      };
    });

    await supabase.from('customers').upsert(rows, { onConflict: 'id,vendor_id' });
    return rows.length;
  } catch(e) {
    console.error('Portal fetch error:', e.message);
    return 0;
  }
}

// ── Auto-sync all vendors with stored tokens every 5 minutes ──
async function autoSyncAllVendors() {
  console.log('[AutoSync] Running sync for all vendors...');
  const { data: vendors } = await supabase
    .from('vendors')
    .select('id, portal_token, portal_token_updated_at, plan, trial_ends_at')
    .not('portal_token', 'is', null);

  if (!vendors || !vendors.length) return;

  for (const vendor of vendors) {
    // Skip expired vendors
    if (vendor.plan === 'expired') continue;
    if (vendor.plan === 'trial' && new Date(vendor.trial_ends_at) < new Date()) continue;
    
    // Skip tokens older than 8 hours (they expire)
    const tokenAge = (Date.now() - new Date(vendor.portal_token_updated_at)) / 3600000;
    if (tokenAge > 8) {
      console.log(`[AutoSync] Token expired for vendor ${vendor.id}`);
      continue;
    }

    const count = await fetchPortalCustomers(vendor.portal_token, vendor.id);
    console.log(`[AutoSync] Vendor ${vendor.id}: ${count} customers synced`);
  }
}

// Run auto-sync every 5 minutes
setInterval(autoSyncAllVendors, 5 * 60 * 1000);
// Run once on startup after 10 seconds
setTimeout(autoSyncAllVendors, 10000);
