// Creased vertex normals for an indexed triangle mesh, rebuilt in the browser so the download can carry
// positions and indices only (normals would cost ~3.5x more, measured in the preflight).
//
// For every corner of every face, the normal is the angle-weighted average of the faces around that vertex
// whose normal lies within `creaseAngle` of the corner's own face. Corners of one vertex that end up with the
// same normal share an output vertex; the rest split. Linear in the mesh size: each vertex only compares the
// faces around it.

export interface CreasedMesh {
  position: Float32Array;
  normal: Float32Array;
  index: Uint32Array;
}

export function creaseNormals(position: Float32Array, index: Uint32Array | Uint16Array, creaseAngle: number): CreasedMesh {
  const nV = position.length / 3;
  const nF = index.length / 3;
  const cosCrease = Math.cos(creaseAngle);

  // Face unit normals and per-corner angles.
  const fn = new Float32Array(nF * 3);
  const angle = new Float32Array(nF * 3);
  for (let f = 0; f < nF; f++) {
    const a = index[3 * f] * 3, b = index[3 * f + 1] * 3, c = index[3 * f + 2] * 3;
    const abx = position[b] - position[a], aby = position[b + 1] - position[a + 1], abz = position[b + 2] - position[a + 2];
    const acx = position[c] - position[a], acy = position[c + 1] - position[a + 1], acz = position[c + 2] - position[a + 2];
    const bcx = position[c] - position[b], bcy = position[c + 1] - position[b + 1], bcz = position[c + 2] - position[b + 2];
    let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) { nx /= l; ny /= l; nz /= l; }
    fn[3 * f] = nx; fn[3 * f + 1] = ny; fn[3 * f + 2] = nz;
    const lab = Math.hypot(abx, aby, abz), lac = Math.hypot(acx, acy, acz), lbc = Math.hypot(bcx, bcy, bcz);
    const cosA = lab > 0 && lac > 0 ? (abx * acx + aby * acy + abz * acz) / (lab * lac) : 1;
    const cosB = lab > 0 && lbc > 0 ? (-abx * bcx - aby * bcy - abz * bcz) / (lab * lbc) : 1;
    const A = Math.acos(Math.max(-1, Math.min(1, cosA)));
    const B = Math.acos(Math.max(-1, Math.min(1, cosB)));
    angle[3 * f] = A; angle[3 * f + 1] = B; angle[3 * f + 2] = Math.max(0, Math.PI - A - B);
  }

  // Vertex -> corners (CSR).
  const start = new Uint32Array(nV + 1);
  for (let c = 0; c < index.length; c++) start[index[c] + 1]++;
  for (let v = 0; v < nV; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nV);
  const corners = new Uint32Array(index.length);
  for (let c = 0; c < index.length; c++) corners[fill[index[c]]++] = c;

  // Output buffers sized for the worst case (every corner its own vertex); trimmed at the end.
  const outPos = new Float32Array(index.length * 3);
  const outNrm = new Float32Array(index.length * 3);
  const outIdx = new Uint32Array(index.length);
  let nOut = 0;

  for (let v = 0; v < nV; v++) {
    const s = start[v], e = start[v + 1];
    const first = nOut;
    for (let i = s; i < e; i++) {
      const c = corners[i];
      const f = (c / 3) | 0;
      let sx = 0, sy = 0, sz = 0;
      for (let k = s; k < e; k++) {
        const c2 = corners[k];
        const f2 = (c2 / 3) | 0;
        if (fn[3 * f] * fn[3 * f2] + fn[3 * f + 1] * fn[3 * f2 + 1] + fn[3 * f + 2] * fn[3 * f2 + 2] < cosCrease) continue;
        const w = angle[c2];
        sx += fn[3 * f2] * w; sy += fn[3 * f2 + 1] * w; sz += fn[3 * f2 + 2] * w;
      }
      const l = Math.hypot(sx, sy, sz);
      if (l > 0) { sx /= l; sy /= l; sz /= l; } else { sx = fn[3 * f]; sy = fn[3 * f + 1]; sz = fn[3 * f + 2]; }
      // Reuse an output vertex of this same source vertex with (nearly) the same normal.
      let o = -1;
      for (let k = first; k < nOut; k++) {
        if (outNrm[3 * k] * sx + outNrm[3 * k + 1] * sy + outNrm[3 * k + 2] * sz > 0.9999) { o = k; break; }
      }
      if (o < 0) {
        o = nOut++;
        outPos[3 * o] = position[3 * v]; outPos[3 * o + 1] = position[3 * v + 1]; outPos[3 * o + 2] = position[3 * v + 2];
        outNrm[3 * o] = sx; outNrm[3 * o + 1] = sy; outNrm[3 * o + 2] = sz;
      }
      outIdx[c] = o;
    }
  }
  return { position: outPos.slice(0, nOut * 3), normal: outNrm.slice(0, nOut * 3), index: outIdx };
}
