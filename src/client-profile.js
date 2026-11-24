'use strict';
// Client business profile: the single home for a client's business info, plus
// their logo. business_name, contact_name, email and phone live on clients;
// website, address, description, services and hours live in client_profiles
// (src/db.js). The logo file lives under DATA_DIR/logos/ — the database
// stores only its generated filename, never the bytes, and the file is
// served back through GET /app/profile/logo (src/web.js), never by a direct
// filesystem path. The client id always comes from the session, never the
// request, so a client can only ever touch their own profile and logo.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const store = require('./store');
const { newToken } = require('./security');

const LIMITS = {
  businessName: 200,
  contactName: 120,
  email: 254,
  phone: 40,
  website: 300,
  addressStreet: 200,
  addressCity: 120,
  addressState: 60,
  addressZip: 20,
  businessDescription: 1000,
  servicesOffered: 1000,
  businessHours: 200,
};

// A logo is an image, at most 2 MB. The type is decided from the file's magic
// bytes, never from the name or Content-Type the browser sent.
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_DIGITS = (v) => String(v || '').replace(/\D/g, '');

/**
 * Validates the profile fields from a form or JSON body. Returns
 * { ok: true, fields } with cleaned values, or { ok: false, error }.
 * business_name is required; email must look like an email when given;
 * phone must be 7 to 15 digits when given; a website without a scheme gets
 * https:// added and must then parse as an http(s) URL.
 */
function validateProfile(input) {
  const fields = {
    businessName: clean(input.business_name, LIMITS.businessName),
    contactName: clean(input.contact_name, LIMITS.contactName),
    email: clean(input.email, LIMITS.email),
    phone: clean(input.phone, LIMITS.phone),
    website: clean(input.website, LIMITS.website),
    addressStreet: clean(input.address_street, LIMITS.addressStreet),
    addressCity: clean(input.address_city, LIMITS.addressCity),
    addressState: clean(input.address_state, LIMITS.addressState),
    addressZip: clean(input.address_zip, LIMITS.addressZip),
    businessDescription: clean(input.business_description, LIMITS.businessDescription),
    servicesOffered: clean(input.services_offered, LIMITS.servicesOffered),
    businessHours: clean(input.business_hours, LIMITS.businessHours),
  };
  if (!fields.businessName) return { ok: false, error: 'Please enter your business name.' };
  if (fields.email && !EMAIL_RE.test(fields.email)) return { ok: false, error: 'That email address does not look right.' };
  const digits = PHONE_DIGITS(fields.phone);
  if (fields.phone && (digits.length < 7 || digits.length > 15)) return { ok: false, error: 'That phone number does not look right.' };
  if (fields.website) {
    let site = fields.website;
    if (!/^https?:\/\//i.test(site)) site = `https://${site}`;
    let parsed = null;
    try { parsed = new URL(site); } catch { parsed = null; }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname.includes('.')) {
      return { ok: false, error: 'That website address does not look right.' };
    }
    fields.website = site;
  }
  return { ok: true, fields };
}

/** The merged profile for a client: clients row + client_profiles row, or null. */
function getProfile(clientId) {
  return store.getProfile(clientId);
}

/**
 * Saves the profile for a client. Validates first; on success updates the
 * clients row (name, contact, email, phone) and upserts the client_profiles
 * row in one transaction. Returns { ok: true, profile } or { ok: false, error }.
 */
function saveProfile(clientId, input) {
  const validated = validateProfile(input);
  if (!validated.ok) return validated;
  if (!store.getProfile(clientId)) return { ok: false, error: 'Client not found.' };
  return { ok: true, profile: store.saveProfileLocal(clientId, validated.fields) };
}

// ---- Logos -------------------------------------------------------------------
// Logos live under DATA_DIR/logos/. The filename is generated here from the
// client id, a random token and the validated extension — the name the
// browser sent is never used, so no path can be smuggled in.

function logoDir() {
  return path.join(config.dataDir, 'logos');
}

function ensureLogoDir() {
  fs.mkdirSync(logoDir(), { recursive: true });
}

/** The stored filename for a client, or null. */
function logoFilename(clientId) {
  const p = store.getProfile(clientId);
  return p ? p.logo_filename : null;
}

/** Absolute path of a stored logo file, or null when the name is not one of ours. */
function logoPath(filename) {
  if (!filename || !/^[A-Za-z0-9_-]+\.[a-z]{3,4}$/.test(filename)) return null;
  const full = path.join(logoDir(), filename);
  if (!full.startsWith(logoDir() + path.sep)) return null;
  return full;
}

