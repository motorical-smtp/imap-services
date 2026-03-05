#!/usr/bin/env node

// Script to synchronize IMAP and SMTP usernames to use unified format
// This will update existing IMAP credentials to match the new unified format

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.ENCIMAP_DATABASE_URL
});

/**
 * Generate a unified username for both IMAP and SMTP credentials
 * Format: encimap-{domain-with-hyphens}-{random-suffix}
 */
function generateUnifiedUsername(domain) {
  // Normalize domain (replace dots with hyphens, remove special chars)
  const normalizedDomain = domain
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/[^a-z0-9\-]/g, '');
  
  // Generate a short random suffix for uniqueness
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  
  // Create unified username format
  const username = `encimap-${normalizedDomain}-${randomSuffix}`;
  
  console.log(`Generated unified username: ${username} for domain: ${domain}`);
  return username;
}

async function syncUsernames() {
  try {
    console.log('🔄 Starting username synchronization...');
    
    // Get all vaultboxes with IMAP credentials that don't follow unified format
    const result = await pool.query(`
      SELECT v.id, v.domain, i.username as current_username
      FROM vaultboxes v 
      JOIN imap_app_credentials i ON v.id = i.vaultbox_id
      WHERE i.username NOT LIKE 'encimap-%'
      ORDER BY v.domain
    `);
    
    console.log(`Found ${result.rows.length} IMAP credentials to update:`);
    
    for (const row of result.rows) {
      console.log(`\n📧 Processing vaultbox: ${row.domain}`);
      console.log(`   Current IMAP username: ${row.current_username}`);
      
      // Generate new unified username
      const newUsername = generateUnifiedUsername(row.domain);
      console.log(`   New unified username: ${newUsername}`);
      
      // Check if new username already exists
      const existingCheck = await pool.query('SELECT id FROM imap_app_credentials WHERE username = $1', [newUsername]);
      if (existingCheck.rows.length > 0) {
        console.log(`   ⚠️  Username ${newUsername} already exists, generating new one...`);
        const alternativeUsername = generateUnifiedUsername(row.domain);
        console.log(`   Using alternative: ${alternativeUsername}`);
        
        // Update to alternative username
        await pool.query(`
          UPDATE imap_app_credentials 
          SET username = $1, updated_at = now()
          WHERE vaultbox_id = $2
        `, [alternativeUsername, row.id]);
        
        console.log(`   ✅ Updated IMAP username to: ${alternativeUsername}`);
      } else {
        // Update to new unified username
        await pool.query(`
          UPDATE imap_app_credentials 
          SET username = $1, updated_at = now()
          WHERE vaultbox_id = $2
        `, [newUsername, row.id]);
        
        console.log(`   ✅ Updated IMAP username to: ${newUsername}`);
      }
    }
    
    console.log('\n🎉 Username synchronization completed!');
    console.log('\n📋 Updated credentials summary:');
    
    // Show final state
    const finalResult = await pool.query(`
      SELECT v.domain, i.username as imap_username
      FROM vaultboxes v 
      JOIN imap_app_credentials i ON v.id = i.vaultbox_id
      ORDER BY v.domain
    `);
    
    finalResult.rows.forEach(row => {
      console.log(`   ${row.domain}: ${row.imap_username}`);
    });
    
  } catch (error) {
    console.error('❌ Error during username synchronization:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run the synchronization
syncUsernames();
