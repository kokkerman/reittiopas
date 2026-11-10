// a small reader for openstreetmap .pbf files, just enough to get the walkable ways and their points

import { inflateSync } from "node:zlib";

// TY Claude!

class Reader {
  position: number;
  constructor(
    public buffer: Uint8Array,
    start = 0,
    public end = buffer.length,
  ) {
    this.position = start;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.buffer[this.position++];
      const payload = byte & 0x7f;
      // bit shifts are 32-bit, so higher bytes are added with multiplication instead.
      result += shift < 28 ? payload << shift : payload * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }

  svarint(): number {
    const zigzag = this.varint();
    return zigzag % 2 === 1 ? -(zigzag + 1) / 2 : zigzag / 2;
  }

  bytes(): [number, number] {
    const length = this.varint();
    const start = this.position;
    this.position += length;
    return [start, this.position];
  }

  skip(wire_type: number) {
    if (wire_type === 0) {
      this.varint();
    } else if (wire_type === 1) {
      this.position += 8;
    } else if (wire_type === 2) {
      const length = this.varint();
      this.position += length;
    } else if (wire_type === 5) {
      this.position += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire_type}`);
    }
  }

  fields(callback: (field: number, wireType: number) => void) {
    while (this.position < this.end) {
      const key = this.varint();
      callback(key >>> 3, key & 7);
    }
  }

  sub_reader(): Reader {
    const [start, end] = this.bytes();
    return new Reader(this.buffer, start, end);
  }
}

function read_packed(reader: Reader, read: (inner_reader: Reader) => number, out: number[]) {
  const packed_reader = reader.sub_reader();
  while (packed_reader.position < packed_reader.end) out.push(read(packed_reader));
}

function read_packed_varints(reader: Reader, out: number[]) {
  read_packed(reader, function (inner_reader) {
    return inner_reader.varint();
  }, out);
}

function read_packed_svarints(reader: Reader, out: number[]) {
  read_packed(reader, function (inner_reader) {
    return inner_reader.svarint();
  }, out);
}

const utf8 = new TextDecoder();

export interface PbfHandlers {
  way?: (id: number, refs: number[], tag: (key: string) => string | undefined) => void;
  node?: (id: number, lat: number, lon: number) => void;
}

function read_blob_header(file: Uint8Array, start: number, end: number): { type: string; data_size: number } {
  let type = "";
  let data_size = 0;
  const header = new Reader(file, start, end);
  header.fields(function (field, wire_type) {
    if (field === 1) {
      const [type_start, type_end] = header.bytes();
      type = utf8.decode(file.subarray(type_start, type_end));
    } else if (field === 3) {
      data_size = header.varint();
    } else {
      header.skip(wire_type);
    }
  });
  return { type, data_size };
}

function read_blob_data(file: Uint8Array, start: number, end: number): Uint8Array | null {
  let raw_data: Uint8Array | null = null;
  const blob = new Reader(file, start, end);
  blob.fields(function (field, wire_type) {
    const is_unsupported_compression = field === 4 || field === 6 || field === 7;
    if (field === 1) {
      const [data_start, data_end] = blob.bytes();
      raw_data = file.subarray(data_start, data_end);
    } else if (field === 3) {
      const [data_start, data_end] = blob.bytes();
      raw_data = inflateSync(file.subarray(data_start, data_end));
    } else if (is_unsupported_compression) {
      throw new Error("OSM PBF uses an unsupported compression (only zlib/raw are supported)");
    } else {
      blob.skip(wire_type);
    }
  });
  return raw_data;
}

function* data_blocks(file: Uint8Array): Generator<Uint8Array> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let position = 0;
  while (position < file.length) {
    const header_length = view.getUint32(position);
    position += 4;

    const { type, data_size } = read_blob_header(file, position, position + header_length);
    position += header_length;

    const blob_start = position;
    position += data_size;
    if (type !== "OSMData") continue;

    const raw_data = read_blob_data(file, blob_start, blob_start + data_size);
    if (raw_data) yield raw_data;
  }
}

function read_string_table(buffer: Uint8Array, start: number, end: number): string[] {
  const strings: string[] = [];
  const table = new Reader(buffer, start, end);
  table.fields(function (field, wire_type) {
    if (field === 1) {
      const [string_start, string_end] = table.bytes();
      strings.push(utf8.decode(buffer.subarray(string_start, string_end)));
    } else {
      table.skip(wire_type);
    }
  });
  return strings;
}

function read_block(buffer: Uint8Array, handlers: PbfHandlers) {
  let strings: string[] = [];
  let granularity = 100;
  let lat_offset = 0;
  let lon_offset = 0;
  const groups: [number, number][] = [];

  const block = new Reader(buffer);
  block.fields(function (field, wire_type) {
    if (field === 1) {
      const [table_start, table_end] = block.bytes();
      if (handlers.way) strings = read_string_table(buffer, table_start, table_end);
    } else if (field === 2) {
      groups.push(block.bytes());
    } else if (field === 17) {
      granularity = block.varint();
    } else if (field === 19) {
      lat_offset = block.varint();
    } else if (field === 20) {
      lon_offset = block.varint();
    } else {
      block.skip(wire_type);
    }
  });

  function to_deg(value: number, offset: number) {
    return 1e-9 * (offset + granularity * value);
  }

  for (const [group_start, group_end] of groups) {
    const reader = new Reader(buffer, group_start, group_end);
    reader.fields(function (field, wire_type) {
      if (field === 2 && handlers.node) {
        read_dense(reader, handlers.node, to_deg, lat_offset, lon_offset);
      } else if (field === 1 && handlers.node) {
        read_node(reader, handlers.node, to_deg, lat_offset, lon_offset);
      } else if (field === 3 && handlers.way) {
        read_way(reader, handlers.way, strings);
      } else {
        reader.skip(wire_type);
      }
    });
  }
}

type ToDeg = (value: number, offset: number) => number;
type NodeCallback = NonNullable<PbfHandlers["node"]>;
type WayCallback = NonNullable<PbfHandlers["way"]>;

function read_dense(
  reader: Reader,
  callback: NodeCallback,
  to_deg: ToDeg,
  lat_offset: number,
  lon_offset: number,
) {
  const ids: number[] = [];
  const lats: number[] = [];
  const lons: number[] = [];
  const field_reader = reader.sub_reader();
  field_reader.fields(function (field, wire_type) {
    if (field === 1) {
      read_packed_svarints(field_reader, ids);
    } else if (field === 8) {
      read_packed_svarints(field_reader, lats);
    } else if (field === 9) {
      read_packed_svarints(field_reader, lons);
    } else {
      field_reader.skip(wire_type);
    }
  });

  // dense nodes are delta-encoded.
  let id = 0;
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < ids.length; i++) {
    id += ids[i];
    lat += lats[i];
    lon += lons[i];
    callback(id, to_deg(lat, lat_offset), to_deg(lon, lon_offset));
  }
}

function read_node(
  reader: Reader,
  callback: NodeCallback,
  to_deg: ToDeg,
  lat_offset: number,
  lon_offset: number,
) {
  let id = 0;
  let lat = 0;
  let lon = 0;
  const field_reader = reader.sub_reader();
  field_reader.fields(function (field, wire_type) {
    if (field === 1) {
      id = field_reader.svarint();
    } else if (field === 8) {
      lat = field_reader.svarint();
    } else if (field === 9) {
      lon = field_reader.svarint();
    } else {
      field_reader.skip(wire_type);
    }
  });
  callback(id, to_deg(lat, lat_offset), to_deg(lon, lon_offset));
}

function read_way(reader: Reader, callback: WayCallback, strings: string[]) {
  let id = 0;
  const keys: number[] = [];
  const values: number[] = [];
  const refs: number[] = [];
  const field_reader = reader.sub_reader();
  field_reader.fields(function (field, wire_type) {
    if (field === 1) {
      id = field_reader.varint();
    } else if (field === 2) {
      read_packed_varints(field_reader, keys);
    } else if (field === 3) {
      read_packed_varints(field_reader, values);
    } else if (field === 8) {
      read_packed_svarints(field_reader, refs);
    } else {
      field_reader.skip(wire_type);
    }
  });

  for (let i = 1; i < refs.length; i++) refs[i] += refs[i - 1];

  function tag(key: string) {
    for (let i = 0; i < keys.length; i++) {
      if (strings[keys[i]] === key) return strings[values[i]];
    }
    return undefined;
  }
  callback(id, refs, tag);
}

export function read_pbf(file: Uint8Array, handlers: PbfHandlers) {
  for (const block of data_blocks(file)) read_block(block, handlers);
}
