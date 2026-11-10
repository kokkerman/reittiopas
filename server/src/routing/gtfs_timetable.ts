// claude did heavy lifting


import { createWriteStream, existsSync, statSync } from "node:fs";
import { rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import yauzl from "yauzl";
import { add_days, helsinki_date, helsinki_midnight, parse_clock } from "../utils/time_utils.js";
import type { Mode } from "../types/api_types.js";
import { Grid } from "../utils/geo_grid.js";
import { load_walk_graph, type WalkGraph } from "./walk_graph.js";

const GTFS_URL = "https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip";
const ZIP_PATH = path.join(os.tmpdir(), "reittiopas-hsl-gtfs.zip");
const ZIP_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_TRANSFER_WALK = 500;
const FALLBACK_DETOUR = 1.3;
const RELOAD_CHECK_INTERVAL_MS = 15 * 60 * 1000;

export interface Pattern {
  route: number;
  stops: Int32Array;
  n_trips: number;
  arr: Int32Array;
  dep: Int32Array;
  trip_ids: string[];
  headsigns: string[];
  shape: Float64Array | null;
  stop_shape_index: Int32Array | null;
}

export interface Timetable {
  date: string;
  base: number;
  stop_ids: string[];
  stop_names: string[];
  stop_codes: (string | null)[];
  stop_lat: Float64Array;
  stop_lon: Float64Array;
  grid: Grid;
  routes: { id: string; shortName: string; mode: Mode }[];
  patterns: Pattern[];
  stop_patterns: Int32Array[];
  transfers: { to: Int32Array; distance: Float32Array }[];
  walk: WalkGraph | null;
  stop_vertex: Int32Array;
  stop_snap: Float32Array;
  vertex_stops: Map<number, number[]>;
}

// terrrrrrible
function mode_from_route_type(type: number): Mode {
  if (type === 0 || (type >= 900 && type < 1000)) return "TRAM";
  if (type === 1 || (type >= 400 && type < 500)) return "SUBWAY";
  if (type === 2 || (type >= 100 && type < 200)) return "RAIL";
  if (type === 4 || (type >= 1000 && type < 1300)) return "FERRY";
  return "BUS";
}

function get_or_create<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

function seconds_since(started: number): string {
  return ((Date.now() - started) / 1000).toFixed(1);
}

function is_fresh(file: string, max_age_ms: number): boolean {
  return existsSync(file) && Date.now() - statSync(file).mtimeMs < max_age_ms;
}

async function ensure_zip(): Promise<string> {
  if (is_fresh(ZIP_PATH, ZIP_MAX_AGE_MS)) return ZIP_PATH;

  console.log("GTFS: downloading", GTFS_URL);
  const response = await fetch(GTFS_URL);
  if (!response.ok || !response.body) throw new Error(`GTFS download failed: ${response.status}`);

  const tmp = `${ZIP_PATH}.part`;
  await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(tmp));
  await rename(tmp, ZIP_PATH);
  return ZIP_PATH;
}

interface GtfsZip {
  zip: yauzl.ZipFile;
  entries: Map<string, yauzl.Entry>;
}

