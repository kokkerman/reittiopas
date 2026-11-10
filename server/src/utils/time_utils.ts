// date and time helpers in helsinki time

const TZ = "Europe/Helsinki";
const date_fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const offset_fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" });

function parse_date(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number);
  return [year, month, day];
}

function parse_gmt_offset_seconds(label: string): number {
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(label);
  if (!match) return 0;

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return sign * (hours * 3600 + minutes * 60);
}

export function helsinki_date(milliseconds = Date.now()): string {
  return date_fmt.format(milliseconds);
}

export function add_days(date: string, n: number): string {
  const [year, month, day] = parse_date(date);
  return new Date(Date.UTC(year, month - 1, day + n)).toISOString().slice(0, 10);
}

export function helsinki_midnight(date: string): number {
  const [year, month, day] = parse_date(date);
  const utc_midnight = Date.UTC(year, month - 1, day) / 1000;

  const parts = offset_fmt.formatToParts(utc_midnight * 1000);
  const zone_part = parts.find(function (part) {
    return part.type === "timeZoneName";
  });
  const label = zone_part?.value ?? "GMT";
  return utc_midnight - parse_gmt_offset_seconds(label);
}

export function parse_clock(clock: string): number {
  const [hours, minutes, seconds] = clock.split(":");
  return Number(hours) * 3600 + Number(minutes) * 60 + (seconds ? Number(seconds) : 0);
}

export function decode_polyline(encoded: string): [number, number][] {
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  function read_delta(): number {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const is_negative = (result & 1) !== 0;
    return is_negative ? ~(result >> 1) : result >> 1;
  }

  while (index < encoded.length) {
    lat += read_delta();
    lon += read_delta();
    out.push([lon / 1e5, lat / 1e5]);
  }
  return out;
}
