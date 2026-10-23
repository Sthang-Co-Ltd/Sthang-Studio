// FFmpeg can interleave other writers between a bbox header and its coordinates.
// Recover only explicitly attributed records; never guess across contexts or frames.
// Rows preserve the existing diagnostic and boxFor field indexes.
export function parsePreviewBboxes(stderr: string, frameWidth: number, frameHeight: number): string[][] {
  type Record = {
    kind: string; pointer: string; index: string; raw: string[];
    coordinates?: string[]; invalid: boolean;
  };
  const records: Record[] = [];
  const current = new Map<string, Record>();
  const prefix = /\[bbox@(caption|focus)\s+@\s+([^\]\s]+)\][ \t]*/g;
  const coordinates = /^x1:(-?\d+)\s+x2:(-?\d+)\s+y1:(-?\d+)\s+y2:(-?\d+)\s+w:(-?\d+)\s+h:(-?\d+)(?=\s|$)/;
  const normalBody = /^n:\d+\s+pts:(?:-?\d+|NOPTS)\s+pts_time:(?:-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|NOPTS)\s+(.+)$/i;

  const assign = (record: Record, body: string) => {
    const match = coordinates.exec(body);
    if (!match) { record.invalid = true; return; }
    // A second anonymous tuple on the same line has no trustworthy frame identity.
    if (/\b(?:n|x1|x2|y1|y2|w|h):/.test(body.slice(match[0].length))) {
      record.invalid = true;
      return;
    }
    const values = match.slice(1);
    const [x1, x2, y1, y2, width, height] = values.map(Number);
    if (!values.every((value) => Number.isSafeInteger(Number(value)))) {
      record.invalid = true;
      return;
    }
    // Negative/zero extents represent no usable box, never a preceding frame's box.
    // Preserve them for duplicate comparison; boxFor already rejects non-positive sizes.
    if (width > 0 && height > 0 &&
        (x1 < 0 || y1 < 0 || x2 >= frameWidth || y2 >= frameHeight ||
          x2 - x1 + 1 !== width || y2 - y1 + 1 !== height)) {
      record.invalid = true;
      return;
    }
    if (record.coordinates && record.coordinates.join(':') !== values.join(':')) {
      record.invalid = true;
    } else {
      record.coordinates = values;
    }
  };

  for (const line of stderr.split(/\r\n|\r|\n/)) {
    const prefixes = [...line.matchAll(prefix)];
    // Do not attribute an unprefixed continuation to whichever frame was latest.
    // Break pending associations; completed explicit records remain independently valid.
    const leading = line.slice(0, prefixes[0]?.index ?? line.length).trim();
    if (/^(?:x1:|n:\d+(?=\s|$))/.test(leading)) {
      for (const record of current.values()) {
        if (!record.coordinates) record.invalid = true;
      }
      current.clear(); // Already poisoned; avoid rescanning on repeated anonymous lines.
    }
    for (let i = 0; i < prefixes.length; i += 1) {
      const match = prefixes[i];
      const kind = match[1].toLowerCase();
      const pointer = match[2]; // Opaque context token: Linux 0x... and Windows hex both work.
      // Stop at any other FFmpeg context prefix, not merely another bbox prefix.
      const body = line.slice(match.index! + match[0].length,
        prefixes[i + 1]?.index ?? line.length).split(/\[[^\]\r\n]+\s+@\s+[^\]\s]+\]/)[0].trim();
      const context = `${kind}:${pointer}`;
      const header = /^n:(\d+)(?=\s|$)/.exec(body);
      if (header) {
        const record: Record = {
          kind, pointer, index: String(Number(header[1])), raw: [match[0] + body],
          invalid: !Number.isSafeInteger(Number(header[1])),
        };
        records.push(record);
        current.set(context, record); // No coordinates carried across any frame header.
        const normal = normalBody.exec(body);
        if (normal && /^x1:/.test(normal[1])) assign(record, normal[1]);
      } else if (/^x1:/.test(body)) {
        const record = current.get(context);
        if (record) {
          record.raw.push(match[0] + body);
          assign(record, body);
        }
        // A continuation without a matching header is ignored, not borrowed.
      } else {
        // Unknown output from the same context invalidates the pending association.
        const record = current.get(context);
        if (record) record.invalid = true;
      }
    }
  }

  const byFrame = new Map<string, Record[]>();
  for (const record of records) {
    const key = `${record.kind}:${record.index}`;
    const group = byFrame.get(key) ?? [];
    group.push(record);
    byFrame.set(key, group);
  }
  const result: string[][] = [];
  for (const group of byFrame.values()) {
    const first = group[0];
    // Do not let Array.find select an arbitrary first answer after a conflict.
    if (group.some((record) => record.invalid || !record.coordinates ||
      record.pointer !== first.pointer ||
      record.coordinates.join(':') !== first.coordinates?.join(':'))) continue;
    result.push([first.raw.join('\n'), first.kind, first.index, ...first.coordinates!]);
  }
  return result;
}
