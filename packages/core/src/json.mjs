// JSON.parse collapses duplicate object keys before a caller can inspect them.
// Scan only text JSON.parse has already accepted, so this helper needs to find
// string keys and object boundaries rather than implement another JSON parser.
export function repeatedJsonObjectKey(raw, { topLevelOnly = false } = {}) {
  const containers = [];

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "{") containers.push({ type: "object", seen: new Set() });
    else if (character === "[") containers.push({ type: "array" });
    else if (character === "}" || character === "]") containers.pop();
    else if (character === '"') {
      const start = index;
      index += 1;
      while (index < raw.length && raw[index] !== '"') index += raw[index] === "\\" ? 2 : 1;
      const container = containers.at(-1);
      if (container?.type !== "object" || (topLevelOnly && containers.length !== 1)) continue;

      let after = index + 1;
      while (/\s/.test(raw[after] || "")) after += 1;
      if (raw[after] !== ":") continue;

      const key = JSON.parse(raw.slice(start, index + 1));
      if (container.seen.has(key)) return key;
      container.seen.add(key);
    }
  }

  return null;
}
