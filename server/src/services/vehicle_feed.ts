// keeps track of every live vehicle from hsl's realtime feed

import mqtt from "mqtt";
import type { Mode, Vehicle } from "../types/api_types.js";

// env vars wold be betteer
const MQTT_URL = "mqtts://mqtt.hsl.fi:8883";
const TOPIC = "/hfp/v2/journey/ongoing/vp/#";
const STALE_MS = 60000;
const CLEANUP_INTERVAL_MS = 10000;


export interface VehicleState extends Vehicle {
  route_id: string;
  direction: number;
  operating_day: string;
  start_time: string;
  next_stop_id: string | null;
  seen_at: number;
}

const vehicles = new Map<string, VehicleState>();

const MODES: Record<string, Mode> = {
  bus: "BUS",
  ubus: "BUS",
  robot: "BUS",
  tram: "TRAM",
  train: "RAIL",
  metro: "SUBWAY",
  ferry: "FERRY",
};

interface HfpVp {
  desi: string;
  dir: string;
  oper: number;
  veh: number;
  tsi: number;
  hdg: number | null;
  lat: number | null;
  long: number | null;
  dl: number | null;
  oday: string;
  start: string;
  route: string;
}

function parse_vp(payload: Buffer): HfpVp | undefined {
  try {
    return (JSON.parse(payload.toString()) as { VP?: HfpVp }).VP;
  } catch {
    return undefined;
  }
}

function handle_message(topic: string, payload: Buffer) {
  const vp = parse_vp(payload);
  if (!vp || vp.lat == null || vp.long == null) return;

  const topic_parts = topic.split("/");
  const transport_mode = topic_parts[6];
  const headsign = topic_parts[11];
  const next_stop = topic_parts[13];
  const has_next_stop = Boolean(next_stop) && next_stop !== "EOL";

  const id = `${vp.oper}_${vp.veh}`;
  vehicles.set(id, {
    id,
    mode: MODES[transport_mode] ?? "BUS",
    line: vp.desi,
    headsign: headsign ?? "",
    lat: vp.lat,
    lon: vp.long,
    heading: vp.hdg ?? 0,
    delaySeconds: vp.dl == null ? 0 : -vp.dl,
    route_id: vp.route,
    direction: Number(vp.dir),
    operating_day: vp.oday,
    start_time: vp.start,
    next_stop_id: has_next_stop ? next_stop : null,
    seen_at: Date.now(),
  });
}

function remove_stale_vehicles() {
  const cutoff = Date.now() - STALE_MS;
  for (const [id, vehicle] of vehicles) {
    if (vehicle.seen_at < cutoff) {
      vehicles.delete(id);
    }
  }
}

export function start_vehicle_feed() {
  const client = mqtt.connect(MQTT_URL);
  client.on("connect", function () {
    console.log("HFP: connected, subscribing to vehicle positions");
    client.subscribe(TOPIC);
  });
  client.on("error", function (error) {
    console.error("HFP error:", error.message);
  });
  client.on("message", handle_message);

  setInterval(remove_stale_vehicles, CLEANUP_INTERVAL_MS).unref();
}

export function get_vehicle(id: string): VehicleState | undefined {
  return vehicles.get(id);
}

export function to_public(vehicle: VehicleState): Vehicle {
  return {
    id: vehicle.id,
    mode: vehicle.mode,
    line: vehicle.line,
    headsign: vehicle.headsign,
    lat: vehicle.lat,
    lon: vehicle.lon,
    heading: vehicle.heading,
    delaySeconds: vehicle.delaySeconds,
  };
}

export function all_vehicles(): IterableIterator<VehicleState> {
  return vehicles.values();
}
