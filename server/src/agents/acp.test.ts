// Protocol-level tests for the ACP transport, using tiny Node child processes as deterministic
// JSON-RPC peers so failures do not consume a provider session.
import assert from "node:assert/strict";
import test from "node:test";

import { spawnAcp, type AcpConnection } from "./acp.ts";

function fixture(source: string, maxLineBytes?: number): AcpConnection {
  return spawnAcp({
    binary: process.execPath,
    args: ["--input-type=module", "-e", source],
    cwd: process.cwd(),
    ...(maxLineBytes ? { maxLineBytes } : {}),
  });
}

const HARNESS = `
  import readline from "node:readline";
  const lines = readline.createInterface({ input: process.stdin });
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
`;

test("correlates calls and answers incoming requests", async (context) => {
  const connection = fixture(`${HARNESS}
    let triggerId = null;
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (message.method === "ping") {
        send({ jsonrpc: "2.0", id: message.id, result: { echo: message.params.value } });
      } else if (message.method === "trigger") {
        triggerId = message.id;
        send({ jsonrpc: "2.0", id: "from-agent", method: "client/question", params: { n: 4 } });
      } else if (message.id === "from-agent") {
        send({ jsonrpc: "2.0", id: triggerId, result: message.result });
      }
    }
  `);
  context.after(() => connection.close());
  connection.registerRequestHandler("client/question", (params) => {
    const value = params as { n: number };
    return { doubled: value.n * 2 };
  });

  assert.deepEqual(await connection.request("ping", { value: "ok" }), { echo: "ok" });
  assert.deepEqual(await connection.request("trigger"), { doubled: 8 });
});

test("returns method-not-found for unknown incoming requests", async (context) => {
  const connection = fixture(`${HARNESS}
    let probeId = null;
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (message.method === "probe") {
        probeId = message.id;
        send({ jsonrpc: "2.0", id: 99, method: "client/missing", params: {} });
      } else if (message.id === 99) {
        send({ jsonrpc: "2.0", id: probeId, result: message.error });
      }
    }
  `);
  context.after(() => connection.close());

  assert.deepEqual(await connection.request("probe"), {
    code: -32601,
    message: "Method not found: client/missing",
  });
});

test("rejects pending calls when the child exits", async (context) => {
  const connection = fixture(`${HARNESS}
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (message.method === "exit") process.exit(17);
    }
  `);
  context.after(() => connection.close());

  await assert.rejects(connection.request("exit"), /ACP stdout ended unexpectedly|code 17/);
});

test("closes a connection that exceeds its line bound", async (context) => {
  const connection = fixture(`${HARNESS}
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (message.method === "oversize") process.stdout.write("x".repeat(300));
    }
  `, 128);
  context.after(() => connection.close());

  await assert.rejects(connection.request("oversize"), /exceeds 128 bytes/);
});

test("omits the jsonrpc field when the envelope option is off", async (context) => {
  const connection = spawnAcp({
    binary: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      `${HARNESS}
        for await (const line of lines) {
          const message = JSON.parse(line);
          if (message.method === "ping") send({ id: message.id, result: message });
        }
      `,
    ],
    cwd: process.cwd(),
    jsonrpc: false,
    label: "Codex",
  });
  context.after(() => connection.close());

  const echoed = await connection.request<Record<string, unknown>>("ping", { value: "ok" });
  assert.equal("jsonrpc" in echoed, false);
  assert.equal(echoed.method, "ping");
  assert.deepEqual(echoed.params, { value: "ok" });
});
