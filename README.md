# IMAP Services

IMAP Services is the public repository for Motorical mailbox infrastructure. It supports both Simple Mailboxes and Encrypted Mailboxes, with standard IMAP access, custom-domain routing, mailbox management, certificate handling for encrypted mailboxes, and optional SMTP companion credentials.

The project used to be described primarily as "Encrypted IMAP". That is no longer accurate: encrypted mailboxes are one mode of the service, while Simple Mailboxes provide regular IMAP mailboxes for customers who do not need S/MIME certificate setup.

## Current Product Positioning

Motorical provides two mailbox types:

| Capability | Simple Mailboxes | Encrypted Mailboxes |
| --- | --- | --- |
| IMAP access | Yes | Yes |
| Works with standard email clients | Yes | Yes |
| Certificate required | No | Yes, S/MIME |
| At-rest protection | Server-level storage protection | Per-message S/MIME encryption |
| Zero-knowledge message content | No | Yes |
| Setup complexity | Minimal | Moderate |

Start with Simple Mailboxes for everyday IMAP access. Use Encrypted Mailboxes when zero-knowledge storage and S/MIME private-key handling are required.

## What It Provides

### Simple Mailboxes

- Standard IMAP mailboxes compatible with Thunderbird, Outlook, Apple Mail, K-9 Mail, and other IMAP clients
- Custom-domain mailbox routing through Motorical MX records
- Maildir storage
- IMAP credentials separate from Motorical account credentials
- Optional SMTP companion credentials for sending

### Encrypted Mailboxes

- S/MIME encryption for inbound mailbox storage
- AES-256 content encryption with RSA 2048 or 4096 bit certificates
- PKCS#12 certificate generation, upload, and download workflows
- Server-side storage of ciphertext only
- Decryption in the customer email client using the private key

### Management And Integration

- Mailbox creation and lifecycle APIs
- Domain and alias management
- IMAP credential management
- Usage reporting for both encrypted and simple mailbox storage
- Webhook and SMTP companion integration points
- Adapter-based boundaries for auth, user, MTA, and storage integrations

## How Mailbox Setup Works

1. Create a mailbox for a domain and alias.
2. Choose Simple or Encrypted mailbox type.
3. Configure MX DNS to route inbound mail through Motorical.
4. Use the generated IMAP username and password in an email client.
5. For Encrypted Mailboxes, download and back up the PKCS#12 certificate/private key.

Required MX record:

```text
Type: MX
Name: @
Value: mail.motorical.com
Priority: 10
```

IMAP client settings:

```text
Server: mail.motorical.com
Port: 993
Security: SSL/TLS
Username: provided IMAP username
Password: provided IMAP password
```

Connectivity can be tested with:

```bash
openssl s_client -connect mail.motorical.com:993 -crlf
```

## Security Model For Encrypted Mailboxes

Encrypted Mailboxes use S/MIME so the server does not need the private decryption key to store incoming mail.

1. Incoming email is encrypted with the mailbox public key before storage.
2. The server stores and serves ciphertext via IMAP.
3. The email client decrypts with the customer private key.
4. Lost private keys cannot be recovered by Motorical.

Security specifications:

| Property | Value |
| --- | --- |
| Encryption standard | S/MIME / CMS |
| Content cipher | AES-256 |
| Key sizes | RSA 2048 or 4096 bit |
| IMAP transport | SSL/TLS on port 993 |
| Required TLS | TLS 1.2+ |

Certificate best practices:

- Back up PKCS#12 files immediately.
- Store private keys offline or in a secure password manager.
- Set renewal reminders before certificate expiration.
- Keep old certificates for mail that was encrypted before rotation.

## Project Structure

```text
imap-services/
|-- adapters/          # Auth, user, MTA, and storage adapter boundaries
|-- config/            # Adapter and service configuration
|-- db/                # Database migrations
|-- deploy/            # Deployment assets
|-- docs/              # Repository-local technical notes
|-- scripts/           # Operational scripts
|-- services/
|   |-- api/           # Mailbox, credential, usage, and management API
|   |-- core/          # Shared mailbox and SMTP service logic
|   `-- intake/        # Inbound mail handling and encryption pipeline
`-- pkg/               # Shared packages
```

## Local Development

Install dependencies:

```bash
npm install
```

Run the basic adapter test:

```bash
npm test
```

Run adapter-specific checks:

```bash
npm run test-adapters
```

Typical environment and configuration inputs:

```bash
MOTORICAL_BACKEND_API_URL=https://api.motorical.com
MOTORICAL_DATABASE_URL=postgresql://user:password@localhost:5432/motorical_db
DATABASE_URL=postgresql://user:password@localhost:5432/imap_services
MAILDIR_ROOT=/var/mail/vaultboxes
```

Production configuration is loaded through `config/adapters.yaml` and environment variables. The production Motorical deployment uses Motorical auth/user data, Postfix routing, PostgreSQL storage, and Maildir-backed IMAP access.

## Public Documentation

Current customer-facing documentation lives in the Motorical docs site:

- [Email Mailboxes Overview](https://docs.motorical.com/email-mailboxes/overview)
- [Encrypted IMAP](https://docs.motorical.com/email-mailboxes/encrypted-imap)
- [Mailbox Setup Guide](https://docs.motorical.com/email-mailboxes/setup-guide)
- [Mailbox Best Practices](https://docs.motorical.com/email-mailboxes/best-practices)

This repository is maintained under the Motorical SMTP organization:

```text
https://github.com/motorical-smtp/imap-services
```
