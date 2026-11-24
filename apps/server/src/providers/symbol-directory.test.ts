import { describe, expect, it } from 'vitest';
import { findSymbolById } from '@openview/datafeed-sdk';
import { toYahooSymbol } from './live-streams.ts';
import {
  normalizeYahooSearchQuote,
  parseBinanceExchangeInfo,
  parseHyperliquidMeta,
  parseNseEquityMasterCsv,
} from './symbol-directory.ts';

describe('Universal Multi-Market Symbol Directory', () => {
  it('parses Binance exchangeInfo, Hyperliquid meta, and Official NSE India EQUITY_L.csv accurately', () => {
    const binance = parseBinanceExchangeInfo({
      symbols: [
        {
          symbol: 'PEPEUSDT',
          status: 'TRADING',
          baseAsset: 'PEPE',
          quoteAsset: 'USDT',
          filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.00000001' }],
        },
        { symbol: 'DEADUSDT', status: 'BREAK', baseAsset: 'DEAD', quoteAsset: 'USDT' },
      ],
    });
    expect(binance).toHaveLength(1);
    expect(binance[0]!.id).toBe('BINANCE:PEPEUSDT');
    expect(binance[0]!.precision).toBe(8);

    const hl = parseHyperliquidMeta({
      universe: [
        { name: 'HYPE', szDecimals: 2, maxLeverage: 10 },
        { name: 'OLD', isDelisted: true },
      ],
    });
    expect(hl).toHaveLength(1);
    expect(hl[0]!.id).toBe('HYPERLIQUID:HYPE-PERP');
    expect(hl[0]!.segment).toBe('perps');

    const nseCsv = [
      'SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE',
      'SUZLON,"Suzlon Energy Limited",EQ,19-OCT-2005,2,1,INE040H01021,2',
      'HAL,Hindustan Aeronautics Limited,EQ,28-MAR-2018,5,1,INE066F01020,5',
    ].join('\n');
    const nse = parseNseEquityMasterCsv(nseCsv);
    expect(nse).toHaveLength(2);
    expect(nse[0]!.id).toBe('NSE:SUZLON');
    expect(nse[1]!.description).toBe('Hindustan Aeronautics Limited');
  });

  it('normalizes global Yahoo Finance search hits and resolves every prefix deterministically', () => {
    const pltr = normalizeYahooSearchQuote({
      symbol: 'PLTR',
      shortname: 'Palantir Technologies Inc.',
      exchange: 'NMS',
      quoteType: 'EQUITY',
    });
    expect(pltr?.id).toBe('US:PLTR');
    expect(pltr?.exchange).toBe('NASDAQ');

    const infyNs = normalizeYahooSearchQuote({
      symbol: 'INFY.NS',
      shortname: 'INFOSYS LIMITED',
      exchange: 'NSI',
      quoteType: 'EQUITY',
    });
    expect(infyNs?.id).toBe('NSE:INFY');

    const bseRel = normalizeYahooSearchQuote({
      symbol: 'RELIANCE.BO',
      shortname: 'RELIANCE INDUSTRIES',
      exchange: 'BSE',
      quoteType: 'EQUITY',
    });
    expect(bseRel?.id).toBe('BSE:RELIANCE');

    const aud = normalizeYahooSearchQuote({
      symbol: 'AUDUSD=X',
      shortname: 'AUD/USD',
      exchange: 'CCY',
      quoteType: 'CURRENCY',
    });
    expect(aud?.id).toBe('FX:AUDUSD');

    // Dynamic round-trip through findSymbolById -> toYahooSymbol
    expect(toYahooSymbol(findSymbolById('FX:USOIL')!)).toBe('CL=F');
    expect(toYahooSymbol(findSymbolById('US:SPX')!)).toBe('^GSPC');
    expect(toYahooSymbol(findSymbolById('BSE:SENSEX')!)).toBe('^BSESN');
    expect(toYahooSymbol(findSymbolById('NSE:SUZLON')!)).toBe('SUZLON.NS');
    expect(toYahooSymbol(findSymbolById('GLOBAL:^N225')!)).toBe('^N225');
    expect(findSymbolById('HYPERLIQUID:HYPE-PERP')?.segment).toBe('perps');
  });
});
