// also claude was a huge help

import { createWriteStream, existsSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { distance } from "../utils/geo_grid.js";
import { read_pbf } from "./osm_pbf_reader.js";

const OSM_URL = "https://karttapalvelu.storage.hsldev.com/hsl.osm/hsl.osm.pbf";
const PBF_PATH = path.join(os.tmpdir(), "reittiopas-hsl.osm.pbf");
const CACHE_PATH = path.join(os.tmpdir(), "reittiopas-walkgraph.bin");
const CACHE_VERSION = 1;
const CACHE_HEADER_BYTES = 1024;
const PBF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SNAP_RADIUS = 250;
const MIN_COMPONENT = 1000;

export const EdgeClass = { PATH: 0, STEPS: 1, STREET: 2, MAJOR_ROAD: 3 } as const;

const HIGHWAY_CLASS: Record<string, number> = {
  footway: EdgeClass.PATH,
  path: EdgeClass.PATH,
  pedestrian: EdgeClass.PATH,
  cycleway: EdgeClass.PATH,
  track: EdgeClass.PATH,
  corridor: EdgeClass.PATH,
  platform: EdgeClass.PATH,
  bridleway: EdgeClass.PATH,
  steps: EdgeClass.STEPS,
  living_street: EdgeClass.STREET,
  residential: EdgeClass.STREET,
  service: EdgeClass.STREET,
  unclassified: EdgeClass.STREET,
  road: EdgeClass.STREET,
  tertiary: EdgeClass.MAJOR_ROAD,
  tertiary_link: EdgeClass.MAJOR_ROAD,
  secondary: EdgeClass.MAJOR_ROAD,
  secondary_link: EdgeClass.MAJOR_ROAD,
  primary: EdgeClass.MAJOR_ROAD,
  primary_link: EdgeClass.MAJOR_ROAD,
  trunk: EdgeClass.MAJOR_ROAD, // only with explicit foot access, see below
  trunk_link: EdgeClass.MAJOR_ROAD,
};

const FOOT_YES = new Set(["yes", "designated", "permissive"]);

function walk_class(tag: (key: string) => string | undefined): number {
  const foot = tag("foot");
  if (foot === "no" || foot === "use_sidepath") return -1;

  const foot_explicitly_allowed = FOOT_YES.has(foot ?? "");
  const access = tag("access");
  const access_denied = access === "no" || access === "private";
  if (access_denied && !foot_explicitly_allowed) return -1;

  const highway = tag("highway");
  if (highway !== undefined) {
    const edge_class = HIGHWAY_CLASS[highway];
    if (edge_class === undefined) return -1;

    const is_trunk = highway === "trunk" || highway === "trunk_link";
    if (is_trunk && !foot_explicitly_allowed) return -1;
    return edge_class;
  }

  const is_platform = tag("railway") === "platform" || tag("public_transport") === "platform";
  if (is_platform) return EdgeClass.PATH;
  return -1;
}

export interface WalkGraphData {
  lat: Float64Array;
  lon: Float64Array;
  offsets: Int32Array;
  targets: Int32Array;
  lengths: Float32Array;
  classes: Uint8Array;
  usable: Uint8Array;
}

const CELL_DEG_LAT = 0.002;
const CELL_DEG_LON = 0.004;

function cell_y(lat: number): number {
  return Math.floor(lat / CELL_DEG_LAT);
}

function cell_x(lon: number): number {
  return Math.floor(lon / CELL_DEG_LON);
}

export class WalkGraph {
  readonly vertex_count: number;
  private cells = new Map<number, Int32Array>();
  readonly from_origin: WalkSearch;
  readonly from_destination: WalkSearch;
  readonly scratch: WalkSearch;

  constructor(readonly g: WalkGraphData) {
    this.vertex_count = g.lat.length;
    this.build_grid();
    this.from_origin = new WalkSearch(this);
    this.from_destination = new WalkSearch(this);
    this.scratch = new WalkSearch(this);
  }

  private cell_key(y: number, x: number) {
    return y * 1000000 + x;
  }

  private build_grid() {
    const buckets = new Map<number, number[]>();
    for (let vertex = 0; vertex < this.vertex_count; vertex++) {
      if (!this.g.usable[vertex]) continue;

      const key = this.cell_key(cell_y(this.g.lat[vertex]), cell_x(this.g.lon[vertex]));
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(vertex);
    }

    for (const [key, bucket] of buckets) this.cells.set(key, Int32Array.from(bucket));
  }

  snap(lat: number, lon: number): { vertex: number; distance: number } | null {
    const center_y = cell_y(lat);
    const center_x = cell_x(lon);
    let best_vertex = -1;
    let best_distance = SNAP_RADIUS;
    for (let y = center_y - 1; y <= center_y + 1; y++) {
      for (let x = center_x - 1; x <= center_x + 1; x++) {
        const cell = this.cells.get(this.cell_key(y, x));
        if (!cell) continue;

        for (const vertex of cell) {
          const meters = distance(lat, lon, this.g.lat[vertex], this.g.lon[vertex]);
          if (meters < best_distance) {
            best_distance = meters;
            best_vertex = vertex;
          }
        }
      }
    }

    if (best_vertex < 0) return null;
    return { vertex: best_vertex, distance: best_distance };
  }

  coord(v: number): [number, number] {
    return [this.g.lon[v], this.g.lat[v]];
  }
}

export class WalkSearch {
  private dist: Float64Array;
  private prev: Int32Array;
  private touched: number[] = [];
  private heap_distances: number[] = [];
  private heap_vertices: number[] = [];
  source = -1;

  constructor(private graph: WalkGraph) {
    this.dist = new Float64Array(graph.vertex_count).fill(Infinity);
    this.prev = new Int32Array(graph.vertex_count).fill(-1);
  }

  private reset() {
    for (const vertex of this.touched) {
      this.dist[vertex] = Infinity;
      this.prev[vertex] = -1;
    }
    this.touched = [];
    this.heap_distances = [];
    this.heap_vertices = [];
  }

  private push(distance: number, vertex: number) {
    const distances = this.heap_distances;
    const vertices = this.heap_vertices;
    let i = distances.length;
    distances.push(distance);
    vertices.push(vertex);

    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (distances[parent] <= distance) break;
      distances[i] = distances[parent];
      vertices[i] = vertices[parent];
      i = parent;
    }
    distances[i] = distance;
    vertices[i] = vertex;
  }

  private pop(): number {
    const distances = this.heap_distances;
    const vertices = this.heap_vertices;
    const top = vertices[0];
    const last_distance = distances.pop()!;
    const last_vertex = vertices.pop()!;
    const size = distances.length;
    if (size === 0) return top;

    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= size) break;
      const right_is_smaller = child + 1 < size && distances[child + 1] < distances[child];
      if (right_is_smaller) child++;
      if (distances[child] >= last_distance) break;
      distances[i] = distances[child];
      vertices[i] = vertices[child];
      i = child;
    }
    distances[i] = last_distance;
    vertices[i] = last_vertex;
    return top;
  }

  run(source: number, max_distance: number, on_settle?: (v: number, d: number) => boolean | void) {
    this.reset();
    this.source = source;
    const { offsets, targets, lengths } = this.graph.g;
    this.dist[source] = 0;
    this.touched.push(source);
    this.push(0, source);

    while (this.heap_distances.length) {
      const settled_distance = this.heap_distances[0];
      const vertex = this.pop();
      if (settled_distance > this.dist[vertex]) continue;
      if (on_settle?.(vertex, settled_distance)) return;

      for (let edge = offsets[vertex]; edge < offsets[vertex + 1]; edge++) {
        const new_distance = settled_distance + lengths[edge];
        if (new_distance > max_distance) continue;

        const target = targets[edge];
        const improves = new_distance < this.dist[target];
        if (!improves) continue;

        if (this.dist[target] === Infinity) this.touched.push(target);
        this.dist[target] = new_distance;
        this.prev[target] = vertex;
        this.push(new_distance, target);
      }
    }
  }

  distance_to(v: number): number {
    return this.dist[v];
  }

  path(v: number): number[] | null {
    if (this.dist[v] === Infinity) return null;
    const out: number[] = [];
    for (let vertex = v; vertex !== -1; vertex = this.prev[vertex]) out.push(vertex);
    return out.reverse();
  }
}

