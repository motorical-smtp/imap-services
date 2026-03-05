# Encrypted IMAP Deployment Guide - Clean Architecture

This guide covers deploying the new clean separation architecture with dedicated vaultbox SMTP credentials, dual database design, and complete service integration.

## 🏗️ **Architecture Overview**

The new architecture provides:
- **Complete separation** between MotorBlocks and vaultbox SMTP credentials
- **Dual database design** for security isolation
- **Unified SMTP authentication** without mixing concerns
- **Clean frontend UI** with no MotorBlock confusion

## 🚀 **Quick Deployment**

### **1. Database Setup**

#### **Setup Encrypted IMAP Database**
```bash
# Create dedicated database and user
sudo -u postgres psql -c "CREATE DATABASE motorical_encrypted_imap;"
sudo -u postgres psql -c "CREATE USER encimap WITH PASSWORD '<DB_PASSWORD>';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE motorical_encrypted_imap TO encimap;"

# Run the complete schema setup
sudo -u postgres psql -d motorical_encrypted_imap -f /root/encrypted-imap/scripts/setup-database.sql
```

#### **Database Verification**
```bash
# Verify both databases are accessible
sudo -u motorical psql -d motorical_db -c "SELECT COUNT(*) FROM users;"
sudo -u encimap psql -d motorical_encrypted_imap -c "SELECT COUNT(*) FROM vaultboxes;"
```

### **2. Environment Configuration**

#### **Backend API Environment** (`/etc/motorical/backend.env`)
```bash
# Main platform database
DATABASE_URL=postgresql://motorical:<DB_PASSWORD>@localhost:5432/motorical_db

# JWT and other configs (existing)
JWT_SECRET=your_jwt_secret
S2S_JWT_SECRET=your_s2s_secret
STRIPE_SECRET_KEY=sk_live_...
```

#### **Encrypted IMAP API Environment** (`/etc/motorical/encimap.env`)
```bash
# Encrypted IMAP database
DATABASE_URL=postgresql://encimap:<DB_PASSWORD>@localhost:5432/motorical_encrypted_imap

# S2S communication
S2S_JWT_SECRET=your_s2s_secret

# Dual database access for SMTP Auth (NEW)
MOTORICAL_DATABASE_URL=postgresql://motorical:<DB_PASSWORD>@localhost:5432/motorical_db
ENCIMAP_DATABASE_URL=postgresql://encimap:<DB_PASSWORD>@localhost:5432/motorical_encrypted_imap
```

#### **Adapter Configuration** (Optional)
```bash
# Copy and customize adapter configuration for advanced features
cd /root/encrypted-imap
cp config/adapters.example.yaml config/adapters.yaml

# Edit configuration for your environment
nano config/adapters.yaml
```

### **3. Install Dependencies**

```bash
cd /root/encrypted-imap
npm install js-yaml bcrypt
```

### **4. Environment Variables**

Add to `/etc/motorical/encimap.env`:

```bash
# Existing variables
DATABASE_URL=postgresql://motorical:<DB_PASSWORD>@localhost:5432/motorical_db
MAILDIR_ROOT=/var/mail/vaultboxes
API_PREFIX=/s2s/v1

# New adapter system variables
S2S_JWT_PUBLIC_BASE64=your_jwt_public_key_base64
MOTORICAL_API_TOKEN=your_api_token_if_needed
NODE_ENV=production
```

### **5. Service Restart**

Restart services in proper dependency order:

```bash
# Restart in correct order for new architecture
sudo systemctl restart motorical-backend-api.service
sudo systemctl restart encimap-api.service
sudo systemctl restart encimap-intake.service
sudo systemctl restart motorical-smtp-gateway.service

# Verify all services are running
sudo systemctl status motorical-backend-api encimap-api encimap-intake motorical-smtp-gateway --no-pager
```

### **6. Verification**

```bash
# Test backend API
curl -f http://localhost:3001/api/health

# Test encrypted IMAP API  
curl -f http://localhost:4301/s2s/v1/health

# Verify frontend loads without errors
curl -f http://localhost:3000/
```

## 📋 **Detailed Deployment Steps**

### **Phase 1: Database Setup (Dual Database Architecture)**

