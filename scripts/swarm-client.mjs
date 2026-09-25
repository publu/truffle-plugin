import { readFile } from "node:fs/promises";

export function workspace(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("Provide a complete swarm URL.");
  }
  const match = url.pathname.match(
    /^\/w\/([a-z][a-z0-9-]{2,39})(?:\/(?:wiki|skill\.md))?\/?$/,
  );
  if (
    !match ||
    url.username ||
    url.password ||
    url.search ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw Error("Use an HTTPS swarm link (HTTP is supported on localhost).");
  return {
    url: `${url.origin}/w/${match[1]}`,
    origin: url.origin,
    id: match[1],
    invite: new URLSearchParams(url.hash.slice(1)).get("invite"),
  };
}

export class SwarmError extends Error {
  constructor(message, status, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export async function request(url, body, headers = {}, signal) {
  let response;
  try {
    response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
  } catch {
    throw new SwarmError(
      "Cannot reach the swarm. Check the server address and connection; redirects are not followed. A write may have succeeded: read current state before retrying.",
      0,
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new SwarmError(
      "The server did not return Truffle JSON. Check the swarm URL.",
      response.status,
    );
  }
  if (!response.ok)
    throw new SwarmError(
      `${response.status}: ${data.error || "Request failed"}${data.currentRevision !== undefined ? ` (current revision ${data.currentRevision})` : ""}`,
      response.status,
      {
        ...(data.guidance?.version === 1 ? { guidance: data.guidance } : {}),
        ...(data.currentRevision !== undefined
          ? { currentRevision: data.currentRevision }
          : {}),
      },
    );
  return { data, response };
}

export async function loadClient(configPath) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw Error(
      "Cannot read the connection profile. Join a swarm first and pass its --config path.",
    );
  }
  const info = workspace(config.url || config.workspace);
  if (config.api && config.api !== `${info.origin}/api/w/${info.id}`)
    throw Error("Saved API URL does not match its workspace.");
  if (
    typeof config.token !== "string" ||
    !config.token ||
    config.token.length > 200
  )
    throw Error("The connection profile has no valid credential.");
  return {
    info,
    async call(path, body, signal) {
      const base = new URL(`${info.origin}/api/w/${info.id}/`),
        target = new URL(path, base);
      if (
        target.origin !== base.origin ||
        !target.pathname.startsWith(base.pathname) ||
        target.hash
      )
        throw Error("Invalid swarm operation.");
      return (
        await request(
          target,
          body,
          { Authorization: `Bearer ${config.token}` },
          signal,
        )
      ).data;
    },
  };
}
