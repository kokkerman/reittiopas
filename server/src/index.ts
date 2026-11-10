// the express server

import express, { type NextFunction, type Request, type Response } from "express";
import {
  DigitransitError,
  get_all_stops,
  get_departures,
  get_trip,
  get_vehicle_trip,
  search_places,
} from "./services/digitransit_client.js";
import { get_timetable, start_timetable_updates } from "./routing/gtfs_timetable.js";
import { DEFAULT_PLAN_OPTIONS, plan, PlanError, type PlanOptions, type RideSpec } from "./routing/raptor_planner.js";
import type { PlanResponse } from "./types/api_types.js";
import { get_vehicle, start_vehicle_feed } from "./services/vehicle_feed.js";
import { attach_live_socket } from "./services/live_vehicle_socket.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3001);
const MAX_RIDE_SPECS = 8;

class BadRequest extends Error {}

app.get("/api/stops", async function (_req, response) {
  response.json(await get_all_stops());
});

app.get("/api/stops/:id/departures", async function (request, response) {
  const result = await get_departures(request.params.id);
  if (!result) {
    response.status(404).json({ error: "Stop not found" });
    return;
  }
  response.json(result);
});

app.get("/api/vehicles/:id/trip", async function (request, response) {
  const vehicle = get_vehicle(request.params.id);
  const trip = vehicle ? await get_vehicle_trip(vehicle) : null;
  if (!trip) {
    response.status(404).json({ error: "Vehicle or trip not found" });
    return;
  }
  response.json(trip);
});

app.get("/api/trips/:id", async function (request, response) {
  const date = String(request.query.date ?? "");
  if (!/^\d{8}$/.test(date)) {
    throw new BadRequest("date=YYYYMMDD required");
  }

  const trip = await get_trip(request.params.id, date);
  if (!trip) {
    response.status(404).json({ error: "Trip not found" });
    return;
  }
  response.json(trip);
});

app.get("/api/places", async function (request, response) {
  const text = String(request.query.text ?? "").trim();
  if (text.length < 2) {
    response.json([]);
    return;
  }

  const focus = request.query.focus ? parse_coordinate(request.query.focus, "focus") : undefined;
  response.json(await search_places(text, focus));
});

function parse_coordinate(value: unknown, name: string) {
  const [lat, lon] = String(value ?? "").split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new BadRequest(`${name}=lat,lon required`);
  }
  return { lat, lon };
}

function parse_number(value: unknown, fallback: number, min: number, max: number, name: string) {
  if (value === undefined) return fallback;

  const number = Number(value);
  const is_in_range = Number.isFinite(number) && number >= min && number <= max;
  if (!is_in_range) {
    throw new BadRequest(`${name} must be between ${min} and ${max}`);
  }
  return number;
}

function parse_modes(value: unknown): Set<string> | null {
  if (!value) return null;
  return new Set(String(value).toUpperCase().split(","));
}

function is_ride_spec(value: unknown): boolean {
  const spec = value as { line?: unknown; from?: unknown; to?: unknown } | null | undefined;
  if (!spec) return false;
  return typeof spec.line === "string" && typeof spec.from === "string" && typeof spec.to === "string";
}

function parse_ride_specs(raw_data: unknown): RideSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw_data));
  } catch {
    throw new BadRequest("route must be JSON");
  }

  const is_valid =
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.length <= MAX_RIDE_SPECS &&
    parsed.every(is_ride_spec);
  if (!is_valid) {
    throw new BadRequest("route must be a list of { line, from, to }");
  }
  return parsed as RideSpec[];
}

app.get("/api/plan", function (request, response) {
  const timetable = get_timetable();
  if (!timetable) {
    response.status(503).json({ error: "Timetable is still loading, try again shortly" });
    return;
  }

  const query = request.query;
  const defaults = DEFAULT_PLAN_OPTIONS;
  const now_seconds = Math.floor(Date.now() / 1000);
  const options: PlanOptions = {
    from: parse_coordinate(query.from, "from"),
    to: parse_coordinate(query.to, "to"),
    time: parse_number(query.time, now_seconds, 0, Infinity, "time"),
    deadline: query.arriveBy ? parse_number(query.arriveBy, 0, 0, Infinity, "arriveBy") : null,
    route: query.route ? parse_ride_specs(query.route) : null, // only this route's later departures
    walk_speed: parse_number(query.walkSpeed, defaults.walkSpeed, 0.3, 3, "walkSpeed"),
    max_walk_distance: parse_number(query.maxWalkDistance, defaults.maxWalkDistance, 50, 5000, "maxWalkDistance"),
    max_transfers: Math.round(parse_number(query.maxTransfers, defaults.maxTransfers, 0, 8, "maxTransfers")),
    transfer_slack: parse_number(query.transferSlack, defaults.transferSlack, 0, 900, "transferSlack"),
    modes: parse_modes(query.modes),
    num_itineraries: Math.round(parse_number(query.num, defaults.numItineraries, 1, 10, "num")),
  };

  const body: PlanResponse = { itineraries: plan(timetable, options) };
  response.json(body);
});

// Express forwards rejected async handlers here.
app.use(function (error: unknown, _req: Request, response: Response, _next: NextFunction) {
  if (error instanceof BadRequest || error instanceof PlanError) {
    response.status(400).json({ error: error.message });
    return;
  }

  console.error(error);
  const status = error instanceof DigitransitError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Internal error";
  response.status(status).json({ error: message });
});

function describe_listen_error(error: Error): string {
  const port_in_use = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
  if (port_in_use) {
    return `Port ${PORT} is already in use: another API server is probably still running. ` +
      "Stop it, or set PORT in server/.env.";
  }
  return `Could not start the API server: ${error.message}`;
}

// Express passes listen errors to this callback.
const server = app.listen(PORT, function (error?: Error) {
  if (error) {
    console.error(describe_listen_error(error));
    process.exit(1);
  }

  console.log(`API server listening on http://localhost:${PORT}`);
  if (!process.env.DIGITRANSIT_KEY) {
    console.warn("WARNING: DIGITRANSIT_KEY is not set");
  }

  attach_live_socket(server);
  start_vehicle_feed();
  start_timetable_updates();
});