function is_fresh(file: string, max_age_ms: number): boolean {
  return existsSync(file) && Date.now() - statSync(file).mtimeMs < max_age_ms;
}

async function ensure_pbf(): Promise<string> {
  if (is_fresh(PBF_PATH, PBF_MAX_AGE_MS)) return PBF_PATH;

  console.log("Walk: downloading", OSM_URL);
  const response = await fetch(OSM_URL);
  if (!response.ok || !response.body) throw new Error(`OSM download failed: ${response.status}`);

  const tmp = `${PBF_PATH}.part`;
  await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(tmp));
  await rename(tmp, PBF_PATH);
  return PBF_PATH;
}

interface Segments {
  from: number[];
  to: number[];
  classes: number[];
}

function collect_walkable_segments(file: Uint8Array, vertex_of: Map<number, number>): Segments {
  const segments: Segments = { from: [], to: [], classes: [] };
  read_pbf(file, {
    way: function (_id, refs, tag) {
      const edge_class = walk_class(tag);
      if (edge_class < 0 || refs.length < 2) return;

      let previous = -1;
      for (const ref of refs) {
        let vertex = vertex_of.get(ref);
        if (vertex === undefined) {
          vertex = vertex_of.size;
          vertex_of.set(ref, vertex);
        }
        if (previous >= 0 && previous !== vertex) {
          segments.from.push(previous);
          segments.to.push(vertex);
          segments.classes.push(edge_class);
        }
        previous = vertex;
      }
    },
  });
  return segments;
}

