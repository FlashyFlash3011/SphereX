// Talks to the SphereX server. Every reply is checked; errors become plain messages.

async function call(url, options) {
  let resp;
  try {
    resp = await fetch(url, options);
  } catch {
    throw new Error("Can't reach the SphereX server. Check your connection and try again.");
  }
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).detail; } catch { /* not JSON */ }
    throw new Error(typeof detail === "string" && detail ? detail : "The server couldn't do that. Try again.");
  }
  return resp;
}

export async function resolve(text) {
  return (await call(`/api/resolve?name=${encodeURIComponent(text)}`)).json();
}

export async function startStack(ra, dec, size) {
  const q = new URLSearchParams({ ra: String(ra), dec: String(dec), size: String(size) });
  return (await call(`/api/stacks?${q}`, { method: "POST" })).json();
}

export async function stackStatus(id, after) {
  return (await call(`/api/stacks/${id}/status?after=${after}`)).json();
}

// Pixels for the given frame numbers, as one Uint16Array (float16 values) per frame.
export async function framePixels(id, indices, n) {
  const out = [];
  for (let k = 0; k < indices.length; k += 48) {
    const part = indices.slice(k, k + 48);
    const buf = await (await call(`/api/stacks/${id}/frames?i=${part.join(",")}`)).arrayBuffer();
    if (buf.byteLength !== part.length * n * n * 2) throw new Error("The server sent an incomplete image. Search again.");
    for (let j = 0; j < part.length; j++) out.push(new Uint16Array(buf, j * n * n * 2, n * n));
  }
  return out;
}
