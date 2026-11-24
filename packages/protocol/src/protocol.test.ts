import { describe, expect, it } from 'vitest';
import {
  computeNseDynamicTickSize,
  parseWsClientMessage,
  precisionFromTickSize,
} from './index.ts';

describe('@openview/protocol', () => {
  it('computes 2025-2026 NSE dynamic price-band tick sizes accurately', () => {
    expect(computeNseDynamicTickSize(120)).toBe(0.01);
    expect(computeNseDynamicTickSize(250)).toBe(0.05);
    expect(computeNseDynamicTickSize(1000)).toBe(0.05);
    expect(computeNseDynamicTickSize(1450)).toBe(0.10);
    expect(computeNseDynamicTickSize(6200)).toBe(0.50);
    expect(computeNseDynamicTickSize(15000)).toBe(1.00);
    expect(computeNseDynamicTickSize(35000)).toBe(5.00);
    expect(computeNseDynamicTickSize(24500, 'index_futures')).toBe(0.10);
    expect(computeNseDynamicTickSize(51000, 'index_futures')).toBe(0.20);
  });

  it('derives display precision from tick sizes', () => {
    expect(precisionFromTickSize(0.00001)).toBe(5);
    expect(precisionFromTickSize(0.01)).toBe(2);
    expect(precisionFromTickSize(0.05)).toBe(2);
    expect(precisionFromTickSize(0.1)).toBe(1);
    expect(precisionFromTickSize(5)).toBe(0);
  });

  it('validates WebSocket client messages strictly', () => {
    expect(parseWsClientMessage('{"type":"ping","id":1,"ts":123}')).toEqual({
      type: 'ping',
      id: 1,
      ts: 123,
    });
    expect(parseWsClientMessage('{"type":"ping","id":"bad"}')).toBeNull();
    expect(parseWsClientMessage('not-json')).toBeNull();
    expect(parseWsClientMessage('{"type":"unknown"}')).toBeNull();
  });
});
