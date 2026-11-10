// the websocket that sends live vehicles to each client, only the ones inside their map view

import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Bbox, HeartbeatMessage, ServerMessage, VehiclesMessage, ViewportMessage } from "../types/api_types.js";
import { all_vehicles, to_public, type VehicleState } from "./vehicle_feed.js";

const TICK_MS = 1000;
const HEARTBEAT_MS = 10000;
const PING_MS = 30000;

interface Client {
  socket: WebSocket;
  bbox: Bbox | null;
  sent: Set<string>;
  last_tick: number;
  needs_full: boolean;
  last_sent_at: number;
  alive: boolean;
}

function is_finite_number(value: unknown): boolean {
  return Number.isFinite(value);
}

function is_valid_bbox(bbox: unknown): boolean {
  if (bbox === null) return true;
  return Array.isArray(bbox) && bbox.length === 4 && bbox.every(is_finite_number);
}

function is_viewport_message(message: unknown): message is ViewportMessage {
  if (typeof message !== "object" || message === null) return false;

  const viewport = message as ViewportMessage;
  if (viewport.type !== "viewport") return false;
  return is_valid_bbox(viewport.bbox);
}

function in_bbox(lon: number, lat: number, [min_lon, min_lat, max_lon, max_lat]: Bbox) {
  return lon >= min_lon && lon <= max_lon && lat >= min_lat && lat <= max_lat;
}

function client_needs_vehicle(client: Client, vehicle: VehicleState): boolean {
  const is_new_to_client = !client.sent.has(vehicle.id);
  const moved_since_last_tick = vehicle.seen_at > client.last_tick;
  return client.needs_full || is_new_to_client || moved_since_last_tick;
}

function send(client: Client, message: ServerMessage, now: number) {
  client.socket.send(JSON.stringify(message));
  client.last_sent_at = now;
}

function tick(client: Client, now: number) {
  if (client.socket.readyState !== WebSocket.OPEN) return;

  const message: VehiclesMessage = { type: "vehicles", full: client.needs_full, updated: [], removed: [] };
  const visible = new Set<string>();
  if (client.bbox) {
    for (const vehicle of all_vehicles()) {
      if (!in_bbox(vehicle.lon, vehicle.lat, client.bbox)) continue;
      visible.add(vehicle.id);
      if (client_needs_vehicle(client, vehicle)) {
        message.updated.push(to_public(vehicle));
      }
    }
  }
  if (!client.needs_full) {
    for (const id of client.sent) {
      if (!visible.has(id)) {
        message.removed.push(id);
      }
    }
  }

  client.sent = visible;
  client.last_tick = now;
  client.needs_full = false;

  const has_changes = message.full || message.updated.length > 0 || message.removed.length > 0;
  if (has_changes) {
    send(client, message, now);
    return;
  }
  if (now - client.last_sent_at >= HEARTBEAT_MS) {
    const heartbeat: HeartbeatMessage = { type: "heartbeat" };
    send(client, heartbeat, now);
  }
}

function create_client(socket: WebSocket): Client {
  return {
    socket,
    bbox: null,
    sent: new Set(),
    last_tick: 0,
    needs_full: true,
    last_sent_at: 0,
    alive: true,
  };
}

export function attach_live_socket(server: Server) {
  const socket_server = new WebSocketServer({ server, path: "/api/ws" });
  const clients = new Set<Client>();

  socket_server.on("connection", function (socket) {
    const client = create_client(socket);
    clients.add(client);
    socket.on("pong", function () {
      client.alive = true;
    });

    socket.on("message", function (data) {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!is_viewport_message(message)) return;

      client.bbox = message.bbox;
      client.needs_full = true;
      tick(client, Date.now());
    });
    socket.on("close", function () {
      clients.delete(client);
    });
    socket.on("error", function () {
      socket.terminate();
    });
  });

  setInterval(function () {
    const now = Date.now();
    for (const client of clients) {
      tick(client, now);
    }
  }, TICK_MS).unref();

  // phones that sleep or lose signal often vanish without closing; drop them so we stop sending.
  setInterval(function () {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, PING_MS).unref();
}
