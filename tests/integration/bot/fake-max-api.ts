/**
 * A local stand-in for platform-api2.max.ru: a node:http server that records every
 * request and answers like the Bot API schema describes. Tests can queue long-polling
 * batches and make message delivery fail for chosen users.
 */
import http from "node:http";

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  /** Parsed JSON body; loosely typed so assertions can walk it freely. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface FakeMaxApi {
  url: string;
  token: string;
  requests: RecordedRequest[];
  /** Requests of one kind, e.g. calls("POST", "/messages"). */
  calls(method: string, path: string): RecordedRequest[];
  /** Batches returned by GET /updates, in order. */
  queueUpdates(batch: { updates: unknown[]; marker: number | null }): void;
  /** POST /messages to this user answers 403 chat.denied. */
  forbid(userId: string | number): void;
  subscriptions: { url: string; time: number; update_types?: string[] }[];
  close(): Promise<void>;
}

export const FAKE_BOT = {
  user_id: 555001,
  first_name: "Олимпус",
  name: "Олимпус",
  username: "olympus_test_bot",
  is_bot: true,
};

export async function startFakeMaxApi(token = "test-bot-token-123"): Promise<FakeMaxApi> {
  const requests: RecordedRequest[] = [];
  const updateBatches: { updates: unknown[]; marker: number | null }[] = [];
  const forbidden = new Set<string>();
  const subscriptions: FakeMaxApi["subscriptions"] = [];
  let mid = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const record: RecordedRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(record);

    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== token)
      return send(401, { code: "verify.token", message: "Invalid access_token" });

    const route = `${record.method} ${record.path}`;
    switch (route) {
      case "GET /me":
        return send(200, FAKE_BOT);
      case "PATCH /me/commands":
        return send(200, { commands: record.body?.commands ?? [] });
      case "GET /subscriptions":
        return send(200, { subscriptions });
      case "POST /subscriptions":
        subscriptions.splice(0, subscriptions.length, {
          url: record.body.url,
          time: Date.now(),
          update_types: record.body.update_types,
        });
        return send(200, { success: true });
      case "POST /messages": {
        const userId = record.query.user_id;
        if (forbidden.has(userId))
          return send(403, { code: "chat.denied", message: "chat.denied" });
        mid += 1;
        return send(200, {
          message: {
            recipient: { chat_type: "dialog", user_id: Number(userId) },
            timestamp: Date.now(),
            body: { mid: `mid.${mid}`, seq: mid, text: record.body?.text ?? null },
          },
        });
      }
      case "POST /answers":
        return send(200, { success: true });
      case "GET /updates": {
        const batch = updateBatches.shift();
        if (batch) return send(200, batch);
        // Nothing queued: behave like a short long-poll timeout.
        setTimeout(() => send(200, { updates: [], marker: null }), 30);
        return;
      }
      default:
        return send(404, { code: "not.found", message: route });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    requests,
    subscriptions,
    calls: (method, path) => requests.filter((r) => r.method === method && r.path === path),
    queueUpdates: (batch) => void updateBatches.push(batch),
    forbid: (userId) => void forbidden.add(String(userId)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