1. **Setup Encrypted IMAP Database**:
   ```bash
   # Create dedicated database
   sudo -u postgres psql -c "CREATE DATABASE motorical_encrypted_imap;"
   sudo -u postgres psql -c "CREATE USER encimap WITH PASSWORD '<DB_PASSWORD>';"
   sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE motorical_encrypted_imap TO encimap;"
   
   # Run complete schema
   sudo -u postgres psql -d motorical_encrypted_imap -f /root/encrypted-imap/scripts/setup-database.sql
   ```

2. **Verify Schema**:
   ```bash
   # Connect to encrypted IMAP database
   sudo -u encimap psql -d motorical_encrypted_imap
   
   # Verify tables exist
   \dt
   # Should show: vaultboxes, vaultbox_smtp_credentials, imap_credentials, certificates
   
   # Verify specific table structure
   \d vaultbox_smtp_credentials
   ```

3. **Verify Dual Database Access**:
   ```bash
   # Test both database connections
   sudo -u motorical psql -d motorical_db -c "SELECT COUNT(*) FROM users;"
   sudo -u encimap psql -d motorical_encrypted_imap -c "SELECT COUNT(*) FROM vaultboxes;"
   ```

### **Phase 2: Adapter Configuration**

1. **Configure Storage Adapter**:
   ```yaml
   adapters:
     storage:
       type: "postgresql"
       config:
         url: "${DATABASE_URL}"
         pool_size: 10
   ```

2. **Configure Auth Adapter**:
   ```yaml
   adapters:
     auth:
       type: "jwt"
       config:
         public_key_base64: "${S2S_JWT_PUBLIC_BASE64}"
         audience: "encimap.svc"
   ```

3. **Configure User Adapter**:
   ```yaml
   adapters:
     user:
       type: "motorical"
       config:
         api_base_url: "http://localhost:3001"
   ```

4. **Configure MTA Adapter**:
   ```yaml
   adapters:
     mta:
       type: "postfix"
       config:
         transport_map: "/etc/postfix/transport"
         main_config: "/etc/postfix/main.cf"
   ```

### **Phase 3: Service Deployment**

1. **Test New API Server**:
   ```bash
   cd /root/encrypted-imap/services/api
   node server-v2.js
   ```

2. **Test Health Endpoint**:
   ```bash
   curl http://localhost:4301/s2s/v1/health
   ```

3. **Update Systemd Service**:
   ```bash
   sudo systemctl edit encimap-api --full
   ```

### **Phase 4: Database Setup**

1. **Run Database Setup**:
   ```bash
   cd /root/encrypted-imap
   sudo -u postgres psql -d motorical_db -f scripts/setup-database.sql
   ```

2. **Verify Setup**:
   ```sql
   -- Check tables were created
   \d vaultbox_smtp_credentials
   \d vaultboxes
   
   -- Test username generation function
   SELECT generate_vaultbox_smtp_username('example.com', gen_random_uuid());
   ```

3. **No Migration Needed**:
   - Fresh start with clean separation
   - No existing data conflicts
   - MotorBlocks remain completely separate

### **Phase 5: Frontend Updates**

1. **Update EncryptedImap.js**:
   - Use new vaultbox SMTP endpoints
   - Remove motorblock creation logic
   - Simplify SMTP credential management

2. **Update MotorBlocks.js**:
   - Remove vaultbox-related filtering
   - Clean up mixed UI elements
   - Focus on pure motorblock features

### **Phase 6: SMTP Gateway Integration**

1. **Update SMTP Gateway** (if separate):
   ```javascript
   import SmtpAuthService from './services/smtp-auth-service.js';
   
   const authService = new SmtpAuthService({
     motoricalDbUrl: process.env.DATABASE_URL,
     encimapDbUrl: process.env.DATABASE_URL,
     debug: process.env.NODE_ENV !== 'production'
   });
   ```

2. **Test Authentication**:
   ```bash
   # Test vaultbox credentials
   echo "test email" | sendmail -S mail.motorical.com:587 -au vaultbox-example-com-12345678 -ap your_password test@example.com
   
   # Test regular motorblock credentials  
   echo "test email" | sendmail -S mail.motorical.com:587 -au regular_motorblock_user -ap motorblock_password test@example.com
   ```

## 🔧 **Configuration Reference**

### **Complete adapters.yaml Example**

