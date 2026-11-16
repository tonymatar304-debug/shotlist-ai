// HDR/SDR detection from ffprobe JSON, and the tone-mapping filter decisions (SDR must never be tone mapped).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const C = require("../claqe-color.js");

// Shapes as FFmpeg 5.1 ffprobe prints them (-show_streams -show_entries stream_side_data_list -of json).
const iphoneDV = { streams: [{ codec_name: "hevc", codec_type: "video", profile: "Main 10", width: 1920, height: 1080, pix_fmt: "yuv420p10le",
  color_range: "tv", color_space: "bt2020nc", color_transfer: "arib-std-b67", color_primaries: "bt2020", r_frame_rate: "30/1", avg_frame_rate: "30/1",
  side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 8, dv_level: 5, dv_bl_signal_compatibility_id: 4 },
    { side_data_type: "Display Matrix", displaymatrix: "...", rotation: -90 }] }] };
const androidHDR10 = { streams: [{ codec_name: "hevc", codec_type: "video", width: 3840, height: 2160, pix_fmt: "yuv420p10le", color_range: "tv",
  color_space: "bt2020nc", color_transfer: "smpte2084", color_primaries: "bt2020", r_frame_rate: "30/1", avg_frame_rate: "30/1",
  side_data_list: [{ side_data_type: "Mastering display metadata", max_luminance: "10000000/10000", min_luminance: "50/10000" },
    { side_data_type: "Content light level metadata", max_content: 1000, max_average: 400 }] }] };
const sdr = (extra = {}) => ({ streams: [{ codec_name: "h264", codec_type: "video", width: 1920, height: 1080, pix_fmt: "yuv420p", r_frame_rate: "30/1", avg_frame_rate: "30/1", ...extra }] });

test("iPhone Dolby Vision 8.4 (HLG base layer), portrait: HLG, rotation, DV recorded, tone mapped", () => {
  const d = C.describe(iphoneDV);
  assert.equal(d.hdr, "hlg"); assert.equal(d.bitDepth, 10); assert.equal(d.rotation, 270);
  assert.deepEqual(d.dolbyVision, { profile: 8, compat: 4 }); assert.equal(d.unsupported, null);
  assert.ok(C.needsToneMap(d)); assert.equal(C.clutKey(d), "hlg_bt2020");
  assert.match(C.toneMapFilter(d), /^zscale=tin=arib-std-b67:pin=bt2020:min=bt2020nc:rin=limited:t=linear:npl=203,.*tonemap=tonemap=mobius:param=0.5:desat=0,.*format=yuv420p$/);
});

test("Android HDR10 (PQ) with mastering display + content light metadata", () => {
  const d = C.describe(androidHDR10);
  assert.equal(d.hdr, "pq"); assert.deepEqual(d.mastering, { maxLuminance: 1000, minLuminance: 0.005 }); assert.deepEqual(d.contentLight, { maxCLL: 1000, maxFALL: 400 });
  assert.match(C.clutCommand(d, "c.png").join(" "), /haldclutsrc=level=8 .*color_trc=smpte2084.*tonemap=tonemap=mobius.* c\.png$/);
});

test("SDR is never tone mapped: untagged, BT.709, 10-bit BT.709, wide-gamut SDR (BT.2020 primaries, SDR transfer), unknown", () => {
  for (const s of [sdr(), sdr({ color_transfer: "bt709", color_primaries: "bt709", color_space: "bt709" }),
    sdr({ pix_fmt: "yuv420p10le", color_transfer: "bt709", color_primaries: "bt709" }),
    sdr({ pix_fmt: "yuv420p10le", color_transfer: "bt2020-10", color_primaries: "bt2020", color_space: "bt2020nc" }),
    sdr({ color_transfer: "unknown" })]) {
    const d = C.describe(s);
    assert.equal(d.hdr, null); assert.equal(C.needsToneMap(d), false); assert.equal(C.clutKey(d), null);
    assert.equal(C.toneMapFilter(d), ""); assert.deepEqual(C.shotTone(d, "h0", "1:v"), { scale: "", after: "" });
  }
  assert.equal(C.describe(sdr({ pix_fmt: "yuv420p10le" })).bitDepth, 10);
});

test("unreadable metadata and Dolby Vision profile 5 are left alone (no wrong conversion)", () => {
  for (const j of [null, {}, { streams: [] }]) { assert.equal(C.describe(j), null); assert.equal(C.toneMapFilter(C.describe(j)), ""); }
  assert.deepEqual(C.shotTone(null, "h0", "1:v"), { scale: "", after: "" });
  const dv5 = C.describe({ streams: [{ ...iphoneDV.streams[0], color_transfer: "smpte2084", side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 5, dv_bl_signal_compatibility_id: 0 }] }] });
  assert.equal(dv5.unsupported, "Dolby Vision profile 5"); assert.equal(C.needsToneMap(dv5), false); assert.equal(C.clutKey(dv5), null);
});

test("rotation (display matrix or legacy tag) and variable frame rate", () => {
  assert.equal(C.describe(sdr({ tags: { rotate: "90" } })).rotation, 90);
  assert.equal(C.describe(sdr({ side_data_list: [{ side_data_type: "Display Matrix", rotation: 180 }] })).rotation, 180);
  assert.equal(C.describe(sdr()).rotation, 0);
  const v = C.describe(sdr({ r_frame_rate: "30/1", avg_frame_rate: "2700/97" })); assert.equal(v.vfr, true); assert.ok(Math.abs(v.frameRate - 27.84) < 0.01);
  assert.equal(C.describe(sdr({ r_frame_rate: "30000/1001", avg_frame_rate: "30000/1001" })).vfr, false);
});

test("shot pieces: CLUT path converts to RGB in the resize and looks up; without a CLUT the direct chain is used", () => {
  const d = C.describe(iphoneDV), fast = C.shotTone(d, "h2", "1:v"), slow = C.shotTone(d, "h2", null);
  assert.equal(fast.scale, ":in_color_matrix=bt2020:in_range=tv:out_range=pc");
  assert.equal(fast.after, ",format=rgb48le[h2];[h2][1:v]haldclut=interp=tetrahedral,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p");
  assert.deepEqual(slow, { scale: "", after: "," + C.toneMapFilter(d) });
});
