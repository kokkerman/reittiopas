// the route labels on the map. also keeps them on the screen, on their route and away from eachother
// polluted by claude

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Marker, useMap } from "react-map-gl/maplibre";
import type { Marker as MapLibreMarker } from "maplibre-gl";
import type { Itinerary } from "../types/api_types";
import { itinerary_color } from "../styles/itinerary_colors";
import { LineBadge, transit_legs } from "../utils/formatting";
import { format_clock_time, format_duration } from "../utils/time_format";
import { MAX_SPOT_SCORE, separate, type LabelCandidates, type ScreenItem } from "../utils/label_placement";
import type { PlannerPlace } from "../hooks/use_planner";

const LABEL_CLASSES =
  "absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border-2 " +
  "bg-neutral-900 px-2 py-0.5 text-sm whitespace-nowrap text-neutral-100";
const FOCUSED_LABEL_CLASSES = "font-bold shadow-lg shadow-black/60";
const OTHER_LABEL_CLASSES = "scale-90 opacity-45";

const STEM = 10;
const BADGE_OFFSET = 6;
const END_SIZE = 20;
const VIEW_INSET = { top: 84, bottom: 120, side: 12 };

const W_ROUTE = 0.3;
const W_MIDDLE = 0.3;
const W_EDGE = 0.15;
const W_CROWD = 0.25;
const STICKY = 0.08;
const EDGE_PX = 80;
const CROWD_PX = 160;
const KEEP_EDGE_PX = 24;
const KEEP_APART_PX = 70;

const TAU_MS = 110;

interface Pose {
  lng: number;
  lat: number;
  ox: number;
  oy: number;
}

interface Size {
  w: number;
  h: number;
}

interface ScreenPoint {
  x: number;
  y: number;
}

interface ViewBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Props {
  itineraries: Itinerary[];
  counts: number[];
  candidates: LabelCandidates[];
  focused: number | null;
  from: PlannerPlace | null;
  to: PlannerPlace | null;
  on_select: (index: number) => void;
}

// keeps the previous size for an element that is currently hidden (offsetWidth 0).
function measure_sizes(elements: (HTMLElement | null)[], previous: (Size | undefined)[]): (Size | undefined)[] {
  return elements.map(function (element, i) {
    if (!element) {
      return undefined;
    }

    if (element.offsetWidth) {
      return { w: element.offsetWidth, h: element.offsetHeight };
    }

    return previous[i];
  });
}

function blend_pose(current: Pose, target: Pose, amount: number): Pose {
  return {
    lng: current.lng + (target.lng - current.lng) * amount,
    lat: current.lat + (target.lat - current.lat) * amount,
    ox: current.ox + (target.ox - current.ox) * amount,
    oy: current.oy + (target.oy - current.oy) * amount,
  };
}

function is_close_to(current: Pose, target: Pose): boolean {
  const position_close = Math.abs(target.lng - current.lng) < 1e-7 && Math.abs(target.lat - current.lat) < 1e-7;
  const offset_close = Math.abs(target.ox - current.ox) < 0.3 && Math.abs(target.oy - current.oy) < 0.3;

  return position_close && offset_close;
}

// route indices in order, the focused one first so it gets the best spot.
function placement_order(count: number, focused: number | null): number[] {
  const order = Array.from({ length: count }, function (_, i) {
    return i;
  });

  return order.sort(function (left, right) {
    if (left === focused) {
      return -1;
    }

    if (right === focused) {
      return 1;
    }

    return left - right;
  });
}

function is_in_view(point: ScreenPoint, view: ViewBox): boolean {
  return point.x >= view.left && point.x <= view.right && point.y >= view.top && point.y <= view.bottom;
}

function is_well_inside_view(point: ScreenPoint, view: ViewBox): boolean {
  const inside_x = point.x >= view.left + KEEP_EDGE_PX && point.x <= view.right - KEEP_EDGE_PX;
  const inside_y = point.y >= view.top + KEEP_EDGE_PX && point.y <= view.bottom - KEEP_EDGE_PX;

  return inside_x && inside_y;
}

