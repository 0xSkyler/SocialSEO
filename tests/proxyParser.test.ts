import { describe, expect, it } from 'vitest';
import { parseProxyLine, parseProxyText } from '../src/proxy/ProxyParser';

describe('ProxyParser', () => {
  it('parses HTTP proxy URLs', () => {
    const proxy = parseProxyLine('http://1.2.3.4:8080');
    expect(proxy).toMatchObject({ protocol: 'http', host: '1.2.3.4', port: 8080, status: 'unverified' });
  });

  it('parses authenticated URLs', () => {
    const proxy = parseProxyLine('http://user:pass@1.2.3.4:8080');
    expect(proxy.username).toBe('user');
    expect(proxy.password).toBe('pass');
  });

  it('parses SOCKS5', () => {
    expect(parseProxyLine('socks5://1.2.3.4:1080')).toMatchObject({ protocol: 'socks5', port: 1080 });
  });


  it('parses login:password@hostname:port gateway format', () => {
    const proxy = parseProxyLine('demo_user:demo_password@gw.dataimpulse.com:824');
    expect(proxy).toMatchObject({
      protocol: 'http',
      host: 'gw.dataimpulse.com',
      port: 824,
      username: 'demo_user',
      password: 'demo_password'
    });
  });

  it('allows @ and : characters inside the password in gateway format', () => {
    const proxy = parseProxyLine('user:pa:ss@word@gateway.example.com:9000');
    expect(proxy).toMatchObject({
      protocol: 'http',
      host: 'gateway.example.com',
      port: 9000,
      username: 'user',
      password: 'pa:ss@word'
    });
  });
  it('parses host:port:user:password', () => {
    expect(parseProxyLine('1.2.3.4:8080:user:pass')).toMatchObject({ protocol: 'http', username: 'user', password: 'pass' });
  });

  it('rejects garbage without stopping the rest of an import', () => {
    const result = parseProxyText('garbage\nhttp://1.2.3.4:8080');
    expect(result.proxies).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });

  it('deduplicates protocol + host + port', () => {
    const result = parseProxyText('http://1.2.3.4:8080\nhttp://1.2.3.4:8080');
    expect(result.proxies).toHaveLength(1);
    expect(result.duplicates).toBe(1);
  });
});
