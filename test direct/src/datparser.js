'use strict';

// Minimal protobuf wire-format reader for V2Ray geosite.dat / geoip.dat
// No external deps. Parses only the fields we care about.

class Reader {
  constructor(buf) {
    this.buf = buf;          // Uint8Array
    this.pos = 0;
    this.len = buf.length;
  }
  eof() { return this.pos >= this.len; }

  varint() {
    let result = 0n;
    let shift = 0n;
    while (true) {
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }
  varintNum() { return Number(this.varint()); }

  tag() {
    const v = this.varintNum();
    return { field: v >>> 3, wire: v & 0x7 };
  }

  bytes() {
    const n = this.varintNum();
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  // Skip a field whose value we don't need
  skip(wire) {
    switch (wire) {
      case 0: this.varint(); break;            // varint
      case 1: this.pos += 8; break;            // 64-bit
      case 2: { const n = this.varintNum(); this.pos += n; break; } // len-delimited
      case 5: this.pos += 4; break;            // 32-bit
      default: throw new Error('Unknown wire type ' + wire);
    }
  }
}

const DOMAIN_TYPE = { 0: 'plain', 1: 'regex', 2: 'domain', 3: 'full' };
const decoder = new TextDecoder('utf-8');
function str(u8) { return decoder.decode(u8); }

// ---- GeoSite ----
// Domain { type=1 varint; value=2 string; attribute=3 message }
function parseDomain(u8) {
  const r = new Reader(u8);
  let type = 0, value = '';
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 0) type = r.varintNum();
    else if (field === 2 && wire === 2) value = str(r.bytes());
    else r.skip(wire);
  }
  return { type: DOMAIN_TYPE[type] || 'domain', value };
}

// GeoSite { country_code=1 string; domain=2 repeated message }
function parseGeoSite(u8) {
  const r = new Reader(u8);
  let code = '';
  const domains = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) code = str(r.bytes());
    else if (field === 2 && wire === 2) domains.push(parseDomain(r.bytes()));
    else r.skip(wire);
  }
  return { code, domains };
}

// GeoSiteList { entry=1 repeated message }
function parseGeoSiteList(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new Reader(u8);
  const categories = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) categories.push(parseGeoSite(r.bytes()));
    else r.skip(wire);
  }
  return categories;
}

// ---- GeoIP ----
function ipv4ToStr(u8) {
  return Array.from(u8).join('.');
}
function ipv6ToStr(u8) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) {
    parts.push(((u8[i] << 8) | u8[i + 1]).toString(16));
  }
  // collapse longest run of zeros
  return parts.join(':').replace(/(^|:)(0:)+0?($|:)/, '::').replace(/:{3,}/, '::');
}
function cidrToStr(ipBytes, prefix) {
  let ip;
  if (ipBytes.length === 4) ip = ipv4ToStr(ipBytes);
  else if (ipBytes.length === 16) ip = ipv6ToStr(ipBytes);
  else ip = ipv4ToStr(ipBytes);
  return ip + '/' + prefix;
}

// CIDR { ip=1 bytes; prefix=2 varint }
function parseCidr(u8) {
  const r = new Reader(u8);
  let ip = new Uint8Array(0), prefix = 0;
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) ip = r.bytes();
    else if (field === 2 && wire === 0) prefix = r.varintNum();
    else r.skip(wire);
  }
  return cidrToStr(ip, prefix);
}

// GeoIP { country_code=1 string; cidr=2 repeated message }
function parseGeoIP(u8) {
  const r = new Reader(u8);
  let code = '';
  const cidrs = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) code = str(r.bytes());
    else if (field === 2 && wire === 2) cidrs.push(parseCidr(r.bytes()));
    else r.skip(wire);
  }
  return { code, cidrs };
}

// GeoIPList { entry=1 repeated message }
function parseGeoIPList(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new Reader(u8);
  const countries = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) countries.push(parseGeoIP(r.bytes()));
    else r.skip(wire);
  }
  return countries;
}

// ========================================================================
// Protobuf writer — encode GeoSiteList / GeoIPList back to .dat format
// ========================================================================

class Writer {
  constructor() { this.buf = []; }
  raw(data) {
    if (typeof data === 'number') this.buf.push(data & 0xff);
    else for (let i = 0; i < data.length; i++) this.buf.push(data[i]);
  }
  varint(v) {
    v = BigInt(v);
    while (v >= 0x80n) {
      this.buf.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.buf.push(Number(v));
  }
  tag(field, wire) { this.varint((field << 3) | wire); }
  bytes(u8) {
    this.varint(u8.length);
    this.raw(u8);
  }
  string(s) { this.bytes(new TextEncoder().encode(s)); }
  result() { return new Uint8Array(this.buf); }
}

function ipv6ToBytes(s) {
  let head = [], tail = [];
  if (s.includes('::')) {
    const parts = s.split('::');
    head = parts[0] ? parts[0].split(':') : [];
    tail = parts[1] ? parts[1].split(':') : [];
  } else {
    head = s.split(':');
  }
  const groups = head.map((h) => parseInt(h || '0', 16));
  const missing = 8 - groups.length - tail.length;
  for (let i = 0; i < missing; i++) groups.push(0);
  for (const t of tail) groups.push(parseInt(t || '0', 16));
  const bytes = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  return new Uint8Array(bytes);
}

function ipBytes(str) {
  const s = str.includes('/') ? str.split('/')[0] : str;
  const prefix = str.includes('/') ? parseInt(str.split('/')[1], 10) : (s.includes(':') ? 128 : 32);
  if (s.includes(':')) return { ip: ipv6ToBytes(s), prefix };
  return { ip: new Uint8Array(s.split('.').map(Number)), prefix };
}

function encodeDomain(domain) {
  const w = new Writer();
  const typeMap = { plain: 0, regex: 1, domain: 2, full: 3, regexp: 1 };
  const type = typeMap[domain.type] || 0;
  w.tag(1, 0); w.varint(type);       // field 1, varint
  w.tag(2, 2); w.string(domain.value); // field 2, string
  return w.result();
}

function encodeGeoSite(cat) {
  const w = new Writer();
  w.tag(1, 2); w.string(cat.code);   // country_code
  for (const d of cat.domains) {
    w.tag(2, 2); w.bytes(encodeDomain(d));
  }
  return w.result();
}

function encodeGeoSiteList(categories) {
  const w = new Writer();
  for (const cat of categories) {
    w.tag(1, 2); w.bytes(encodeGeoSite(cat));
  }
  return w.result();
}

function encodeCidr(cidrStr) {
  const w = new Writer();
  const { ip, prefix } = ipBytes(cidrStr);
  w.tag(1, 2); w.bytes(ip);       // ip
  w.tag(2, 0); w.varint(prefix);   // prefix
  return w.result();
}

function encodeGeoIP(entry) {
  const w = new Writer();
  w.tag(1, 2); w.string(entry.code);   // country_code
  for (const c of entry.cidrs) {
    w.tag(2, 2); w.bytes(encodeCidr(c));
  }
  return w.result();
}

function encodeGeoIPList(countries) {
  const w = new Writer();
  for (const c of countries) {
    w.tag(1, 2); w.bytes(encodeGeoIP(c));
  }
  return w.result();
}

module.exports = { parseGeoSiteList, parseGeoIPList, encodeGeoSiteList, encodeGeoIPList };
