import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface SealedSecretRecord {
  version: 1;
  provider: string;
  ivB64: string;
  tagB64: string;
  ciphertextB64: string;
}

export interface IMasterKeySealer {
  readonly mode: 'windows_dpapi' | 'ram_passphrase';
  seal(rawKey: Buffer): Buffer;
  unseal(sealedBlob: Buffer): Buffer;
}

/**
 * Windows DPAPI sealer using built-in .NET ProtectedData via PowerShell over stdin/stdout.
 * Zero native C++ / node-gyp dependencies; secrets are never placed in CLI arguments.
 */
export class WindowsDpapiSealer implements IMasterKeySealer {
  readonly mode = 'windows_dpapi' as const;

  seal(rawKey: Buffer): Buffer {
    if (process.platform !== 'win32') {
      throw new Error('WindowsDpapiSealer is only supported on win32');
    }
    const script = [
      'Add-Type -AssemblyName System.Security;',
      '$inB64 = [Console]::In.ReadToEnd().Trim();',
      '$bytes = [Convert]::FromBase64String($inB64);',
      '$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Console]::Out.Write([Convert]::ToBase64String($protected));',
    ].join(' ');

    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        input: rawKey.toString('base64'),
        encoding: 'utf8',
        windowsHide: true,
      },
    ).trim();

    return Buffer.from(out, 'base64');
  }

  unseal(sealedBlob: Buffer): Buffer {
    if (process.platform !== 'win32') {
      throw new Error('WindowsDpapiSealer is only supported on win32');
    }
    const script = [
      'Add-Type -AssemblyName System.Security;',
      '$inB64 = [Console]::In.ReadToEnd().Trim();',
      '$bytes = [Convert]::FromBase64String($inB64);',
      '$raw = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Console]::Out.Write([Convert]::ToBase64String($raw));',
    ].join(' ');

    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        input: sealedBlob.toString('base64'),
        encoding: 'utf8',
        windowsHide: true,
      },
    ).trim();

    return Buffer.from(out, 'base64');
  }
}

/**
 * RAM-only passphrase sealer using scrypt key derivation + AES-256-GCM.
 * Used on Linux/macOS/Docker or in automated tests.
 */
export class PassphraseRamSealer implements IMasterKeySealer {
  readonly mode = 'ram_passphrase' as const;
  private readonly kek: Buffer;

  constructor(passphrase: string, salt: Buffer) {
    if (passphrase.length < 8) {
      throw new Error('Vault passphrase must be at least 8 characters');
    }
    this.kek = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  }

  seal(rawKey: Buffer): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.kek, iv);
    cipher.setAAD(Buffer.from('openview-master-key-v1', 'utf8'));
    const encrypted = Buffer.concat([cipher.update(rawKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]);
  }

  unseal(sealedBlob: Buffer): Buffer {
    if (sealedBlob.length < 12 + 16 + 32) {
      throw new Error('Corrupt sealed master key blob');
    }
    const iv = sealedBlob.subarray(0, 12);
    const tag = sealedBlob.subarray(12, 28);
    const ciphertext = sealedBlob.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.kek, iv);
    decipher.setAAD(Buffer.from('openview-master-key-v1', 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}

export class CredentialVault {
  private masterKey: Buffer | null = null;
  private readonly sealerMode: 'windows_dpapi' | 'ram_passphrase';

  constructor(
    private readonly keyFilePath: string,
    private readonly sealer: IMasterKeySealer,
  ) {
    this.sealerMode = sealer.mode;
  }

  get mode(): 'windows_dpapi' | 'ram_passphrase' {
    return this.sealerMode;
  }

  isUnlocked(): boolean {
    return this.masterKey !== null;
  }

  unlockOrInitialize(): void {
    fs.mkdirSync(path.dirname(this.keyFilePath), { recursive: true });
    if (fs.existsSync(this.keyFilePath)) {
      const sealed = fs.readFileSync(this.keyFilePath);
      const raw = this.sealer.unseal(sealed);
      if (raw.length !== 32) {
        throw new Error(`Invalid unsealed master key length: ${raw.length}`);
      }
      this.masterKey = raw;
      return;
    }

    const freshKey = crypto.randomBytes(32);
    const sealed = this.sealer.seal(freshKey);
    fs.writeFileSync(this.keyFilePath, sealed, { mode: 0o600 });
    this.masterKey = freshKey;
  }

  encryptSecret(provider: string, plaintextJson: string): SealedSecretRecord {
    const key = this.requireMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`openview-vault-v1:${provider}`, 'utf8'));
    const encrypted = Buffer.concat([
      cipher.update(plaintextJson, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      version: 1,
      provider,
      ivB64: iv.toString('base64'),
      tagB64: tag.toString('base64'),
      ciphertextB64: encrypted.toString('base64'),
    };
  }

  decryptSecret(record: SealedSecretRecord): string {
    const key = this.requireMasterKey();
    const iv = Buffer.from(record.ivB64, 'base64');
    const tag = Buffer.from(record.tagB64, 'base64');
    const ciphertext = Buffer.from(record.ciphertextB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(`openview-vault-v1:${record.provider}`, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  lock(): void {
    if (this.masterKey) {
      this.masterKey.fill(0);
      this.masterKey = null;
    }
  }

  private requireMasterKey(): Buffer {
    if (!this.masterKey) {
      throw new Error('CredentialVault is locked');
    }
    return this.masterKey;
  }
}
