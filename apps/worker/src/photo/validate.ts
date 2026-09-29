/**
 * Upload validation (sections 4 and 6).
 *
 * Section 4: "Max upload 5 MB, JPEG, PNG or WebP only." Section 6 makes it
 * the Workflow's first step as well, so a file that was swapped or truncated
 * between the upload and the run is caught before a vision call is spent
 * on it.
 *
 * The type is decided by the leading bytes, not by `Content-Type`. That
 * header is whatever the client typed; the bytes are what the vision model
 * will actually be handed. A `.jpg` that is really a PDF fails here for
 * about a microsecond instead of failing inside a 50-neuron inference call.
 *
 * Pure: bytes in, verdict out.
 */

/** Section 4. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export const ALLOWED_TYPES: ImageType[] = ['image/jpeg', 'image/png', 'image/webp'];

export const EXTENSIONS: Record<ImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export type ValidationResult =
  | { ok: true; type: ImageType; extension: string; bytes: number }
  | { ok: false; reason: string };

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean =>
  signature.every((b, i) => bytes[offset + i] === b);

/**
 * The image type, read from the leading bytes.
 *
 * WebP needs two checks: `RIFF` at 0 and `WEBP` at 8. The first four bytes
 * alone are shared with WAV and AVI, so matching on `RIFF` would accept an
 * audio file.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }
  return null;
}

export function validateUpload(bytes: Uint8Array): ValidationResult {
  if (bytes.byteLength === 0) return { ok: false, reason: 'The file is empty.' };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    const mb = (bytes.byteLength / (1024 * 1024)).toFixed(1);
    return { ok: false, reason: `That photo is ${mb} MB. The limit is 5 MB.` };
  }

  const type = sniffImageType(bytes);
  if (!type) {
    return { ok: false, reason: 'That is not a JPEG, PNG or WebP image.' };
  }

  return { ok: true, type, extension: EXTENSIONS[type], bytes: bytes.byteLength };
}

/** Section 4: `uploads/{userId}/{uuid}.{ext}`. */
export function uploadKey(userId: string, extension: string, id = crypto.randomUUID()): string {
  return `uploads/${userId}/${id}.${extension}`;
}

/**
 * The user ID an upload key belongs to.
 *
 * Used to check that a Workflow is only ever handed a key inside its own
 * user's prefix. The Workflow's parameters come from the route, which has
 * already checked the session — but the key is the one field that names
 * another user's data if it is ever wrong, so it is re-checked rather than
 * trusted.
 */
export function userIdFromKey(key: string): string | null {
  const parts = key.split('/');
  if (parts.length !== 3 || parts[0] !== 'uploads') return null;
  return parts[1] || null;
}
