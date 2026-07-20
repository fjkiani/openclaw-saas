/**
 * r2Archive.ts — Cloudflare R2 archival for training artifacts.
 *
 * Uses @aws-sdk/client-s3 against the R2 S3-compatible endpoint. Falls back to
 * a no-op when R2_* env vars are missing so local runs don't crash.
 *
 * Env vars:
 *   R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const HAS_R2 = Boolean(
  process.env.R2_ENDPOINT_URL &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET,
);

let clientSingleton: S3Client | null = null;

function getClient(): S3Client {
  if (clientSingleton) return clientSingleton;
  clientSingleton = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT_URL!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  return clientSingleton;
}

export interface ArchiveResult {
  archived: boolean;
  bucket?: string;
  key?: string;
  bytes?: number;
  reason?: string;
}

export async function archiveJsonl(
  key: string,
  records: unknown[],
): Promise<ArchiveResult> {
  if (!HAS_R2) {
    return { archived: false, reason: "R2 env vars missing" };
  }
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const bucket = process.env.R2_BUCKET!;
  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/jsonl",
      }),
    );
    return { archived: true, bucket, key, bytes: Buffer.byteLength(body) };
  } catch (err) {
    return { archived: false, reason: (err as Error).message };
  }
}

export async function archiveJson(key: string, obj: unknown): Promise<ArchiveResult> {
  if (!HAS_R2) return { archived: false, reason: "R2 env vars missing" };
  const body = JSON.stringify(obj);
  const bucket = process.env.R2_BUCKET!;
  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
      }),
    );
    return { archived: true, bucket, key, bytes: Buffer.byteLength(body) };
  } catch (err) {
    return { archived: false, reason: (err as Error).message };
  }
}
