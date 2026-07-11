import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.azure.internal",
]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export class TargetUrlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TargetUrlError";
    this.code = code;
  }
}

function ipv4ToInt(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inIpv4Range(address, base, prefix) {
  const value = ipv4ToInt(address);
  const rangeBase = ipv4ToInt(base);
  if (value === null || rangeBase === null) return true;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (rangeBase & mask);
}

function isPublicIpv4(address) {
  const blocked = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, prefix]) => inIpv4Range(address, base, prefix));
}

function isPublicIpv6(address) {
  const normalized = address.toLowerCase().split("%")[0];
  const mapped = normalized.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIpv4(mapped[1]);

  if (normalized === "::" || normalized === "::1") return false;
  if (/^(?:fc|fd)/.test(normalized)) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (/^ff/.test(normalized)) return false;
  if (/^2001:db8(?::|$)/.test(normalized)) return false;
  return true;
}

export function isPublicIpAddress(address) {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function allowedPorts() {
  const configured = String(process.env.STS_ALLOWED_TARGET_PORTS || "80,443")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);
  return new Set(configured.length ? configured : [80, 443]);
}

export function parseTargetUrl(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new TargetUrlError("invalid_url", "Enter a valid product URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TargetUrlError("unsupported_protocol", "Only http and https URLs are supported.");
  }
  if (url.username || url.password) {
    throw new TargetUrlError("embedded_credentials", "URLs containing embedded credentials are not accepted.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || BLOCKED_HOSTS.has(hostname) || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new TargetUrlError("blocked_hostname", "Private and local network targets are not allowed.");
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!allowedPorts().has(port)) {
    throw new TargetUrlError("blocked_port", `Target port ${port} is not allowed.`);
  }

  if (isIP(hostname) && !isPublicIpAddress(hostname)) {
    throw new TargetUrlError("blocked_address", "Private, loopback, link-local, and reserved addresses are not allowed.");
  }

  url.hostname = hostname;
  url.hash = "";
  return url;
}

export async function assertPublicTargetUrl(input, { lookup = dnsLookup } = {}) {
  const url = parseTargetUrl(input);
  if (isIP(url.hostname)) {
    return { url, addresses: [url.hostname] };
  }

  let records;
  try {
    records = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new TargetUrlError("dns_failed", "The target hostname could not be resolved.");
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new TargetUrlError("dns_empty", "The target hostname did not resolve to an address.");
  }

  const addresses = records.map((record) => record.address).filter(Boolean);
  if (addresses.length !== records.length || addresses.some((address) => !isPublicIpAddress(address))) {
    throw new TargetUrlError("blocked_address", "The target resolves to a private, loopback, link-local, or reserved address.");
  }

  return { url, addresses };
}
