// live vehicles on the map. gets them from the server over a websocket and glides them between updates

import { useEffect } from "react";
import { Layer, Source, useMap } from "react-map-gl/maplibre";
import type { GeoJSONFeatureDiff, GeoJSONSource } from "maplibre-gl";
import type { Feature, FeatureCollection, Point } from "geojson";
import { MODE_COLOR_EXPRESSION } from "../styles/mode_colors";
import { ui_scale } from "../utils/ui_scale";
import type { Bbox, ServerMessage, Vehicle, VehiclesMessage, ViewportMessage } from "../types/api_types";

const UPDATE_MS = 1000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
// the server sends something at least every 10 s; silence longer than this means a dead link
// (typical after a phone sleeps: the socket looks open but nothing arrives).
const STALE_MS = 25000;
const MIN_ZOOM = 12;
const FRAME_MS = 50;

export const VEHICLES_HIT_LAYER = "vehicles-hit";

type VehicleProps = Pick<Vehicle, "id" | "mode" | "line">;

interface Track {
  vehicle: Vehicle;
  from: [number, number];
  to: [number, number];
  started_at: number;
}

const EMPTY: FeatureCollection<Point, VehicleProps> = { type: "FeatureCollection", features: [] };

// close without an abrupt reset: a socket still connecting is closed once it opens
// (closing it mid-handshake is what produced "ws proxy error: ECONNRESET").
function close_socket(socket: WebSocket) {
  socket.onmessage = null;

  if (socket.readyState === WebSocket.CONNECTING) {
    socket.onopen = function () {
      socket.close();
    };
  } else if (socket.readyState === WebSocket.OPEN) {
    socket.close();
  }
}

function position_at(track: Track, now: number): [number, number] {
  const progress = Math.min(1, (now - track.started_at) / UPDATE_MS);
  const [from_lon, from_lat] = track.from;
  const [to_lon, to_lat] = track.to;

  return [from_lon + (to_lon - from_lon) * progress, from_lat + (to_lat - from_lat) * progress];
}

function vehicle_position(vehicle: Vehicle): [number, number] {
  return [vehicle.lon, vehicle.lat];
}

function line_or_mode_changed(previous: Vehicle, vehicle: Vehicle): boolean {
  return previous.line !== vehicle.line || previous.mode !== vehicle.mode;
}

interface Props {
  selected_id: string | null;
}

