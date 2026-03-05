/**
 * Unified SMTP Authentication Service
 * 
 * Handles authentication for both regular MotorBlocks and Vaultbox SMTP credentials.
 * This service integrates with the main SMTP gateway to provide clean separation.
 */

import { Pool } from 'pg';
import bcrypt from 'bcrypt';

export class SmtpAuthService {
  constructor(config = {}) {
    // Main Motorical database for regular motorblocks
    this.motoricalPool = new Pool({
      connectionString: config.motoricalDbUrl || process.env.MOTORICAL_DATABASE_URL
    });
    
    // Encrypted IMAP database for vaultbox credentials  
    this.encimapPool = new Pool({
      connectionString: config.encimapDbUrl || process.env.ENCIMAP_DATABASE_URL
    });
    
    this.debug = config.debug || false;
  }

  /**
   * Authenticate SMTP credentials - handles both MotorBlocks and Vaultboxes
   */
  async authenticate(username, password) {
    try {
      if (this.debug) {
        console.log(`[SmtpAuth] Authenticating: ${username}`);
      }

      // Determine credential type based on username pattern
      if (username.startsWith('vaultbox-')) {
        return await this._authenticateVaultbox(username, password);
      } else {
        return await this._authenticateMotorBlock(username, password);
      }
    } catch (error) {
      console.error('[SmtpAuth] Authentication error:', error);
      return {
        success: false,
        type: 'error',
        error: error.message
      };
    }
  }

  /**
   * Get rate limits for authenticated user
   */
  async getRateLimits(authResult) {
    try {
      if (authResult.type === 'vaultbox') {
        // Vaultbox SMTP has simple, generous limits
        return {
          dailyLimit: 1000,
          hourlyLimit: 100,
          burstLimit: 10,
          concurrentConnections: 2
        };
      } else if (authResult.type === 'motorblock') {
        // Get limits from motorblock configuration
        const result = await this.motoricalPool.query(`
          SELECT limits FROM motor_blocks WHERE id = $1
        `, [authResult.motorBlockId]);
        
        if (result.rows.length > 0) {
          const limits = result.rows[0].limits || {};
          return {
            dailyLimit: limits.dailyVolume || 1000,
            hourlyLimit: limits.hourlyRate || 100,
            burstLimit: limits.burstLimit || 50,
            concurrentConnections: limits.concurrentConnections || 5
          };
        }
      }

      // Default limits
      return {
        dailyLimit: 100,
        hourlyLimit: 10,
        burstLimit: 5,
        concurrentConnections: 1
      };
    } catch (error) {
      console.error('[SmtpAuth] Error getting rate limits:', error);
      // Return conservative defaults on error
      return {
        dailyLimit: 100,
        hourlyLimit: 10,
        burstLimit: 5,
        concurrentConnections: 1
      };
    }
  }

  /**
   * Record successful email sending
   */
  async recordEmailSent(authResult, messageSize = 0) {
    try {
      if (authResult.type === 'vaultbox') {
        // Update vaultbox SMTP usage
        await this.encimapPool.query(`
          UPDATE vaultbox_smtp_credentials 
          SET 
            messages_sent_count = messages_sent_count + 1,
            last_message_sent = now()
          WHERE id = $1
        `, [authResult.credentialsId]);
      } else if (authResult.type === 'motorblock') {
        // Record in motorblock system (this would integrate with existing tracking)
        // For now, just log it
        if (this.debug) {
          console.log(`[SmtpAuth] Email sent via motorblock ${authResult.motorBlockId}: ${messageSize} bytes`);
        }
      }
    } catch (error) {
      // Don't throw - this is best effort tracking
      console.warn('[SmtpAuth] Failed to record email sent:', error.message);
    }
  }