```yaml
api:
  prefix: "/s2s/v1"
  port: 4301

adapters:
  auth:
    type: "jwt"
    config:
      public_key_base64: "${S2S_JWT_PUBLIC_BASE64}"
      algorithm: "RS256"
      audience: "encimap.svc"
  
  user:
    type: "motorical"
    config:
      api_base_url: "http://localhost:3001"
  
  mta:
    type: "postfix"
    config:
      transport_map: "/etc/postfix/transport"
      main_config: "/etc/postfix/main.cf"
      reload_command: ["systemctl", "reload", "postfix"]
  
  storage:
    type: "postgresql"
    config:
      url: "${DATABASE_URL}"
      pool_size: 10

environments:
  production:
    adapters:
      storage:
        config:
          pool_size: 20
```

### **Environment Variables**

```bash
# Required - Encrypted IMAP Database (separate from Motorical)
ENCIMAP_DATABASE_URL=postgresql://encimap:<DB_PASSWORD>@localhost:5432/motorical_encrypted_imap
S2S_JWT_PUBLIC_BASE64=base64_encoded_public_key

# Optional - Motorical Database (for SMTP auth integration)
MOTORICAL_DATABASE_URL=postgresql://motorical:<DB_PASSWORD>@localhost:5432/motorical_db

# Optional
MOTORICAL_API_TOKEN=optional_for_internal_calls
NODE_ENV=production
MAILDIR_ROOT=/var/mail/vaultboxes
API_PREFIX=/s2s/v1
```

## ✅ **Verification Steps**

### **1. Health Checks**

```bash
# Check API health
curl http://localhost:4301/s2s/v1/health

# Check adapter health
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     http://localhost:4301/s2s/v1/admin/adapters/status
```

### **2. Database Verification**

```sql
-- Check vaultbox SMTP credentials
SELECT v.domain, vsc.username, vsc.enabled 
FROM vaultboxes v
JOIN vaultbox_smtp_credentials vsc ON v.id = vsc.vaultbox_id;

-- Check for migrated motorblocks
SELECT name, description, active 
FROM motor_blocks 
WHERE description LIKE '%MIGRATED%';
```

### **3. Functional Testing**

```bash
# Test vaultbox creation
curl -X POST -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"domain":"test.com","name":"Test Vaultbox"}' \
     http://localhost:4301/s2s/v1/vaultboxes

# Test SMTP credential creation
curl -X POST -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     http://localhost:4301/s2s/v1/vaultboxes/VAULTBOX_ID/smtp-credentials
```

## 🚨 **Troubleshooting**

### **Common Issues**

1. **Adapter Health Fails**:
   ```bash
   # Check logs
   sudo journalctl -u encimap-api -f
   
   # Test database connection
   sudo -u postgres psql -d motorical_db -c "SELECT 1"
   ```

2. **Database Setup Issues**:
   ```bash
   # Re-run setup script
   sudo -u postgres psql -d motorical_db -f scripts/setup-database.sql
   
   # Check table structure
   sudo -u postgres psql -d motorical_db -c "\d vaultbox_smtp_credentials"
   ```

3. **SMTP Authentication Fails**:
   ```bash
   # Check credentials in database
   sudo -u postgres psql -d motorical_db -c "SELECT username, enabled FROM vaultbox_smtp_credentials"
   
   # Test password hashing
   node -e "const bcrypt=require('bcrypt'); console.log(bcrypt.compareSync('testpass', 'stored_hash'))"
   ```

### **Rollback Procedure**

If you need to rollback:

1. **Stop New Service**:
   ```bash
   sudo systemctl stop encimap-api
   ```

2. **Restore Old Service**:
   ```bash
   # Edit systemd service back to old server
   sudo systemctl edit encimap-api --full
   # Change ExecStart back to server.js
   sudo systemctl start encimap-api
   ```

3. **Clean Database** (if needed):
   ```sql
   -- Remove vaultbox SMTP data to start fresh
   TRUNCATE vaultbox_smtp_credentials;
   UPDATE vaultboxes SET smtp_enabled = false;
   ```

## 📞 **Support**

- **Logs**: `sudo journalctl -u encimap-api -f`
- **Database**: `sudo -u postgres psql -d motorical_db`
- **Health Check**: `curl http://localhost:4301/s2s/v1/health`
- **Configuration**: `/root/encrypted-imap/config/adapters.yaml`

---

**Next**: Update frontend for clean vaultbox-motorblock separation