const LOGO_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/**
 * Detects an image type from magic bytes. Returns 'png', 'jpg', 'webp' or
 * 'gif', or null when the bytes are not a supported image. This is what the
 * upload is checked against, not the file extension or Content-Type.
 */
function detectImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
    && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

/**
 * Validates one uploaded file: size, then magic bytes. Returns
 * { ok: true, ext } or { ok: false, error }.
 */
function validateLogoFile(buf) {
  if (!buf || buf.length === 0) return { ok: false, error: 'Choose an image file to upload.' };
  if (buf.length > MAX_LOGO_BYTES) return { ok: false, error: 'That image is too large. Please use one under 2 MB.' };
  const ext = detectImageType(buf);
  if (!ext) return { ok: false, error: 'That file is not a supported image. Please use a PNG, JPG, WebP or GIF.' };
  return { ok: true, ext };
}

/**
 * Stores a validated logo for a client: writes the file under DATA_DIR/logos/
 * with a generated name, records it, and removes the previous logo file.
 * Returns { ok: true, profile } or { ok: false, error }.
 */
function saveLogo(clientId, buf) {
  const profile = store.getProfile(clientId);
  if (!profile) return { ok: false, error: 'Client not found.' };
  const check = validateLogoFile(buf);
  if (!check.ok) return check;
  ensureLogoDir();
  const filename = `${clientId}-${newToken(12)}.${check.ext}`;
  const full = path.join(logoDir(), filename);
  const oldFilename = profile.logo_filename;
  try {
    fs.writeFileSync(full, buf, { flag: 'wx' });
  } catch (err) {
    return { ok: false, error: 'We could not save that image. Please try again.' };
  }
  store.setLogo(clientId, filename);
  if (oldFilename && oldFilename !== filename) {
    const oldPath = logoPath(oldFilename);
    if (oldPath) fs.rmSync(oldPath, { force: true });
  }
  return { ok: true, profile: store.getProfile(clientId) };
}

/**
 * Removes a client's logo: deletes the file and clears the record.
 * Returns { ok: true, profile } (or { ok: false, error: 'no-logo' } when
 * there is nothing to remove).
 */
function removeLogo(clientId) {
  const profile = store.getProfile(clientId);
  if (!profile) return { ok: false, error: 'Client not found.' };
  if (!profile.logo_filename) return { ok: false, error: 'no-logo' };
  const oldPath = logoPath(profile.logo_filename);
  store.clearLogo(clientId);
  if (oldPath) fs.rmSync(oldPath, { force: true });
  return { ok: true, profile: store.getProfile(clientId) };
}

// ---- Minimal multipart/form-data parsing (no dependency) --------------------
// Only used for the logo upload, which is the one form that carries a file.
// Returns { fields, files } where files maps a field name to
// { filename, contentType, data } (data is a Buffer). Throws on a bad body.

function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(contentType || ''));
  const boundary = (m && (m[1] || m[2]) || '').trim();
  if (!boundary) throw new Error('Missing multipart boundary');
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = {};
  let pos = 0;
  for (;;) {
    const start = buffer.indexOf(boundaryBuf, pos);
    if (start === -1) break;
    let after = start + boundaryBuf.length;
    if (buffer[after] === 0x2d && buffer[after + 1] === 0x2d) break; // closing --boundary--
    if (buffer[after] === 0x0d && buffer[after + 1] === 0x0a) after += 2;
    else if (buffer[after] === 0x0a) after += 1;
    const next = buffer.indexOf(boundaryBuf, after);
    if (next === -1) break;
    let part = buffer.subarray(after, next);
    // Strip the trailing CRLF before the next boundary.
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) part = part.subarray(0, part.length - 2);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) { pos = next; continue; }
    const headers = part.subarray(0, headerEnd).toString('latin1');
    const data = part.subarray(headerEnd + 4);
    const disp = /Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
    if (!disp) { pos = next; continue; }
    const name = disp[1];
    const filename = disp[2];
    if (filename !== undefined) {
      const type = /Content-Type:\s*([^\r\n;]+)/i.exec(headers);
      files[name] = { filename, contentType: (type && type[1].trim()) || 'application/octet-stream', data: Buffer.from(data) };
    } else {
      fields[name] = data.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}

module.exports = {
  LIMITS, MAX_LOGO_BYTES, LOGO_MIME,
  validateProfile, getProfile, saveProfile,
  logoDir, logoFilename, logoPath, detectImageType, validateLogoFile, saveLogo, removeLogo,
  parseMultipart,
};
