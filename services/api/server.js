/**
 * Motorical Encrypted IMAP API Server v2
 * 
 * Updated to use the adapter architecture with clean vaultbox-motorblock separation.
 * This version implements the dedicated vaultbox SMTP credentials system.
 */

import express from 'express';
import { loadAdapters, getAdapter } from '../../config/adapter-loader.js';
import VaultboxSmtpService from '../core/vaultbox-smtp-service.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: '2mb' }));

// Global adapter references
let adapters = {};
let vaultboxSmtpService = null;

// Initialize adapters on startup
async function initializeServer() {
  try {
    console.log('[EncimapAPI] Loading adapters...');
    adapters = await loadAdapters();
    
    // Initialize vaultbox SMTP service
    vaultboxSmtpService = new VaultboxSmtpService(adapters.storage);
    
    console.log('[EncimapAPI] Server initialized with adapters');
  } catch (error) {
    console.error('[EncimapAPI] Failed to initialize:', error.message);
    process.exit(1);
  }
}

// Authentication middleware
async function authenticateS2S(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'missing bearer token' });
  }

  try {
    const authResult = await adapters.auth.validateToken(auth, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      headers: req.headers
    });

    if (!authResult.valid) {
      return res.status(403).json({ success: false, error: authResult.error || 'invalid token' });
    }

    req.user = {
      id: authResult.user_id,
      permissions: authResult.permissions || [],
      metadata: authResult.metadata
    };

    next();
  } catch (error) {
    console.error('[EncimapAPI] Auth error:', error);
    return res.status(500).json({ success: false, error: 'authentication failed' });
  }
}

// Utility helpers for simple mailbox alias/catch-all rules
async function getSimpleMailboxCountByDomain(domain) {
  const res = await adapters.storage.query(
    `SELECT COUNT(*)::int AS cnt FROM vaultboxes WHERE domain = $1 AND mailbox_type = 'simple'`,
    [domain]
  );
  return (res.rows && res.rows[0] && res.rows[0].cnt) || 0;
}

async function isCatchallEnabledForDomain(domain) {
  const res = await adapters.storage.query(
    `SELECT enabled FROM simple_domain_catchall WHERE domain = $1 LIMIT 1`,
    [domain]
  );
  const row = res.rows && res.rows[0];
  return !!(row && row.enabled);
}

async function getAliasCountForVaultbox(vaultboxId) {
  const res = await adapters.storage.query(
    `SELECT COUNT(*)::int AS cnt FROM simple_mailbox_aliases WHERE vaultbox_id = $1 AND active = TRUE`,
    [vaultboxId]
  );
  return (res.rows && res.rows[0] && res.rows[0].cnt) || 0;
}

async function primaryEmailForVaultbox(vaultbox) {
  if ((vaultbox.alias || '').trim()) {
    return `${String(vaultbox.alias).toLowerCase()}@${String(vaultbox.domain).toLowerCase()}`;
  }
  return null;
}

function isUuidMaybe(value) {
  const s = String(value || '');
  return /^[0-9a-fA-F-]{36}$/.test(s);
}

