/**
 * CDP 客户端 - 与 Chrome DevTools Protocol 通信
 */

import { request as httpRequest } from "node:http";
import type { Request, Response } from "@bb-browser/shared";
import { applyJq } from "./jq.js";
import { sendCommand as sendCdpCommand } from "./cdp-client.js";
import { monitorCommand } from "./monitor-manager.js";

const MONITOR_ACTIONS = new Set(["network", "console", "errors", "trace"]);

const VIA_EXTENSION = process.env.BB_VIA_EXTENSION === "1";
const DAEMON_HOST = process.env.BB_DAEMON_HOST || "::1";
const DAEMON_PORT = Number(process.env.BB_DAEMON_PORT || 19824);

function sendDaemonCommand(req: Request): Promise<Response> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(req);
    const r = httpRequest(
      {
        host: DAEMON_HOST,
        port: DAEMON_PORT,
        path: "/command",
        method: "POST",
        family: DAEMON_HOST.includes(":") ? 6 : 4,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as Response);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    r.on("error", reject);
    r.setTimeout(60000, () => {
      r.destroy(new Error("Daemon request timeout"));
    });
    r.write(data);
    r.end();
  });
}

let jqExpression: string | undefined;

export function setJqExpression(expression?: string): void {
  jqExpression = expression;
}

function printJqResults(response: Response): never {
  const target = response.data ?? response;
  const results = applyJq(target, jqExpression || ".");
  for (const result of results) {
    console.log(typeof result === "string" ? result : JSON.stringify(result));
  }
  process.exit(0);
}

export function handleJqResponse(response: Response): void {
  if (jqExpression) {
    printJqResults(response);
  }
}

export async function sendCommand(request: Request): Promise<Response> {
  if (VIA_EXTENSION) {
    return sendDaemonCommand(request);
  }
  if (MONITOR_ACTIONS.has(request.action)) {
    try {
      return await monitorCommand(request);
    } catch {
      // Fallback to direct CDP if monitor is unavailable
      return sendCdpCommand(request);
    }
  }
  return sendCdpCommand(request);
}