function open_zip(file: string): Promise<GtfsZip> {
  return new Promise(function (resolve, reject) {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, function (error, zip) {
      if (error || !zip) return reject(error);

      const entries = new Map<string, yauzl.Entry>();
      zip.on("entry", function (entry: yauzl.Entry) {
        entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.on("end", function () {
        resolve({ zip, entries });
      });
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

function parse_csv_line(line: string): string[] {
  if (!line.includes('"')) return line.split(",");

  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      out.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  out.push(field);
  return out;
}

type Columns = Record<string, number>;

function open_entry_stream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise<Readable>(function (resolve, reject) {
    zip.openReadStream(entry, function (error, stream) {
      if (error || !stream) {
        reject(error);
      } else {
        resolve(stream);
      }
    });
  });
}

function parse_header(line: string): Columns {
  const columns: Columns = {};
  const names = parse_csv_line(line.replace(/^﻿/, ""));
  names.forEach(function (name, i) {
    columns[name.trim()] = i;
  });
  return columns;
}

async function read_csv(
  gtfs: GtfsZip,
  name: string,
  on_row: (line: string, col: Columns) => void,
): Promise<void> {
  const entry = gtfs.entries.get(name);
  if (!entry) return;

  const stream = await open_entry_stream(gtfs.zip, entry);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let col: Columns | null = null;
  for await (const line of lines) {
    if (!col) {
      col = parse_header(line);
      continue;
    }
    if (line) on_row(line, col);
  }
}

function parse_optional_number(fields: string[], column: number | undefined): number {
  if (column === undefined || fields[column] === "") return NaN;
  return Number(fields[column]);
}

interface TripInfo {
  route: number;
  headsign: string;
  shape_id: string;
  days: number;
}

interface TripTimes {
  stops: number[];
  arr: number[];
  dep: number[];
  seq: number[];
  dist: number[];
}

interface Shape {
  lat: number[];
  lon: number[];
  dist: number[];
}

function empty_trip_times(): TripTimes {
  return { stops: [], arr: [], dep: [], seq: [], dist: [] };
}

function empty_shape(): Shape {
  return { lat: [], lon: [], dist: [] };
}

function empty_stop_list(): number[] {
  return [];
}

function shift_times(times: number[], offset: number): number[] {
  return times.map(function (time) {
    return time + offset;
  });
}

interface TripInstance {
  trip_id: string;
  headsign: string;
  arr: number[];
  dep: number[];
}

interface TripGroup {
  route: number;
  stops: number[];
  shape_id: string;
  dist: number[];
  instances: TripInstance[];
}

interface Stops {
  ids: string[];
  names: string[];
  codes: (string | null)[];
  lats: number[];
  lons: number[];
  index: Map<string, number>;
}

interface StopSnaps {
  stop_vertex: Int32Array;
  stop_snap: Float32Array;
  vertex_stops: Map<number, number[]>;
}

function snap_stops_to_shape(
  shape: Shape,
  stop_dist: number[],
  stop_lat: number[],
  stop_lon: number[],
): Int32Array {
  const out = new Int32Array(stop_dist.length);
  let search_start = 0;
  for (let i = 0; i < stop_dist.length; i++) {
    let index = search_start;
    if (Number.isFinite(stop_dist[i])) {
      const last_point = shape.dist.length - 1;
      while (index < last_point && shape.dist[index] < stop_dist[i]) index++;
    } else {
      let best = Infinity;
      for (let j = search_start; j < shape.lat.length; j++) {
        const squared_distance = (shape.lat[j] - stop_lat[i]) ** 2 + (shape.lon[j] - stop_lon[i]) ** 2;
        if (squared_distance < best) {
          best = squared_distance;
          index = j;
        }
      }
    }
    out[i] = index;
    search_start = index;
  }
  return out;
}

const DAYS = [-1, 0, 1];
const WEEKDAY_COLUMNS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

async function read_service_days(gtfs: GtfsZip, dates: string[]): Promise<Map<string, number>> {
  const compact_dates = dates.map(function (date) {
    return date.replaceAll("-", "");
  });
  const weekdays = dates.map(function (date) {
    return WEEKDAY_COLUMNS[new Date(`${date}T12:00:00Z`).getUTCDay()];
  });

  const services = new Map<string, number>();
  await read_csv(gtfs, "calendar.txt", function (line, col) {
    const fields = parse_csv_line(line);
    let mask = 0;
    compact_dates.forEach(function (date, i) {
      const in_range = fields[col.start_date] <= date && date <= fields[col.end_date];
      if (in_range && fields[col[weekdays[i]]] === "1") mask |= 1 << i;
    });
    services.set(fields[col.service_id], mask);
  });

  await read_csv(gtfs, "calendar_dates.txt", function (line, col) {
    const fields = parse_csv_line(line);
    const day = compact_dates.indexOf(fields[col.date]);
    if (day < 0) return;

    const service_id = fields[col.service_id];
    const mask = services.get(service_id) ?? 0;
    const is_added = fields[col.exception_type] === "1";
    services.set(service_id, is_added ? mask | (1 << day) : mask & ~(1 << day));
  });
  return services;
}

async function read_routes(gtfs: GtfsZip) {
  const routes: Timetable["routes"] = [];
  const route_index = new Map<string, number>();
  await read_csv(gtfs, "routes.txt", function (line, col) {
    const fields = parse_csv_line(line);
    route_index.set(fields[col.route_id], routes.length);
    routes.push({
      id: `HSL:${fields[col.route_id]}`,
      shortName: fields[col.route_short_name],
      mode: mode_from_route_type(Number(fields[col.route_type])),
    });
  });
  return { routes, route_index };
}

async function read_stops(gtfs: GtfsZip): Promise<Stops> {
  const stops: Stops = { ids: [], names: [], codes: [], lats: [], lons: [], index: new Map() };
  await read_csv(gtfs, "stops.txt", function (line, col) {
    const fields = parse_csv_line(line);
    const location_type = fields[col.location_type]?.trim();
    if (location_type && location_type !== "0") return;

    stops.index.set(fields[col.stop_id], stops.ids.length);
    stops.ids.push(`HSL:${fields[col.stop_id]}`);
    stops.names.push(fields[col.stop_name]);
    stops.codes.push(fields[col.stop_code]?.trim() || null);
    stops.lats.push(Number(fields[col.stop_lat]));
    stops.lons.push(Number(fields[col.stop_lon]));
  });
  return stops;
}

async function read_trips(
  gtfs: GtfsZip,
  services: Map<string, number>,
  route_index: Map<string, number>,
): Promise<Map<string, TripInfo>> {
  const trips = new Map<string, TripInfo>();
  await read_csv(gtfs, "trips.txt", function (line, col) {
    const fields = parse_csv_line(line);
    const days = services.get(fields[col.service_id]) ?? 0;
    const route = route_index.get(fields[col.route_id]);
    if (!days || route === undefined) return;

    trips.set(fields[col.trip_id], {
      route,
      headsign: fields[col.trip_headsign],
      shape_id: fields[col.shape_id] ?? "",
      days,
    });
  });
  return trips;
}

async function read_stop_times(
  gtfs: GtfsZip,
  trips: Map<string, TripInfo>,
  stop_index: Map<string, number>,
): Promise<Map<string, TripTimes>> {
  const times = new Map<string, TripTimes>();
  await read_csv(gtfs, "stop_times.txt", function (line, col) {
    // cheap pre-filter on the first column (trip_id) before parsing the whole line.
    const trip_id = line.slice(0, line.indexOf(","));
    if (!trips.has(trip_id)) return;

    const fields = parse_csv_line(line);
    const stop = stop_index.get(fields[col.stop_id]);
    if (stop === undefined) return;

    const trip_times = get_or_create(times, trip_id, empty_trip_times);
    trip_times.stops.push(stop);
    trip_times.arr.push(parse_clock(fields[col.arrival_time]));
    trip_times.dep.push(parse_clock(fields[col.departure_time]));
    trip_times.seq.push(Number(fields[col.stop_sequence]));
    trip_times.dist.push(parse_optional_number(fields, col.shape_dist_traveled));
  });
  return times;
}

function in_sequence_order(trip_times: TripTimes) {
  const { seq } = trip_times;
  let order = seq.map(function (_, i) {
    return i;
  });
  const is_out_of_order = seq.some(function (value, i) {
    return i > 0 && value < seq[i - 1];
  });
  if (is_out_of_order) {
    order = order.sort(function (left, right) {
      return seq[left] - seq[right];
    });
  }

  function reorder(values: number[]): number[] {
    return order.map(function (i) {
      return values[i];
    });
  }

  return {
    stops: reorder(trip_times.stops),
    arr: reorder(trip_times.arr),
    dep: reorder(trip_times.dep),
    dist: reorder(trip_times.dist),
  };
}

// groups trips with the same route and stop sequence; each running day becomes its own instance.
function group_trips(
  trips: Map<string, TripInfo>,
  times: Map<string, TripTimes>,
  day_offsets: number[],
): Map<string, TripGroup> {
  const groups = new Map<string, TripGroup>();
  for (const [trip_id, trip_times] of times) {
    const info = trips.get(trip_id)!;
    if (trip_times.stops.length < 2) continue;

    const { stops, arr, dep, dist } = in_sequence_order(trip_times);
    const key = `${info.route}|${stops.join(",")}`;
    const group = get_or_create(groups, key, function (): TripGroup {
      return { route: info.route, stops, shape_id: info.shape_id, dist, instances: [] };
    });

    DAYS.forEach(function (_, day) {
      const runs_on_day = info.days & (1 << day);
      if (!runs_on_day) return;

      const offset = day_offsets[day];
      const has_ended_before_base = arr[arr.length - 1] + offset < 0;
      if (has_ended_before_base) return;

      group.instances.push({
        trip_id,
        headsign: info.headsign,
        arr: shift_times(arr, offset),
        dep: shift_times(dep, offset),
      });
    });
  }
  return groups;
}

async function read_shapes(gtfs: GtfsZip, groups: Map<string, TripGroup>): Promise<Map<string, Shape>> {
  const needed_shapes = new Set<string>();
  for (const group of groups.values()) {
    if (group.instances.length && group.shape_id) needed_shapes.add(group.shape_id);
  }

  const shapes = new Map<string, Shape>();
  await read_csv(gtfs, "shapes.txt", function (line, col) {
    const fields = parse_csv_line(line);
    const id = fields[col.shape_id];
    if (!needed_shapes.has(id)) return;

    const shape = get_or_create(shapes, id, empty_shape);
    shape.lat.push(Number(fields[col.shape_pt_lat]));
    shape.lon.push(Number(fields[col.shape_pt_lon]));
    shape.dist.push(Number(fields[col.shape_dist_traveled]));
  });
  return shapes;
}

function build_pattern(group: TripGroup, shape: Shape | undefined, stops: Stops): Pattern {
  group.instances.sort(function (left, right) {
    return left.dep[0] - right.dep[0];
  });

  const stop_count = group.stops.length;
  const arr = new Int32Array(group.instances.length * stop_count);
  const dep = new Int32Array(group.instances.length * stop_count);
  group.instances.forEach(function (instance, trip) {
    arr.set(instance.arr, trip * stop_count);
    dep.set(instance.dep, trip * stop_count);
  });

  let shape_coords: Float64Array | null = null;
  let stop_shape_index: Int32Array | null = null;
  if (shape) {
    const lon_lat_pairs = shape.lat.flatMap(function (lat, i) {
      return [shape.lon[i], lat];
    });
    shape_coords = Float64Array.from(lon_lat_pairs);

    const group_lats = group.stops.map(function (stop) {
      return stops.lats[stop];
    });
    const group_lons = group.stops.map(function (stop) {
      return stops.lons[stop];
    });
    stop_shape_index = snap_stops_to_shape(shape, group.dist, group_lats, group_lons);
  }

  return {
    route: group.route,
    shape: shape_coords,
    stop_shape_index,
    stops: Int32Array.from(group.stops),
    n_trips: group.instances.length,
    arr,
    dep,
    trip_ids: group.instances.map(function (instance) {
      return `HSL:${instance.trip_id}`;
    }),
    headsigns: group.instances.map(function (instance) {
      return instance.headsign;
    }),
  };
}

// per stop, a flat list of (pattern index, position in pattern) pairs.
function build_stop_patterns(stop_count: number, patterns: Pattern[]): Int32Array[] {
  const per_stop: number[][] = Array.from({ length: stop_count }, empty_stop_list);
  patterns.forEach(function (pattern, pattern_index) {
    pattern.stops.forEach(function (stop, position) {
      per_stop[stop].push(pattern_index, position);
    });
  });
  return per_stop.map(function (list) {
    return Int32Array.from(list);
  });
}

function snap_stops_to_walk_graph(
  walk: WalkGraph | null,
  stop_lat: Float64Array,
  stop_lon: Float64Array,
): StopSnaps {
  const stop_count = stop_lat.length;
  const stop_vertex = new Int32Array(stop_count).fill(-1);
  const stop_snap = new Float32Array(stop_count);
  const vertex_stops = new Map<number, number[]>();
  if (!walk) return { stop_vertex, stop_snap, vertex_stops };

  for (let stop = 0; stop < stop_count; stop++) {
    const snap = walk.snap(stop_lat[stop], stop_lon[stop]);
    if (!snap) continue;

    stop_vertex[stop] = snap.vertex;
    stop_snap[stop] = snap.distance;
    get_or_create(vertex_stops, snap.vertex, empty_stop_list).push(stop);
  }
  return { stop_vertex, stop_snap, vertex_stops };
}

function street_transfers_from(stop: number, walk: WalkGraph, snaps: StopSnaps): Map<number, number> {
  const { stop_vertex, stop_snap, vertex_stops } = snaps;
  const best = new Map<number, number>();
  walk.scratch.run(stop_vertex[stop], MAX_TRANSFER_WALK - stop_snap[stop], function (vertex, walked) {
    for (const target of vertex_stops.get(vertex) ?? []) {
      if (target === stop) continue;

      const total = stop_snap[stop] + walked + stop_snap[target];
      const is_shorter = total < (best.get(target) ?? Infinity);
      if (total <= MAX_TRANSFER_WALK && is_shorter) best.set(target, total);
    }
  });
  return best;
}

function straight_line_transfers_from(
  stop: number,
  grid: Grid,
  stop_lat: Float64Array,
  stop_lon: Float64Array,
): Map<number, number> {
  const best = new Map<number, number>();
  const nearby = grid.near(stop_lat[stop], stop_lon[stop], MAX_TRANSFER_WALK / FALLBACK_DETOUR);
  for (const neighbour of nearby) {
    if (neighbour.index !== stop) best.set(neighbour.index, neighbour.distance * FALLBACK_DETOUR);
  }
  return best;
}

function build_transfers(
  walk: WalkGraph | null,
  grid: Grid,
  stop_lat: Float64Array,
  stop_lon: Float64Array,
  snaps: StopSnaps,
): Timetable["transfers"] {
  const transfers: Timetable["transfers"] = [];
  for (let stop = 0; stop < stop_lat.length; stop++) {
    const is_on_walk_graph = walk && snaps.stop_vertex[stop] >= 0;
    const best = is_on_walk_graph
      ? street_transfers_from(stop, walk, snaps)
      : straight_line_transfers_from(stop, grid, stop_lat, stop_lon);
    transfers.push({ to: Int32Array.from(best.keys()), distance: Float32Array.from(best.values()) });
  }
  return transfers;
}

export async function build_timetable(walk: WalkGraph | null): Promise<Timetable> {
  const started = Date.now();
  const zip_file = await ensure_zip();
  const gtfs = await open_zip(zip_file);

  const today = helsinki_date();
  const base = helsinki_midnight(today);
  const dates = DAYS.map(function (offset) {
    return add_days(today, offset);
  });
  const day_offsets = dates.map(function (date) {
    return helsinki_midnight(date) - base;
  });

  const services = await read_service_days(gtfs, dates);
  const { routes, route_index } = await read_routes(gtfs);
  const stops = await read_stops(gtfs);
  const trips = await read_trips(gtfs, services, route_index);
  const times = await read_stop_times(gtfs, trips, stops.index);
  const groups = group_trips(trips, times, day_offsets);
  const shapes = await read_shapes(gtfs, groups);
  gtfs.zip.close();

  const patterns: Pattern[] = [];
  for (const group of groups.values()) {
    if (!group.instances.length) continue;
    patterns.push(build_pattern(group, shapes.get(group.shape_id), stops));
  }
  const stop_patterns = build_stop_patterns(stops.ids.length, patterns);

  const stop_lat = Float64Array.from(stops.lats);
  const stop_lon = Float64Array.from(stops.lons);
  const grid = new Grid(stop_lat, stop_lon);
  const snaps = snap_stops_to_walk_graph(walk, stop_lat, stop_lon);

  const transfers_started = Date.now();
  const transfers = build_transfers(walk, grid, stop_lat, stop_lon, snaps);
  const snapped = snaps.stop_vertex.filter(function (vertex) {
    return vertex >= 0;
  }).length;
  const transfer_method = walk
    ? ` along streets (${snapped}/${stops.ids.length} stops on the walking network)`
    : " (straight-line fallback)";
  console.log(`GTFS: transfers in ${seconds_since(transfers_started)} s` + transfer_method);

  const trip_count = patterns.reduce(function (sum, pattern) {
    return sum + pattern.n_trips;
  }, 0);
  console.log(
    `GTFS: timetable for ${today} ready in ${seconds_since(started)} s — ` +
      `${stops.ids.length} stops, ${patterns.length} patterns, ${trip_count} trips`,
  );

  return {
    date: today,
    base,
    stop_ids: stops.ids,
    stop_names: stops.names,
    stop_codes: stops.codes,
    stop_lat,
    stop_lon,
    grid,
    routes,
    patterns,
    stop_patterns,
    transfers,
    walk,
    stop_vertex: snaps.stop_vertex,
    stop_snap: snaps.stop_snap,
    vertex_stops: snaps.vertex_stops,
  };
}

let current: Timetable | null = null;
let loading: Promise<void> | null = null;

export function get_timetable(): Timetable | null {
  return current;
}

function reload() {
  if (loading) return;
  loading = load_walk_graph()
    .catch(function (error) {
      console.error("Walk: failed to load walking network, using straight lines:", error);
      return null;
    })
    .then(function (walk) {
      return build_timetable(walk);
    })
    .then(function (timetable) {
      current = timetable;
    })
    .catch(function (error) {
      console.error("GTFS: failed to build timetable:", error);
    })
    .finally(function () {
      loading = null;
    });
}

export function start_timetable_updates() {
  reload();
  setInterval(function () {
    const is_stale = !current || current.date !== helsinki_date();
    if (is_stale) reload();
  }, RELOAD_CHECK_INTERVAL_MS).unref();
}