export default function VehiclesLayer({ selected_id }: Props) {
  const { current: map_ref } = useMap();

  useEffect(function () {
    const current_map = map_ref?.getMap();
    if (!current_map) return;
    // re-bound so the function declarations below see it as defined (narrowing doesn't reach them).
    const map = current_map;

    const tracks = new Map<string, Track>();
    const pending = new Set<string>();
    let animation_frame = 0;
    let last_frame = 0;
    let socket: WebSocket | null = null;
    let reconnect_timer = 0;
    let reconnect_delay = RECONNECT_MIN_MS;
    let last_message_at = 0;
    let disposed = false;

    // performance is not the best. but atleast room for improvement
    function get_source() {
      return map.getSource("vehicles") as GeoJSONSource | undefined;
    }

    function to_feature(track: Track, now: number): Feature<Point, VehicleProps> {
      const { id, mode, line } = track.vehicle;
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: position_at(track, now) },
        properties: { id, mode, line },
      };
    }

    function draw(now: number) {
      if (!pending.size) return;

      const update: GeoJSONFeatureDiff[] = [];
      for (const id of pending) {
        const track = tracks.get(id);
        if (!track) {
          pending.delete(id);
          continue;
        }

        update.push({ id, newGeometry: { type: "Point", coordinates: position_at(track, now) } });

        const has_arrived = now - track.started_at >= UPDATE_MS;
        if (has_arrived) {
          pending.delete(id);
        }
      }

      if (update.length) {
        get_source()?.updateData({ update });
      }
    }

    function frame(now: number) {
      animation_frame = 0;

      // while the user drags/zooms, the map is busy redrawing
      const frame_due = now - last_frame >= FRAME_MS;
      if (!map.isMoving() && frame_due) {
        last_frame = now;
        draw(now);
      }

      if (pending.size) {
        animation_frame = requestAnimationFrame(frame);
      }
    }

    function animate() {
      if (!animation_frame) {
        animation_frame = requestAnimationFrame(frame);
      }
    }

    let needs_full = true;

    function replace_all_tracks(message: VehiclesMessage, now: number) {
      if (message.full) {
        tracks.clear();
      }
      for (const id of message.removed) {
        tracks.delete(id);
      }
      for (const vehicle of message.updated) {
        const position = vehicle_position(vehicle);
        tracks.set(vehicle.id, { vehicle, from: position, to: position, started_at: now });
      }
    }

    function ids_to_remove(message: VehiclesMessage): string[] {
      const remove: string[] = [];

      if (message.full) {
        const updated_ids = message.updated.map(function (vehicle) {
          return vehicle.id;
        });
        const keep = new Set(updated_ids);
        for (const id of tracks.keys()) {
          if (!keep.has(id)) {
            remove.push(id);
          }
        }
      }

      for (const id of message.removed) {
        if (tracks.has(id)) {
          remove.push(id);
        }
      }

      return remove;
    }

    function apply_message(message: VehiclesMessage) {
      const now = performance.now();
      const source = get_source();

      if (!source || needs_full) {
        replace_all_tracks(message, now);
        if (source) {
          const features = [...tracks.values()].map(function (track) {
            return to_feature(track, now);
          });
          source.setData({ type: "FeatureCollection", features });
          needs_full = false;
        }
        return;
      }

      const remove = ids_to_remove(message);
      for (const id of remove) {
        tracks.delete(id);
        pending.delete(id);
      }

      const add: Feature<Point, VehicleProps>[] = [];
      const update: GeoJSONFeatureDiff[] = [];
      for (const vehicle of message.updated) {
        const previous = tracks.get(vehicle.id);
        const from = previous ? position_at(previous, now) : vehicle_position(vehicle);
        const track: Track = { vehicle, from, to: vehicle_position(vehicle), started_at: now };
        tracks.set(vehicle.id, track);

        if (!previous) {
          add.push(to_feature(track, now));
          continue;
        }

        pending.add(vehicle.id);
        if (line_or_mode_changed(previous.vehicle, vehicle)) {
          update.push({
            id: vehicle.id,
            addOrUpdateProperties: [
              { key: "line", value: vehicle.line },
              { key: "mode", value: vehicle.mode },
            ],
          });
        }
      }

      if (remove.length || add.length || update.length) {
        source.updateData({ remove, add, update });
      }
      animate();
    }

    function send_viewport() {
      if (socket?.readyState !== WebSocket.OPEN) return;

      let bbox: Bbox | null = null;
      if (map.getZoom() >= MIN_ZOOM) {
        const bounds = map.getBounds();
        bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
      }

      const message: ViewportMessage = { type: "viewport", bbox };
      socket.send(JSON.stringify(message));
    }

    function schedule_reconnect() {
      if (disposed || reconnect_timer) return;
      reconnect_timer = window.setTimeout(function () {
        reconnect_timer = 0;
        connect();
      }, reconnect_delay);
      reconnect_delay = Math.min(reconnect_delay * 2, RECONNECT_MAX_MS);
    }

    function connect() {
      if (disposed) return;
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const new_socket = new WebSocket(`${protocol}://${location.host}/api/ws`);
      socket = new_socket;
      new_socket.onopen = function () {
        reconnect_delay = RECONNECT_MIN_MS;
        last_message_at = Date.now();
        send_viewport();
      };
      new_socket.onmessage = function (event) {
        last_message_at = Date.now();
        const message = JSON.parse(event.data as string) as ServerMessage;
        if (message.type === "vehicles") {
          apply_message(message);
        }
      };
      new_socket.onclose = function () {
        if (socket === new_socket) {
          socket = null;
        }
        schedule_reconnect();
      };
    }

    function reconnect_now() {
      if (disposed) return;
      clearTimeout(reconnect_timer);
      reconnect_timer = 0;
      reconnect_delay = RECONNECT_MIN_MS;
      const old_socket = socket;
      socket = null;
      if (old_socket) {
        old_socket.onclose = null;
        close_socket(old_socket);
      }
      connect();
    }

    function is_healthy() {
      if (socket === null) {
        return false;
      }

      if (socket.readyState === WebSocket.CONNECTING) {
        return true;
      }

      const heard_recently = Date.now() - last_message_at < STALE_MS;
      return socket.readyState === WebSocket.OPEN && heard_recently;
    }

    const watchdog = window.setInterval(function () {
      if (socket?.readyState === WebSocket.OPEN && !is_healthy()) {
        reconnect_now();
      }
    }, 5000);

    function on_resume() {
      if (document.visibilityState === "visible" && !is_healthy()) {
        reconnect_now();
      }
    }
    document.addEventListener("visibilitychange", on_resume);
    window.addEventListener("online", on_resume);

    connect();
    map.on("moveend", send_viewport);
    return function () {
      disposed = true;
      map.off("moveend", send_viewport);
      document.removeEventListener("visibilitychange", on_resume);
      window.removeEventListener("online", on_resume);
      clearInterval(watchdog);
      clearTimeout(reconnect_timer);
      if (socket) {
        socket.onclose = null;
        close_socket(socket);
      }
      cancelAnimationFrame(animation_frame);
    };
  }, [map_ref]);

  return (
    <Source id="vehicles" type="geojson" data={EMPTY} promoteId="id">
      <Layer
        id="vehicles-selected"
        type="circle"
        filter={["==", ["get", "id"], selected_id ?? ""]}
        paint={{ "circle-radius": 15 * ui_scale(), "circle-color": "#ffffff" }}
      />
      <Layer
        id="vehicles-dot"
        type="circle"
        paint={{
          "circle-color": MODE_COLOR_EXPRESSION,
          "circle-radius": 11 * ui_scale(),
          "circle-stroke-color": "#0a0a0a",
          "circle-stroke-width": 1.5,
        }}
      />
      <Layer
        id="vehicles-label"
        type="symbol"
        layout={{
          "text-field": ["get", "line"],
          "text-font": ["Noto Sans Regular"], // must be a font the map style serves
          "text-size": 10 * ui_scale(),
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        }}
        paint={{ "text-color": "#ffffff" }}
      />
      <Layer id={VEHICLES_HIT_LAYER} type="circle" paint={{ "circle-radius": 18 * ui_scale(), "circle-opacity": 0 }} />
    </Source>
  );
}