function read_vertex_coords(file: Uint8Array, vertex_of: Map<number, number>) {
  const lat = new Float64Array(vertex_of.size).fill(NaN);
  const lon = new Float64Array(vertex_of.size).fill(NaN);
  read_pbf(file, {
    node: function (id, node_lat, node_lon) {
      const vertex = vertex_of.get(id);
      if (vertex === undefined) return;
      lat[vertex] = node_lat;
      lon[vertex] = node_lon;
    },
  });
  return { lat, lon };
}

function build_adjacency(vertex_count: number, segments: Segments, lat: Float64Array, lon: Float64Array) {
  const degree = new Int32Array(vertex_count + 1);
  const keep: boolean[] = [];
  for (let i = 0; i < segments.from.length; i++) {
    const is_valid = !Number.isNaN(lat[segments.from[i]]) && !Number.isNaN(lat[segments.to[i]]);
    keep.push(is_valid);
    if (is_valid) {
      degree[segments.from[i]]++;
      degree[segments.to[i]]++;
    }
  }

  const offsets = new Int32Array(vertex_count + 1);
  for (let vertex = 0; vertex < vertex_count; vertex++) {
    offsets[vertex + 1] = offsets[vertex] + degree[vertex];
  }

  const edge_count = offsets[vertex_count];
  const targets = new Int32Array(edge_count);
  const lengths = new Float32Array(edge_count);
  const classes = new Uint8Array(edge_count);
  const next_edge = offsets.slice(0, vertex_count);
  for (let i = 0; i < segments.from.length; i++) {
    if (!keep[i]) continue;

    const a = segments.from[i];
    const b = segments.to[i];
    const length = distance(lat[a], lon[a], lat[b], lon[b]);
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      const edge = next_edge[from]++;
      targets[edge] = to;
      lengths[edge] = length;
      classes[edge] = segments.classes[i];
    }
  }

  return { offsets, targets, lengths, classes };
}

