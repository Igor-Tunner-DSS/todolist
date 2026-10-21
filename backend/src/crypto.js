import crypto from 'node:crypto';

// AES-256-GCM. Formato: v1:<iv>:<tag>:<cipher> (base64). A chave vem de TOKEN_ENCRYPTION_KEY
// (32 bytes em base64 ou 64 caracteres hexadecimais).
function loadKey(raw) {
    if (!raw) throw new Error('TOKEN_ENCRYPTION_KEY não configurada');
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY deve ter 32 bytes (base64 ou hex)');
    return key;
}

export function encrypt(plain, rawKey) {
    const key = loadKey(rawKey);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(payload, rawKey) {
    const key = loadKey(rawKey);
    const [v, iv, tag, data] = String(payload).split(':');
    if (v !== 'v1' || !iv || !tag || !data) throw new Error('Formato de segredo inválido');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
