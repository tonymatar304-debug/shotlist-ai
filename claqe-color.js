/* CLAQE colour handling for phone footage: reads a clip's video-stream metadata (ffprobe JSON) and decides whether its
 * picture is HDR (HLG / PQ) and needs tone mapping to SDR BT.709, or is SDR and must pass through untouched.
 * Pure functions, no DOM: unit-tested in tests/claqe-color.test.js. Not AI. */
(function (root) {
  "use strict";
  const HDR_TRC = { "arib-std-b67": "hlg", "smpte2084": "pq" };
  const num = (v) => (v === undefined || v === null || v === "" || isNaN(+v) ? null : +v);
  const rate = (r) => { const m = /^(\d+)\/(\d+)$/.exec(r || ""); return m && +m[2] ? +m[1] / +m[2] : null; };

  // ffprobe -show_streams -show_entries ... -of json  ->  { streams:[...] }  ->  summary of the first video stream.
  function describe(json) {
    const s = (json && json.streams || []).find((x) => x.codec_type === "video" || x.width) || null;
    if (!s) return null;
    const side = s.side_data_list || [], find = (re) => side.find((d) => re.test(d.side_data_type || "")) || null;
    const dm = find(/display matrix/i), dovi = find(/dovi|dolby/i), mdm = find(/mastering display/i), cll = find(/content light/i);
    const rot = num(dm && dm.rotation) ?? num(s.tags && s.tags.rotate) ?? 0;
    const pix = s.pix_fmt || "", depth = num(s.bits_per_raw_sample) || (/p10|p12|p16/.test(pix) ? +(/p(1[026])/.exec(pix) || [0, 8])[1] : 8);
    const transfer = s.color_transfer || "unknown", primaries = s.color_primaries || "unknown";
    let hdr = HDR_TRC[transfer] || null;
    const dv = dovi ? { profile: num(dovi.dv_profile), compat: num(dovi.dv_bl_signal_compatibility_id) } : null;
    // Dolby Vision profile 5 has no HDR10/HLG/SDR-compatible base layer (IPT-PQ-c2): no correct conversion without DV processing.
    const unsupported = dv && dv.profile === 5 ? "Dolby Vision profile 5" : null;
    const r = rate(s.r_frame_rate), a = rate(s.avg_frame_rate);
    return {
      codec: s.codec_name || null, profile: s.profile || null, pixFmt: pix || null, bitDepth: depth,
      width: num(s.width), height: num(s.height),
      rotation: ((Math.round(rot / 90) * 90) % 360 + 360) % 360, // degrees, normalised to 0/90/180/270
      primaries, transfer, matrix: s.color_space || "unknown", range: s.color_range || "unknown",
      hdr, dolbyVision: dv, unsupported,
      mastering: mdm ? { maxLuminance: lum(mdm.max_luminance), minLuminance: lum(mdm.min_luminance) } : null,
      contentLight: cll ? { maxCLL: num(cll.max_content), maxFALL: num(cll.max_average) } : null,
      // r_frame_rate is the stream's base rate; a clearly different average means variable frame rate.
      frameRate: a || r, vfr: !!(r && a && Math.abs(r - a) / r > 0.02),
    };
  }
  const lum = (v) => { const m = /^(\d+)\/(\d+)$/.exec(String(v || "")); return m && +m[2] ? +m[1] / +m[2] : num(v); };

  // Tone-mapping filter for a described clip, inserted after the clip is scaled to output size (cheap: small frames).
  // "" for SDR (never touched). HLG and PQ go through zimg to linear light, BT.709 primaries, a highlight roll-off, and
  // back to BT.709. npl = the luminance treated as SDR white (BT.2408 reference white, 203 nits).
  const TONEMAP = { op: "mobius", param: 0.5, desat: 0, npl: 203 };
  function toneMapFilter(info, opts) {
    if (!needsToneMap(info)) return "";
    const o = Object.assign({}, TONEMAP, opts), trc = info.hdr === "hlg" ? "arib-std-b67" : "smpte2084";
    const pin = info.primaries === "unknown" ? "bt2020" : info.primaries, min = info.matrix === "unknown" ? "bt2020nc" : info.matrix;
    return "zscale=tin=" + trc + ":pin=" + pin + ":min=" + min + ":rin=" + (info.range === "pc" ? "full" : "limited") + ":t=linear:npl=" + o.npl +
      ",format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=" + o.op + (o.param === null ? "" : ":param=" + o.param) + ":desat=" + o.desat +
      ",zscale=t=bt709:m=bt709:r=limited,format=yuv420p";
  }

  // Fast path: the same conversion baked once per job into a Hald CLUT (64 points per axis, 16-bit PNG), then applied to every
  // frame as a 3D lookup with tetrahedral interpolation (~10x cheaper than the float zimg chain).
  // clutCommand -> FFmpeg args that write the CLUT for this clip's transfer; clutFilter -> per-frame graph fragment.
  function clutCommand(info, out, opts) {
    const o = Object.assign({}, TONEMAP, opts), trc = info.hdr === "hlg" ? "arib-std-b67" : "smpte2084", pin = info.primaries === "unknown" ? "bt2020" : info.primaries;
    // The identity CLUT must be tagged (zimg aborts the WASM module on an untagged RGB frame).
    return ["-y", "-f", "lavfi", "-i", "haldclutsrc=level=8", "-frames:v", "1", "-vf",
      "setparams=range=pc:color_primaries=" + pin + ":color_trc=" + trc + ":colorspace=gbr,format=gbrpf32le,zscale=t=linear:npl=" + o.npl +
      ",zscale=p=bt709,tonemap=tonemap=" + o.op + (o.param === null ? "" : ":param=" + o.param) + ":desat=" + o.desat +
      ",zscale=t=bt709,format=rgb48be", "-update", "1", "-c:v", "png", out];
  }
  // One CLUT per transfer + primaries (several clips can share it).
  const clutKey = (info) => (needsToneMap(info) ? info.hdr + "_" + (info.primaries === "unknown" ? "bt2020" : info.primaries) : null);
  const needsToneMap = (info) => !!(info && info.hdr && !info.unsupported);
  const rgbIn = (info) => ":in_color_matrix=bt2020:in_range=" + (info.range === "pc" ? "pc" : "tv") + ":out_range=pc";
  // Pieces of a shot's picture chain: `scale` is appended to the shot's resize (which then also converts to full-range RGB),
  // `after` goes right after its crop/setsar. With a CLUT input label the fast lookup is used, otherwise the direct chain.
  // SDR (or unknown) footage: both empty, the picture is never touched.
  function shotTone(info, label, clutLabel) {
    if (!needsToneMap(info)) return { scale: "", after: "" };
    if (!clutLabel) return { scale: "", after: "," + toneMapFilter(info) };
    return { scale: rgbIn(info), after: ",format=rgb48le[" + label + "];[" + label + "][" + clutLabel + "]haldclut=interp=tetrahedral," +
      "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p" };
  }
  // [in] (decoded HDR frames, any size) + [clut] -> [out] SDR BT.709 yuv420p (benchmarks)
  function clutFilter(info, inLabel, clutLabel, outLabel) {
    return "[" + inLabel + "]scale=" + rgbIn(info).slice(1) + ",format=rgb48le[" + inLabel + "_rgb];" +
      "[" + inLabel + "_rgb][" + clutLabel + "]haldclut=interp=tetrahedral,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[" + outLabel + "]";
  }

  const api = { describe, needsToneMap, toneMapFilter, clutKey, clutCommand, shotTone, clutFilter, TONEMAP };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ClaqeColor = api;
})(typeof self !== "undefined" ? self : this);
