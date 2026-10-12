import { createInterface } from 'node:readline';
import type { Toolkit } from '../debugger/toolkit';

const SERVER_INFO = { name: 'gs-code', version: '0.2.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

interface Request {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/**
 * A Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0), so any MCP client
 * (Claude Code, Cursor, Copilot, …) can use GS Code's tools: `claude mcp add gscode -- gscode mcp`.
 * Logs go to stderr; stdout carries protocol messages only.
 */
export function serveMcp(toolkit: Toolkit, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const send = (message: Record<string, unknown>) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!isRequest(parsed)) {
      send({ id: requestId(parsed) ?? null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const request = parsed;
    void handle(toolkit, request).then(
      (result) => {
        if (request.id !== undefined && request.id !== null && result !== undefined) send({ id: request.id, result });
      },
      (error: unknown) => {
        if (request.id !== undefined && request.id !== null) send({ id: request.id, error: { code: errorCode(error), message: error instanceof Error ? error.message : String(error) } });
      },
    );
  });
  return new Promise((resolve) => lines.once('close', () => resolve()));
}

function isRequest(value: unknown): value is Request {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { method, id, params } = value as Record<string, unknown>;
  const validId = id === undefined || id === null || typeof id === 'string' || typeof id === 'number';
  const validParams = params === undefined || (typeof params === 'object' && params !== null);
  return typeof method === 'string' && validId && validParams;
}

/** The id of a malformed request, when it has a usable one, so the error can be matched to it. */
function requestId(value: unknown): string | number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id } = value as Record<string, unknown>;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

/** A JSON-RPC error code carried by the thrown error (e.g. -32601), else Internal error. */
function errorCode(error: unknown): number {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'number' && Number.isInteger(code) ? code : -32603;
}

async function handle(toolkit: Toolkit, request: Request): Promise<unknown> {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'GS Code mirrors a Google Tag Manager workspace as files and debugs it in a real browser. Typical loop: debug_start → debug_events → debug_explain (tells you which mirror file and condition decided a tag) → edit the file → gtm_status → gtm_push → debug_reload. Agents cannot publish.',
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: toolkit.definitions().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const name = String(request.params?.name ?? '');
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return { content: [{ type: 'text', text: await toolkit.run(name, args) }] };
      } catch (error: unknown) {
        // Tool failures are results the model should see, not protocol errors.
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    }
    default:
      if (request.id === undefined) return undefined;
      throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
  }
}
