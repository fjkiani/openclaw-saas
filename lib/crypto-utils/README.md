# @workspace/crypto-utils

AES-256-GCM encryption utilities for storing sensitive connector credentials in the database.

## Overview

Connector API keys are encrypted before being written to `tenant_connectors.encryptedCredential` and decrypted on-the-fly when a connector needs to make an authenticated API call. The raw credential value is **never** returned in any API response.

## Implementation

- **Algorithm**: AES-256-GCM (authenticated encryption — provides both confidentiality and integrity)
- **Key derivation**: PBKDF2 with 100,000 iterations, SHA-256 digest, applied to `SESSION_SECRET`
- **IV**: Random 12-byte initialization vector generated per encryption (prepended to ciphertext)
- **Auth tag**: 16-byte GCM authentication tag (appended to ciphertext)
- **Storage format**: `base64(iv + ciphertext + authTag)` — single string stored in the DB column

## API

```typescript
import { encrypt, decrypt } from "@workspace/crypto-utils";

// Encrypt before storing
const encrypted = await encrypt(rawApiKey);
// → "base64string..."

// Decrypt before using
const rawApiKey = await decrypt(encrypted);
// → "user_api_key_value"
```

### `encrypt(plaintext: string): Promise<string>`

Encrypts the given plaintext string and returns a base64-encoded blob containing the random IV, ciphertext, and GCM auth tag.

### `decrypt(ciphertext: string): Promise<string>`

Decrypts a base64-encoded blob produced by `encrypt`. Throws if the auth tag verification fails (tamper detection).

## Security Notes

- `SESSION_SECRET` must be at least 32 characters of high-entropy random data
- Rotating `SESSION_SECRET` will invalidate all stored credentials — rotate carefully and re-encrypt existing values
- The GCM auth tag prevents undetected tampering with stored credentials
- Each encryption uses a fresh random IV so identical credentials produce different ciphertexts

## Environment

```
SESSION_SECRET=<32+ random bytes>
```

Generate a suitable value:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
