import type {
  FeedQualityBadge,
  MarketCategory,
  OHLCVBar,
  QuoteTick,
  Resolution,
  SymbolInfo,
} from '@openview/protocol';

export interface SymbolSearchFilter {
  market?: MarketCategory | 'all';
  limit?: number;
}

export interface HistoryRequest {
  symbol: SymbolInfo;
  resolution: Resolution;
  from?: number;
  to?: number;
  countBack?: number;
}

export interface HistoryResponse {
  bars: OHLCVBar[];
  noData: boolean;
  feedQuality: FeedQualityBadge;
  providerLabel: string;
}

export interface IDatafeed {
  readonly id: string;
  readonly name: string;
  searchSymbols(query: string, filter?: SymbolSearchFilter): Promise<SymbolInfo[]>;
  resolveSymbol(symbolId: string): Promise<SymbolInfo | null>;
  getBars(req: HistoryRequest): Promise<HistoryResponse>;
  subscribeBars(
    symbol: SymbolInfo,
    resolution: Resolution,
    onBar: (bar: OHLCVBar, quality: FeedQualityBadge) => void,
  ): () => void;
  subscribeQuotes?(symbols: string[], onQuote: (quote: QuoteTick) => void): () => void;
}
