export type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5';
export type ProxyStatus = 'unverified' | 'checking' | 'working' | 'dead';

export interface ProxyRecord {
  id: string;
  host: string;
  port: number;
  protocol: ProxyProtocol;
  username?: string;
  password?: string;
  source: string;
  status: ProxyStatus;
  latencyMs?: number;
  lastCheckedAt?: string;
  lastError?: string;
}

export interface ProxyImportResult {
  imported: number;
  valid: number;
  invalid: number;
  duplicates: number;
  assigned: number;
  errors: Array<{ line: number; value: string; reason: string }>;
}

export interface ProxyAssignment {
  workspaceId: number;
  proxyId?: string;
}

export interface ProxyValidationProgress {
  runId: string;
  active: boolean;
  cancelled: boolean;
  total: number;
  completed: number;
  checking: number;
  working: number;
  dead: number;
  assigned: number;
  startedAt?: string;
  finishedAt?: string;
  latestProxyId?: string;
  latestEndpoint?: string;
  latestStatus?: ProxyStatus;
  latestLatencyMs?: number;
  latestError?: string;
}