// marks vertices in connected components of at least MIN_COMPONENT vertices, dropping small islands.
function mark_usable_vertices(lat: Float64Array, offsets: Int32Array, targets: Int32Array): Uint8Array {
  const vertex_count = lat.length;
  const component = new Int32Array(vertex_count).fill(-1);
  const usable = new Uint8Array(vertex_count);
  const queue = new Int32Array(vertex_count);
  for (let root = 0; root < vertex_count; root++) {
    if (component[root] >= 0 || Number.isNaN(lat[root])) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = root;
    component[root] = root;
    while (head < tail) {
      const vertex = queue[head++];
      for (let edge = offsets[vertex]; edge < offsets[vertex + 1]; edge++) {
        const target = targets[edge];
        if (component[target] < 0) {
          component[target] = root;
          queue[tail++] = target;
        }
      }
    }

    if (tail >= MIN_COMPONENT) {
      for (let i = 0; i < tail; i++) usable[queue[i]] = 1;
    }
  }
  return usable;
}

function build_from_pbf(file: Uint8Array): WalkGraphData {
  const vertex_of = new Map<number, number>();
  const segments = collect_walkable_segments(file, vertex_of);
  const vertex_count = vertex_of.size;
  const { lat, lon } = read_vertex_coords(file, vertex_of);
  vertex_of.clear();

  const { offsets, targets, lengths, classes } = build_adjacency(vertex_count, segments, lat, lon);
  const usable = mark_usable_vertices(lat, offsets, targets);
  return { lat, lon, offsets, targets, lengths, classes, usable };
}

const ARRAY_KEYS = ["lat", "lon", "offsets", "targets", "lengths", "classes", "usable"] as const;

interface CacheHeader {
  version: number;
  pbfMtime: number;
  sizes: number[];
}

async function save_cache(data: WalkGraphData, pbf_mtime: number) {
  const parts = ARRAY_KEYS.map(function (key) {
    const array = data[key];
    return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  });
  const header: CacheHeader = {
    version: CACHE_VERSION,
    pbfMtime: pbf_mtime,
    sizes: parts.map(function (part) {
      return part.length;
    }),
  };
  const header_bytes = Buffer.from(JSON.stringify(header).padEnd(CACHE_HEADER_BYTES));

  const tmp = `${CACHE_PATH}.part`;
  await writeFile(tmp, Buffer.concat([header_bytes, ...parts]));
  await rename(tmp, CACHE_PATH);
}

async function load_cache(pbf_mtime: number): Promise<WalkGraphData | null> {
  if (!existsSync(CACHE_PATH)) return null;

  const buffer = await readFile(CACHE_PATH);
  const header_text = buffer.subarray(0, CACHE_HEADER_BYTES).toString().trim();
  const header = JSON.parse(header_text) as CacheHeader;
  if (header.version !== CACHE_VERSION || header.pbfMtime !== pbf_mtime) return null;

  let position = CACHE_HEADER_BYTES;
  function next_part(i: number) {
    const start = buffer.byteOffset + position;
    const part = buffer.buffer.slice(start, start + header.sizes[i]);
    position += header.sizes[i];
    return part;
  }
  return {
    lat: new Float64Array(next_part(0)),
    lon: new Float64Array(next_part(1)),
    offsets: new Int32Array(next_part(2)),
    targets: new Int32Array(next_part(3)),
    lengths: new Float32Array(next_part(4)),
    classes: new Uint8Array(next_part(5)),
    usable: new Uint8Array(next_part(6)),
  };
}

export async function load_walk_graph(): Promise<WalkGraph> {
  const started = Date.now();
  const pbf = await ensure_pbf();
  const mtime = Math.floor(statSync(pbf).mtimeMs);

  let data = await load_cache(mtime);
  const from_cache = data !== null;
  if (!data) {
    console.log("Walk: building walking network from OSM (first run after a new extract; takes a while)…");
    data = build_from_pbf(await readFile(pbf));
    await save_cache(data, mtime);
  }

  const graph = new WalkGraph(data);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const cached_note = from_cache ? " (cached)" : "";
  console.log(
    `Walk: network ready in ${seconds} s${cached_note} — ` +
      `${graph.vertex_count} points, ${data.targets.length / 2} segments`,
  );
  return graph;
}
