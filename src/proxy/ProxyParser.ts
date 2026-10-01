import { createHash } from 'node:crypto';
import type { ProxyProtocol, ProxyRecord } from '../shared/types/proxy';

const PROTOCOLS = new Set<ProxyProtocol>(['http', 'https', 'socks4', 'socks5']);

export class ProxyParseError extends Error {}

function makeId(protocol: ProxyProtocol, host: string, port: number): string {
  return createHash('sha256').update(`${protocol}|${host.toLowerCase()}|${port}`).digest('hex').slice(0, 20);
}

function validateHost(host: string): string {
  const value = host.trim();
  if (!value || /\s/.test(value)) throw new ProxyParseError('Invalid host');
  return value;
}

function validatePort(value: string | number): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProxyParseError('Port must be 1-65535');
  return port;
}

function parseHostPort(value: string): { host: string; port: number } {
  const separator = value.lastIndexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new ProxyParseError('Expected hostname:port');
  }
  return {
    host: validateHost(value.slice(0, separator)),
    port: validatePort(value.slice(separator + 1))
  };
}

function parseCredentialPrefix(value: string): { username: string; password: string } {
  const separator = value.indexOf(':');
  if (separator <= 0) throw new ProxyParseError('Expected login:password before @');
  const username = value.slice(0, separator);
  const password = value.slice(separator + 1);
  if (!username || !password) throw new ProxyParseError('Login and password are required');
  return { username, password };
}

export function parseProxyLine(input: string, source = 'imported'): ProxyRecord {
  const line = input.trim();
  if (!line) throw new ProxyParseError('Empty line');

  let protocol: ProxyProtocol = 'http';
  let host = '';
  let port = 0;
  let username: string | undefined;
  let password: string | undefined;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
    let url: URL;
    try { url = new URL(line); } catch { throw new ProxyParseError('Malformed proxy URL'); }
    const rawProtocol = url.protocol.replace(':', '').toLowerCase() as ProxyProtocol;
    if (!PROTOCOLS.has(rawProtocol)) throw new ProxyParseError(`Unsupported protocol: ${rawProtocol}`);
    protocol = rawProtocol;
    host = validateHost(url.hostname);
    port = validatePort(url.port || (protocol === 'https' ? 443 : 80));
    username = url.username ? decodeURIComponent(url.username) : undefined;
    password = url.password ? decodeURIComponent(url.password) : undefined;
  } else if (line.includes('@')) {
    // Common gateway format used by providers such as DataImpulse:
    // login:password@hostname:port
    // Use the final @ so passwords containing @ are still accepted.
    const at = line.lastIndexOf('@');
    const credentials = parseCredentialPrefix(line.slice(0, at));
    const endpoint = parseHostPort(line.slice(at + 1));
    host = endpoint.host;
    port = endpoint.port;
    username = credentials.username;
    password = credentials.password;
  } else {
    const parts = line.split(':');
    if (parts.length !== 2 && parts.length !== 4) {
      throw new ProxyParseError('Expected host:port, host:port:user:password, or login:password@hostname:port');
    }
    host = validateHost(parts[0] ?? '');
    port = validatePort(parts[1] ?? '');
    if (parts.length === 4) {
      username = parts[2] || undefined;
      password = parts[3] || undefined;
    }
  }

  return {
    id: makeId(protocol, host, port),
    host,
    port,
    protocol,
    username,
    password,
    source,
    status: 'unverified'
  };
}

export function parseProxyText(text: string, source = 'imported'): {
  proxies: ProxyRecord[];
  errors: Array<{ line: number; value: string; reason: string }>;
  duplicates: number;
} {
  const proxies: ProxyRecord[] = [];
  const errors: Array<{ line: number; value: string; reason: string }> = [];
  const seen = new Set<string>();
  let duplicates = 0;

  text.split(/\r?\n/).forEach((raw, index) => {
    const value = raw.trim();
    if (!value || value.startsWith('#')) return;
    try {
      const proxy = parseProxyLine(value, source);
      const key = `${proxy.protocol}|${proxy.host.toLowerCase()}|${proxy.port}`;
      if (seen.has(key)) { duplicates += 1; return; }
      seen.add(key);
      proxies.push(proxy);
    } catch (error) {
      errors.push({ line: index + 1, value, reason: error instanceof Error ? error.message : 'Invalid proxy' });
    }
  });
  return { proxies, errors, duplicates };
}
