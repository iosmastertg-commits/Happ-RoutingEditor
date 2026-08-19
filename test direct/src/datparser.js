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

module.exports = { parseGeoSiteList, parseGeoIPList };
