/**
 * AES-256-GCM encryption helpers for env var storage.
 * Pure module — no DB, no config imports.
 *
 * Requires ENCRYPTION_KEY env var: 64 hex chars (32 bytes).
 * Generate a key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { AppError } from "./middleware/error-handler.js";

const ALGORITHM = "aes-256-gcm" as const;

export interface EncryptedValue {
  encrypted: string; // base64 AES-GCM ciphertext
  iv: string;        // base64 12-byte nonce
  tag: string;       // base64 16-byte authentication tag
}

function getKey(): Buffer {
  const raw = process.env["ENCRYPTION_KEY"] ?? "";
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new AppError(
      500,
      "Server misconfiguration: ENCRYPTION_KEY must be 64 hex chars (32 bytes)",
      "CONFIGURATION_ERROR",
    );
  }
  return key;
}

export function encrypt(plaintext: string): EncryptedValue {
  const key    = getKey();
  const iv     = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return {
    encrypted: enc.toString("base64"),
    iv:        iv.toString("base64"),
    tag:       tag.toString("base64"),
  };
}

export function decrypt(enc: EncryptedValue): string {
  const key      = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(enc.iv, "base64"));
  decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(enc.encrypted, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