  /**
   * Get user information for logging/monitoring
   */
  async getUserInfo(authResult) {
    try {
      if (authResult.type === 'vaultbox') {
        const result = await this.encimapPool.query(`
          SELECT 
            v.user_id,
            v.domain,
            v.name as vaultbox_name,
            vsc.username,
            vsc.messages_sent_count
          FROM vaultbox_smtp_credentials vsc
          JOIN vaultboxes v ON vsc.vaultbox_id = v.id
          WHERE vsc.id = $1
        `, [authResult.credentialsId]);

        if (result.rows.length > 0) {
          const row = result.rows[0];
          return {
            userId: row.user_id,
            domain: row.domain,
            containerName: row.vaultbox_name,
            username: row.username,
            messagesSent: row.messages_sent_count || 0,
            type: 'vaultbox'
          };
        }
      } else if (authResult.type === 'motorblock') {
        const result = await this.motoricalPool.query(`
          SELECT 
            mb.user_id,
            mb.name as motorblock_name,
            d.domain,
            mb.smtp_user as username
          FROM motor_blocks mb
          LEFT JOIN domains d ON mb.domain_id = d.id
          WHERE mb.id = $1
        `, [authResult.motorBlockId]);

        if (result.rows.length > 0) {
          const row = result.rows[0];
          return {
            userId: row.user_id,
            domain: row.domain,
            containerName: row.motorblock_name,
            username: row.username,
            type: 'motorblock'
          };
        }
      }

      return null;
    } catch (error) {
      console.error('[SmtpAuth] Error getting user info:', error);
      return null;
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      // Test both database connections
      await this.motoricalPool.query('SELECT 1');
      await this.encimapPool.query('SELECT 1');
      
      return {
        healthy: true,
        details: {
          motorical_db: 'connected',
          encimap_db: 'connected'
        }
      };
    } catch (error) {
      return {
        healthy: false,
        details: {
          error: error.message
        }
      };
    }
  }

  // Private methods
  async _authenticateVaultbox(username, password) {
    try {
      const result = await this.encimapPool.query(`
        SELECT 
          vsc.id,
          vsc.password_hash,
          vsc.vaultbox_id,
          vsc.enabled,
          v.user_id,
          v.domain
        FROM vaultbox_smtp_credentials vsc
        JOIN vaultboxes v ON vsc.vaultbox_id = v.id
        WHERE vsc.username = $1 AND vsc.enabled = true
      `, [username]);

      if (result.rows.length === 0) {
        return {
          success: false,
          type: 'vaultbox',
          error: 'credentials not found'
        };
      }

      const creds = result.rows[0];
      const isValid = await bcrypt.compare(password, creds.password_hash);

      if (!isValid) {
        return {
          success: false,
          type: 'vaultbox',
          error: 'invalid password'
        };
      }

      // Update last used timestamp
      await this.encimapPool.query(`
        UPDATE vaultbox_smtp_credentials 
        SET last_used = now() 
        WHERE id = $1
      `, [creds.id]);

      if (this.debug) {
        console.log(`[SmtpAuth] Vaultbox auth success: ${username} (${creds.domain})`);
      }

      return {
        success: true,
        type: 'vaultbox',
        credentialsId: creds.id,
        vaultboxId: creds.vaultbox_id,
        userId: creds.user_id,
        domain: creds.domain,
        username: username
      };
    } catch (error) {
      throw new Error(`Vaultbox authentication failed: ${error.message}`);
    }
  }

  async _authenticateMotorBlock(username, password) {
    try {
      // Query the motor_blocks table for authentication
      // This integrates with your existing MotorBlock system
      const result = await this.motoricalPool.query(`
        SELECT 
          mb.id,
          mb.smtp_password,
          mb.user_id,
          mb.active,
          d.domain
        FROM motor_blocks mb
        LEFT JOIN domains d ON mb.domain_id = d.id
        WHERE mb.smtp_user = $1 AND mb.active = true
      `, [username]);

      if (result.rows.length === 0) {
        return {
          success: false,
          type: 'motorblock',
          error: 'motorblock not found'
        };
      }

      const motorBlock = result.rows[0];
      
      // For motorblocks, password might be stored differently
      // This depends on your existing implementation
      const isValid = password === motorBlock.smtp_password || 
                     await bcrypt.compare(password, motorBlock.smtp_password);

      if (!isValid) {
        return {
          success: false,
          type: 'motorblock',
          error: 'invalid password'
        };
      }

      if (this.debug) {
        console.log(`[SmtpAuth] MotorBlock auth success: ${username} (${motorBlock.domain})`);
      }

      return {
        success: true,
        type: 'motorblock',
        motorBlockId: motorBlock.id,
        userId: motorBlock.user_id,
        domain: motorBlock.domain,
        username: username
      };
    } catch (error) {
      throw new Error(`MotorBlock authentication failed: ${error.message}`);
    }
  }

  /**
   * Close database connections
   */
  async close() {
    await this.motoricalPool.end();
    await this.encimapPool.end();
  }
}

export default SmtpAuthService;
