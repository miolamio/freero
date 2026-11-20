import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { isBlockedAddress, safeFetch, type FetchOptions } from './fetch';

let server: Server;
let net: NonNullable<FetchOptions['testNetwork']>;
const drips: ReturnType<typeof setInterval>[] = [];

beforeAll(async () => {
  // Answers "HTTP/1.1 200 OK" one byte at a time and never finishes the headers.
  server = createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () => {
      const bytes = Buffer.from('HTTP/1.1 200 OK\r\nX-Slow: ' + 'a'.repeat(500));
      let i = 0;
      const t = setInterval(() => (i < bytes.length && !socket.destroyed ? socket.write(bytes.subarray(i++, i)) : clearInterval(t)), 40);
      drips.push(t);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  net = {
    port: (server.address() as AddressInfo).port,
    resolve: (_host, _opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
    isBlocked: (ip) => ip !== '127.0.0.1' && isBlockedAddress(ip),
  };
});

afterAll(async () => {
  drips.forEach(clearInterval);
  server.close();
});

it('a server dripping its response headers byte by byte is cut off at the overall deadline', async () => {
  const started = Date.now();
  await expect(safeFetch('http://slow.test/', { maxBytes: 1000, timeoutMs: 400, accept: '*/*', testNetwork: net })).rejects.toMatchObject({ failure: 'timeout' });
  expect(Date.now() - started).toBeLessThan(1500);
});

it('addresses that tunnel to an IPv4 target (6to4, Teredo) are blocked, however they are written', () => {
  for (const ip of ['2002:0a00:0001::1', '2002:a9fe:a9fe::', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:0000::1', '2001::1'])
    expect(isBlockedAddress(ip), ip).toBe(true);
  for (const ip of ['2001:4860:4860::8888', '2001:1::1', '2606:4700:4700::1111']) expect(isBlockedAddress(ip), ip).toBe(false);
});