function distance(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distance_to_view_edge(point: ScreenPoint, view: ViewBox): number {
  return Math.min(point.x - view.left, view.right - point.x, point.y - view.top, view.bottom - point.y);
}

function is_good_spot_to_keep(point: ScreenPoint | undefined, view: ViewBox, placed: ScreenPoint[]): boolean {
  if (!point) {
    return false;
  }

  const far_from_others = placed.every(function (other) {
    return distance(point, other) >= KEEP_APART_PX;
  });

  return is_well_inside_view(point, view) && far_from_others;
}

function best_spot(
  projected: ScreenPoint[],
  visible: number[],
  scores: number[],
  view: ViewBox,
  placed: ScreenPoint[],
  current_spot: number | undefined,
): number {
  const first = visible[0];
  const last_visible = visible[visible.length - 1];
  const middle_index = (first + last_visible) / 2;
  const half = Math.max(1, (last_visible - first) / 2);

  let spot = -1;
  let best_score = -Infinity;
  for (const index of visible) {
    const screen_point = projected[index];

    const route = scores[index] / MAX_SPOT_SCORE;
    const middle = 1 - Math.abs(index - middle_index) / half;
    const edge = Math.min(EDGE_PX, distance_to_view_edge(screen_point, view)) / EDGE_PX;

    let nearest = CROWD_PX;
    for (const other of placed) {
      nearest = Math.min(nearest, distance(screen_point, other));
    }
    const crowd = nearest / CROWD_PX;

    const sticky_bonus = index === current_spot ? STICKY : 0;
    const score = W_ROUTE * route + W_MIDDLE * middle + W_EDGE * edge + W_CROWD * crowd + sticky_bonus;
    if (score > best_score) {
      best_score = score;
      spot = index;
    }
  }

  return spot;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function RouteLabelContent({ itinerary, extra_count }: { itinerary: Itinerary; extra_count: number }) {
  const lines = transit_legs(itinerary);

  return (
    <>
      {format_duration(itinerary.duration)}
      {lines.length === 0 ? (
        <span className="text-neutral-400">kävely</span>
      ) : (
        lines.map(function (leg, index) {
          return <LineBadge key={index} leg={leg} />;
        })
      )}
      <span className="ml-0.5 border-l border-neutral-700 pl-1.5 text-sm font-normal text-neutral-300">
        perillä <span className="font-semibold text-white tabular-nums">{format_clock_time(itinerary.end)}</span>
      </span>
      {extra_count > 0 && (
        <span className="rounded-full bg-neutral-700 px-1.5 text-xs font-semibold text-neutral-200">+{extra_count}</span>
      )}
    </>
  );
}

export default function RouteLabels({ itineraries, counts, candidates, focused, from, to, on_select }: Props) {
  const { current: map_ref } = useMap();
  const label_els = useRef<(HTMLElement | null)[]>([]);
  const badge_els = useRef<(HTMLElement | null)[]>([]);
  const markers = useRef<(MapLibreMarker | null)[]>([]);
  const stems = useRef<(SVGLineElement | null)[]>([]);
  const spots = useRef<number[]>([]);
  const pose = useRef<(Pose | undefined)[]>([]);
  const label_size = useRef<(Size | undefined)[]>([]);
  const badge_size = useRef<(Size | undefined)[]>([]);
  useLayoutEffect(function () {
    label_size.current = measure_sizes(label_els.current, label_size.current);
    badge_size.current = measure_sizes(badge_els.current, badge_size.current);
  });
  const target = useRef<(Pose | undefined)[]>([]);

  useEffect(function () {
    spots.current = [];
    pose.current = [];
    target.current = [];
  }, [candidates]);

  const boardings = useMemo(function () {
    if (focused === null || !itineraries[focused]) {
      return [];
    }

    return transit_legs(itineraries[focused]);
  }, [itineraries, focused]);

  useEffect(function () {
    const current_map = map_ref?.getMap();
    if (!current_map) return;
    const map = current_map;

    let layout_frame = 0;
    let anim_frame = 0;
    let last = 0;

    function apply(i: number, current_pose: Pose) {
      markers.current[i]?.setLngLat([current_pose.lng, current_pose.lat]);

      const element = label_els.current[i];
      if (element) {
        element.style.left = `${current_pose.ox}px`;
        element.style.top = `${current_pose.oy}px`;
      }

      stems.current[i]?.setAttribute("x2", String(current_pose.ox));
      stems.current[i]?.setAttribute("y2", String(current_pose.oy));
    }

    function animate(time: number) {
      anim_frame = 0;
      const time_step = last ? Math.min(64, time - last) : 16;
      last = time;
      const blend = 1 - Math.exp(-time_step / TAU_MS);

      let moving = false;
      target.current.forEach(function (target_pose, i) {
        if (!target_pose) return;

        let current_pose = pose.current[i];
        if (!current_pose) {
          current_pose = { ...target_pose };
        } else {
          current_pose = blend_pose(current_pose, target_pose, blend);
          if (is_close_to(current_pose, target_pose)) {
            current_pose = { ...target_pose };
          } else {
            moving = true;
          }
        }

        pose.current[i] = current_pose;
        apply(i, current_pose);
      });

      if (moving) {
        anim_frame = requestAnimationFrame(animate);
      } else {
        last = 0;
      }
    }

    function start_animating() {
      if (!anim_frame) {
        anim_frame = requestAnimationFrame(animate);
      }
    }

    function ensure_label_size(i: number): boolean {
      if (label_size.current[i]) {
        return true;
      }

      const element = label_els.current[i];
      const marker_element = markers.current[i]?.getElement();
      if (marker_element) {
        marker_element.style.display = "";
      }

      if (!element?.offsetWidth) {
        return false;
      }

      label_size.current[i] = { w: element.offsetWidth, h: element.offsetHeight };
      return true;
    }

    function layout() {
      layout_frame = 0;
      const { clientWidth: width, clientHeight: height } = map.getContainer();
      const view: ViewBox = {
        left: VIEW_INSET.side,
        right: width - VIEW_INSET.side,
        top: VIEW_INSET.top,
        bottom: height - VIEW_INSET.bottom,
      };

      const placed: ScreenPoint[] = [];
      const anchor_px: (ScreenPoint | undefined)[] = [];
      for (const i of placement_order(candidates.length, focused)) {
        const route_candidates = candidates[i];
        if (!route_candidates.points.length) continue;
        if (!ensure_label_size(i)) continue;

        const projected = route_candidates.points.map(function (point) {
          return map.project(point);
        });
        const visible: number[] = [];
        projected.forEach(function (screen_point, index) {
          if (is_in_view(screen_point, view)) {
            visible.push(index);
          }
        });

        const marker = markers.current[i]?.getElement();
        if (!visible.length) {
          if (marker) {
            marker.style.display = "none";
          }
          target.current[i] = undefined;
          pose.current[i] = undefined;
          continue;
        }
        if (marker) {
          marker.style.display = "";
        }

        const current_spot = spots.current[i];
        const current_point = current_spot !== undefined ? projected[current_spot] : undefined;
        const spot = is_good_spot_to_keep(current_point, view, placed)
          ? current_spot!
          : best_spot(projected, visible, route_candidates.scores, view, placed, current_spot);

        spots.current[i] = spot;
        anchor_px[i] = projected[spot];
        placed.push(projected[spot]);
      }

      const items: ScreenItem[] = [];
      const label_index: number[] = [];
      anchor_px.forEach(function (anchor, i) {
        const size = label_size.current[i];
        if (!anchor || !size) return;

        const { w, h } = size;
        items.push({ x: anchor.x, y: anchor.y, w, h, dx: 0, dy: -(STEM + h / 2) });
        label_index.push(i);
      });
      boardings.forEach(function (leg, i) {
        const size = badge_size.current[i];
        if (!size) return;

        const screen_point = map.project([leg.from.lon, leg.from.lat]);
        const { w, h } = size;
        const dx = BADGE_OFFSET + w / 2;
        const dy = -(BADGE_OFFSET + h / 2);
        items.push({ x: screen_point.x, y: screen_point.y, w, h, dx, dy, fixed: true });
      });
      for (const end of [from, to]) {
        if (!end) continue;

        const screen_point = map.project([end.lon, end.lat]);
        items.push({ x: screen_point.x, y: screen_point.y, w: END_SIZE, h: END_SIZE, dx: 0, dy: 0, fixed: true });
      }

      const offsets = separate(items);

      label_index.forEach(function (i, item_index) {
        const item = items[item_index];
        const [offset_x, offset_y] = offsets[item_index];
        const center_x = clamp(item.x + offset_x, view.left + item.w / 2, view.right - item.w / 2);
        const center_y = clamp(item.y + offset_y, view.top + item.h / 2, view.bottom - item.h / 2);
        const [lng, lat] = candidates[i].points[spots.current[i]];
        target.current[i] = { lng, lat, ox: center_x - item.x, oy: center_y - item.y };
      });

      start_animating();
    }

    function schedule_layout() {
      if (!layout_frame) {
        layout_frame = requestAnimationFrame(layout);
      }
    }

    schedule_layout();
    map.on("moveend", schedule_layout);
    map.on("resize", schedule_layout);
    return function () {
      map.off("moveend", schedule_layout);
      map.off("resize", schedule_layout);
      cancelAnimationFrame(layout_frame);
      cancelAnimationFrame(anim_frame);
    };
  }, [map_ref, candidates, boardings, focused, from, to]);

  return (
    <>
      {boardings.map(function (leg, i) {
        return (
          <Marker
            key={`board-${focused}-${i}`}
            longitude={leg.from.lon}
            latitude={leg.from.lat}
            anchor="bottom-left"
            offset={[BADGE_OFFSET, -BADGE_OFFSET]}
            style={{ pointerEvents: "none" }}
          >
            <span
              ref={function (element) {
                badge_els.current[i] = element;
              }}
              className="inline-block"
            >
              <LineBadge leg={leg} />
            </span>
          </Marker>
        );
      })}

      {itineraries.map(function (itinerary, i) {
        const route_candidates = candidates[i];
        if (!route_candidates?.points.length) return null;

        const current_pose = pose.current[i];
        const middle_point = route_candidates.points[Math.floor(route_candidates.points.length / 2)];
        const [longitude, latitude] = current_pose ? [current_pose.lng, current_pose.lat] : middle_point;
        const offset_x = current_pose?.ox ?? 0;
        const offset_y = current_pose?.oy ?? -(STEM + 12);
        const is_focused = i === focused;
        const color = itinerary_color(i);

        return (
          <Marker
            key={`label-${i}`}
            ref={function (marker) {
              markers.current[i] = marker;
            }}
            longitude={longitude}
            latitude={latitude}
            anchor="center"
            style={{ zIndex: is_focused ? 2 : 1 }}
            onClick={function (event) {
              event.originalEvent.stopPropagation();
              on_select(i);
            }}
          >
            <div className="relative h-0 w-0">
              <svg className="pointer-events-none absolute overflow-visible" width="0" height="0">
                <line
                  ref={function (element) {
                    stems.current[i] = element;
                  }}
                  x1={0}
                  y1={0}
                  x2={offset_x}
                  y2={offset_y}
                  stroke={color}
                  strokeWidth={is_focused ? 2 : 1.5}
                  strokeOpacity={is_focused ? 1 : 0.35}
                />
                <circle r={is_focused ? 3.5 : 2.5} fill={color} fillOpacity={is_focused ? 1 : 0.4} />
              </svg>
              <button
                type="button"
                ref={function (element) {
                  label_els.current[i] = element;
                }}
                className={`${LABEL_CLASSES} ${is_focused ? FOCUSED_LABEL_CLASSES : OTHER_LABEL_CLASSES}`}
                style={{ left: offset_x, top: offset_y, borderColor: color }}
              >
                <RouteLabelContent itinerary={itinerary} extra_count={counts[i] - 1} />
              </button>
            </div>
          </Marker>
        );
      })}
    </>
  );
}
