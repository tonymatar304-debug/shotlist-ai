// Reference test chart for HDR/SDR phone-footage tests, computed from the standards (not from FFmpeg):
// BT.709 OETF, BT.2087 (709 -> 2020 primaries), BT.2100 HLG and PQ, BT.2408 (SDR reference white = HLG 75 % / PQ 203 nits).
// 3 rows x 8 patches: grey ramp (SDR), colours incl. two skin tones (ColorChecker sRGB values as BT.709 code values),
// highlights above SDR white. Each patch's "sdr" field is the expected BT.709 code value (0..1) of a correct conversion;
// highlights have none (they must roll off towards white without clipping hue).
export const W = 640, H = 360, COLS = 8, ROWS = 3, PW = W / COLS, PH = H / ROWS;

const inv709 = (v) => (v < 0.081 ? v / 4.5 : ((v + 0.099) / 1.099) ** (1 / 0.45));
const M709to2020 = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]];
const mul = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const A = 0.17883277, B = 1 - 4 * A, C = 0.5 - A * Math.log(4 * A);
export const hlgOetf = (e) => (e <= 1 / 12 ? Math.sqrt(3 * Math.max(0, e)) : A * Math.log(12 * e - B) + C);
const hlgInv = (v) => (v <= 0.5 ? (v * v) / 3 : (Math.exp((v - C) / A) + B) / 12);
const SCALE = hlgInv(0.75); // scene-light gain: SDR 100 % -> HLG 75 %
export const pqOetf = (nits) => { const y = Math.max(0, nits) / 10000, m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  const p = y ** m1; return ((c1 + c2 * p) / (1 + c3 * p)) ** m2; };

const rgb = (r, g, b) => [r / 255, g / 255, b / 255];
export const PATCHES = [
  ...[0.06, 0.18, 0.3, 0.42, 0.54, 0.66, 0.8, 1.0].map((v) => ({ name: "grey " + v, sdr: [v, v, v] })),
  { name: "dark skin", sdr: rgb(115, 82, 68), skin: true }, { name: "light skin", sdr: rgb(194, 150, 130), skin: true },
  { name: "blue sky", sdr: rgb(98, 122, 157) }, { name: "foliage", sdr: rgb(87, 108, 67) }, { name: "red", sdr: rgb(175, 54, 60) },
  { name: "green", sdr: rgb(70, 148, 73) }, { name: "blue", sdr: rgb(56, 61, 150) }, { name: "yellow", sdr: rgb(231, 199, 31) },
  // Highlights: scene light 1x .. 4x SDR white (neutral), a warm sunset highlight and a bright sky.
  ...[1, 1.5, 2, 2.75, 3.77].map((k) => ({ name: "highlight x" + k, hi: [k, k, k] })),
  { name: "sunset highlight", hi: [3.2, 1.9, 0.8] }, { name: "bright sky", hi: [1.1, 1.5, 2.2] }, { name: "flash white", hi: [3.77, 3.77, 3.77] },
];

// Linear BT.2020 scene light per patch, relative to SDR white = 1.
const sceneLinear2020 = (p) => (p.hi ? mul(M709to2020, p.hi) : mul(M709to2020, p.sdr.map(inv709)));
// Non-linear BT.2020 R'G'B' for a transfer: "hlg" | "pq" | "sdr709" (plain BT.709 SDR in BT.709 primaries).
export function signal(p, transfer) {
  if (transfer === "sdr709") return (p.sdr || [1, 1, 1]).slice();
  // HLG: scene light, SDR white -> HLG 75 %. PQ: display light (BT.1886, gamma 2.4) with SDR white at 203 nits (BT.2408);
  // highlights are multiples of SDR white in the same light (x3.77 ~ 765 nits).
  if (transfer === "hlg") return sceneLinear2020(p).map((x) => hlgOetf(Math.min(1, x * SCALE)));
  return mul(M709to2020, p.hi || p.sdr.map((v) => v ** 2.4)).map((x) => pqOetf(x * 203));
}
// R'G'B' -> 10-bit limited-range Y'CbCr (BT.2020 NCL or BT.709 matrix).
export function ycc10(rgbN, matrix) {
  const [kr, kb] = matrix === "bt709" ? [0.2126, 0.0722] : [0.2627, 0.0593], [r, g, b] = rgbN, y = kr * r + (1 - kr - kb) * g + kb * b;
  return [64 + 876 * y, 512 + 896 * ((b - y) / (2 * (1 - kb))), 512 + 896 * ((r - y) / (2 * (1 - kr)))].map((v) => Math.round(Math.min(1023, Math.max(0, v))));
}
// One raw yuv444p10le frame of the chart. flash=true -> whole frame "flash white" (A/V sync marker).
// A small orientation marker (pure red 24x24) sits in the top-left corner.
export function frame(transfer, matrix, flash = false) {
  const planes = [0, 1, 2].map(() => new Uint16Array(W * H));
  const val = PATCHES.map((p) => ycc10(signal(flash ? PATCHES.find((q) => q.name === "flash white") : p, transfer), matrix));
  const red = ycc10(signal({ sdr: [1, 0, 0] }, transfer), matrix);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = !flash && x < 24 && y < 24 ? red : val[Math.floor(y / PH) * COLS + Math.floor(x / PW)];
    for (let c = 0; c < 3; c++) planes[c][y * W + x] = v[c];
  }
  return Buffer.concat(planes.map((p) => Buffer.from(p.buffer)));
}
// Display-referred BT.709 R'G'B' (0..1) -> CIELAB (D65), for Delta E 2000.
export function lab(rgbN) {
  const l = rgbN.map((v) => Math.max(0, Math.min(1, v)) ** 2.4); // BT.1886 display
  const X = 0.4124 * l[0] + 0.3576 * l[1] + 0.1805 * l[2], Y = 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2], Z = 0.0193 * l[0] + 0.1192 * l[1] + 0.9505 * l[2];
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116), fx = f(X / 0.95047), fy = f(Y), fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function dE2000([L1, a1, b1], [L2, a2, b2]) {
  const d = Math.PI / 180, C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2, G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G), C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (b, a) => { const t = Math.atan2(b, a) / d; return t < 0 ? t + 360 : t; }, h1 = h(b1, a1p), h2 = h(b2, a2p);
  let dh = h2 - h1; if (C1p * C2p === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dL = L2 - L1, dC = C2p - C1p, dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * d), Lm = (L1 + L2) / 2, Cmp = (C1p + C2p) / 2;
  let hm = h1 + h2; if (C1p * C2p !== 0) hm = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2;
  const T = 1 - 0.17 * Math.cos((hm - 30) * d) + 0.24 * Math.cos(2 * hm * d) + 0.32 * Math.cos((3 * hm + 6) * d) - 0.2 * Math.cos((4 * hm - 63) * d);
  const SL = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2), SC = 1 + 0.045 * Cmp, SH = 1 + 0.015 * Cmp * T;
  const RT = -2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * d);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}