// Health check endpoint (public)
app.get('/s2s/v1/health', async (req, res) => {
  try {
    if (!adapters.storage) {
      return res.status(500).json({ status: 'not_initialized' });
    }

    // Test storage adapter
    await adapters.storage.query('SELECT 1');
    
    // Get adapter health
    const adapterHealth = {};
    for (const [name, adapter] of Object.entries(adapters)) {
      try {
        adapterHealth[name] = await adapter.healthCheck();
      } catch (error) {
        adapterHealth[name] = { healthy: false, error: error.message };
      }
    }

    const allHealthy = Object.values(adapterHealth).every(h => h.healthy);

    res.json({ 
      status: allHealthy ? 'ok' : 'degraded',
      adapters: adapterHealth,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// All other endpoints require authentication
app.use('/s2s/v1', authenticateS2S);

// ====================================================================
// VAULTBOX MANAGEMENT ENDPOINTS
// ====================================================================
// Helper: write a simple welcome message into a Maildir
async function writeWelcomeMaildirMessage(maildirRoot, toEmail, mailboxType) {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const { execSync } = await import('child_process');

    const newDir = path.join(maildirRoot, 'new');
    try { fs.mkdirSync(newDir, { recursive: true }); } catch(_) {}

    const now = new Date();
    const messageId = `<${now.getTime()}.${Math.random().toString(36).slice(2)}@motorical.com>`;
    const fileName = `${now.getTime()}.${Math.random().toString(36).slice(2)}.motorical`;
    const filePath = path.join(newDir, fileName);

    const body = `Welcome to Motorical Mail!\n\n` +
      `Your mailbox is ready.\n\n` +
      `Incoming IMAP: mail.motorical.com (${mailboxType === 'encrypted' ? 'port 4993 (SSL/TLS)' : 'port 993 (SSL/TLS)'})\n` +
      `Outgoing SMTP: mail.motorical.com (port 465 SSL/TLS, or 587 STARTTLS)\n` +
      `Username: your email address (${toEmail})\n` +
      `Password: the one shown in your dashboard.\n\n` +
      `Need help? https://motorical.com/email-mailboxes/guide\n`;

    const rfc822 = [
      `From: Motorical <support@motorical.com>`,
      `To: ${toEmail}`,
      `Subject: Welcome to Motorical Mail` ,
      `Message-ID: ${messageId}`,
      `Date: ${now.toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=UTF-8`,
      '',
      body
    ].join('\r\n');

    fs.writeFileSync(filePath, rfc822, { mode: 0o600 });
    try { execSync(`chown -R vmail:vmail ${maildirRoot}`); } catch(_) {}
    return true;
  } catch (e) {
    console.warn('[EncimapAPI] Failed to write welcome message:', e.message);
    return false;
  }
}

// List user's vaultboxes with enhanced information
app.get('/s2s/v1/vaultboxes', async (req, res) => {
  try {
    const userId = req.query.user_id || req.user.id;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'missing user_id' });
    }

    // Check permission
    const hasPermission = await adapters.auth.hasPermission(
      req.user.id, 'read', 'vaultbox', { user_id: userId }
    );
    if (!hasPermission && req.user.id !== userId) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    // Get vaultboxes with certificate and SMTP info (includes mailbox_type)
    const result = await adapters.storage.query(`
      SELECT 
        v.id, v.domain, v.name, v.alias, v.status, v.smtp_enabled, v.mailbox_type, v.created_at,
        COALESCE(c.enabled, false) AS is_catch_all,
        EXISTS (SELECT 1 FROM vaultbox_certs c WHERE c.vaultbox_id = v.id) AS has_certs,
        (SELECT COUNT(*) FROM messages m WHERE m.vaultbox_id = v.id) AS message_count,
        vsc.username as smtp_username,
        vsc.host as smtp_host,
        vsc.port as smtp_port,
        vsc.security_type as smtp_security,
        vsc.messages_sent_count as smtp_messages_sent,
        vsc.last_used as smtp_last_used
      FROM vaultboxes v
      LEFT JOIN simple_domain_catchall c ON c.domain = v.domain AND c.enabled = true
      LEFT JOIN vaultbox_smtp_credentials vsc ON v.id = vsc.vaultbox_id AND vsc.enabled = true
      WHERE v.user_id = $1
      ORDER BY v.created_at DESC
    `, [userId]);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('[EncimapAPI] Error fetching vaultboxes:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create new vaultbox (supports both encrypted and simple mailbox types)
app.post('/s2s/v1/vaultboxes', async (req, res) => {
  try {
    const { user_id, domain, name, alias, mailbox_type, isCatchAll } = req.body || {};
    const userId = user_id || req.user.id;

    if (!domain) {
      return res.status(400).json({ success: false, error: 'missing domain' });
    }

    // Validate mailbox_type (default to encrypted for backward compatibility)
    const type = mailbox_type || 'encrypted';
    if (!['encrypted', 'simple'].includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'mailbox_type must be "encrypted" or "simple"' 
      });
    }

    // Check permission
    const hasPermission = await adapters.auth.hasPermission(
      req.user.id, 'create', 'vaultbox'
    );
    if (!hasPermission) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    // Verify user has access to domain
    const userDomains = await adapters.user.getUserDomains(userId);
    const domainLower = domain.toLowerCase();
    const validDomain = userDomains.find(d => d.domain.toLowerCase() === domainLower && d.verified);
    
    if (!validDomain) {
      return res.status(400).json({ success: false, error: 'domain not verified for user' });
    }

    // Simple mailbox constraints: catch-all and multi-mailbox rules
    if (type === 'simple') {
      const count = await getSimpleMailboxCountByDomain(domainLower);
      const catchall = await isCatchallEnabledForDomain(domainLower);
      if (catchall) {
        return res.status(400).json({ success: false, error: 'domain is in catch-all mode; cannot add additional simple mailboxes' });
      }
      if (isCatchAll === true && count > 0) {
        return res.status(400).json({ success: false, error: 'catch-all can only be set when creating the first simple mailbox for this domain' });
      }
    }

    // Encrypted mailbox requirement: primary address (alias) is mandatory; no catch-all/aliases supported
    if (type === 'encrypted') {
      if (!alias || !String(alias).trim()) {
        return res.status(400).json({ success: false, error: 'alias (local-part) is required for encrypted mailboxes' });
      }
    }

    // Create vaultbox with type
    const niceName = (name && String(name).trim()) || (alias && `${String(alias).trim().toLowerCase()}@${domainLower}`) || domainLower;
    const vaultboxData = {
      user_id: userId,
      domain: domainLower,
      name: niceName,
      alias: alias ? alias.trim().toLowerCase() : null,
      mailbox_type: type,
      status: 'active',
      smtp_enabled: false
    };

    const result = await adapters.storage.insert('vaultboxes', vaultboxData);
    const vaultboxId = result.id;

    // If simple and isCatchAll=true, bind domain catch-all to this mailbox
    if (type === 'simple' && isCatchAll === true) {
      try {
        const createdBy = userId; // ensure UUID from owner user
        await adapters.storage.insert('simple_domain_catchall', {
          domain: domainLower,
          vaultbox_id: vaultboxId,
          enabled: true,
          created_by: createdBy
        });
      } catch (e) {
        console.warn('[EncimapAPI] Failed to bind catch-all:', e.message);
        // Rollback vaultbox if this fails to avoid partial state
        try { await adapters.storage.delete('vaultboxes', { id: vaultboxId }); } catch(_) {}
        return res.status(400).json({ success: false, error: 'failed to enable catch-all for this domain' });
      }
    }

    // Create Maildir structure for encrypted mailboxes
    if (type === 'encrypted') {
      try {
        const fs = await import('fs');
        const { execSync } = await import('child_process');
        const maildirPath = `/var/mail/vaultboxes/${vaultboxId}/Maildir`;
        
        // Create Maildir folders
        fs.mkdirSync(`${maildirPath}/tmp`, { recursive: true });
        fs.mkdirSync(`${maildirPath}/new`, { recursive: true });
        fs.mkdirSync(`${maildirPath}/cur`, { recursive: true });
        
        // Set ownership to vmail:vmail (uid/gid 5000)
        execSync(`chown -R vmail:vmail /var/mail/vaultboxes/${vaultboxId}`);
        execSync(`chmod -R 700 /var/mail/vaultboxes/${vaultboxId}`);
        
        console.log(`[EncimapAPI] Created Maildir structure for ${vaultboxId}`);
        // Drop a welcome message if we know the email address
        if (alias) {
          const toEmail = `${alias}@${domainLower}`;
          await writeWelcomeMaildirMessage(maildirPath, toEmail, 'encrypted');
        }
      } catch (maildirError) {
        console.error(`[EncimapAPI] Failed to create Maildir for ${vaultboxId}:`, maildirError.message);
        // Continue - can be created later manually if needed
      }
    }

    // Add MTA routing based on mailbox type
    try {
      if (type === 'encrypted') {
        const emailAddress = `${alias}@${domainLower}`;
        await adapters.mta.addEmailRoute(emailAddress, vaultboxId, {
          priority: 10,
          route_type: 'encrypted_imap'
        });
        console.log(`[EncimapAPI] Added encrypted email route: ${emailAddress} -> ${vaultboxId}`);
      } else if (alias) {
        // For simple mailboxes, defer route until IMAP username exists
        const emailAddress = `${alias}@${domainLower}`;
        console.log(`[EncimapAPI] Deferring simple route for ${emailAddress} until IMAP credentials are created`);
      } else {
        console.warn('[EncimapAPI] No alias provided, skipping MTA route creation');
      }
    } catch (mtaError) {
      console.warn('[EncimapAPI] MTA routing setup failed:', mtaError.message);
      // Continue - vaultbox is created, routing can be fixed later
    }

    console.log(`[EncimapAPI] Created ${type} mailbox ${vaultboxId} for ${domainLower}${(type==='simple'&&isCatchAll)?' (catch-all)':''}`);
    
    res.json({
      success: true,
      data: {
        vaultbox_id: vaultboxId,
        id: vaultboxId,
        domain: domainLower,
        name: name.trim(),
        mailbox_type: type,
        has_certs: false,
        smtp_enabled: false,
        is_catch_all: !!isCatchAll
      } 
    });
  } catch (error) {
    console.error('[EncimapAPI] Error creating vaultbox:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete vaultbox
app.delete('/s2s/v1/vaultboxes/:id', async (req, res) => {
  try {
    const vaultboxId = req.params.id;
    
    if (!vaultboxId) {
      return res.status(400).json({ success: false, error: 'missing vaultbox id' });
    }

    // Verify vaultbox exists and user has access
    const vaultbox = await adapters.storage.findById('vaultboxes', vaultboxId);
    if (!vaultbox) {
      return res.status(404).json({ success: false, error: 'vaultbox not found' });
    }

    // Check if this is a service-to-service call or user owns the vaultbox
    const isServiceCall = req.user.id === 'backend.motorical' || req.user.id === 'motorical-backend';
    const userOwnsVaultbox = req.user.id === vaultbox.user_id;
    
    if (!isServiceCall && !userOwnsVaultbox) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    // Remove MTA routing for the specific email address
    try {
      if (vaultbox.alias) {
        const emailAddress = `${vaultbox.alias}@${vaultbox.domain}`;
        await adapters.mta.removeEmailRoute(emailAddress);
        console.log(`[EncimapAPI] Removed MTA routing for email ${emailAddress}`);
    } else {
        console.warn('[EncimapAPI] No alias found, skipping MTA route removal');
      }
    } catch (mtaError) {
      console.warn('[EncimapAPI] MTA routing removal failed:', mtaError.message);
      // Continue - vaultbox deletion is more important
    }

    // Delete vaultbox and cascade to related data (messages, certs, smtp_credentials, imap_credentials)
    await adapters.storage.delete('vaultboxes', { id: vaultboxId });

    // Remove maildir if it exists
    try {
      const fs = await import('fs');
      // Remove encrypted Maildir (vaultboxId-based)
      const encPath = `/var/mail/vaultboxes/${vaultboxId}`;
      if (fs.existsSync(encPath)) {
        fs.rmSync(encPath, { recursive: true, force: true });
        console.log(`[EncimapAPI] Removed encrypted maildir ${encPath}`);
      }
      // Remove simple Maildirs (username-based) if any IMAP usernames exist
      try {
        const creds = await adapters.storage.find('imap_app_credentials', { vaultbox_id: vaultboxId });
        const usernames = (creds.rows || []).map(c => c.username).filter(Boolean);
        for (const u of usernames) {
          const uPath = `/var/mail/vaultboxes/${u}`;
          if (fs.existsSync(uPath)) {
            fs.rmSync(uPath, { recursive: true, force: true });
            console.log(`[EncimapAPI] Removed simple maildir ${uPath}`);
          }
        }
      } catch (_) {}
    } catch (error) {
      console.warn('[EncimapAPI] Maildir removal failed:', error.message);
      // Continue - this is not critical
    }

    console.log(`[EncimapAPI] Deleted vaultbox ${vaultboxId} (${vaultbox.domain})`);
    res.json({ success: true, message: 'Vaultbox deleted successfully' });
  } catch (error) {
    console.error('[EncimapAPI] Error deleting vaultbox:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// VAULTBOX SMTP CREDENTIALS ENDPOINTS (NEW CLEAN SYSTEM)
// ====================================================================

    // Create SMTP credentials for vaultbox
app.post('/s2s/v1/vaultboxes/:id/smtp-credentials', async (req, res) => {
  try {
    const vaultboxId = req.params.id;
    const { host, port, security_type } = req.body || {};

    // Verify vaultbox exists and user has access
    const vaultbox = await adapters.storage.findById('vaultboxes', vaultboxId);
    if (!vaultbox) {
      return res.status(404).json({ success: false, error: 'vaultbox not found' });
    }

    // Check permission
    const hasPermission = await adapters.auth.hasPermission(
      req.user.id, 'create', 'credentials', { vaultbox_id: vaultboxId }
    );
    if (!hasPermission && req.user.id !== vaultbox.user_id) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    // Check if IMAP credentials already exist to use the same username
    let username;
    const existingImap = await adapters.storage.find('imap_app_credentials', { vaultbox_id: vaultboxId });
    
        if (existingImap.rows && existingImap.rows.length > 0) {
          // Use existing IMAP username for SMTP to ensure they match
          username = existingImap.rows[0].username;
          console.log(`[EncimapAPI] Using existing IMAP username for SMTP: ${username}`);
        } else {
          // Prefer email-style username alias@domain when alias exists; fallback to unified format
          if ((vaultbox.alias || '').trim()) {
            username = `${vaultbox.alias.toLowerCase()}@${vaultbox.domain.toLowerCase()}`;
          } else {
            username = generateUnifiedUsername(vaultbox.domain, vaultboxId);
          }
        }
    
    const password = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    
    // Hash password using bcrypt
    const bcrypt = await import('bcrypt');
    const passwordHash = await bcrypt.hash(password, 12);

    // Create SMTP credentials with unified username
    const credentials = await adapters.storage.insert('vaultbox_smtp_credentials', {
      vaultbox_id: vaultboxId,
      username: username,
      password_hash: passwordHash,
      host: host || 'mail.motorical.com',
      port: port || 587,
      security_type: security_type || 'STARTTLS'
    });

    console.log(`[EncimapAPI] Created SMTP credentials for vaultbox ${vaultboxId}: ${username}`);

    res.json({
      success: true,
      data: {
        credentials: {
          id: credentials.id,
          vaultbox_id: vaultboxId,
          username: username,
          password: password,
          host: host || 'mail.motorical.com',
          port: port || 587,
          security_type: security_type || 'STARTTLS',
          created_at: new Date().toISOString()
        },
        message: 'SMTP credentials created successfully'
      }
    });
  } catch (error) {
    console.error('[EncimapAPI] Error creating SMTP credentials:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get SMTP credentials for vaultbox (without password)
app.get('/s2s/v1/vaultboxes/:id/smtp-credentials', async (req, res) => {
  try {
    const vaultboxId = req.params.id;

    // Verify vaultbox exists and user has access
    const vaultbox = await adapters.storage.findById('vaultboxes', vaultboxId);
    if (!vaultbox) {
      return res.status(404).json({ success: false, error: 'vaultbox not found' });
    }

    // Check permission
    const hasPermission = await adapters.auth.hasPermission(
      req.user.id, 'read', 'credentials', { vaultbox_id: vaultboxId }
    );
    if (!hasPermission && req.user.id !== vaultbox.user_id) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    const credentials = await vaultboxSmtpService.getCredentials(vaultboxId);

    res.json({
      success: true,
      data: credentials 
    });
  } catch (error) {
    console.error('[EncimapAPI] Error fetching SMTP credentials:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Regenerate SMTP password
app.post('/s2s/v1/vaultboxes/:id/smtp-credentials/regenerate', async (req, res) => {
  try {
    const vaultboxId = req.params.id;

    // Verify vaultbox exists and user has access
    const vaultbox = await adapters.storage.findById('vaultboxes', vaultboxId);
    if (!vaultbox) {
      return res.status(404).json({ success: false, error: 'vaultbox not found' });
    }

    // Check if this is a service-to-service call or user owns the vaultbox
    const isServiceCall = req.user.id === 'backend.motorical' || req.user.id === 'motorical-backend';
    const userOwnsVaultbox = req.user.id === vaultbox.user_id;
    
    if (!isServiceCall && !userOwnsVaultbox) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    const newCredentials = await vaultboxSmtpService.regeneratePassword(vaultboxId);

    console.log(`[EncimapAPI] Regenerated SMTP password for vaultbox ${vaultboxId}`);

    res.json({
      success: true,
      data: {
        credentials: newCredentials,
        message: 'SMTP password regenerated successfully'
      }
    });
  } catch (error) {
    console.error('[EncimapAPI] Error regenerating SMTP password:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete SMTP credentials
app.delete('/s2s/v1/vaultboxes/:id/smtp-credentials', async (req, res) => {
  try {
    const vaultboxId = req.params.id;

    // Verify vaultbox exists and user has access
    const vaultbox = await adapters.storage.findById('vaultboxes', vaultboxId);
    if (!vaultbox) {
      return res.status(404).json({ success: false, error: 'vaultbox not found' });
    }

    // Check permission
    const hasPermission = await adapters.auth.hasPermission(
      req.user.id, 'delete', 'credentials', { vaultbox_id: vaultboxId }
    );
    if (!hasPermission && req.user.id !== vaultbox.user_id) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    const deleted = await vaultboxSmtpService.deleteCredentials(vaultboxId);

    if (deleted) {
      console.log(`[EncimapAPI] Deleted SMTP credentials for vaultbox ${vaultboxId}`);
      res.json({ success: true, message: 'SMTP credentials deleted successfully' });
    } else {
      res.status(404).json({ success: false, error: 'no SMTP credentials found' });
    }
  } catch (error) {
    console.error('[EncimapAPI] Error deleting SMTP credentials:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get usage statistics for user's vaultboxes
app.get('/s2s/v1/usage', async (req, res) => {
  try {
    const userId = req.query.user_id || req.user.id;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'missing user_id' });
    }

    // Check permission
    const hasPermission = await adapters.auth.hasPermission(
      req.user.id, 'read', 'usage', { user_id: userId }
    );
    if (!hasPermission && req.user.id !== userId) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    // Get vaultboxes for user
    const vaultboxesResult = await adapters.storage.query(`
      SELECT id, domain, mailbox_type, alias
      FROM vaultboxes
      WHERE user_id = $1
    `, [userId]);

    const usage = [];

    for (const vaultbox of vaultboxesResult.rows) {
      if (vaultbox.mailbox_type === 'encrypted') {
        // Encrypted mailboxes: query messages table
        const result = await adapters.storage.query(`
          SELECT 
            COUNT(*)::int as message_count,
            COALESCE(SUM(size_bytes), 0)::bigint as total_bytes,
            MAX(received_at) as last_received
          FROM messages
          WHERE vaultbox_id = $1
        `, [vaultbox.id]);

        const row = result.rows[0];
        usage.push({
          vaultbox_id: vaultbox.id,
          domain: vaultbox.domain,
          mailbox_type: 'encrypted',
          message_count: Number(row?.message_count || 0),
          total_bytes: Number(row?.total_bytes || 0),
          last_received: row?.last_received || null
        });
      } else if (vaultbox.mailbox_type === 'simple') {
        // Simple mailboxes: read Maildir
        try {
          const fs = await import('fs').then(m => m.promises);
          const path = await import('path');
          const maildirRoot = process.env.MAILDIR_ROOT || '/var/mail/vaultboxes';
          
          // Get IMAP username for simple mailbox
          const credResult = await adapters.storage.query(`
            SELECT username FROM imap_app_credentials
            WHERE vaultbox_id = $1
            LIMIT 1
          `, [vaultbox.id]);
          
          if (credResult.rows && credResult.rows[0]) {
            const imapUsername = credResult.rows[0].username;
            const maildirPath = path.default.join(maildirRoot, imapUsername, 'Maildir');
            
            let messageCount = 0;
            let totalBytes = 0;
            let lastReceived = null;

            // Check new and cur directories
            for (const subdir of ['new', 'cur']) {
              const dirPath = path.default.join(maildirPath, subdir);
              try {
                const files = await fs.readdir(dirPath);
                messageCount += files.length;
                
                // Get file stats for size and last modified
                for (const file of files) {
                  try {
                    const filePath = path.default.join(dirPath, file);
                    const stats = await fs.stat(filePath);
                    totalBytes += stats.size;
                    if (!lastReceived || stats.mtime > lastReceived) {
                      lastReceived = stats.mtime;
                    }
                  } catch (fileErr) {
                    // Skip individual file errors
                  }
                }
              } catch (dirErr) {
                // Directory doesn't exist or can't be read - skip
              }
            }

            usage.push({
              vaultbox_id: vaultbox.id,
              domain: vaultbox.domain,
              mailbox_type: 'simple',
              message_count: messageCount,
              total_bytes: totalBytes,
              last_received: lastReceived ? new Date(lastReceived).toISOString() : null
            });
          } else {
            // No IMAP credentials yet - return zero usage
            usage.push({
              vaultbox_id: vaultbox.id,
              domain: vaultbox.domain,
              mailbox_type: 'simple',
              message_count: 0,
              total_bytes: 0,
              last_received: null
            });
          }
        } catch (maildirError) {
          console.warn(`[EncimapAPI] Error reading Maildir for vaultbox ${vaultbox.id}:`, maildirError.message);
          // Return zero usage on error
          usage.push({
            vaultbox_id: vaultbox.id,
            domain: vaultbox.domain,
            mailbox_type: 'simple',
            message_count: 0,
            total_bytes: 0,
            last_received: null
          });
        }
      }
    }

    console.log(`[EncimapAPI] Usage query for user ${userId}: ${usage.length} vaultboxes, ${usage.reduce((sum, u) => sum + u.message_count, 0)} total messages`);

    res.json({ success: true, data: usage });
  } catch (error) {
    console.error('[EncimapAPI] Error getting usage statistics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// VAULTBOX IMAP CREDENTIALS ENDPOINTS
// ====================================================================

// Create IMAP credentials for vaultbox
app.post('/s2s/v1/vaultboxes/:id/imap-credentials', async (req, res) => {
  try {
    const vaultboxId = req.params.id;

    // Verify vaultbox exists and user has access
    const vaultbox = await adapters.storage.findById('vaultboxes', vaultboxId);
    if (!vaultbox) {
      return res.status(404).json({ success: false, error: 'vaultbox not found' });
    }

    // Check if this is a service-to-service call or user owns the vaultbox
    const isServiceCall = req.user.id === 'backend.motorical' || req.user.id === 'motorical-backend';
    const userOwnsVaultbox = req.user.id === vaultbox.user_id;
    
    if (!isServiceCall && !userOwnsVaultbox) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    // Check if IMAP credentials already exist
    const existing = await adapters.storage.find('imap_app_credentials', { vaultbox_id: vaultboxId });
    if (existing.rows && existing.rows.length > 0) {
      const existingCred = existing.rows[0];
      return res.json({
        success: true,
        data: {
          username: existingCred.username,
          vaultbox_id: vaultboxId,
          created_at: existingCred.created_at
        }
      });
    }

    // Check if SMTP credentials already exist to use the same username
    let username;
    const existingSmtp = await adapters.storage.find('vaultbox_smtp_credentials', { vaultbox_id: vaultboxId });
    
    if (existingSmtp.rows && existingSmtp.rows.length > 0) {
      // Use existing SMTP username for IMAP to ensure they match
      username = existingSmtp.rows[0].username;
      console.log(`[EncimapAPI] Using existing SMTP username for IMAP: ${username}`);
    } else {
      // Prefer email-style username alias@domain when alias exists; fallback to unified format
      if ((vaultbox.alias || '').trim()) {
        username = `${vaultbox.alias.toLowerCase()}@${vaultbox.domain.toLowerCase()}`;
      } else {
        username = generateUnifiedUsername(vaultbox.domain, vaultboxId);
      }
    }
    
    const password = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    
    // Hash password using bcrypt
    const bcrypt = await import('bcrypt');
    const passwordHash = await bcrypt.hash(password, 12);

    // Create IMAP credentials
    const result = await adapters.storage.insert('imap_app_credentials', {
      user_id: vaultbox.user_id,
      vaultbox_id: vaultboxId,
      username: username,
      password_hash: passwordHash
    });

    // For simple mailboxes, ensure Maildir exists using username path
    if (vaultbox.mailbox_type === 'simple') {
      try {
        const fs = await import('fs');
        const { execSync } = await import('child_process');
        const userMaildir = `/var/mail/vaultboxes/${username}/Maildir`;
        fs.mkdirSync(`${userMaildir}/tmp`, { recursive: true });
        fs.mkdirSync(`${userMaildir}/new`, { recursive: true });
        fs.mkdirSync(`${userMaildir}/cur`, { recursive: true });
        execSync(`chown -R vmail:vmail /var/mail/vaultboxes/${username}`);
        execSync(`chmod -R 700 /var/mail/vaultboxes/${username}`);
        console.log(`[EncimapAPI] Created Maildir for simple mailbox user ${username}`);
        // Place a welcome message for simple boxes
        const toEmail = vaultbox.alias ? `${vaultbox.alias}@${vaultbox.domain}` : username;
        await writeWelcomeMaildirMessage(userMaildir, toEmail, 'simple');
      } catch (err) {
        console.error('[EncimapAPI] Failed to create Maildir for simple mailbox:', err.message);
      }
    }

    console.log(`[EncimapAPI] Created IMAP credentials for vaultbox ${vaultboxId}: ${username}`);

    // Ensure MTA route is correct for simple mailboxes (email alias -> simple maildir username)
    try {
      if (vaultbox.mailbox_type === 'simple' && vaultbox.alias) {
        const emailAddress = `${vaultbox.alias}@${vaultbox.domain}`;
        await adapters.mta.addEmailRoute(emailAddress, vaultboxId, {
          priority: 10,
          route_type: 'simple_imap',
          username: username
        });
        console.log(`[EncimapAPI] Ensured simple route: ${emailAddress} -> simple-maildir:${username}`);
      }
    } catch (routeErr) {
      console.warn('[EncimapAPI] Failed to ensure simple route after IMAP credential creation:', routeErr.message);
    }

    // If domain is in catch-all mode for this vaultbox, we must ensure that non-existing local parts are routed.
    // With pgsql virtual_catchall_map in Postfix, no extra transport entries are needed here.

    res.json({
      success: true,
      data: {
        username: username,
        password: password,  // Only returned on creation
        vaultbox_id: vaultboxId,
        created_at: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('[EncimapAPI] Error creating IMAP credentials:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Regenerate IMAP password for vaultbox (keep same username)
app.post('/s2s/v1/vaultboxes/:id/imap-credentials/regenerate', async (req, res) => {
  try {
    const vaultboxId = req.params.id;

    // Verify vaultbox exists and user has access
    const vaultbox = await adapters.storage.findById('vaultboxes', vaultboxId);
    if (!vaultbox) {
      return res.status(404).json({ success: false, error: 'vaultbox not found' });
    }

    // Check if this is a service-to-service call or user owns the vaultbox
    const isServiceCall = req.user.id === 'backend.motorical' || req.user.id === 'motorical-backend';
    const userOwnsVaultbox = req.user.id === vaultbox.user_id;
    
    if (!isServiceCall && !userOwnsVaultbox) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    // Check if IMAP credentials exist
    const existing = await adapters.storage.find('imap_app_credentials', { vaultbox_id: vaultboxId });
    if (!existing.rows || existing.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'IMAP credentials not found' });
    }

    const existingCred = existing.rows[0];
    
    // Generate new password
    const newPassword = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    
    // Hash password using bcrypt
    const bcrypt = await import('bcrypt');
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update password in database
    await adapters.storage.update('imap_app_credentials', 
      { 
        password_hash: passwordHash,
        updated_at: new Date().toISOString()
      },
      { vaultbox_id: vaultboxId }
    );

    console.log(`[EncimapAPI] Regenerated IMAP password for vaultbox ${vaultboxId}: ${existingCred.username}`);

    res.json({
      success: true,
      data: {
        vaultbox_id: vaultboxId,
        username: existingCred.username,
        password: newPassword // Return new plaintext password
      }
    });
  } catch (error) {
    console.error('[EncimapAPI] Error regenerating IMAP password:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get IMAP credentials for vaultbox (without password)
app.get('/s2s/v1/vaultboxes/:id/imap-credentials', async (req, res) => {
  try {
    const vaultboxId = req.params.id;

    // Verify vaultbox exists and user has access
    const vaultbox = await adapters.storage.findById('vaultboxes', vaultboxId);
    if (!vaultbox) {
      return res.status(404).json({ success: false, error: 'vaultbox not found' });
    }

    // Check if this is a service-to-service call or user owns the vaultbox
    const isServiceCall = req.user.id === 'backend.motorical' || req.user.id === 'motorical-backend';
    const userOwnsVaultbox = req.user.id === vaultbox.user_id;
    
    if (!isServiceCall && !userOwnsVaultbox) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    // Get IMAP credentials (without password)
    const result = await adapters.storage.find('imap_app_credentials', { vaultbox_id: vaultboxId });
    
    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'IMAP credentials not found' });
    }

    const credentials = result.rows[0];

    res.json({
      success: true,
      data: {
        username: credentials.username,
        vaultbox_id: vaultboxId,
        created_at: credentials.created_at
      }
    });
  } catch (error) {
    console.error('[EncimapAPI] Error getting IMAP credentials:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get latest active IMAP credentials for user (username only)
app.get('/s2s/v1/imap-credentials', async (req, res) => {
  try {
    const userId = req.query.user_id || req.user.id;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'missing user_id' });
    }

    // Check if this is a service-to-service call or user is requesting their own data
    const isServiceCall = req.user.id === 'backend.motorical' || req.user.id === 'motorical-backend';
    const userRequestingOwnData = req.user.id === userId;
    
    if (!isServiceCall && !userRequestingOwnData) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    // Get latest IMAP credentials for user
    const result = await adapters.storage.query(`
      SELECT username FROM imap_app_credentials 
      WHERE user_id = $1 
      ORDER BY created_at DESC LIMIT 1
    `, [userId]);

    const row = (result.rows && result.rows.length > 0) ? result.rows[0] : null;
    
    res.json({ 
      success: true, 
      data: row 
    });
  } catch (error) {
    console.error('[EncimapAPI] Error getting user IMAP credentials:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// List all IMAP credentials for user
app.get('/s2s/v1/imap-credentials/list', async (req, res) => {
  try {
    const userId = req.query.user_id || req.user.id;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'missing user_id' });
    }

    // Check if this is a service-to-service call or user is requesting their own data
    const isServiceCall = req.user.id === 'backend.motorical' || req.user.id === 'motorical-backend';
    const userRequestingOwnData = req.user.id === userId;
    
    if (!isServiceCall && !userRequestingOwnData) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    // Get all IMAP credentials for user with vaultbox details
    const result = await adapters.storage.query(`
      SELECT a.username, a.created_at, a.vaultbox_id, v.domain
      FROM imap_app_credentials a
      LEFT JOIN vaultboxes v ON v.id = a.vaultbox_id
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC
    `, [userId]);

    res.json({ 
      success: true, 
      data: result.rows || []
    });
  } catch (error) {
    console.error('[EncimapAPI] Error listing user IMAP credentials:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// DOMAIN SIMPLE MAILBOX STATUS AND CATCH-ALL CONTROL
// ====================================================================

// Get simple mailbox count, catch-all status, and conversion eligibility
app.get('/s2s/v1/domains/:domain/simple-status', async (req, res) => {
  try {
    const domain = String(req.params.domain || '').toLowerCase();
    if (!domain) return res.status(400).json({ success: false, error: 'domain required' });

    const count = await getSimpleMailboxCountByDomain(domain);
    const catchall = await isCatchallEnabledForDomain(domain);

    // Check conversion eligibility: exactly one simple mailbox and it has 0 aliases
    let eligibleVaultboxId = null;
    let eligible = false;
    if (count === 1) {
      const r = await adapters.storage.query(
        `SELECT id FROM vaultboxes WHERE domain = $1 AND mailbox_type = 'simple' LIMIT 1`,
        [domain]
      );
      const vb = r.rows && r.rows[0];
      if (vb && vb.id) {
        const aliasCnt = await getAliasCountForVaultbox(vb.id);
        eligible = aliasCnt === 0 && !catchall;
        eligibleVaultboxId = vb.id;
      }
    }

    res.json({ success: true, data: { domain, simpleCount: count, catchallEnabled: catchall, conversionEligible: eligible, eligibleVaultboxId } });
  } catch (e) {
    console.error('[EncimapAPI] simple-status error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Enable catch-all (conversion) only when exactly one simple mailbox and 0 aliases
app.put('/s2s/v1/domains/:domain/catchall', async (req, res) => {
  try {
    const domain = String(req.params.domain || '').toLowerCase();
    const { enabled, vaultbox_id, force } = req.body || {};
    if (!domain) return res.status(400).json({ success: false, error: 'domain required' });
    
    if (enabled === false) {
      // Disable catch-all for domain (no mailbox constraints)
      try {
        await adapters.storage.query(
          `UPDATE simple_domain_catchall SET enabled = FALSE WHERE domain = $1`,
          [domain]
        );
      } catch (e) {
        return res.status(500).json({ success: false, error: 'failed to disable catch-all' });
      }

      // Remove Postfix catch-all alias if present (file-based fallback)
      try {
        if (adapters?.mta?.removeCatchallRoute) {
          await adapters.mta.removeCatchallRoute(domain);
        } else {
          const fs = await import('fs');
          const { execSync } = await import('child_process');
          const path = '/etc/postfix/virtual_aliases';
          let text = '';
          try { text = fs.readFileSync(path, 'utf8'); } catch (_) { text = ''; }
          const lines = String(text || '').split('\n');
          const re = new RegExp(`^@${domain}\\s+`, 'i');
          const filtered = lines.filter(l => !re.test(l));
          if (filtered.length !== lines.length) {
            fs.writeFileSync(path, filtered.join('\n'));
            try { execSync('postmap /etc/postfix/virtual_aliases', { stdio: 'ignore' }); } catch (_) {}
            try { execSync('systemctl reload postfix', { stdio: 'ignore' }); } catch (_) {}
          }
        }
      } catch (wiringErr) {
        console.warn('[EncimapAPI] Catch-all Postfix removal skipped:', wiringErr?.message || wiringErr);
      }

      return res.json({ success: true, data: { domain, enabled: false } });
    }

    // Enabling flow
    const count = await getSimpleMailboxCountByDomain(domain);
    if (count !== 1) return res.status(400).json({ success: false, error: 'catch-all can be enabled only when exactly one simple mailbox exists' });

    const r = await adapters.storage.query(`SELECT id, alias, domain, user_id FROM vaultboxes WHERE domain = $1 AND mailbox_type = 'simple' LIMIT 1`, [domain]);
    const vb = r.rows && r.rows[0];
    if (!vb) return res.status(404).json({ success: false, error: 'no simple mailbox found' });
    if (String(vaultbox_id || '') !== String(vb.id)) return res.status(400).json({ success: false, error: 'vaultbox_id must match the single simple mailbox' });

    const aliasCnt = await getAliasCountForVaultbox(vb.id);
    if (aliasCnt > 0 && !force) return res.status(409).json({ success: false, error: 'remove aliases before enabling catch-all', code: 'ALIAS_PRESENT' });
    if (aliasCnt > 0 && force) {
      try {
        const aliases = await adapters.storage.query(`SELECT id, alias_email FROM simple_mailbox_aliases WHERE vaultbox_id = $1`, [vb.id]);
        for (const row of aliases.rows || []) {
          try { if (row.alias_email) await adapters.mta.removeEmailRoute(String(row.alias_email).toLowerCase()); } catch (_) {}
        }
        await adapters.storage.query(`DELETE FROM simple_mailbox_aliases WHERE vaultbox_id = $1`, [vb.id]);
      } catch (cleanupErr) {
        return res.status(500).json({ success: false, error: 'failed to cleanup aliases prior to catch-all' });
      }
    }

    // Upsert catch-all binding
    // Use the vaultbox owner UUID for created_by to satisfy UUID constraint
    const createdBy = vb.user_id || null;
    await adapters.storage.query(
      `INSERT INTO simple_domain_catchall(domain, vaultbox_id, enabled, created_at, created_by)
       VALUES ($1, $2, TRUE, now(), $3)
       ON CONFLICT (domain) DO UPDATE SET vaultbox_id = EXCLUDED.vaultbox_id, enabled = TRUE`,
      [domain, vb.id, createdBy]
    );

    // Ensure Postfix catch-all delivery is active in file-based setups
    // Fallback path when pgsql virtual_catchall_map is not configured on the host.
    try {
      // Determine primary email to rewrite to (prefer mailbox alias)
      let rewriteTarget = null;
      try {
        const vbRow = await adapters.storage.query(
          `SELECT alias, domain FROM vaultboxes WHERE id = $1 LIMIT 1`, [vb.id]
        );
        const row = vbRow?.rows && vbRow.rows[0];
        if (row && (row.alias || '').trim()) {
          rewriteTarget = `${String(row.alias).toLowerCase()}@${String(row.domain).toLowerCase()}`;
        }
      } catch (_) { /* ignore */ }

      if (!rewriteTarget) {
        try {
          const cred = await adapters.storage.find('imap_app_credentials', { vaultbox_id: vb.id });
          const username = cred?.rows && cred.rows[0] ? String(cred.rows[0].username) : null;
          if (username) rewriteTarget = username;
        } catch (_) { /* ignore */ }
      }

      if (rewriteTarget) {
        try {
          // Preferred: use MTA adapter if it supports a catch-all operation
          if (adapters?.mta?.addCatchallRoute) {
            await adapters.mta.addCatchallRoute(domain, rewriteTarget, { vaultbox_id: vb.id });
          } else {
            // Fallback: write to /etc/postfix/virtual_aliases and reload
            const fs = await import('fs');
            const { execSync } = await import('child_process');
            const path = '/etc/postfix/virtual_aliases';
            let text = '';
            try { text = fs.readFileSync(path, 'utf8'); } catch (_) { text = ''; }
            const lines = String(text || '').split('\n');
            const re = new RegExp(`^@${domain}\\s+`, 'i');
            const filtered = lines.filter(l => !re.test(l));
            filtered.push(`@${domain}\t${rewriteTarget}`);
            fs.writeFileSync(path, filtered.join('\n'));
            try { execSync('postmap /etc/postfix/virtual_aliases', { stdio: 'ignore' }); } catch (_) {}
            try { execSync('systemctl reload postfix', { stdio: 'ignore' }); } catch (_) {}
          }
          console.log(`[EncimapAPI] Catch-all enabled for ${domain} -> ${rewriteTarget}`);
        } catch (routeErr) {
          console.warn('[EncimapAPI] Failed to apply Postfix catch-all route:', routeErr?.message || routeErr);
        }
      } else {
        console.warn('[EncimapAPI] Could not determine rewrite target for catch-all (no alias or IMAP username)');
      }
    } catch (wiringErr) {
      console.warn('[EncimapAPI] Catch-all Postfix wiring skipped:', wiringErr?.message || wiringErr);
    }

    res.json({ success: true, data: { domain, vaultbox_id: vb.id, enabled: true } });
  } catch (e) {
    console.error('[EncimapAPI] enable catch-all error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ====================================================================
// SIMPLE MAILBOX ALIASES (RECEIVE-ONLY) ENDPOINTS
// ====================================================================

// List aliases for a simple mailbox (vaultbox)
app.get('/s2s/v1/vaultboxes/:id/aliases', async (req, res) => {
  try {
    const vaultboxId = req.params.id;
    const vaultbox = await adapters.storage.findById('vaultboxes', vaultboxId);
    if (!vaultbox) return res.status(404).json({ success: false, error: 'vaultbox not found' });
    if (vaultbox.mailbox_type !== 'simple') return res.status(400).json({ success: false, error: 'aliases supported only for simple mailboxes' });

    const hasPermission = await adapters.auth.hasPermission(req.user.id, 'read', 'vaultbox', { vaultbox_id: vaultboxId });
    if (!hasPermission && req.user.id !== vaultbox.user_id) return res.status(403).json({ success: false, error: 'access denied' });

    const rows = (await adapters.storage.query(
      'SELECT id, alias_email, active, created_at FROM simple_mailbox_aliases WHERE vaultbox_id = $1 ORDER BY created_at DESC',
      [vaultboxId]
    )).rows || [];
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('[EncimapAPI] List aliases error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Create alias (receive-only)
app.post('/s2s/v1/vaultboxes/:id/aliases', async (req, res) => {
  try {
    const vaultboxId = req.params.id;
    const { alias_email } = req.body || {};
    const vaultbox = await adapters.storage.findById('vaultboxes', vaultboxId);
    if (!vaultbox) return res.status(404).json({ success: false, error: 'vaultbox not found' });
    if (vaultbox.mailbox_type !== 'simple') return res.status(400).json({ success: false, error: 'aliases supported only for simple mailboxes' });

    const hasPermission = await adapters.auth.hasPermission(req.user.id, 'create', 'alias', { vaultbox_id: vaultboxId });
    if (!hasPermission && req.user.id !== vaultbox.user_id) return res.status(403).json({ success: false, error: 'access denied' });

    // Domain catch-all guard
    const catchall = await isCatchallEnabledForDomain(String(vaultbox.domain).toLowerCase());
    if (catchall) return res.status(409).json({ success: false, error: 'domain is in catch-all mode; aliases are not allowed', code: 'DOMAIN_CATCHALL' });

    // Alias limit (5)
    const count = await getAliasCountForVaultbox(vaultboxId);
    if (count >= 5) return res.status(409).json({ success: false, error: 'alias limit reached (5)', code: 'ALIAS_LIMIT' });

    // Normalize and basic validate
    const email = String(alias_email || '').trim().toLowerCase();
    if (!email.includes('@')) return res.status(422).json({ success: false, error: 'invalid alias_email', code: 'VALIDATION_ERROR' });
    const [local, domain] = email.split('@');
    if (!local || !domain) return res.status(422).json({ success: false, error: 'invalid alias_email', code: 'VALIDATION_ERROR' });
    if (domain !== String(vaultbox.domain).toLowerCase()) return res.status(422).json({ success: false, error: 'alias must be in the same domain', code: 'VALIDATION_ERROR' });

    // Ensure alias is not the primary email and not any mailbox/alias elsewhere
    const primary = await primaryEmailForVaultbox(vaultbox);
    if (primary && primary === email) return res.status(409).json({ success: false, error: 'alias equals primary email', code: 'ALIAS_CONFLICT' });

    // Conflict with any existing alias
    const conflict = await adapters.storage.query(
      `SELECT 1 FROM simple_mailbox_aliases WHERE alias_email = $1 LIMIT 1`, [email]
    );
    if (conflict.rows && conflict.rows.length > 0) return res.status(409).json({ success: false, error: 'alias already exists', code: 'ALIAS_CONFLICT' });

    // Conflict with any existing mailbox primary address (any mailbox, simple or encrypted)
    const existingMailbox = await adapters.storage.query(
      `SELECT 1 FROM vaultboxes WHERE lower(domain) = $1 AND lower(alias) = $2 LIMIT 1`,
      [domain, local]
    );
    if (existingMailbox.rows && existingMailbox.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'alias conflicts with existing mailbox address', code: 'ALIAS_CONFLICT' });
    }

    const created = await adapters.storage.insert('simple_mailbox_aliases', {
      vaultbox_id: vaultboxId,
      alias_email: email,
      active: true,
      created_by: vaultbox.user_id
    });

    console.log(`[EncimapAPI] Created receive-only alias ${email} -> ${primary || '(unknown primary)'}`);
    // Add transport route for this alias to deliver to simple Maildir username (immediate effect without pgsql maps)
    try {
      const cred = await adapters.storage.find('imap_app_credentials', { vaultbox_id: vaultboxId });
      const imapUsername = cred?.rows && cred.rows[0] ? cred.rows[0].username : null;
      if (imapUsername) {
        await adapters.mta.addEmailRoute(email, vaultboxId, { route_type: 'simple_imap', username: imapUsername, priority: 10 });
        console.log(`[EncimapAPI] MTA route added for alias ${email} -> simple-maildir:${imapUsername}`);
      } else {
        console.warn(`[EncimapAPI] No IMAP username found for vaultbox ${vaultboxId}; alias route not added (will rely on pgsql maps if configured)`);
      }
    } catch (routeErr) {
      console.warn('[EncimapAPI] Failed to add MTA route for alias:', routeErr.message);
    }
    res.status(201).json({ success: true, data: { id: created.id, alias_email: email, active: true } });
  } catch (e) {
    console.error('[EncimapAPI] Create alias error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Delete alias
app.delete('/s2s/v1/vaultboxes/:id/aliases/:aliasId', async (req, res) => {
  try {
    const vaultboxId = req.params.id;
    const aliasId = req.params.aliasId;
    const vaultbox = await adapters.storage.findById('vaultboxes', vaultboxId);
    if (!vaultbox) return res.status(404).json({ success: false, error: 'vaultbox not found' });
    if (vaultbox.mailbox_type !== 'simple') return res.status(400).json({ success: false, error: 'aliases supported only for simple mailboxes' });

    const hasPermission = await adapters.auth.hasPermission(req.user.id, 'delete', 'alias', { vaultbox_id: vaultboxId });
    if (!hasPermission && req.user.id !== vaultbox.user_id) return res.status(403).json({ success: false, error: 'access denied' });

    const existing = await adapters.storage.findById('simple_mailbox_aliases', aliasId);
    if (!existing) return res.status(404).json({ success: false, error: 'alias not found' });
    if (existing.vaultbox_id !== vaultboxId) return res.status(400).json({ success: false, error: 'alias does not belong to this mailbox' });

    // Remove MTA route first (best-effort)
    try {
      if (existing.alias_email) {
        await adapters.mta.removeEmailRoute(String(existing.alias_email).toLowerCase());
        console.log(`[EncimapAPI] MTA route removed for alias ${existing.alias_email}`);
      }
    } catch (routeErr) {
      console.warn('[EncimapAPI] Failed to remove MTA route for alias:', routeErr.message);
    }

    await adapters.storage.delete('simple_mailbox_aliases', { id: aliasId });
    res.json({ success: true, message: 'alias deleted' });
  } catch (e) {
    console.error('[EncimapAPI] Delete alias error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ====================================================================
// CERTIFICATE MANAGEMENT ENDPOINTS (EXISTING FUNCTIONALITY)
// ====================================================================

// Generate certificate using server-side OpenSSL
app.post('/s2s/v1/generate-certificate', async (req, res) => {
  try {
    const { common_name, email, organization } = req.body || {};
    if (!common_name || !email) {
      return res.status(400).json({ success: false, error: 'missing common_name or email' });
    }

    const fs = await import('fs');
    const os = await import('os');
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);

    const tmp = fs.mkdtempSync(os.tmpdir() + '/cert-gen-');
    const keyPath = tmp + '/private.key';
    const crtPath = tmp + '/certificate.crt';
    const configPath = tmp + '/cert.conf';
    
    // Create OpenSSL config for S/MIME certificate
    const config = `[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = ${common_name}
emailAddress = ${email}
O = ${organization || 'Motorical Encrypted IMAP (Self-signed)'}

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment, dataEncipherment
extendedKeyUsage = emailProtection, clientAuth
subjectAltName = email:${email}
`;
    
    fs.writeFileSync(configPath, config);
    
    // Generate private key (2048-bit RSA)
    await run('openssl', ['genrsa', '-out', keyPath, '2048']);
    
    // Generate self-signed certificate
    await run('openssl', ['req', '-new', '-x509', '-key', keyPath, '-out', crtPath, '-days', '365', '-config', configPath]);
    
    // Read generated files
    const pemKey = fs.readFileSync(keyPath, 'utf8');
    const pemCert = fs.readFileSync(crtPath, 'utf8');
    
    // Cleanup
    try { 
      fs.rmSync(tmp, { recursive: true, force: true }); 
    } catch(_) {}
    
    console.log(`[EncimapAPI] Generated certificate for ${common_name} (${email})`);

    res.json({
      success: true,
      data: {
        private_key: pemKey,
        certificate: pemCert,
        common_name,
        email
      }
    });
  } catch (error) {
    console.error('[EncimapAPI] Certificate generation failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Upload certificate for vaultbox
app.post('/s2s/v1/vaultboxes/:id/certs', async (req, res) => {
  try {
    const vaultboxId = req.params.id;
    const { label, public_cert_pem } = req.body || {};

    if (!public_cert_pem) {
      return res.status(400).json({ success: false, error: 'missing certificate' });
    }

    // Verify vaultbox exists and user has access
    const vaultbox = await adapters.storage.findById('vaultboxes', vaultboxId);
    if (!vaultbox) {
      return res.status(404).json({ success: false, error: 'vaultbox not found' });
    }

    // Check permission
    const hasPermission = await adapters.auth.hasPermission(
      req.user.id, 'create', 'certificate', { vaultbox_id: vaultboxId }
    );
    if (!hasPermission && req.user.id !== vaultbox.user_id) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    // Generate certificate fingerprint (placeholder - implement proper fingerprinting)
    const fingerprint = 'sha256:' + Buffer.from(public_cert_pem).toString('base64').slice(0, 32);

    const certData = {
      vaultbox_id: vaultboxId,
      label: label || null,
      public_cert_pem,
      fingerprint_sha256: fingerprint
    };

    const result = await adapters.storage.insert('vaultbox_certs', certData);

    console.log(`[EncimapAPI] Added certificate to vaultbox ${vaultboxId}`);

    res.json({
      success: true,
      data: {
        id: result.id, 
        fingerprint: fingerprint 
      }
    });
  } catch (error) {
    console.error('[EncimapAPI] Error adding certificate:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// IMAP CREDENTIALS ENDPOINTS (EXISTING FUNCTIONALITY)
// ====================================================================

// Create IMAP credentials (one per vaultbox)
app.post('/s2s/v1/imap-credentials', async (req, res) => {
  try {
    const { user_id, vaultbox_id } = req.body || {};
    const userId = user_id || req.user.id;

    // Check permission
    const hasPermission = await adapters.auth.hasPermission(
      req.user.id, 'create', 'credentials'
    );
    if (!hasPermission) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    // For now, maintain existing IMAP credential creation logic
    // This should be updated to use adapters, but keeping existing functionality
    // TODO: Refactor to use proper IMAP credential service

    res.json({ success: true, message: 'IMAP credentials endpoint - TODO: implement with adapters' });
  } catch (error) {
    console.error('[EncimapAPI] Error creating IMAP credentials:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate P12 bundle from PEM key and certificate
app.post('/s2s/v1/p12', async (req, res) => {
  try {
    const { pem_key, pem_cert, password, friendly_name } = req.body || {};
    if (!pem_key || !pem_cert || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'missing pem_key, pem_cert or password' });
    }

    const fs = await import('fs');
    const os = await import('os');
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);

    const tmp = fs.mkdtempSync(os.tmpdir() + '/p12-');
    const keyPath = tmp + '/key.pem';
    const crtPath = tmp + '/cert.pem';
    const outPath = tmp + '/bundle.p12';
    
    fs.writeFileSync(keyPath, pem_key);
    fs.writeFileSync(crtPath, pem_cert);
    
    const name = friendly_name || 'Encrypted IMAP';
    await run('openssl', ['pkcs12', '-export', '-inkey', keyPath, '-in', crtPath, '-name', name, '-passout', `pass:${password}`, '-out', outPath]);
    
    const buf = fs.readFileSync(outPath);
    
    res.setHeader('Content-Type', 'application/x-pkcs12');
    res.setHeader('Content-Disposition', 'attachment; filename="encrypted-imap.p12"');
    res.end(buf);
    
    try { 
      fs.rmSync(tmp, { recursive: true, force: true }); 
    } catch(_) {}
    
    console.log(`[EncimapAPI] Generated P12 bundle: ${name}`);
  } catch (error) {
    console.error('[EncimapAPI] P12 generation failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate ZIP bundle containing P12 and PEM files
app.post('/s2s/v1/bundle', async (req, res) => {
  try {
    const { pem_key, pem_cert, password, friendly_name } = req.body || {};
    if (!pem_key || !pem_cert || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'missing pem_key, pem_cert or password' });
    }

    const fs = await import('fs');
    const os = await import('os');
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);
    const JSZip = (await import('jszip')).default;

    const zip = new JSZip();
    const tmp = fs.mkdtempSync(os.tmpdir() + '/bundle-');
    const keyPath = tmp + '/key.pem';
    const crtPath = tmp + '/cert.pem';
    const outPath = tmp + '/bundle.p12';
    
    fs.writeFileSync(keyPath, pem_key);
    fs.writeFileSync(crtPath, pem_cert);
    
    const name = friendly_name || 'Encrypted IMAP';
    await run('openssl', ['pkcs12', '-export', '-inkey', keyPath, '-in', crtPath, '-name', name, '-passout', `pass:${password}`, '-out', outPath]);
    const p12Buffer = fs.readFileSync(outPath);
    
    // Add files to ZIP
    zip.file('encrypted-imap.p12', p12Buffer);
    zip.file('smime.crt', pem_cert);
    zip.file('README.txt', `Encrypted IMAP Certificate Bundle

Generated: ${new Date().toISOString()}
Password for P12: ${password}

Files included:
- encrypted-imap.p12: PKCS#12 bundle for mail client installation
- smime.crt: S/MIME certificate for encryption

Installation:
1. Install encrypted-imap.p12 in your mail client (iOS Mail, Apple Mail, Outlook, Thunderbird)
   - Tools → Settings → Privacy & Security → Certificates → Manage Certificates
   - Go to "Your Certificates" tab
   - Click "Import" and select encrypted-imap.p12
   - Enter password: ${password}
   
2. Import smime.crt for S/MIME encryption (optional, for other users to encrypt emails to you)

3. Configure IMAP:
   - Server: mail.motorical.com
   - Port: 4993 (for encrypted mailboxes) or 993 (for simple mailboxes)
   - Security: SSL/TLS
   - Authentication: Normal password

4. Restart your mail client

Note: When viewing encrypted messages, Thunderbird will automatically decrypt them using your imported certificate.
If you see a "security warning" about the self-signed certificate, you can safely ignore it - the encryption still works!

Support: https://motorical.com/docs/encrypted-imap
`);

    const zipBuffer = await zip.generateAsync({ 
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="encrypted-imap-bundle.zip"');
    res.end(zipBuffer);
    
    try { 
      fs.rmSync(tmp, { recursive: true, force: true }); 
    } catch(_) {}
    
    console.log(`[EncimapAPI] Generated certificate bundle: ${name}`);
  } catch (error) {
    console.error('[EncimapAPI] Bundle generation failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// DOMAIN MANAGEMENT ENDPOINTS
// ====================================================================

// Register domain for encrypted IMAP
app.post('/s2s/v1/domains', async (req, res) => {
  try {
    const { user_id, domain, name, alias } = req.body || {};
    const userId = user_id || req.user.id;

    if (!domain) {
      return res.status(400).json({ success: false, error: 'missing domain' });
    }

    // Check permission
    const hasPermission = await adapters.auth.hasPermission(
      req.user.id, 'create', 'domain'
    );
    if (!hasPermission) {
      return res.status(403).json({ success: false, error: 'access denied' });
    }

    const domainLower = domain.toLowerCase();

    // Verify user owns the domain
    const userDomains = await adapters.user.getUserDomains(userId);
    const validDomain = userDomains.find(d => d.domain.toLowerCase() === domainLower && d.verified);
    
    if (!validDomain) {
      return res.status(400).json({ success: false, error: 'domain not verified for user' });
    }

    // Check if vaultbox already exists for this domain
    const existingVaultbox = await adapters.storage.find('vaultboxes', {
      user_id: userId,
      domain: domainLower
    }, { limit: 1 });

    let vaultboxId;
    if (existingVaultbox.rows.length > 0) {
      vaultboxId = existingVaultbox.rows[0].id;
    } else {
      // Create new vaultbox
      const vaultboxData = {
        user_id: userId,
        domain: domainLower,
        name: name || domainLower,
        status: 'active',
        smtp_enabled: false
      };

      const result = await adapters.storage.insert('vaultboxes', vaultboxData);
      vaultboxId = result.id;
    }

    // Set up MTA routing
    try {
      await adapters.mta.addDomainRoute(domainLower, vaultboxId, {
        priority: 10,
        route_type: 'encrypted_imap'
      });
    } catch (mtaError) {
      console.warn('[EncimapAPI] MTA routing setup failed:', mtaError.message);
    }

    res.json({
      success: true,
      data: {
        vaultbox_id: vaultboxId,
        domain: domainLower 
      }
    });
  } catch (error) {
    console.error('[EncimapAPI] Error registering domain:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete domain registration (best-effort): removes any transport mapping for domain-level routing
app.delete('/s2s/v1/domains/:domain', async (req, res) => {
  try {
    const domain = String(req.params.domain || '').toLowerCase();
    if (!domain) return res.status(400).json({ success: false, error: 'missing domain' });

    // Remove domain route in Postfix transport (best-effort)
    try {
      await adapters.mta.removeDomainRoute(domain);
    } catch (_) { /* ignore */ }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// ADMINISTRATION AND MONITORING
// ====================================================================

// Get adapter status (admin only)
app.get('/s2s/v1/admin/adapters/status', async (req, res) => {
  try {
    // Check admin permission
    const hasPermission = await adapters.auth.hasPermission(
      req.user.id, 'read', 'system'
    );
    if (!hasPermission) {
      return res.status(403).json({ success: false, error: 'admin access required' });
    }

    const adapterHealth = {};
    for (const [name, adapter] of Object.entries(adapters)) {
      try {
        adapterHealth[name] = await adapter.healthCheck();
      } catch (error) {
        adapterHealth[name] = { healthy: false, error: error.message };
      }
    }

    res.json({ success: true, data: adapterHealth });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// HELPER FUNCTIONS FOR UNIFIED USERNAME GENERATION
// ====================================================================

/**
 * Generate a unified username for both IMAP and SMTP credentials
 * Format: encimap-{domain-with-hyphens}-{random-suffix}
 * This ensures both IMAP and SMTP use the same standardized format
 */


// ====================================================================
// FIREWALL MANAGEMENT API ENDPOINTS (for OVH24 Backend)
// ====================================================================
// These endpoints manage iptables port forwarding and UFW rules
// on the mail host via HTTP API calls from OVH24.

const FIREWALL_TARGET_PORT = 2587;
const FIREWALL_COMMAND_TIMEOUT_MS = 10000;

function parseTcpPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function normalizeUfwComment(comment) {
  if (!comment) {
    return null;
  }

  const normalized = String(comment).trim();
  if (!normalized) {
    return null;
  }

  if (/[\x00-\x1F\x7F]/.test(normalized) || normalized.length > 128) {
    throw new Error('Invalid UFW comment');
  }

  return normalized;
}

async function runFirewallCommand(command, args) {
  return execFileAsync(command, args, {
    timeout: FIREWALL_COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  });
}

function iptablesPortForwardArgs(action, port, targetPort = FIREWALL_TARGET_PORT) {
  return [
    '-t', 'nat', action, 'PREROUTING',
    '-p', 'tcp', '--dport', String(port),
    '-j', 'REDIRECT', '--to-port', String(targetPort)
  ];
}

async function getUfwStatus() {
  const { stdout } = await runFirewallCommand('ufw', ['status', 'numbered']);
  return stdout || '';
}

function ufwStatusHasPort(statusOutput, port) {
  return new RegExp(`\\b${port}/tcp\\b`).test(statusOutput);
}

// Firewall routes require S2S authentication
app.use('/api/internal/firewall', authenticateS2S);

// GET /api/internal/firewall/check-port-forward/:port
app.get('/api/internal/firewall/check-port-forward/:port', async (req, res) => {
  try {
    const port = parseTcpPort(req.params.port);
    if (!port) {
      return res.status(400).json({ success: false, error: 'Invalid port number' });
    }
    try {
      await runFirewallCommand('iptables', iptablesPortForwardArgs('-C', port));
      res.json({ exists: true, targetPort: FIREWALL_TARGET_PORT });
    } catch (checkError) {
      res.json({ exists: false });
    }
  } catch (error) {
    console.error('[EncimapAPI] Check port forward error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/internal/firewall/port-forward
app.post('/api/internal/firewall/port-forward', async (req, res) => {
  try {
    const { port, targetPort } = req.body || {};
    const portNum = parseTcpPort(port);
    const targetPortNum = targetPort === undefined ? FIREWALL_TARGET_PORT : parseTcpPort(targetPort);
    if (!portNum || !targetPortNum) {
      return res.status(400).json({ success: false, error: 'Invalid port number' });
    }
    try {
      await runFirewallCommand('iptables', iptablesPortForwardArgs('-C', portNum, targetPortNum));
      return res.json({ success: true, created: false, message: 'Port forwarding already exists' });
    } catch (checkError) {
      await runFirewallCommand('iptables', iptablesPortForwardArgs('-A', portNum, targetPortNum));
      console.log(`[EncimapAPI] Created iptables port forwarding: ${portNum} -> ${targetPortNum}`);
      return res.json({ success: true, created: true, message: 'Port forwarding created successfully' });
    }
  } catch (error) {
    console.error('[EncimapAPI] Create port forward error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/internal/firewall/port-forward/:port
app.delete('/api/internal/firewall/port-forward/:port', async (req, res) => {
  try {
    const port = parseTcpPort(req.params.port);
    if (!port) {
      return res.status(400).json({ success: false, error: 'Invalid port number' });
    }
    try {
      await runFirewallCommand('iptables', iptablesPortForwardArgs('-D', port));
      console.log(`[EncimapAPI] Removed iptables port forwarding: ${port} -> ${FIREWALL_TARGET_PORT}`);
      res.json({ success: true, message: 'Port forwarding removed successfully' });
    } catch (error) {
      console.warn(`[EncimapAPI] Port forwarding rule for ${port} may not exist:`, error.message);
      res.json({ success: true, message: 'Port forwarding rule not found (may already be removed)' });
    }
  } catch (error) {
    console.error('[EncimapAPI] Remove port forward error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/internal/firewall/check-ufw/:port
app.get('/api/internal/firewall/check-ufw/:port', async (req, res) => {
  try {
    const port = parseTcpPort(req.params.port);
    if (!port) {
      return res.status(400).json({ success: false, error: 'Invalid port number' });
    }
    try {
      const statusOutput = await getUfwStatus();
      res.json({ exists: ufwStatusHasPort(statusOutput, port) });
    } catch (checkError) {
      res.json({ exists: false });
    }
  } catch (error) {
    console.error('[EncimapAPI] Check UFW error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/internal/firewall/ufw-rule
app.post('/api/internal/firewall/ufw-rule', async (req, res) => {
  try {
    const { port, comment } = req.body || {};
    const portNum = parseTcpPort(port);
    if (!portNum) {
      return res.status(400).json({ success: false, error: 'Invalid port number' });
    }
    const statusOutput = await getUfwStatus();
    if (ufwStatusHasPort(statusOutput, portNum)) {
      return res.json({ success: true, created: false, message: 'UFW rule already exists' });
    }

    const args = ['allow', `${portNum}/tcp`];
    const commentValue = normalizeUfwComment(comment);
    if (commentValue) {
      args.push('comment', commentValue);
    }

    await runFirewallCommand('ufw', args);
    console.log(`[EncimapAPI] Created UFW rule for port ${portNum}`);
    return res.json({ success: true, created: true, message: 'UFW rule created successfully' });
  } catch (error) {
    console.error('[EncimapAPI] Create UFW rule error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/internal/firewall/ufw-rule/:port
app.delete('/api/internal/firewall/ufw-rule/:port', async (req, res) => {
  try {
    const port = parseTcpPort(req.params.port);
    if (!port) {
      return res.status(400).json({ success: false, error: 'Invalid port number' });
    }
    try {
      await runFirewallCommand('ufw', ['delete', 'allow', `${port}/tcp`]);
      console.log(`[EncimapAPI] Removed UFW rule for port ${port}`);
      res.json({ success: true, message: 'UFW rule removed successfully' });
    } catch (error) {
      console.warn(`[EncimapAPI] UFW rule for ${port} may not exist:`, error.message);
      res.json({ success: true, message: 'UFW rule not found (may already be removed)' });
    }
  } catch (error) {
    console.error('[EncimapAPI] Remove UFW rule error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/internal/firewall/rules
app.get('/api/internal/firewall/rules', async (req, res) => {
  try {
    const iptablesOutput = await runFirewallCommand('iptables', ['-t', 'nat', '-L', 'PREROUTING', '-n']);
    const iptablesPorts = [];
    const lines = iptablesOutput.stdout.split('\n');
    for (const line of lines) {
      const match = line.match(/dpt:(\d+).*redir ports (\d+)/);
      if (match) {
        iptablesPorts.push(parseInt(match[1]));
      }
    }

    const ufwOutput = await getUfwStatus();
    const ufwPorts = [...ufwOutput.matchAll(/\b(\d+)\/tcp\b/g)]
      .map(match => parseInt(match[1]))
      .filter(port => !isNaN(port));

    res.json({ 
      iptables: [...new Set(iptablesPorts)].sort((a, b) => a - b),
      ufw: [...new Set(ufwPorts)].sort((a, b) => a - b)
    });
  } catch (error) {
    console.error('[EncimapAPI] Get firewall rules error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

function generateUnifiedUsername(domain, vaultboxId) {
  // Normalize domain (replace dots with hyphens, remove special chars)
  const normalizedDomain = domain
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/[^a-z0-9\-]/g, '');
  
  // Generate a short random suffix for uniqueness
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  
  // Create unified username format
  const username = `encimap-${normalizedDomain}-${randomSuffix}`;
  
  console.log(`[EncimapAPI] Generated unified username: ${username} for domain: ${domain}`);
  return username;
}

// Start server
const PORT = process.env.PORT || 4301;

// Initialize and start
initializeServer().then(() => {
  app.listen(PORT, () => {
    console.log(`[EncimapAPI] Server listening on port ${PORT} with adapter architecture`);
  });
}).catch((error) => {
  console.error('[EncimapAPI] Failed to start server:', error);
  process.exit(1);
});

export default app;
