// Owns everything viewer.js's WebGL2 code used to do: GL context + shader
// setup, layer-batched vertex buffers, camera (pan/zoom) state, input
// handling, .lyp color parsing, and scale-bar text/width. JS never touches
// per-polygon data directly.
//
// parseGdsToLayers() (parse + flatten + triangulate, no GL/DOM) runs inside
// a Worker instantiated from this same module (see wasm-worker.js) so large
// files don't block the main thread; its result crosses back over
// postMessage and uploadLayers() (GL upload only) applies it on the main
// thread, which owns the canvas. loadAndRenderGds() still does both in one
// synchronous call for callers that don't need a Worker.
//
// GDS bytes still arrive via MEMFS (see bindings.cpp's parseGds, which is
// kept around for non-graphical testing of the parse path in isolation).

#include <GLES3/gl3.h>

#include <emscripten/bind.h>
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>
#include <emscripten/val.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <unordered_map>
#include <vector>

#include <gdstk/gdstk.hpp>

#include "gds_common.hpp"

using namespace emscripten;
using namespace gdstk;

namespace {

// The three a_instance* attributes carry a per-instance 2x3 affine (2x2
// linear part split into two columns + a translation) mapping an instanced
// batch's unit-shape local coordinates to world space (see InstancedBatch /
// draw_frame). Their array pointers are only enabled for instanced draws; for
// every other (static) draw the arrays stay disabled and each attribute reads
// its context-level "generic" value instead, which init_gl sets to the
// identity map (col0=(1,0), col1=(0,1), translate=(0,0)) so a_position passes
// through unchanged -- no separate non-instanced shader needed.
const char* kVertexShaderSrc =
    "#version 300 es\n"
    "in vec2 a_position;\n"
    "in vec2 a_iCol0;\n"
    "in vec2 a_iCol1;\n"
    "in vec2 a_iTranslate;\n"
    "uniform vec2 u_resolution;\n"
    "uniform vec2 u_offset;\n"
    "uniform float u_zoom;\n"
    "void main() {\n"
    "    vec2 worldPos = vec2(\n"
    "        a_iCol0.x * a_position.x + a_iCol1.x * a_position.y + a_iTranslate.x,\n"
    "        a_iCol0.y * a_position.x + a_iCol1.y * a_position.y + a_iTranslate.y);\n"
    "    vec2 centeredPos = worldPos - u_offset;\n"
    "    vec2 zoomedPos = centeredPos * u_zoom;\n"
    "    vec2 clipSpace = (zoomedPos / u_resolution) * 2.0;\n"
    "    gl_Position = vec4(clipSpace.x, clipSpace.y, 0.0, 1.0);\n"
    "}";

// Fill polygons are stippled rather than solid-filled so that overlapping
// layers (and whatever is drawn underneath them) stay visible through the
// gaps -- a flat semi-transparent fill makes stacked layers blur into mud
// once you have more than two or three on screen. Several pattern *kinds*
// (not just one hatch angle) exist because two adjacent layers both doing
// 45-degree lines are still hard to tell apart at a glance; KLayout's .lyp
// stipple patterns solve the same problem the same way. Patterns are
// computed in screen space (gl_FragCoord) rather than world space so the
// pitch stays a constant pixel cadence regardless of zoom; world-space
// patterns would turn into solid fill when zoomed in and disappear when
// zoomed out. Outlines (u_useHatch=0) are unaffected.
const char* kFragmentShaderSrc =
    "#version 300 es\n"
    "precision highp float;\n"
    "uniform vec4 u_color;\n"
    "uniform float u_useHatch;\n"
    "uniform float u_patternType;\n"
    "uniform float u_hatchAngle;\n"
    "uniform float u_hatchSpacing;\n"
    "uniform float u_hatchWidth;\n"
    "out vec4 fragColor;\n"
    "float lineMask(float coord, float spacing, float halfWidth) {\n"
    "    float t = mod(coord, spacing);\n"
    "    float d = min(t, spacing - t);\n"
    "    float aa = fwidth(coord) * 0.5 + 0.001;\n"
    "    return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, d);\n"
    "}\n"
    "void main() {\n"
    "    float alpha = u_color.a;\n"
    "    if (u_useHatch > 0.5) {\n"
    "        float c = cos(u_hatchAngle);\n"
    "        float s = sin(u_hatchAngle);\n"
    "        vec2 p = gl_FragCoord.xy;\n"
    "        float u = p.x * c + p.y * s;\n"
    "        float v = -p.x * s + p.y * c;\n"
    "        int patternType = int(u_patternType + 0.5);\n"
    "        float mask;\n"
    "        if (patternType == 0) {\n"
    "            mask = lineMask(u, u_hatchSpacing, u_hatchWidth);\n"
    "        } else if (patternType == 1) {\n"
    "            mask = max(lineMask(u, u_hatchSpacing, u_hatchWidth), lineMask(v, u_hatchSpacing, u_hatchWidth));\n"
    "        } else if (patternType == 2) {\n"
    "            float du = mod(u, u_hatchSpacing) - u_hatchSpacing * 0.5;\n"
    "            float dv = mod(v, u_hatchSpacing) - u_hatchSpacing * 0.5;\n"
    "            float dist = length(vec2(du, dv));\n"
    "            float aa = fwidth(dist) + 0.001;\n"
    "            float dotRadius = u_hatchWidth * 1.7;\n"
    "            mask = 1.0 - smoothstep(dotRadius - aa, dotRadius + aa, dist);\n"
    "        } else {\n"
    "            mask = max(lineMask(p.x, u_hatchSpacing, u_hatchWidth), lineMask(p.y, u_hatchSpacing, u_hatchWidth));\n"
    "        }\n"
    "        alpha = min(u_color.a * 1.4, 0.7) * mask;\n"
    "    }\n"
    "    fragColor = vec4(u_color.rgb, alpha);\n"
    "}";

// Fragment shader for merge mode's coverage pass: every covered fragment
// writes 1 into the R8 mask texture, blending off, so any number of
// overlapping polygons on the layer collapse into plain per-pixel coverage.
// That mask *is* the union of the layer's polygons -- no CPU boolean ops
// anywhere. Pairs with kVertexShaderSrc so static and instanced geometry
// rasterize through the exact same camera/instancing path as normal draws.
const char* kMaskFragmentShaderSrc =
    "#version 300 es\n"
    "precision mediump float;\n"
    "out vec4 fragColor;\n"
    "void main() { fragColor = vec4(1.0); }";

// Fullscreen triangle for merge mode's composite pass, derived from
// gl_VertexID -- no vertex buffer, no attributes. (0,0)/(2,0)/(0,2) in UV
// maps to clip-space (-1,-1)/(3,-1)/(-1,3), covering the screen with one
// triangle.
const char* kCompositeVertexShaderSrc =
    "#version 300 es\n"
    "void main() {\n"
    "    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n"
    "    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n"
    "}";

// Merge mode's composite pass: reads the layer's coverage mask and paints the
// union boundary in the layer's frame color and the interior with the same
// screen-space hatch patterns the normal fill path uses (duplicated from
// kFragmentShaderSrc, with fwidth() replaced by exact analytic derivatives --
// the pattern coords are linear in gl_FragCoord, and derivatives after a
// discard are undefined).
//
// Anti-aliasing comes from two things working together. First, supersampling:
// the mask is u_maskScale (normally 2) times the canvas resolution, so edges
// land between canvas pixels with sub-pixel precision. (Deliberately not MSAA
// -- a multisampled R8 renderbuffer + resolve blit rendered blank on at least
// one real driver; this path only uses the plain texture FBO machinery that
// single-sample mode already proved.) Second, bilinear reconstruction: the
// mask texture is LINEAR-filtered and every read is a texture() tap, so
// coverage varies continuously as the true edge moves -- a texelFetch/min
// over raw binary texels would snap the border back to hard steps no matter
// the supersample factor, which is exactly what the first version of this
// shader got wrong. The border weight ramps with the lowest tap in a 1-canvas-
// pixel ring, frame color composites over fill by that weight, and the final
// alpha scales by the pixel's own coverage so the outer silhouette fades
// smoothly. Uncovered pixels discard, so normal alpha blending stacks merged
// layers the same way unmerged ones stack. CLAMP_TO_EDGE on the sampler keeps
// geometry running past the viewport from growing a false outline at the
// screen border.
const char* kCompositeFragmentShaderSrc =
    "#version 300 es\n"
    "precision highp float;\n"
    "uniform sampler2D u_mask;\n"
    "uniform vec4 u_fillColor;\n"
    "uniform vec4 u_frameColor;\n"
    "uniform float u_patternType;\n"
    "uniform float u_hatchAngle;\n"
    "uniform float u_hatchSpacing;\n"
    "uniform float u_hatchWidth;\n"
    "uniform float u_showFill;\n"
    "uniform int u_maskScale;\n"
    "out vec4 fragColor;\n"
    "float lineMask(float coord, float spacing, float halfWidth, float deriv) {\n"
    "    float t = mod(coord, spacing);\n"
    "    float d = min(t, spacing - t);\n"
    "    float aa = deriv * 0.5 + 0.001;\n"
    "    return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, d);\n"
    "}\n"
    "void main() {\n"
    // uv of this canvas pixel's center in the (canvas * scale)-sized mask;
    // pixelUv is one canvas pixel expressed in uv units.
    "    vec2 texSize = vec2(textureSize(u_mask, 0));\n"
    "    vec2 pixelUv = float(u_maskScale) / texSize;\n"
    "    vec2 uv = gl_FragCoord.xy * pixelUv;\n"
    // Bilinear center tap: at scale 2 the pixel center sits exactly between
    // its 2x2 mask block, so this single tap IS the block average -- the
    // pixel's fractional coverage.
    "    float coverage = texture(u_mask, uv).r;\n"
    "    if (coverage <= 0.0) discard;\n"
    // Border weight: lowest bilinear tap in a 1-canvas-pixel ring. Every tap
    // is itself an interpolated (continuous) value, so the ramp moves
    // smoothly with the true edge instead of snapping at texel boundaries.
    // 1.4 sharpens it so the outline reads as a line rather than a soft glow.
    "    float inner = coverage;\n"
    "    for (int dy = -1; dy <= 1; dy++) {\n"
    "        for (int dx = -1; dx <= 1; dx++) {\n"
    "            if (dx == 0 && dy == 0) continue;\n"
    "            inner = min(inner, texture(u_mask, uv + vec2(dx, dy) * pixelUv).r);\n"
    "        }\n"
    "    }\n"
    "    float border = min(1.0, (1.0 - inner) * 1.4);\n"
    "    float fillAlpha = 0.0;\n"
    "    if (u_showFill > 0.5) {\n"
    "        float c = cos(u_hatchAngle);\n"
    "        float s2 = sin(u_hatchAngle);\n"
    "        vec2 p = gl_FragCoord.xy;\n"
    "        float u = p.x * c + p.y * s2;\n"
    "        float v = -p.x * s2 + p.y * c;\n"
    // d(u)/d(pixel) is exactly (|c|, |s2|); fwidth would sum those, so pass
    // |c|+|s2| (same for v by symmetry) and 1.0 for the axis-aligned grid.
    "        float duv = abs(c) + abs(s2);\n"
    "        int patternType = int(u_patternType + 0.5);\n"
    "        float mask;\n"
    "        if (patternType == 0) {\n"
    "            mask = lineMask(u, u_hatchSpacing, u_hatchWidth, duv);\n"
    "        } else if (patternType == 1) {\n"
    "            mask = max(lineMask(u, u_hatchSpacing, u_hatchWidth, duv), lineMask(v, u_hatchSpacing, u_hatchWidth, duv));\n"
    "        } else if (patternType == 2) {\n"
    "            float du = mod(u, u_hatchSpacing) - u_hatchSpacing * 0.5;\n"
    "            float dv = mod(v, u_hatchSpacing) - u_hatchSpacing * 0.5;\n"
    "            float dist = length(vec2(du, dv));\n"
    "            float aa = 1.0 + 0.001;\n"  // fwidth(dist) <= sqrt(2); 1.0 is close enough
    "            float dotRadius = u_hatchWidth * 1.7;\n"
    "            mask = 1.0 - smoothstep(dotRadius - aa, dotRadius + aa, dist);\n"
    "        } else {\n"
    "            mask = max(lineMask(p.x, u_hatchSpacing, u_hatchWidth, 1.0), lineMask(p.y, u_hatchSpacing, u_hatchWidth, 1.0));\n"
    "        }\n"
    "        fillAlpha = min(u_fillColor.a * 1.4, 0.7) * mask;\n"
    "    }\n"
    // Frame-over-fill compositing by border weight, then the whole result
    // fades by the pixel's own coverage at the outer silhouette.
    "    float frameAlpha = u_frameColor.a * border;\n"
    "    float outAlpha = frameAlpha + fillAlpha * (1.0 - frameAlpha);\n"
    "    float finalAlpha = outAlpha * coverage;\n"
    "    if (finalAlpha < 0.002) discard;\n"
    "    vec3 rgb = (u_frameColor.rgb * frameAlpha + u_fillColor.rgb * fillAlpha * (1.0 - frameAlpha)) / max(outAlpha, 0.0001);\n"
    "    fragColor = vec4(rgb, finalAlpha);\n"
    "}";

struct PolygonRange {
    GLint first;
    GLsizei count;
    // World-space bounding box, used to skip glDrawArrays calls for polygons
    // outside the current viewport (see is_range_visible/draw_frame) --
    // large designs can have millions of off-screen polygons while zoomed
    // in, and issuing a draw call per polygon regardless is the dominant
    // per-frame cost at that point.
    float min_x, max_x, min_y, max_y;
};

// One reused cell's geometry, uploaded once and drawn instance_count times
// via glDraw*Instanced with a per-instance 2x3 affine (see a_iCol0/a_iCol1/
// a_iTranslate in kVertexShaderSrc) -- built from an instance group produced
// by collect_instanced() so that a cell placed 100,000 times (whether as one
// AREF or 100,000 individual SREFs at different positions/rotations) costs
// one unique shape's worth of triangulation/VBO memory instead of 100,000
// copies of it. fill_vbo/outline_vbo/outline_ebo hold the *unit* shape (the
// cell's geometry in its own local frame); instance_vbo holds 6 floats
// (col0.xy, col1.xy, translate.xy) per instance, bound with
// glVertexAttribDivisor so it advances once per instance.
struct InstancedBatch {
    GLuint fill_vbo = 0;
    GLsizei fill_vertex_count = 0;
    GLuint outline_vbo = 0;
    GLuint outline_ebo = 0;
    GLsizei outline_index_count = 0;
    // Shared across every layer touched by the same instance group (a group
    // can span multiple layers, e.g. metal + via) -- deleting the same GL
    // buffer name more than once is a defined no-op per the GL/WebGL2 spec,
    // so clear_layers() doesn't need to track ownership per copy.
    GLuint instance_vbo = 0;
    GLsizei instance_count = 0;
};

constexpr GLsizei kInstanceStrideFloats = 6;  // col0.xy, col1.xy, translate.xy

// One pair of VBOs per layer (fill triangles + outline points) holding all
// of that layer's non-instanced polygons back-to-back, plus per-polygon
// (first, count) ranges so each polygon still draws as its own primitive
// group -- LINE_LOOP loops can't be naively concatenated (the loop-closing
// edge would connect unrelated polygons), and triangle fans from ear-clipping
// are similarly per-polygon. Repeated references on this layer are drawn
// separately via instanced_batches instead of being flattened in here.
struct LayerBuffer {
    uint32_t layer;
    // GDS datatype: layers are keyed on the (layer, datatype) pair, not the
    // layer number alone, since real PDKs put many distinct styles on the same
    // layer number distinguished only by datatype. tag() packs the pair into
    // gdstk's 64-bit Tag, the key used by g_lyp_info and every by-tag bucket.
    uint32_t datatype = 0;
    uint64_t tag() const { return make_tag(layer, datatype); }
    GLuint outline_vbo = 0;
    GLuint fill_vbo = 0;
    // Index buffer over outline_vbo, one GL_LINE_LOOP per polygon joined by
    // restart markers (see kRestartIndex) -- lets draw_frame draw every
    // outline polygon on the layer in a single glDrawElements call when the
    // whole layer is on screen, instead of one glDrawArrays per polygon.
    GLuint outline_ebo = 0;
    GLsizei outline_index_count = 0;
    // Total vertex count in fill_vbo -- triangle lists have no loop-closing
    // constraint, so the whole buffer can be drawn in one glDrawArrays call
    // with no indices needed.
    GLsizei fill_vertex_count = 0;
    // Repeated references on this layer -- see InstancedBatch.
    std::vector<InstancedBatch> instanced_batches;
    // Logical polygon count on this layer, including instanced copies
    // (unit-shape polygon count * instance_count for each batch) -- every
    // layer draws unconditionally in one call each for fill/outline (see
    // draw_frame), so per-polygon geometry doesn't need to stick around at
    // runtime, just this count for the UI/stats readout.
    uint32_t polygon_count = 0;
    std::array<float, 4> fill_color{};
    std::array<float, 4> frame_color{};
    float hatch_angle = 0.0f;
    float pattern_type = 0.0f;  // see kFragmentShaderSrc's patternType branches
    bool visible = true;
    // Union of every polygon's bbox on this layer, so draw_frame can skip
    // the whole layer with one check instead of scanning every polygon when
    // the layer isn't on screen at all.
    float min_x = HUGE_VAL, max_x = -HUGE_VAL, min_y = HUGE_VAL, max_y = -HUGE_VAL;
};

// Index value that marks a primitive-restart boundary in an outline_ebo.
// WebGL2 (like GLES 3.0) always treats the max value of the index type as a
// restart marker for indexed draws -- unlike desktop GL, there's no
// GL_PRIMITIVE_RESTART capability to glEnable and no way to disable it, so
// no setup call is needed beyond using this value.
constexpr uint32_t kRestartIndex = 0xFFFFFFFFu;

// Parsed out of a single <properties>/<group-members> block in a .lyp file.
// Keyed in g_lyp_info by the (layer, datatype) Tag it applies to. Persists
// across GDS reloads (same as the old g_lyp_colors did) so re-opening/replacing
// the GDS file keeps previously-applied layer styling.
struct LypEntry {
    std::string name;
    // Display name of the enclosing top-level <properties> group in the .lyp
    // (e.g. "Metals", "Waveguide"), or empty for an ungrouped/flat entry. Used
    // only to organize the sidebar into collapsible categories; empty otherwise.
    std::string group;
    std::array<float, 4> fill_color{};
    std::array<float, 4> frame_color{};
    bool has_fill = false;
    bool has_frame = false;
    bool visible = true;
    int order = 0;
};

GLuint g_program = 0;
GLuint g_vao = 0;
GLint g_loc_position = -1;
GLint g_loc_i_col0 = -1;
GLint g_loc_i_col1 = -1;
GLint g_loc_i_translate = -1;
GLint g_loc_resolution = -1;
GLint g_loc_color = -1;
GLint g_loc_offset = -1;
GLint g_loc_zoom = -1;
GLint g_loc_use_hatch = -1;
GLint g_loc_pattern_type = -1;
GLint g_loc_hatch_angle = -1;
GLint g_loc_hatch_spacing = -1;
GLint g_loc_hatch_width = -1;

// Merge mode's GL objects (see draw_layer_merged): the coverage-mask program
// (kVertexShaderSrc + kMaskFragmentShaderSrc, so it needs its own copies of
// the camera uniforms), the composite program, and one screen-sized R8 mask
// texture + FBO reused by every merged layer every frame.
GLuint g_mask_program = 0;
GLint g_mask_loc_resolution = -1;
GLint g_mask_loc_offset = -1;
GLint g_mask_loc_zoom = -1;
GLuint g_comp_program = 0;
GLint g_comp_loc_fill_color = -1;
GLint g_comp_loc_frame_color = -1;
GLint g_comp_loc_pattern_type = -1;
GLint g_comp_loc_hatch_angle = -1;
GLint g_comp_loc_hatch_spacing = -1;
GLint g_comp_loc_hatch_width = -1;
GLint g_comp_loc_show_fill = -1;
GLint g_comp_loc_mask_scale = -1;
GLuint g_mask_fbo = 0;
GLuint g_mask_tex = 0;
// Supersampling factor for the coverage mask (mask texture = canvas size *
// this) -- merge mode's anti-aliasing (see kCompositeFragmentShaderSrc).
// Recomputed per resize: drops to 1 if 2x the canvas would exceed
// GL_MAX_TEXTURE_SIZE (AA off, but never blank).
int g_mask_scale = 2;

// Constant pixel pitch for every layer's pattern -- only the angle and
// pattern kind vary per layer (see pattern_for_layer) so stacked layers
// stay visually distinguishable from each other.
constexpr float kHatchSpacingPx = 10.0f;
constexpr float kHatchHalfWidthPx = 0.25f;
constexpr int kPatternTypeCount = 4;  // diagonal, cross-hatch, dots, grid

std::vector<LayerBuffer> g_layers;
std::unordered_map<uint64_t, LypEntry> g_lyp_info;
int g_lyp_order_counter = 0;

// Total polygon count across all layers (set once in uploadLayers), used as
// the denominator for the "visible polygons" stat draw_frame recomputes
// every frame (see update_render_stats).
uint64_t g_total_polygons = 0;

float g_zoom = 1.0f;
float g_pan_x = 0.0f;
float g_pan_y = 0.0f;
int g_canvas_width = 0;
int g_canvas_height = 0;

// Camera state captured the last time the view was framed to the design
// (see uploadLayers) -- what the "Reset View" button restores.
float g_fit_zoom = 1.0f;
float g_fit_pan_x = 0.0f;
float g_fit_pan_y = 0.0f;

// Design bbox in world space, used to keep pan/zoom from wandering off into
// empty space. min > max (the HUGE_VALF/-HUGE_VALF sentinel pair) means "no
// geometry loaded yet" -- clamp_pan() is a no-op in that case.
float g_bbox_min_x = HUGE_VALF;
float g_bbox_max_x = -HUGE_VALF;
float g_bbox_min_y = HUGE_VALF;
float g_bbox_max_y = -HUGE_VALF;

// Zoom bounds are relative to the fit-to-window zoom rather than absolute,
// so they scale with whatever unit the design happens to be drawn in.
constexpr float kMinZoomRatio = 0.05f;
constexpr float kMaxZoomRatio = 2000.0f;

bool g_dragging = false;
int g_last_mouse_x = 0;
int g_last_mouse_y = 0;

// Ruler ("measure") tool state -- see setMeasureMode/on_mousedown. While the
// mode is active, clicks measure instead of pan: the first click anchors the
// ruler's start point, the line then tracks the cursor (g_measure_pending),
// and a second click freezes it. The measurement is world-space, so it stays
// glued to the geometry across pan/zoom; only the readout label (#measureLabel,
// repositioned every draw_frame) lives in screen space.
bool g_measure_mode = false;
bool g_measure_pending = false;   // first point placed, waiting for the second click
bool g_measure_has_line = false;  // anything to draw at all (pending or finalized)
float g_measure_x0 = 0.0f, g_measure_y0 = 0.0f;
float g_measure_x1 = 0.0f, g_measure_y1 = 0.0f;
GLuint g_measure_vbo = 0;

bool g_frame_requested = false;

// Toggles the hatched polygon fill (the "infill") on/off for every layer at
// once -- see draw_frame and setShowInfill. Outlines are unaffected.
bool g_show_infill = true;

// Merge-overlaps mode: when on, each layer draws as the union of its polygons
// (screen-space coverage mask + composite pass, see draw_layer_merged) so
// edges interior to overlapping/abutting polygons disappear and only the
// layer's true boundary shows. Purely a render-time effect -- the parsed
// geometry is untouched, so toggling never re-parses or re-uploads anything.
bool g_merge_mode = false;

GLuint compile_shader(GLenum type, const char* source) {
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &source, nullptr);
    glCompileShader(shader);
    return shader;
}

// Attribute locations are bound to fixed indices before linking (rather than
// queried after) so every program built from kVertexShaderSrc -- the main
// layer program and merge mode's mask program -- agrees on them: attribute
// enables, pointers, divisors, and the generic identity values set in
// init_gl are all per-index context/VAO state, so agreeing on indices lets
// draw_frame switch programs without redoing any of that setup. Harmless for
// programs that don't declare these names (the composite pass has no
// attributes at all).
constexpr GLuint kAttrPosition = 0;
constexpr GLuint kAttrICol0 = 1;
constexpr GLuint kAttrICol1 = 2;
constexpr GLuint kAttrITranslate = 3;

GLuint link_program(const char* vs_src, const char* fs_src) {
    GLuint program = glCreateProgram();
    glAttachShader(program, compile_shader(GL_VERTEX_SHADER, vs_src));
    glAttachShader(program, compile_shader(GL_FRAGMENT_SHADER, fs_src));
    glBindAttribLocation(program, kAttrPosition, "a_position");
    glBindAttribLocation(program, kAttrICol0, "a_iCol0");
    glBindAttribLocation(program, kAttrICol1, "a_iCol1");
    glBindAttribLocation(program, kAttrITranslate, "a_iTranslate");
    glLinkProgram(program);
    return program;
}

// False in environments with no real WebGL2-capable canvas -- notably plain
// Node, which is how parseGds() (bindings.cpp) is exercised for headless
// parse-path testing (see RENDERING_REWRITE.md's phase-1 verification).
// main() checks this before touching any further GL/DOM state so that
// non-graphical testing still works after this file's GL init runs
// automatically at module load.
bool g_gl_ready = false;

bool init_gl() {
    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx = emscripten_webgl_create_context("#glCanvas", &attrs);
    if (ctx <= 0) return false;
    if (emscripten_webgl_make_context_current(ctx) != EMSCRIPTEN_RESULT_SUCCESS) return false;

    g_program = link_program(kVertexShaderSrc, kFragmentShaderSrc);

    g_loc_position = kAttrPosition;
    g_loc_i_col0 = kAttrICol0;
    g_loc_i_col1 = kAttrICol1;
    g_loc_i_translate = kAttrITranslate;
    g_loc_resolution = glGetUniformLocation(g_program, "u_resolution");
    g_loc_color = glGetUniformLocation(g_program, "u_color");
    g_loc_offset = glGetUniformLocation(g_program, "u_offset");
    g_loc_zoom = glGetUniformLocation(g_program, "u_zoom");
    g_loc_use_hatch = glGetUniformLocation(g_program, "u_useHatch");
    g_loc_pattern_type = glGetUniformLocation(g_program, "u_patternType");
    g_loc_hatch_angle = glGetUniformLocation(g_program, "u_hatchAngle");
    g_loc_hatch_spacing = glGetUniformLocation(g_program, "u_hatchSpacing");
    g_loc_hatch_width = glGetUniformLocation(g_program, "u_hatchWidth");

    glGenVertexArrays(1, &g_vao);
    glBindVertexArray(g_vao);

    // Generic (array-disabled) values for the per-instance affine attributes:
    // the identity map, so static (non-instanced) draws -- which never enable
    // these arrays -- pass a_position straight through (see kVertexShaderSrc).
    // These are context state, not VAO state, so setting them once here holds
    // for every later draw that leaves the arrays disabled.
    if (g_loc_i_col0 >= 0) glVertexAttrib2f(g_loc_i_col0, 1.0f, 0.0f);
    if (g_loc_i_col1 >= 0) glVertexAttrib2f(g_loc_i_col1, 0.0f, 1.0f);
    if (g_loc_i_translate >= 0) glVertexAttrib2f(g_loc_i_translate, 0.0f, 0.0f);

    // Merge mode's two extra programs (see draw_layer_merged). The composite
    // program's sampler is bound to texture unit 0 once here.
    g_mask_program = link_program(kVertexShaderSrc, kMaskFragmentShaderSrc);
    g_mask_loc_resolution = glGetUniformLocation(g_mask_program, "u_resolution");
    g_mask_loc_offset = glGetUniformLocation(g_mask_program, "u_offset");
    g_mask_loc_zoom = glGetUniformLocation(g_mask_program, "u_zoom");

    g_comp_program = link_program(kCompositeVertexShaderSrc, kCompositeFragmentShaderSrc);
    g_comp_loc_fill_color = glGetUniformLocation(g_comp_program, "u_fillColor");
    g_comp_loc_frame_color = glGetUniformLocation(g_comp_program, "u_frameColor");
    g_comp_loc_pattern_type = glGetUniformLocation(g_comp_program, "u_patternType");
    g_comp_loc_hatch_angle = glGetUniformLocation(g_comp_program, "u_hatchAngle");
    g_comp_loc_hatch_spacing = glGetUniformLocation(g_comp_program, "u_hatchSpacing");
    g_comp_loc_hatch_width = glGetUniformLocation(g_comp_program, "u_hatchWidth");
    g_comp_loc_show_fill = glGetUniformLocation(g_comp_program, "u_showFill");
    g_comp_loc_mask_scale = glGetUniformLocation(g_comp_program, "u_maskScale");
    glUseProgram(g_comp_program);
    glUniform1i(glGetUniformLocation(g_comp_program, "u_mask"), 0);

    // The mask texture's storage is (re)allocated at the canvas size in
    // resize_canvas; only the texture object and its FBO attachment are
    // created here.
    // LINEAR, not NEAREST: the composite pass reads the mask with bilinear
    // taps so coverage varies continuously as the true edge moves sub-texel
    // -- the anti-aliasing depends on it (see kCompositeFragmentShaderSrc).
    glGenTextures(1, &g_mask_tex);
    glBindTexture(GL_TEXTURE_2D, g_mask_tex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glGenFramebuffers(1, &g_mask_fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, g_mask_fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g_mask_tex, 0);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);

    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    return true;
}

// Mirrors the old JS per-layer color fallback hash (viewer.js:151-156) for
// layers with no matching .lyp entry.
std::array<float, 4> default_color(uint32_t layer, uint32_t datatype) {
    // Fold datatype into the seed so two datatypes on the same layer number
    // don't collapse to one fallback color. datatype 0 leaves seed == layer,
    // preserving the exact colors this used before datatype support existed.
    uint32_t seed = layer + datatype * 97u;
    float r = (float)((seed * 65) % 200 + 55) / 255.0f;
    float g = (float)((seed * 115) % 200 + 55) / 255.0f;
    float b = (float)((seed * 175) % 200 + 55) / 255.0f;
    return {r, g, b, 0.8f};
}

// Spreads layers across the 4 pattern kinds and 6 hatch angles
// (0/30/60/90/120/150 degrees) so adjacent layer numbers -- which is how
// overlapping layers are usually numbered in real GDS decks -- don't end up
// looking like the same pattern. Angle is ignored by the dot/grid kinds
// (they're already rotation-symmetric-ish), but assigning one anyway keeps
// this a single deterministic function of the layer number.
void pattern_for_layer(uint32_t layer, uint32_t datatype, float& out_pattern_type, float& out_angle) {
    constexpr float kPi = 3.14159265358979323846f;
    // Same datatype-0-preserving seed as default_color, so distinct datatypes
    // on one layer number also get distinguishable hatch patterns.
    uint32_t seed = layer + datatype * 97u;
    out_pattern_type = (float)(seed % kPatternTypeCount);
    uint32_t angle_index = (seed / kPatternTypeCount) % 6;
    out_angle = (float)angle_index * (kPi / 6.0f);
}

// Resolves a layer's fill/frame color + visibility from g_lyp_info (falling
// back to the hash color above for layers with no .lyp entry, or for the
// half of a fill/frame pair that's missing from the entry).
void apply_layer_colors(LayerBuffer& layer) {
    pattern_for_layer(layer.layer, layer.datatype, layer.pattern_type, layer.hatch_angle);
    auto it = g_lyp_info.find(layer.tag());
    if (it == g_lyp_info.end()) {
        std::array<float, 4> base = default_color(layer.layer, layer.datatype);
        layer.fill_color = {base[0], base[1], base[2], 0.4f};
        layer.frame_color = {base[0], base[1], base[2], 0.9f};
        layer.visible = true;
        return;
    }
    const LypEntry& e = it->second;
    std::array<float, 4> base = default_color(layer.layer, layer.datatype);
    if (e.has_fill) {
        layer.fill_color = e.fill_color;
    } else if (e.has_frame) {
        layer.fill_color = {e.frame_color[0], e.frame_color[1], e.frame_color[2], 0.45f};
    } else {
        layer.fill_color = {base[0], base[1], base[2], 0.4f};
    }
    if (e.has_frame) {
        layer.frame_color = e.frame_color;
    } else if (e.has_fill) {
        layer.frame_color = {e.fill_color[0], e.fill_color[1], e.fill_color[2], 0.9f};
    } else {
        layer.frame_color = {base[0], base[1], base[2], 0.9f};
    }
    layer.visible = e.visible;
}

void apply_lyp_to_layers() {
    for (LayerBuffer& layer : g_layers) apply_layer_colors(layer);
}

std::string rgba_to_css(const std::array<float, 4>& c) {
    char buf[64];
    snprintf(buf, sizeof(buf), "rgba(%d,%d,%d,%.3f)", (int)std::lround(c[0] * 255.0f),
             (int)std::lround(c[1] * 255.0f), (int)std::lround(c[2] * 255.0f), c[3]);
    return buf;
}

// Ear-clipping triangulation for filled rendering. GDS polygons are simple
// (non-self-intersecting) by convention -- including the "comb" slits some
// tools use to represent holes -- so plain ear clipping is sufficient; no
// need for a general/robust tessellator. Capped at kMaxTriangulatePoints
// since this is naive O(n^3) in the worst case (each of the ~n ear removals
// rescans the remaining ~n vertices against ~n inside-triangle tests); large
// polygons just render outline-only rather than risk stalling the load on a
// single pathological shape. Appends triangle vertex indices (into pts) to
// out_indices; leaves it untouched (empty, if previously cleared by the
// caller) on failure.
constexpr uint64_t kMaxTriangulatePoints = 512;

void triangulate(const Array<Vec2>& pts, std::vector<uint32_t>& out_indices) {
    uint64_t n = pts.count;
    if (n < 3 || n > kMaxTriangulatePoints) return;

    std::vector<uint32_t> remaining(n);
    for (uint64_t i = 0; i < n; i++) remaining[i] = (uint32_t)i;

    double area2 = 0;
    for (uint64_t i = 0; i < n; i++) {
        const Vec2& a = pts[i];
        const Vec2& b = pts[(i + 1) % n];
        area2 += a.x * b.y - b.x * a.y;
    }
    if (area2 < 0) std::reverse(remaining.begin(), remaining.end());

    auto cross = [](const Vec2& o, const Vec2& a, const Vec2& b) {
        return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    };
    auto point_in_tri = [&](const Vec2& p, const Vec2& a, const Vec2& b, const Vec2& c) {
        double d1 = cross(a, b, p);
        double d2 = cross(b, c, p);
        double d3 = cross(c, a, p);
        bool has_neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
        bool has_pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
        return !(has_neg && has_pos);
    };

    uint64_t guard = 0;
    uint64_t max_iters = n * n + 16;
    while (remaining.size() > 3 && guard++ < max_iters) {
        uint64_t m = remaining.size();
        bool ear_found = false;
        for (uint64_t i = 0; i < m; i++) {
            uint64_t iprev = (i + m - 1) % m;
            uint64_t inext = (i + 1) % m;
            const Vec2& a = pts[remaining[iprev]];
            const Vec2& b = pts[remaining[i]];
            const Vec2& c = pts[remaining[inext]];
            if (cross(a, b, c) <= 0) continue;  // reflex/collinear vertex, not a convex ear tip
            bool any_inside = false;
            for (uint64_t j = 0; j < m; j++) {
                if (j == iprev || j == i || j == inext) continue;
                const Vec2& p = pts[remaining[j]];
                // Keyhole/comb polygons (the self-touching slits tools use to
                // represent holes) duplicate the slit's bridge vertices, and a
                // duplicate lands exactly on an ear corner -- point_in_tri is
                // boundary-inclusive, so without this exemption every ear near
                // the bridge is vetoed and triangulation stalls at zero.
                if (p == a || p == b || p == c) continue;
                if (point_in_tri(p, a, b, c)) {
                    any_inside = true;
                    break;
                }
            }
            if (any_inside) continue;
            out_indices.push_back(remaining[iprev]);
            out_indices.push_back(remaining[i]);
            out_indices.push_back(remaining[inext]);
            remaining.erase(remaining.begin() + i);
            ear_found = true;
            break;
        }
        // Degenerate input (e.g. self-touching/duplicate points) can leave no
        // valid ear -- bail with whatever triangles were already found rather
        // than looping; partial fill is fine, the outline still draws fully.
        if (!ear_found) return;
    }
    if (remaining.size() == 3) {
        out_indices.push_back(remaining[0]);
        out_indices.push_back(remaining[1]);
        out_indices.push_back(remaining[2]);
    }
}

// Computes a PolygonRange's world-space bbox from the flat [x0,y0,x1,y1,...]
// vertex buffer it indexes into (shared by both outline and fill ranges,
// since fill vertices are a subset of the same polygon points).
PolygonRange make_range(const std::vector<float>& verts, GLint first, GLsizei count) {
    PolygonRange range{first, count, HUGE_VALF, -HUGE_VALF, HUGE_VALF, -HUGE_VALF};
    for (GLsizei i = 0; i < count; i++) {
        float x = verts[(size_t)(first + i) * 2];
        float y = verts[(size_t)(first + i) * 2 + 1];
        range.min_x = std::min(range.min_x, x);
        range.max_x = std::max(range.max_x, x);
        range.min_y = std::min(range.min_y, y);
        range.max_y = std::max(range.max_y, y);
    }
    return range;
}

void set_inner_html(const char* id, const std::string& html) {
    val el = val::global("document").call<val>("getElementById", std::string(id));
    if (!el.isNull() && !el.isUndefined()) el.set("innerHTML", html);
}

void set_inner_text(const char* id, const std::string& text) {
    val el = val::global("document").call<val>("getElementById", std::string(id));
    if (!el.isNull() && !el.isUndefined()) el.set("innerText", text);
}

// dbuPerMicron is always 1.0 now -- gdstk's read_gds() is called with
// unit=1e-6, which normalizes every file's coordinates to microns at parse
// time (see bindings.cpp), so the old per-file scale factor the JS scale
// bar used to divide by no longer varies.
void update_scale_bar() {
    const double target_pixel_width = 120.0;
    double microns_value = target_pixel_width / g_zoom;
    if (!(microns_value > 0) || !std::isfinite(microns_value)) return;

    double magnitude = std::pow(10.0, std::floor(std::log10(microns_value)));
    double normalized = microns_value / magnitude;
    double step = magnitude;
    if (normalized >= 5) step = 5 * magnitude;
    else if (normalized >= 2) step = 2 * magnitude;
    double final_bar_pixels = step * g_zoom;

    val scale_bar = val::global("document").call<val>("getElementById", std::string("scaleBar"));
    if (!scale_bar.isNull() && !scale_bar.isUndefined()) {
        scale_bar["style"].set("width", std::to_string(final_bar_pixels) + "px");
    }

    char buf[64];
    if (step >= 1000) {
        snprintf(buf, sizeof(buf), "%.1f mm", step / 1000.0);
    } else if (step >= 1) {
        snprintf(buf, sizeof(buf), "%.0f \xC2\xB5m", step);  // µm, UTF-8
    } else {
        snprintf(buf, sizeof(buf), "%.0f nm", step * 1000.0);
    }
    set_inner_text("scaleLabel", buf);
}

// Inverse of the vertex shader's camera transform (see kVertexShaderSrc):
// canvas-relative pixel coordinates -> world coordinates. Same math on_wheel
// inlines for its zoom-around-cursor anchor.
void screen_to_world(float screen_x, float screen_y, float& world_x, float& world_y) {
    float px = screen_x - (float)g_canvas_width * 0.5f;
    float py = (float)g_canvas_height * 0.5f - screen_y;
    world_x = g_pan_x + px / g_zoom;
    world_y = g_pan_y + py / g_zoom;
}

// Forward camera transform: world -> canvas-relative pixel coordinates. Used
// to pin the measure label to the ruler midpoint on every redraw.
void world_to_screen(float world_x, float world_y, float& screen_x, float& screen_y) {
    screen_x = (world_x - g_pan_x) * g_zoom + (float)g_canvas_width * 0.5f;
    screen_y = (float)g_canvas_height * 0.5f - (world_y - g_pan_y) * g_zoom;
}

// World units are always microns (see update_scale_bar's dbuPerMicron note);
// picks nm/µm/mm to keep the number readable. %.4g rather than a fixed
// precision so short distances don't drown in trailing zeros.
std::string format_distance_um(double microns) {
    char buf[64];
    if (microns >= 1000.0) {
        snprintf(buf, sizeof(buf), "%.4g mm", microns / 1000.0);
    } else if (microns >= 1.0) {
        snprintf(buf, sizeof(buf), "%.4g \xC2\xB5m", microns);  // µm, UTF-8
    } else {
        snprintf(buf, sizeof(buf), "%.4g nm", microns * 1000.0);
    }
    return buf;
}

// Repositions/re-fills #measureLabel (viewer.html) at the ruler's midpoint,
// or hides it when there's no measurement. Called from draw_frame so the
// label follows the world-space ruler across pan/zoom without its own event
// plumbing.
void update_measure_label() {
    val el = val::global("document").call<val>("getElementById", std::string("measureLabel"));
    if (el.isNull() || el.isUndefined()) return;
    if (!g_measure_has_line) {
        el["classList"].call<void>("add", std::string("hidden"));
        return;
    }
    float dx = g_measure_x1 - g_measure_x0;
    float dy = g_measure_y1 - g_measure_y0;
    double dist = std::sqrt((double)dx * dx + (double)dy * dy);
    std::string html = "<b>" + format_distance_um(dist) + "</b><br>\xCE\x94x " +
                       format_distance_um(std::fabs(dx)) + " \xC2\xB7 \xCE\x94y " +
                       format_distance_um(std::fabs(dy));  // Δx · Δy
    el.set("innerHTML", html);
    float sx, sy;
    world_to_screen((g_measure_x0 + g_measure_x1) * 0.5f, (g_measure_y0 + g_measure_y1) * 0.5f, sx, sy);
    el["style"].set("left", std::to_string(sx) + "px");
    el["style"].set("top", std::to_string(sy) + "px");
    el["classList"].call<void>("remove", std::string("hidden"));
}

// Draws the ruler: the measurement segment plus a short perpendicular tick at
// each endpoint (constant on-screen length, so world size is divided by
// zoom). Reuses the layer shader -- the instance attributes' generic identity
// values (see init_gl) pass positions through, and u_useHatch=0 gives a solid
// line. The VBO is tiny and re-uploaded whenever the endpoints move.
void draw_measure_line() {
    if (!g_measure_has_line) return;
    float verts[12];
    int count = 4;
    verts[0] = g_measure_x0;
    verts[1] = g_measure_y0;
    verts[2] = g_measure_x1;
    verts[3] = g_measure_y1;
    float dx = g_measure_x1 - g_measure_x0;
    float dy = g_measure_y1 - g_measure_y0;
    float len = std::sqrt(dx * dx + dy * dy);
    if (len > 0.0f) {
        float tick = 6.0f / g_zoom;  // 6px half-length ticks
        float nx = -dy / len * tick;
        float ny = dx / len * tick;
        verts[4] = g_measure_x0 - nx;
        verts[5] = g_measure_y0 - ny;
        verts[6] = g_measure_x0 + nx;
        verts[7] = g_measure_y0 + ny;
        verts[8] = g_measure_x1 - nx;
        verts[9] = g_measure_y1 - ny;
        verts[10] = g_measure_x1 + nx;
        verts[11] = g_measure_y1 + ny;
        count = 12;
    }
    if (!g_measure_vbo) glGenBuffers(1, &g_measure_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, g_measure_vbo);
    glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(count * sizeof(float)), verts, GL_DYNAMIC_DRAW);
    glEnableVertexAttribArray(g_loc_position);
    glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
    glUniform4f(g_loc_color, 1.0f, 1.0f, 1.0f, 0.95f);
    glUniform1f(g_loc_use_hatch, 0.0f);
    glDrawArrays(GL_LINES, 0, count / 2);
}

struct ViewRect {
    float min_x, max_x, min_y, max_y;
};

// World-space extent of the current viewport, derived from the same
// pan/zoom the vertex shader applies (see kVertexShaderSrc). Padded by one
// hatch spacing so screen-space fill patterns (computed from gl_FragCoord,
// not world position) don't visibly pop at the edge of the view as a
// polygon crosses the cull boundary.
ViewRect current_view_rect() {
    float half_w = (float)g_canvas_width * 0.5f / g_zoom + kHatchSpacingPx;
    float half_h = (float)g_canvas_height * 0.5f / g_zoom + kHatchSpacingPx;
    return {g_pan_x - half_w, g_pan_x + half_w, g_pan_y - half_h, g_pan_y + half_h};
}

bool bbox_intersects_view(float min_x, float max_x, float min_y, float max_y, const ViewRect& view) {
    return min_x <= view.max_x && max_x >= view.min_x && min_y <= view.max_y && max_y >= view.min_y;
}

// Writes the per-frame "visible polygons" readout into #renderStats (a span
// inside #ui, see uploadLayers). layers_drawn/layers_total count only the
// layer-level visibility/bbox skip in draw_frame -- there's no per-polygon
// culling anymore, so every drawn layer's polygons are all visible.
void update_render_stats(uint64_t visible_polygons, int layers_drawn, int layers_total) {
    char buf[160];
    snprintf(buf, sizeof(buf), "Visible: %llu / %llu polygons<br>Render: no culling (%d / %d layers on screen)",
             (unsigned long long)visible_polygons, (unsigned long long)g_total_polygons, layers_drawn, layers_total);
    set_inner_html("renderStats", buf);
}

float clamp_zoom_value(float zoom) {
    float min_zoom = g_fit_zoom * kMinZoomRatio;
    float max_zoom = g_fit_zoom * kMaxZoomRatio;
    return std::clamp(zoom, min_zoom, max_zoom);
}

// Keeps the design bbox from being panned entirely out of view: pan is
// clamped so the current viewport (half_w/half_h around it, same math as
// current_view_rect) always overlaps the bbox by at least a hair, rather
// than letting the user scroll off into empty space indefinitely.
void clamp_pan() {
    if (g_bbox_min_x > g_bbox_max_x) return;
    float half_w = (float)g_canvas_width * 0.5f / g_zoom;
    float half_h = (float)g_canvas_height * 0.5f / g_zoom;
    g_pan_x = std::clamp(g_pan_x, g_bbox_min_x - half_w, g_bbox_max_x + half_w);
    g_pan_y = std::clamp(g_pan_y, g_bbox_min_y - half_h, g_bbox_max_y + half_h);
}

// Points the three per-instance affine attributes at an InstancedBatch's
// instance VBO with a per-instance divisor / reverts them to the disabled
// (generic identity) state -- shared by draw_frame's normal path and
// draw_layer_merged's mask pass, which draw the same batches under different
// programs (the attribute indices are fixed at link time, see link_program).
void enable_instance_attribs(GLuint instance_vbo) {
    const GLsizei stride = kInstanceStrideFloats * (GLsizei)sizeof(float);
    glBindBuffer(GL_ARRAY_BUFFER, instance_vbo);
    glEnableVertexAttribArray(g_loc_i_col0);
    glVertexAttribPointer(g_loc_i_col0, 2, GL_FLOAT, GL_FALSE, stride, (void*)0);
    glVertexAttribDivisor(g_loc_i_col0, 1);
    glEnableVertexAttribArray(g_loc_i_col1);
    glVertexAttribPointer(g_loc_i_col1, 2, GL_FLOAT, GL_FALSE, stride, (void*)(2 * sizeof(float)));
    glVertexAttribDivisor(g_loc_i_col1, 1);
    glEnableVertexAttribArray(g_loc_i_translate);
    glVertexAttribPointer(g_loc_i_translate, 2, GL_FLOAT, GL_FALSE, stride, (void*)(4 * sizeof(float)));
    glVertexAttribDivisor(g_loc_i_translate, 1);
}

void disable_instance_attribs() {
    glDisableVertexAttribArray(g_loc_i_col0);
    glDisableVertexAttribArray(g_loc_i_col1);
    glDisableVertexAttribArray(g_loc_i_translate);
}

// Merge-mode path for one layer, two passes. Pass 1 rasterizes the layer's
// fill triangles (static + instanced, same VBOs the normal path draws) into
// the screen-sized R8 mask with blending off, collapsing any overlap into
// plain coverage -- the union of the layer's polygons, computed by the
// rasterizer instead of CPU polygon booleans. Pass 2 draws one fullscreen
// triangle that turns that mask into pixels: frame color along the coverage
// boundary, hatch fill inside, discard outside (see
// kCompositeFragmentShaderSrc). Alpha blending on the canvas is per-pass-2-
// fragment, so merged layers stack against other layers exactly like normal
// ones. Coverage comes from the triangulated fill data, so polygons that
// exceeded kMaxTriangulatePoints (rendered outline-only in normal mode)
// don't contribute here.
void draw_layer_merged(const LayerBuffer& layer) {
    bool has_fill = layer.fill_vbo != 0;
    for (const InstancedBatch& batch : layer.instanced_batches) {
        if (batch.fill_vbo) has_fill = true;
    }
    if (!has_fill) return;

    // Pass 1: coverage mask, rasterized at g_mask_scale times the canvas
    // resolution for anti-aliasing (see kCompositeFragmentShaderSrc). Only
    // the viewport changes -- the camera uniforms produce clip-space
    // coordinates, which are viewport-independent, so the same values place
    // every vertex at exactly scale x its canvas pixel position.
    glBindFramebuffer(GL_FRAMEBUFFER, g_mask_fbo);
    glViewport(0, 0, g_canvas_width * g_mask_scale, g_canvas_height * g_mask_scale);
    glDisable(GL_BLEND);
    glClearColor(0.0f, 0.0f, 0.0f, 0.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glUseProgram(g_mask_program);
    glUniform2f(g_mask_loc_resolution, (float)g_canvas_width, (float)g_canvas_height);
    glUniform2f(g_mask_loc_offset, g_pan_x, g_pan_y);
    glUniform1f(g_mask_loc_zoom, g_zoom);

    if (layer.fill_vbo) {
        glBindBuffer(GL_ARRAY_BUFFER, layer.fill_vbo);
        glEnableVertexAttribArray(g_loc_position);
        glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
        glDrawArrays(GL_TRIANGLES, 0, layer.fill_vertex_count);
    }
    for (const InstancedBatch& batch : layer.instanced_batches) {
        if (!batch.fill_vbo) continue;
        enable_instance_attribs(batch.instance_vbo);
        glBindBuffer(GL_ARRAY_BUFFER, batch.fill_vbo);
        glEnableVertexAttribArray(g_loc_position);
        glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
        glDrawArraysInstanced(GL_TRIANGLES, 0, batch.fill_vertex_count, batch.instance_count);
        disable_instance_attribs();
    }

    // Pass 2: composite boundary + fill onto the canvas, back at 1:1.
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glViewport(0, 0, g_canvas_width, g_canvas_height);
    glEnable(GL_BLEND);
    glUseProgram(g_comp_program);
    glUniform1i(g_comp_loc_mask_scale, g_mask_scale);
    glUniform4fv(g_comp_loc_fill_color, 1, layer.fill_color.data());
    glUniform4fv(g_comp_loc_frame_color, 1, layer.frame_color.data());
    glUniform1f(g_comp_loc_pattern_type, layer.pattern_type);
    glUniform1f(g_comp_loc_hatch_angle, layer.hatch_angle);
    glUniform1f(g_comp_loc_hatch_spacing, kHatchSpacingPx);
    glUniform1f(g_comp_loc_hatch_width, kHatchHalfWidthPx);
    glUniform1f(g_comp_loc_show_fill, g_show_infill ? 1.0f : 0.0f);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, g_mask_tex);
    // The fullscreen triangle comes from gl_VertexID; a_position must not be
    // an enabled array here or GL would read (and bounds-check) whatever
    // buffer the mask pass left bound.
    glDisableVertexAttribArray(g_loc_position);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glUseProgram(g_program);
}

bool draw_frame(double /*time*/, void* /*userData*/) {
    g_frame_requested = false;
    if (g_layers.empty()) return false;

    glClearColor(0.06f, 0.06f, 0.07f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glUseProgram(g_program);
    glBindVertexArray(g_vao);

    glUniform2f(g_loc_resolution, (float)g_canvas_width, (float)g_canvas_height);
    glUniform2f(g_loc_offset, g_pan_x, g_pan_y);
    glUniform1f(g_loc_zoom, g_zoom);

    const ViewRect view = current_view_rect();

    // No per-polygon or per-tile culling: every on-screen layer draws in
    // exactly one glDrawArrays (fill) + one glDrawElements (outline) call,
    // full stop. An earlier version tried to fall back to a per-polygon
    // culled draw loop when a layer was only partially on screen (i.e. most
    // zoom levels between "fit to window" and "zoomed in on a small area"),
    // but that fallback issued one draw call per remaining visible polygon
    // and was the actual bottleneck -- worse than just drawing everything
    // unconditionally. The only skip left is the layer-level bbox check
    // below, which is O(number of layers), not O(number of polygons).
    uint64_t frame_visible_polygons = 0;
    int frame_layers_drawn = 0;

    for (const LayerBuffer& layer : g_layers) {
        if (!layer.visible) continue;
        if (!bbox_intersects_view(layer.min_x, layer.max_x, layer.min_y, layer.max_y, view)) continue;

        frame_layers_drawn++;
        frame_visible_polygons += layer.polygon_count;

        if (g_merge_mode) {
            draw_layer_merged(layer);
            continue;
        }

        if (layer.fill_vbo && g_show_infill) {
            glBindBuffer(GL_ARRAY_BUFFER, layer.fill_vbo);
            glEnableVertexAttribArray(g_loc_position);
            glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
            glUniform4fv(g_loc_color, 1, layer.fill_color.data());
            glUniform1f(g_loc_use_hatch, 1.0f);
            glUniform1f(g_loc_pattern_type, layer.pattern_type);
            glUniform1f(g_loc_hatch_angle, layer.hatch_angle);
            glUniform1f(g_loc_hatch_spacing, kHatchSpacingPx);
            glUniform1f(g_loc_hatch_width, kHatchHalfWidthPx);
            // Fill vertices are triangles laid back-to-back with no
            // loop-closing constraint, so the whole layer draws correctly
            // in one shot -- no indices needed.
            glDrawArrays(GL_TRIANGLES, 0, layer.fill_vertex_count);
        }

        if (layer.outline_ebo) {
            glBindBuffer(GL_ARRAY_BUFFER, layer.outline_vbo);
            glEnableVertexAttribArray(g_loc_position);
            glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
            glUniform4fv(g_loc_color, 1, layer.frame_color.data());
            glUniform1f(g_loc_use_hatch, 0.0f);
            // outline_ebo strings every polygon's LINE_LOOP together with
            // primitive-restart markers (kRestartIndex) -- WebGL2 always
            // honors these for indexed draws, so this one glDrawElements
            // call draws every outline polygon on the layer without
            // connecting unrelated polygons' loop-closing edges.
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, layer.outline_ebo);
            glDrawElements(GL_LINE_LOOP, layer.outline_index_count, GL_UNSIGNED_INT, 0);
        }

        // Reused cells: one unique unit shape drawn instance_count times,
        // each placed by a per-instance 2x3 affine read from instance_vbo
        // (see a_iCol0/a_iCol1/a_iTranslate in kVertexShaderSrc). The divisor
        // makes those attributes advance once per instance instead of once
        // per vertex; the arrays are disabled again after each batch so the
        // affine reverts to the identity generic value (set in init_gl) for
        // the non-instanced draws above/below.
        for (const InstancedBatch& batch : layer.instanced_batches) {
            enable_instance_attribs(batch.instance_vbo);

            if (batch.fill_vbo && g_show_infill) {
                glBindBuffer(GL_ARRAY_BUFFER, batch.fill_vbo);
                glEnableVertexAttribArray(g_loc_position);
                glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
                glUniform4fv(g_loc_color, 1, layer.fill_color.data());
                glUniform1f(g_loc_use_hatch, 1.0f);
                glUniform1f(g_loc_pattern_type, layer.pattern_type);
                glUniform1f(g_loc_hatch_angle, layer.hatch_angle);
                glUniform1f(g_loc_hatch_spacing, kHatchSpacingPx);
                glUniform1f(g_loc_hatch_width, kHatchHalfWidthPx);
                glDrawArraysInstanced(GL_TRIANGLES, 0, batch.fill_vertex_count, batch.instance_count);
            }

            if (batch.outline_ebo) {
                glBindBuffer(GL_ARRAY_BUFFER, batch.outline_vbo);
                glEnableVertexAttribArray(g_loc_position);
                glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
                glUniform4fv(g_loc_color, 1, layer.frame_color.data());
                glUniform1f(g_loc_use_hatch, 0.0f);
                glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, batch.outline_ebo);
                glDrawElementsInstanced(GL_LINE_LOOP, batch.outline_index_count, GL_UNSIGNED_INT, 0,
                                        batch.instance_count);
            }

            disable_instance_attribs();
        }
    }
    draw_measure_line();
    update_measure_label();
    update_render_stats(frame_visible_polygons, frame_layers_drawn, (int)g_layers.size());
    return false;
}

// Redraw-on-demand, not a ticking loop: only called from handlers that
// actually change state (resize, new data, drag move, wheel, .lyp load).
void request_redraw() {
    if (!g_gl_ready || g_frame_requested) return;
    g_frame_requested = true;
    emscripten_request_animation_frame(draw_frame, nullptr);
}

void resize_canvas() {
    val window = val::global("window");
    int width = window["innerWidth"].as<int>();
    int height = window["innerHeight"].as<int>();
    g_canvas_width = width;
    g_canvas_height = height;

    val canvas = val::global("document").call<val>("getElementById", std::string("glCanvas"));
    canvas.set("width", width);
    canvas.set("height", height);

    glViewport(0, 0, width, height);

    // Keep merge mode's coverage mask at canvas size * g_mask_scale -- the
    // composite pass addresses a scale x scale block per canvas pixel (the
    // supersampling that anti-aliases merge mode).
    if (g_mask_tex) {
        GLint max_tex = 0;
        glGetIntegerv(GL_MAX_TEXTURE_SIZE, &max_tex);
        g_mask_scale = (2 * width <= max_tex && 2 * height <= max_tex) ? 2 : 1;
        glBindTexture(GL_TEXTURE_2D, g_mask_tex);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, width * g_mask_scale, height * g_mask_scale, 0, GL_RED,
                     GL_UNSIGNED_BYTE, nullptr);
        // Merge mode failing at the FBO level shows as a blank canvas with no
        // other symptom (the mask reads all-zero and the composite discards
        // everything) -- check loudly here instead. Never triggered on a
        // conformant WebGL2 impl; exists because an earlier MSAA-based mask
        // did exactly that silently.
        glBindFramebuffer(GL_FRAMEBUFFER, g_mask_fbo);
        GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
        GLenum err = glGetError();
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        if (status != GL_FRAMEBUFFER_COMPLETE || err != GL_NO_ERROR) {
            EM_ASM({ console.warn('[GDS] merge-mode mask FBO incomplete: status 0x' + $0.toString(16) +
                                  ', glGetError 0x' + $1.toString(16)); },
                   (int)status, (int)err);
        }
    }
    clamp_pan();
    update_scale_bar();
    request_redraw();
}

void clear_layers() {
    for (LayerBuffer& layer : g_layers) {
        if (layer.outline_vbo) glDeleteBuffers(1, &layer.outline_vbo);
        if (layer.outline_ebo) glDeleteBuffers(1, &layer.outline_ebo);
        if (layer.fill_vbo) glDeleteBuffers(1, &layer.fill_vbo);
        for (InstancedBatch& batch : layer.instanced_batches) {
            if (batch.fill_vbo) glDeleteBuffers(1, &batch.fill_vbo);
            if (batch.outline_vbo) glDeleteBuffers(1, &batch.outline_vbo);
            if (batch.outline_ebo) glDeleteBuffers(1, &batch.outline_ebo);
            if (batch.instance_vbo) glDeleteBuffers(1, &batch.instance_vbo);
        }
    }
    g_layers.clear();
}

// A 2D affine map x' = a*x + b*y + tx, y' = c*x + d*y + ty. Used to track the
// accumulated transform down a reference tree without materializing
// geometry at every level (see collect_instanced) -- gdstk's own
// Reference::transform composes Reference structs directly, but we need to
// split a reference's transform into its linear part (mag/x_reflection/
// rotation) and translation part (origin) separately, since only the
// translation varies across one repeated reference's instances.
struct Affine2D {
    double a = 1.0, b = 0.0, c = 0.0, d = 1.0;
    double tx = 0.0, ty = 0.0;

    Vec2 apply_point(const Vec2& p) const { return {a * p.x + b * p.y + tx, c * p.x + d * p.y + ty}; }
    Vec2 apply_linear(const Vec2& p) const { return {a * p.x + b * p.y, c * p.x + d * p.y}; }
};

// Composes two affine maps so that the result's apply_point matches
// outer.apply_point(inner.apply_point(p)) for any point p.
Affine2D compose_affine(const Affine2D& outer, const Affine2D& inner) {
    Affine2D r;
    r.a = outer.a * inner.a + outer.b * inner.c;
    r.b = outer.a * inner.b + outer.b * inner.d;
    r.c = outer.c * inner.a + outer.d * inner.c;
    r.d = outer.c * inner.b + outer.d * inner.d;
    Vec2 t = outer.apply_point({inner.tx, inner.ty});
    r.tx = t.x;
    r.ty = t.y;
    return r;
}

// Linear-only part (magnification, x_reflection, rotation) of a Reference's
// own transform -- mirrors the per-point math in
// Reference::repeat_and_transform, minus the +origin/+offset translation
// term, which collect_instanced applies separately per instance.
Affine2D reference_linear_transform(const Reference* ref) {
    double mag = ref->magnification;
    double ca = cos(ref->rotation), sa = sin(ref->rotation);
    double sy = ref->x_reflection ? -1.0 : 1.0;
    Affine2D t;
    t.a = mag * ca;
    t.b = -mag * sy * sa;
    t.c = mag * sa;
    t.d = mag * sy * ca;
    return t;
}

void transform_points(Array<Vec2>& points, const Affine2D& t, bool with_translation) {
    for (uint64_t i = 0; i < points.count; i++) {
        points[i] = with_translation ? t.apply_point(points[i]) : t.apply_linear(points[i]);
    }
}

// The full transform (linear part + origin translation) a reference applies
// to its target cell's local coordinates. offset is the extra per-copy
// displacement from the reference's repetition (see get_offsets); (0,0) for a
// plain non-repeated reference.
Affine2D reference_placement(const Reference* ref, const Vec2& offset) {
    Affine2D t = reference_linear_transform(ref);
    t.tx = ref->origin.x + offset.x;
    t.ty = ref->origin.y + offset.y;
    return t;
}

// One reused cell's worth of geometry: a single "unit shape" in the cell's
// own local frame (see build_instance_templates) plus one per-instance 2x3
// affine mapping that unit shape into world space -- one entry per place the
// cell ends up drawn. The unit shape is triangulated/uploaded once regardless
// of how many instances there are, which is the whole point: a cell placed
// 800k times (as one AREF or 800k separate SREFs) costs one shape plus 800k
// cheap affines instead of 800k full copies.
struct InstanceGroupPolys {
    // Keyed by gdstk Tag (layer + datatype), not layer number -- see LayerBuffer.
    std::unordered_map<uint64_t, std::vector<Polygon*>> by_layer_unit;
    std::vector<Affine2D> instances;
};

// Fully flattens cell's whole subtree into concrete polygons in the cell's
// own local frame (every reference and repetition expanded, no instancing) --
// the unit shape baked once per instanced cell. Any reuse *inside* this
// subtree is materialized here rather than sub-instanced, which keeps GPU
// instancing to a single level (an instanced cell's template may itself
// contain other instanced cells, but along any path collect_instanced stops
// at the outermost one -- see its comment -- so nothing is double-drawn).
void build_cell_template(Cell* cell, std::unordered_map<uint64_t, std::vector<Polygon*>>& out_by_layer) {
    Array<Polygon*> polygons = {};
    cell->get_polygons(true, true, -1, false, 0, polygons);
    for (uint64_t i = 0; i < polygons.count; i++) {
        Polygon* poly = polygons[i];
        out_by_layer[poly->tag].push_back(poly);
    }
    polygons.clear();
}

// Number of expanded instances of each cell across the whole rendered design
// -- i.e. how many times its own geometry would appear if the hierarchy were
// fully flattened. Used to decide which cells are worth GPU-instancing (see
// choose_instanced_cells): a cell placed thousands of times is; a cell placed
// once or twice isn't (instancing it would only add draw calls). Computed as
// a saturating double because the true count can overflow any integer for
// deep arrayed hierarchies -- and overflowing is itself a strong "instance
// this" signal, so saturation at the threshold is harmless.
constexpr double kInstanceCountCap = 1e18;

// A cell is GPU-instanced when it's placed at least this many times. Below
// this, flattening the few copies into the static per-layer buffers is
// cheaper than the extra per-batch draw calls instancing would add.
constexpr double kInstanceThreshold = 8.0;

// Fills counts[C] = expanded instance count of C, via memoized recursion over
// the reference DAG (GDS references never form a cycle). roots are the cells
// rendered directly at top level (each contributes 1); every reference
// multiplies its target's count by the parent's count times the reference's
// repetition count.
double compute_instance_count(Cell* cell, const std::unordered_map<Cell*, double>& base_counts,
                              std::unordered_map<Cell*, double>& memo,
                              std::unordered_map<Cell*, int>& visiting);

double count_contributions_from_parents(Cell* cell, const std::unordered_map<Cell*, double>& base_counts,
                                         std::unordered_map<Cell*, double>& memo,
                                         std::unordered_map<Cell*, int>& visiting,
                                         const std::unordered_map<Cell*, std::vector<std::pair<Cell*, double>>>& preds) {
    double total = base_counts.count(cell) ? base_counts.at(cell) : 0.0;
    auto it = preds.find(cell);
    if (it != preds.end()) {
        for (const auto& pr : it->second) {
            double parent_count = compute_instance_count(pr.first, base_counts, memo, visiting);
            total += parent_count * pr.second;
            if (total >= kInstanceCountCap) return kInstanceCountCap;
        }
    }
    return total;
}

// preds is captured via a thread-local-ish shim below; see choose_instanced_cells.
const std::unordered_map<Cell*, std::vector<std::pair<Cell*, double>>>* g_preds_for_count = nullptr;

double compute_instance_count(Cell* cell, const std::unordered_map<Cell*, double>& base_counts,
                              std::unordered_map<Cell*, double>& memo,
                              std::unordered_map<Cell*, int>& visiting) {
    auto m = memo.find(cell);
    if (m != memo.end()) return m->second;
    // Guard against a malformed cyclic library (shouldn't happen in valid
    // GDS): treat a cell currently being computed as contributing nothing on
    // the back-edge rather than recursing forever.
    if (visiting[cell]) return 0.0;
    visiting[cell] = 1;
    double total = count_contributions_from_parents(cell, base_counts, memo, visiting, *g_preds_for_count);
    visiting[cell] = 0;
    memo[cell] = total;
    return total;
}

// Picks the set of cells to GPU-instance: those placed >= kInstanceThreshold
// times across the design. Builds the reference DAG's reverse adjacency
// (child -> [(parent, repetition_count)]) once, then evaluates
// compute_instance_count for every cell.
std::unordered_map<Cell*, bool> choose_instanced_cells(Library& lib,
                                                       const std::unordered_map<Cell*, double>& base_counts) {
    std::unordered_map<Cell*, std::vector<std::pair<Cell*, double>>> preds;
    for (uint64_t i = 0; i < lib.cell_array.count; i++) {
        Cell* parent = lib.cell_array[i];
        for (uint64_t r = 0; r < parent->reference_array.count; r++) {
            Reference* ref = parent->reference_array[r];
            if (ref->type != ReferenceType::Cell || ref->cell == nullptr) continue;
            // get_count() returns 0 for a plain (non-arrayed) reference; that
            // reference still places one copy, so floor it at 1.
            uint64_t rep_count = ref->repetition.get_count();
            double rep = rep_count > 0 ? (double)rep_count : 1.0;
            preds[ref->cell].push_back({parent, rep});
        }
    }
    g_preds_for_count = &preds;

    std::unordered_map<Cell*, double> memo;
    std::unordered_map<Cell*, int> visiting;
    std::unordered_map<Cell*, bool> instanced;
    for (uint64_t i = 0; i < lib.cell_array.count; i++) {
        Cell* cell = lib.cell_array[i];
        double count = compute_instance_count(cell, base_counts, memo, visiting);
        instanced[cell] = count >= kInstanceThreshold;
    }
    g_preds_for_count = nullptr;
    return instanced;
}

// Walks cell's reference tree under the accumulated transform `current`,
// splitting geometry into:
//   * by_layer_static -- plain per-layer polygons already in world space, for
//     cells not worth instancing (placed only a handful of times), same as a
//     full flatten would produce; and
//   * groups -- one InstanceGroupPolys per instanced cell (see `instanced`),
//     accumulating a per-instance affine each time that cell is placed.
// Descent stops at the first instanced cell on any path (its whole subtree is
// captured by its template, built separately), so no polygon is emitted
// twice. templates_needed collects which cells actually got instanced so the
// caller only builds templates for those.
void collect_instanced(Cell* cell, const Affine2D& current,
                       const std::unordered_map<Cell*, bool>& instanced,
                       std::unordered_map<uint64_t, std::vector<Polygon*>>& by_layer_static,
                       std::unordered_map<Cell*, InstanceGroupPolys>& groups) {
    // This cell's own polygons/paths only (depth=0); apply_repetitions still
    // expands any repetition attached directly to a polygon/path (a rarer
    // feature distinct from a Reference's repetition), left as static
    // geometry.
    Array<Polygon*> own_polygons = {};
    cell->get_polygons(true, true, 0, false, 0, own_polygons);
    for (uint64_t i = 0; i < own_polygons.count; i++) {
        Polygon* poly = own_polygons[i];
        transform_points(poly->point_array, current, /*with_translation=*/true);
        by_layer_static[poly->tag].push_back(poly);
    }
    own_polygons.clear();

    for (uint64_t i = 0; i < cell->reference_array.count; i++) {
        Reference* ref = cell->reference_array[i];
        if (ref->type != ReferenceType::Cell || ref->cell == nullptr) continue;

        // One (0,0) offset for a plain reference, one per copy for an AREF.
        Vec2 zero = {0, 0};
        Array<Vec2> offsets = {};
        if (ref->repetition.type != RepetitionType::None) {
            ref->repetition.get_offsets(offsets);
        } else {
            offsets.count = 1;
            offsets.items = &zero;
        }

        auto it = instanced.find(ref->cell);
        bool is_instanced = it != instanced.end() && it->second;

        for (uint64_t k = 0; k < offsets.count; k++) {
            Affine2D placement = compose_affine(current, reference_placement(ref, offsets[k]));
            if (is_instanced) {
                groups[ref->cell].instances.push_back(placement);
            } else {
                collect_instanced(ref->cell, placement, instanced, by_layer_static, groups);
            }
        }

        if (ref->repetition.type != RepetitionType::None) offsets.clear();
    }
}

// Fresh JS-owned Float32Array copied out of a wasm-heap vector -- mirrors
// bindings.cpp's to_float64_array. The returned array doesn't alias wasm
// memory, so it's safe for a caller (e.g. the Worker script) to hold onto or
// postMessage-transfer after this call returns.
val to_float32_array(const std::vector<float>& data) {
    val array = val::global("Float32Array").new_(data.size());
    array.call<void>("set", typed_memory_view(data.size(), data.data()));
    return array;
}

// Fire-and-forget progress ping: self.postMessage in the Worker that runs
// parseGdsToLayers (the normal case), window.postMessage on the main thread
// otherwise. Workers deliver postMessage to the other thread as soon as it's
// called, not when the sender goes idle, so the listener sees these
// near-real-time even though this function is called from deep inside a
// single long synchronous C++ call.
void report_progress(const char* phase, uint64_t current, uint64_t total) {
    EM_ASM(
        {
            if (typeof postMessage === 'function') {
                postMessage({type : 'gdsProgress', phase : UTF8ToString($0), current : $1, total : $2});
            }
        },
        phase, (double)current, (double)total);
}

bool extract_tag_value(const std::string& block, const char* tag, std::string& out) {
    std::string open_tag = std::string("<") + tag + ">";
    std::string close_tag = std::string("</") + tag + ">";
    size_t open_pos = block.find(open_tag);
    if (open_pos == std::string::npos) return false;
    open_pos += open_tag.length();
    size_t close_pos = block.find(close_tag, open_pos);
    if (close_pos == std::string::npos) return false;
    out = block.substr(open_pos, close_pos - open_pos);
    return true;
}

std::string trim(const std::string& s) {
    size_t start = s.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return "";
    size_t end = s.find_last_not_of(" \t\r\n");
    return s.substr(start, end - start + 1);
}

// alpha output of 0 signals "invalid hex" to the caller (mirrors the old
// hexToRgb() returning null); the requested alpha is otherwise always > 0.
std::array<float, 4> hex_to_rgba(const std::string& hex_in, float alpha) {
    std::string hex = trim(hex_in);
    if (!hex.empty() && hex[0] == '#') hex = hex.substr(1);
    if (hex.size() != 6) return {0.0f, 0.0f, 0.0f, 0.0f};

    char byte_buf[3] = {0, 0, 0};
    auto hex_byte = [&](size_t pos) -> float {
        byte_buf[0] = hex[pos];
        byte_buf[1] = hex[pos + 1];
        return (float)strtol(byte_buf, nullptr, 16);
    };
    return {hex_byte(0) / 255.0f, hex_byte(2) / 255.0f, hex_byte(4) / 255.0f, alpha};
}

bool on_mousedown(int /*eventType*/, const EmscriptenMouseEvent* e, void* /*userData*/) {
    if (g_measure_mode) {
        // Click-click measurement: first click anchors the start point (the
        // line then tracks the cursor via on_mousemove), second click freezes
        // it. A further click starts a fresh measurement.
        float wx, wy;
        screen_to_world((float)e->targetX, (float)e->targetY, wx, wy);
        if (!g_measure_pending) {
            g_measure_x0 = wx;
            g_measure_y0 = wy;
            g_measure_x1 = wx;
            g_measure_y1 = wy;
            g_measure_pending = true;
            g_measure_has_line = true;
        } else {
            g_measure_x1 = wx;
            g_measure_y1 = wy;
            g_measure_pending = false;
        }
        request_redraw();
        return true;
    }
    g_dragging = true;
    g_last_mouse_x = e->clientX;
    g_last_mouse_y = e->clientY;
    return true;
}

bool on_mousemove(int /*eventType*/, const EmscriptenMouseEvent* e, void* /*userData*/) {
    if (g_measure_pending) {
        screen_to_world((float)e->targetX, (float)e->targetY, g_measure_x1, g_measure_y1);
        request_redraw();
        return true;
    }
    if (!g_dragging) return false;
    int dx = e->clientX - g_last_mouse_x;
    int dy = e->clientY - g_last_mouse_y;
    g_pan_x -= dx / g_zoom;
    g_pan_y += dy / g_zoom;
    clamp_pan();
    g_last_mouse_x = e->clientX;
    g_last_mouse_y = e->clientY;
    request_redraw();
    return true;
}

bool on_mouseup(int /*eventType*/, const EmscriptenMouseEvent* /*e*/, void* /*userData*/) {
    g_dragging = false;
    return true;
}

// Zooms around the cursor rather than the view center: the world point
// currently under the mouse (computed from the vertex shader's inverse --
// see kVertexShaderSrc) is held fixed on screen across the zoom change by
// solving for the new pan that keeps it there.
bool on_wheel(int /*eventType*/, const EmscriptenWheelEvent* e, void* /*userData*/) {
    float old_zoom = g_zoom;
    float factor = (e->deltaY < 0) ? 1.15f : (1.0f / 1.15f);
    float new_zoom = clamp_zoom_value(old_zoom * factor);
    if (new_zoom != old_zoom) {
        float px = (float)e->mouse.targetX - (float)g_canvas_width * 0.5f;
        float py = (float)g_canvas_height * 0.5f - (float)e->mouse.targetY;
        float world_x = g_pan_x + px / old_zoom;
        float world_y = g_pan_y + py / old_zoom;
        g_zoom = new_zoom;
        g_pan_x = world_x - px / new_zoom;
        g_pan_y = world_y - py / new_zoom;
        clamp_pan();
    }
    update_scale_bar();
    request_redraw();
    return true;
}

void reset_view() {
    g_zoom = g_fit_zoom;
    g_pan_x = g_fit_pan_x;
    g_pan_y = g_fit_pan_y;
    update_scale_bar();
    request_redraw();
}

bool on_resize(int /*eventType*/, const EmscriptenUiEvent* /*e*/, void* /*userData*/) {
    resize_canvas();
    return true;
}

// Triangulates polys (already fully positioned in whatever coordinate frame
// the caller wants -- world space for static layers, unit space for an
// instance group's shape) into the same JS-facing
// {outlineVertices,outlineRanges,fillVertices,fillRanges} layout
// parseGdsToLayers has always produced, reusable for both. Reports the
// bounding box of every point it consumed via out_min/max (min > max if
// polys was empty) so the caller can fold it into whatever bbox accumulator
// applies (design bbox for static layers, unit-shape bbox for a group -- see
// parseGdsToLayers). Frees every Polygon* in polys before returning.
val build_layer_entry(uint64_t tag, std::vector<Polygon*>& polys, uint64_t& out_polygon_count,
                      double& out_min_x, double& out_max_x, double& out_min_y, double& out_max_y) {
    out_polygon_count = polys.size();
    out_min_x = HUGE_VAL;
    out_max_x = -HUGE_VAL;
    out_min_y = HUGE_VAL;
    out_max_y = -HUGE_VAL;

    uint64_t point_total = 0;
    for (Polygon* poly : polys) point_total += poly->point_array.count;

    std::vector<float> outline_vertices;
    outline_vertices.reserve(point_total * 2);
    std::vector<float> fill_vertices;
    val outline_ranges = val::array();
    val fill_ranges = val::array();
    std::vector<uint32_t> tri_indices;

    auto append_fill = [&](const Array<Vec2>& pts, const std::vector<uint32_t>& indices) {
        if (indices.empty()) return;
        uint32_t fill_first = (uint32_t)(fill_vertices.size() / 2);
        for (uint32_t idx : indices) {
            const Vec2& pt = pts[idx];
            fill_vertices.push_back((float)pt.x);
            fill_vertices.push_back((float)pt.y);
        }
        val fill_range = val::array();
        fill_range.set(0, fill_first);
        fill_range.set(1, (uint32_t)indices.size());
        fill_ranges.call<void>("push", fill_range);
    };

    for (Polygon* poly : polys) {
        uint32_t first = (uint32_t)(outline_vertices.size() / 2);
        for (uint64_t i = 0; i < poly->point_array.count; i++) {
            const Vec2& pt = poly->point_array[i];
            outline_vertices.push_back((float)pt.x);
            outline_vertices.push_back((float)pt.y);
            out_min_x = std::min(out_min_x, pt.x);
            out_max_x = std::max(out_max_x, pt.x);
            out_min_y = std::min(out_min_y, pt.y);
            out_max_y = std::max(out_max_y, pt.y);
        }
        val outline_range = val::array();
        outline_range.set(0, first);
        outline_range.set(1, (uint32_t)poly->point_array.count);
        outline_ranges.call<void>("push", outline_range);

        tri_indices.clear();
        triangulate(poly->point_array, tri_indices);
        // A simple polygon with n vertices triangulates into exactly n-2
        // triangles; fewer means triangulate() declined (over the point cap)
        // or bailed partway (degenerate input, e.g. the self-touching comb
        // slits some tools emit to represent holes). Fall back to gdstk's
        // fracture(), whose horizontal/vertical cuts both bound the piece
        // size and split away most degeneracies, and triangulate the pieces.
        // Fill only -- the outline above still traces the original polygon,
        // and the seams the cuts introduce are invisible: normal mode never
        // strokes fill internals, and merge mode's coverage mask unions the
        // pieces back together.
        uint64_t n = poly->point_array.count;
        bool complete = n >= 3 && tri_indices.size() == (size_t)(n - 2) * 3;
        if (complete || n < 3) {
            append_fill(poly->point_array, tri_indices);
        } else {
            Array<Polygon*> pieces = {};
            // precision = 1e-3: coordinates are in microns (see read_gds's
            // unit argument), so cuts snap to a 1 nm grid.
            poly->fracture(kMaxTriangulatePoints, 1e-3, pieces);
            if (pieces.count == 0) {
                // fracture had nothing to offer -- keep whatever partial
                // triangulation the ear clipper managed.
                append_fill(poly->point_array, tri_indices);
            }
            for (uint64_t p = 0; p < pieces.count; p++) {
                Polygon* piece = pieces[p];
                tri_indices.clear();
                triangulate(piece->point_array, tri_indices);
                append_fill(piece->point_array, tri_indices);
                piece->clear();
                free_allocation(piece);
            }
            pieces.clear();
        }
    }

    val layer_entry = val::object();
    layer_entry.set("layer", get_layer(tag));
    layer_entry.set("datatype", get_type(tag));
    layer_entry.set("outlineVertices", to_float32_array(outline_vertices));
    layer_entry.set("outlineRanges", outline_ranges);
    layer_entry.set("fillVertices", to_float32_array(fill_vertices));
    layer_entry.set("fillRanges", fill_ranges);

    for (Polygon* poly : polys) {
        poly->clear();
        free_allocation(poly);
    }

    return layer_entry;
}

// Result of uploading one {outlineVertices,outlineRanges,fillVertices,
// fillRanges} JS entry (as produced by build_layer_entry) to fresh GL
// buffers -- shared by both uploadLayers' static per-layer path and its
// per-(instance group, layer) path, which otherwise did the exact same VBO/
// EBO construction.
struct UploadedGeometry {
    GLuint outline_vbo = 0;
    GLuint outline_ebo = 0;
    GLsizei outline_index_count = 0;
    GLuint fill_vbo = 0;
    GLsizei fill_vertex_count = 0;
    uint32_t polygon_count = 0;
    float min_x = HUGE_VAL, max_x = -HUGE_VAL, min_y = HUGE_VAL, max_y = -HUGE_VAL;
};

UploadedGeometry upload_geometry(val entry) {
    UploadedGeometry g;

    // convertJSArrayToNumberVector does one bulk typed_memory_view copy;
    // vecFromJSArray would marshal one element at a time, which is too slow
    // for vertex buffers that can run into the millions of floats.
    std::vector<float> outline_vertices = convertJSArrayToNumberVector<float>(entry["outlineVertices"]);
    std::vector<float> fill_vertices = convertJSArrayToNumberVector<float>(entry["fillVertices"]);

    val outline_ranges = entry["outlineRanges"];
    unsigned outline_range_count = outline_ranges["length"].as<unsigned>();
    // Indices for outline_ebo: each polygon's vertex range followed by a
    // restart marker, so the whole layer/batch can be drawn as one
    // GL_LINE_LOOP glDraw(Elements|ElementsInstanced) call (see draw_frame).
    std::vector<uint32_t> outline_indices;
    outline_indices.reserve(outline_vertices.size() / 2 + outline_range_count);
    for (unsigned r = 0; r < outline_range_count; r++) {
        val range = outline_ranges[r];
        uint32_t first = range[0].as<uint32_t>();
        uint32_t count = range[1].as<uint32_t>();
        PolygonRange pr = make_range(outline_vertices, (GLint)first, (GLsizei)count);
        g.min_x = std::min(g.min_x, pr.min_x);
        g.max_x = std::max(g.max_x, pr.max_x);
        g.min_y = std::min(g.min_y, pr.min_y);
        g.max_y = std::max(g.max_y, pr.max_y);
        for (uint32_t k = 0; k < count; k++) outline_indices.push_back(first + k);
        outline_indices.push_back(kRestartIndex);
    }
    g.polygon_count = outline_range_count;
    g.fill_vertex_count = (GLsizei)(fill_vertices.size() / 2);

    glGenBuffers(1, &g.outline_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, g.outline_vbo);
    glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(outline_vertices.size() * sizeof(float)), outline_vertices.data(),
                GL_STATIC_DRAW);

    if (!outline_indices.empty()) {
        glGenBuffers(1, &g.outline_ebo);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, g.outline_ebo);
        glBufferData(GL_ELEMENT_ARRAY_BUFFER, (GLsizeiptr)(outline_indices.size() * sizeof(uint32_t)),
                    outline_indices.data(), GL_STATIC_DRAW);
        g.outline_index_count = (GLsizei)outline_indices.size();
    }

    if (!fill_vertices.empty()) {
        glGenBuffers(1, &g.fill_vbo);
        glBindBuffer(GL_ARRAY_BUFFER, g.fill_vbo);
        glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(fill_vertices.size() * sizeof(float)), fill_vertices.data(),
                    GL_STATIC_DRAW);
    }

    return g;
}

}  // namespace

// Parses, flattens, and triangulates a GDS file into plain per-layer vertex
// data -- no GL/DOM touched, so this is safe to run inside a Worker (see
// wasm-worker.js) as well as on the main thread. Reports progress via
// report_progress() as it goes; the caller (JS) is expected to relay
// 'gdsProgress' postMessages to whatever's driving a progress bar.
val parseGdsToLayers(const std::string& path) {
    val result = val::object();

    report_progress("parsing", 0, 1);
    ErrorCode error_code = ErrorCode::NoError;
    Library lib = read_gds(path.c_str(), 1e-6, 1e-2, NULL, &error_code);
    report_progress("parsing", 1, 1);

    if (gds_common::is_fatal(error_code)) {
        result.set("ok", false);
        result.set("error", std::string(gds_common::error_string(error_code)));
        lib.free_all();
        return result;
    }

    Array<Cell*> top_cells = {};
    Array<RawCell*> top_rawcells = {};
    lib.top_level(top_cells, top_rawcells);

    // The cells we actually render at top level (each an instance-count root):
    // every non-metadata top cell, or -- if the hierarchy has no clean root
    // (e.g. a reference cycle) -- the last cell defined, mirroring common GDS
    // tooling. base_counts seeds compute_instance_count with 1 per root.
    std::vector<Cell*> roots;
    for (uint64_t i = 0; i < top_cells.count; i++) {
        if (!gds_common::is_metadata_cell(top_cells[i])) roots.push_back(top_cells[i]);
    }
    if (roots.empty() && lib.cell_array.count > 0) {
        roots.push_back(lib.cell_array[lib.cell_array.count - 1]);
    }
    top_cells.clear();
    top_rawcells.clear();

    std::unordered_map<Cell*, double> base_counts;
    for (Cell* root : roots) base_counts[root] += 1.0;

    // Decide which cells are reused enough to GPU-instance, then split the
    // design into static geometry + one instance group per instanced cell.
    std::unordered_map<Cell*, bool> instanced = choose_instanced_cells(lib, base_counts);

    std::unordered_map<uint64_t, std::vector<Polygon*>> by_layer_static;
    std::unordered_map<Cell*, InstanceGroupPolys> groups;
    uint64_t root_index = 0;
    for (Cell* root : roots) {
        collect_instanced(root, Affine2D{}, instanced, by_layer_static, groups);
        root_index++;
        report_progress("flattening", root_index, roots.size());
    }

    // Build the unit shape (once) for every cell that actually got instances.
    for (auto& kv : groups) {
        build_cell_template(kv.first, kv.second.by_layer_unit);
    }

    double min_x = HUGE_VAL, max_x = -HUGE_VAL;
    double min_y = HUGE_VAL, max_y = -HUGE_VAL;
    uint64_t total_polygons = 0;

    val layers = val::array();
    uint64_t layer_index = 0;
    uint64_t layer_total = by_layer_static.size();
    for (const auto& kv : groups) layer_total += kv.second.by_layer_unit.size();

    for (auto& entry : by_layer_static) {
        uint64_t layer_polygon_count = 0;
        double lmin_x, lmax_x, lmin_y, lmax_y;
        val layer_entry = build_layer_entry(entry.first, entry.second, layer_polygon_count, lmin_x, lmax_x, lmin_y, lmax_y);
        if (layer_polygon_count > 0 && lmin_x <= lmax_x) {
            min_x = std::min(min_x, lmin_x);
            max_x = std::max(max_x, lmax_x);
            min_y = std::min(min_y, lmin_y);
            max_y = std::max(max_y, lmax_y);
        }
        total_polygons += layer_polygon_count;
        layers.call<void>("push", layer_entry);

        layer_index++;
        report_progress("triangulating", layer_index, layer_total);
    }

    // Each instance group becomes one JS entry: a flat per-instance affine
    // array (6 floats each -- col0.xy, col1.xy, translate.xy) plus the group's
    // unit shape split by layer the same way static layers are. The group's
    // world footprint is the unit-shape bbox's four corners mapped through
    // every instance affine (rotation/mirror can vary per instance, so a
    // simple min/max of translations isn't enough) -- used both to grow the
    // design bbox here and, on the main thread, each touched layer's cull box.
    val instance_groups_js = val::array();
    for (auto& kv : groups) {
        InstanceGroupPolys& group = kv.second;
        double group_min_x = HUGE_VAL, group_max_x = -HUGE_VAL;
        double group_min_y = HUGE_VAL, group_max_y = -HUGE_VAL;
        val group_layers = val::array();
        uint64_t unit_polygon_count_sum = 0;

        for (auto& entry : group.by_layer_unit) {
            uint64_t layer_polygon_count = 0;
            double lmin_x, lmax_x, lmin_y, lmax_y;
            val layer_entry =
                build_layer_entry(entry.first, entry.second, layer_polygon_count, lmin_x, lmax_x, lmin_y, lmax_y);
            if (layer_polygon_count > 0 && lmin_x <= lmax_x) {
                group_min_x = std::min(group_min_x, lmin_x);
                group_max_x = std::max(group_max_x, lmax_x);
                group_min_y = std::min(group_min_y, lmin_y);
                group_max_y = std::max(group_max_y, lmax_y);
            }
            unit_polygon_count_sum += layer_polygon_count;
            group_layers.call<void>("push", layer_entry);

            layer_index++;
            report_progress("triangulating", layer_index, layer_total);
        }

        uint64_t instance_count = group.instances.size();
        total_polygons += unit_polygon_count_sum * instance_count;

        std::vector<float> instances_flat;
        instances_flat.reserve(group.instances.size() * kInstanceStrideFloats);
        double g_min_x = HUGE_VAL, g_max_x = -HUGE_VAL, g_min_y = HUGE_VAL, g_max_y = -HUGE_VAL;
        bool have_unit_bbox = unit_polygon_count_sum > 0 && group_min_x <= group_max_x;
        Vec2 unit_corners[4] = {{group_min_x, group_min_y},
                                {group_max_x, group_min_y},
                                {group_min_x, group_max_y},
                                {group_max_x, group_max_y}};
        for (const Affine2D& m : group.instances) {
            instances_flat.push_back((float)m.a);
            instances_flat.push_back((float)m.c);
            instances_flat.push_back((float)m.b);
            instances_flat.push_back((float)m.d);
            instances_flat.push_back((float)m.tx);
            instances_flat.push_back((float)m.ty);
            if (have_unit_bbox) {
                for (const Vec2& corner : unit_corners) {
                    Vec2 w = m.apply_point(corner);
                    g_min_x = std::min(g_min_x, w.x);
                    g_max_x = std::max(g_max_x, w.x);
                    g_min_y = std::min(g_min_y, w.y);
                    g_max_y = std::max(g_max_y, w.y);
                }
            }
        }

        if (have_unit_bbox && instance_count > 0) {
            min_x = std::min(min_x, g_min_x);
            max_x = std::max(max_x, g_max_x);
            min_y = std::min(min_y, g_min_y);
            max_y = std::max(max_y, g_max_y);
        }

        val group_bbox = val::object();
        group_bbox.set("minX", g_min_x);
        group_bbox.set("maxX", g_max_x);
        group_bbox.set("minY", g_min_y);
        group_bbox.set("maxY", g_max_y);

        val group_entry = val::object();
        group_entry.set("instances", to_float32_array(instances_flat));
        group_entry.set("layers", group_layers);
        group_entry.set("bbox", group_bbox);
        instance_groups_js.call<void>("push", group_entry);
    }

    lib.free_all();

    val bbox = val::object();
    bbox.set("minX", total_polygons > 0 && min_x <= max_x ? min_x : 0.0);
    bbox.set("maxX", total_polygons > 0 && min_x <= max_x ? max_x : 0.0);
    bbox.set("minY", total_polygons > 0 && min_x <= max_x ? min_y : 0.0);
    bbox.set("maxY", total_polygons > 0 && min_x <= max_x ? max_y : 0.0);

    result.set("ok", true);
    result.set("error", std::string(gds_common::error_string(error_code)));
    result.set("layers", layers);
    result.set("instanceGroups", instance_groups_js);
    result.set("bbox", bbox);
    result.set("totalPolygons", total_polygons);
    return result;
}

// GL-upload half of the old loadAndRenderGds: takes the plain per-layer
// vertex data produced by parseGdsToLayers() (either called directly, or
// reconstructed from a Worker's 'gdsResult' postMessage) and turns it into
// VBOs + camera framing. Must run on the main thread (owns the GL context).
void uploadLayers(val layers_data, val instance_groups_data, val bbox_data) {
    if (!g_gl_ready) return;
    clear_layers();
    // A measurement is anchored to the old file's geometry -- drop it rather
    // than leaving a stale ruler floating over the new design.
    g_measure_has_line = false;
    g_measure_pending = false;

    unsigned layer_count = layers_data["length"].as<unsigned>();
    unsigned group_count = instance_groups_data["length"].as<unsigned>();

    // Reserve enough capacity that g_layers never reallocates while this
    // function holds a raw pointer into it (see the group loop below) -- a
    // layer that only appears inside a repeated reference, never directly at
    // the top level, creates a brand new entry while processing groups.
    uint64_t max_new_layers = layer_count;
    for (unsigned gi = 0; gi < group_count; gi++) {
        max_new_layers += instance_groups_data[gi]["layers"]["length"].as<unsigned>();
    }
    g_layers.reserve(g_layers.size() + max_new_layers);

    std::unordered_map<uint64_t, size_t> layer_index_by_tag;
    uint64_t total_polygons = 0;

    for (unsigned i = 0; i < layer_count; i++) {
        val entry = layers_data[i];
        LayerBuffer layer_buffer;
        layer_buffer.layer = entry["layer"].as<uint32_t>();
        layer_buffer.datatype = entry["datatype"].as<uint32_t>();

        UploadedGeometry g = upload_geometry(entry);
        layer_buffer.outline_vbo = g.outline_vbo;
        layer_buffer.outline_ebo = g.outline_ebo;
        layer_buffer.outline_index_count = g.outline_index_count;
        layer_buffer.fill_vbo = g.fill_vbo;
        layer_buffer.fill_vertex_count = g.fill_vertex_count;
        layer_buffer.polygon_count = g.polygon_count;
        layer_buffer.min_x = g.min_x;
        layer_buffer.max_x = g.max_x;
        layer_buffer.min_y = g.min_y;
        layer_buffer.max_y = g.max_y;
        total_polygons += g.polygon_count;

        apply_layer_colors(layer_buffer);
        layer_index_by_tag[layer_buffer.tag()] = g_layers.size();
        g_layers.push_back(std::move(layer_buffer));
    }

    // Instanced cells: one shared per-instance affine buffer per group (see
    // InstancedBatch), plus one InstancedBatch per layer the group's unit
    // shape touches -- possibly on a layer with no static geometry of its own
    // at all, hence find-or-create rather than an index lookup. The whole
    // group's precomputed world bbox (which already accounts for per-instance
    // rotation/mirror -- see parseGdsToLayers) is folded into each touched
    // layer's cull box.
    for (unsigned gi = 0; gi < group_count; gi++) {
        val group = instance_groups_data[gi];
        std::vector<float> instances = convertJSArrayToNumberVector<float>(group["instances"]);
        GLsizei instance_count = (GLsizei)(instances.size() / kInstanceStrideFloats);
        if (instance_count == 0) continue;

        val group_bbox = group["bbox"];
        float gb_min_x = (float)group_bbox["minX"].as<double>();
        float gb_max_x = (float)group_bbox["maxX"].as<double>();
        float gb_min_y = (float)group_bbox["minY"].as<double>();
        float gb_max_y = (float)group_bbox["maxY"].as<double>();
        bool have_group_bbox = gb_min_x <= gb_max_x;

        GLuint instance_vbo = 0;
        glGenBuffers(1, &instance_vbo);
        glBindBuffer(GL_ARRAY_BUFFER, instance_vbo);
        glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(instances.size() * sizeof(float)), instances.data(),
                     GL_STATIC_DRAW);

        val group_layers = group["layers"];
        unsigned group_layer_count = group_layers["length"].as<unsigned>();
        for (unsigned li = 0; li < group_layer_count; li++) {
            val entry = group_layers[li];
            uint32_t layer_number = entry["layer"].as<uint32_t>();
            uint32_t datatype = entry["datatype"].as<uint32_t>();
            uint64_t tag = make_tag(layer_number, datatype);
            UploadedGeometry g = upload_geometry(entry);

            LayerBuffer* layer_buffer;
            auto it = layer_index_by_tag.find(tag);
            if (it != layer_index_by_tag.end()) {
                layer_buffer = &g_layers[it->second];
            } else {
                LayerBuffer new_layer;
                new_layer.layer = layer_number;
                new_layer.datatype = datatype;
                apply_layer_colors(new_layer);
                layer_index_by_tag[tag] = g_layers.size();
                g_layers.push_back(std::move(new_layer));
                layer_buffer = &g_layers.back();
            }

            InstancedBatch batch;
            batch.fill_vbo = g.fill_vbo;
            batch.fill_vertex_count = g.fill_vertex_count;
            batch.outline_vbo = g.outline_vbo;
            batch.outline_ebo = g.outline_ebo;
            batch.outline_index_count = g.outline_index_count;
            batch.instance_vbo = instance_vbo;
            batch.instance_count = instance_count;
            layer_buffer->instanced_batches.push_back(batch);

            uint64_t logical_count = (uint64_t)g.polygon_count * (uint64_t)instance_count;
            layer_buffer->polygon_count += (uint32_t)logical_count;
            total_polygons += logical_count;

            if (g.polygon_count > 0 && have_group_bbox) {
                layer_buffer->min_x = std::min(layer_buffer->min_x, gb_min_x);
                layer_buffer->max_x = std::max(layer_buffer->max_x, gb_max_x);
                layer_buffer->min_y = std::min(layer_buffer->min_y, gb_min_y);
                layer_buffer->max_y = std::max(layer_buffer->max_y, gb_max_y);
            }
        }
    }

    double min_x = bbox_data["minX"].as<double>();
    double max_x = bbox_data["maxX"].as<double>();
    double min_y = bbox_data["minY"].as<double>();
    double max_y = bbox_data["maxY"].as<double>();

    if (total_polygons > 0 && min_x <= max_x) {
        double total_width = max_x - min_x;
        double total_height = max_y - min_y;
        g_pan_x = (float)(min_x + total_width / 2.0);
        g_pan_y = (float)(min_y + total_height / 2.0);
        double zoom_x = g_canvas_width / (total_width > 0 ? total_width : 1.0);
        double zoom_y = g_canvas_height / (total_height > 0 ? total_height : 1.0);
        g_zoom = (float)(std::min(zoom_x, zoom_y) * 0.85);
        g_bbox_min_x = (float)min_x;
        g_bbox_max_x = (float)max_x;
        g_bbox_min_y = (float)min_y;
        g_bbox_max_y = (float)max_y;
    } else {
        g_zoom = 1.0f;
        g_pan_x = 0.0f;
        g_pan_y = 0.0f;
        g_bbox_min_x = HUGE_VALF;
        g_bbox_max_x = -HUGE_VALF;
        g_bbox_min_y = HUGE_VALF;
        g_bbox_max_y = -HUGE_VALF;
    }
    g_fit_zoom = g_zoom;
    g_fit_pan_x = g_pan_x;
    g_fit_pan_y = g_pan_y;
    g_total_polygons = total_polygons;

    // #renderStats is a placeholder draw_frame overwrites every redraw (see
    // update_render_stats) with the live visible-polygon-count / rendering-
    // mode readout -- kept as a separate span so draw_frame's per-frame
    // update doesn't have to re-set the static title/count text above it.
    set_inner_html("ui", "<b>GDSII Core Engine Active</b><br>Polygons: " + std::to_string(total_polygons) +
                              "<br><span id=\"renderStats\"></span>");
    update_scale_bar();
    request_redraw();
}

void showLoadError(const std::string& message) {
    if (!g_gl_ready) return;
    clear_layers();
    // With no layers draw_frame early-returns and can't hide the label, so
    // hide it here directly.
    g_measure_has_line = false;
    g_measure_pending = false;
    update_measure_label();
    set_inner_html("ui", std::string("<b>Error</b><br>") + message);
    request_redraw();
}

// Synchronous single-call path kept for callers that don't need progress
// reporting -- parseGdsToLayers()/uploadLayers() are what viewer.js actually
// drives via the Worker now.
void loadAndRenderGds(const std::string& path) {
    if (!g_gl_ready) {
        // No WebGL2-capable canvas (e.g. running under plain Node) -- use
        // parseGds() instead for headless parse-path testing.
        return;
    }
    val r = parseGdsToLayers(path);
    if (!r["ok"].as<bool>()) {
        showLoadError(r["error"].as<std::string>());
        return;
    }
    uploadLayers(r["layers"], r["instanceGroups"], r["bbox"]);
}

// Parse one leaf .lyp block -- the region covering a single layer, containing
// exactly one <source> -- and insert it into g_lyp_info under `category`. A
// no-op when the block has no numeric <source> (e.g. a subgroup header, or
// KLayout's catch-all "*/*") or defines no usable color.
void parse_lyp_leaf(const std::string& block, const std::string& category) {
    // <source> is "layer/datatype@layout-index" (e.g. "250/9@1"). Split off the
    // layer at '/', then the datatype up to '@' (or end). A missing datatype
    // defaults to 0.
    std::string source_text;
    if (!extract_tag_value(block, "source", source_text)) return;
    size_t slash_pos = source_text.find('/');
    std::string layer_text = trim(source_text.substr(0, slash_pos));
    if (layer_text.empty()) return;
    char* endptr = nullptr;
    long layer_number = strtol(layer_text.c_str(), &endptr, 10);
    if (endptr == layer_text.c_str()) return;

    long datatype_number = 0;
    if (slash_pos != std::string::npos) {
        std::string dt_text = source_text.substr(slash_pos + 1);
        size_t at_pos = dt_text.find('@');
        if (at_pos != std::string::npos) dt_text = dt_text.substr(0, at_pos);
        dt_text = trim(dt_text);
        char* dt_endptr = nullptr;
        long parsed = strtol(dt_text.c_str(), &dt_endptr, 10);
        // Only take a fully numeric datatype; a wildcard ("*") leaves it 0.
        if (dt_endptr != dt_text.c_str()) datatype_number = parsed;
    }

    LypEntry entry;
    entry.order = g_lyp_order_counter++;
    entry.group = category;

    std::string fill_text, frame_text;
    entry.has_fill = extract_tag_value(block, "fill-color", fill_text);
    entry.has_frame = extract_tag_value(block, "frame-color", frame_text);
    if (entry.has_fill) {
        entry.fill_color = hex_to_rgba(fill_text, 0.55f);
        if (entry.fill_color[3] == 0.0f) entry.has_fill = false;
    }
    if (entry.has_frame) {
        entry.frame_color = hex_to_rgba(frame_text, 0.9f);
        if (entry.frame_color[3] == 0.0f) entry.has_frame = false;
    }
    if (!entry.has_fill && !entry.has_frame) return;

    std::string name_text;
    if (extract_tag_value(block, "name", name_text)) entry.name = trim(name_text);

    std::string visible_text;
    if (extract_tag_value(block, "visible", visible_text)) {
        std::string v = trim(visible_text);
        entry.visible = !(v == "false" || v == "0");
    }

    g_lyp_info[make_tag((uint32_t)layer_number, (uint32_t)datatype_number)] = entry;
}

void loadLypText(const std::string& xml_text) {
    g_lyp_info.clear();
    g_lyp_order_counter = 0;

    // KLayout .lyp: the root <layer-properties> holds top-level <properties>
    // blocks. A <properties> block is either a single layer (has <source>
    // directly) or a group -- a <name> (the category, e.g. "Metals") plus one
    // or more <group-members>, each itself a layer or a further nested subgroup.
    // <properties> never nests; only <group-members> does. So: walk top-level
    // <properties> blocks; when a block contains <group-members>, its leading
    // <name> is the category; then flatten every <group-members> region into
    // leaf entries. Splitting on "<group-members>" flattens nested subgroups
    // too (a subgroup-header region carries no <source>, so parse_lyp_leaf skips
    // it), and every leaf inherits the outermost category -- exactly the flat
    // two-level (category -> layers) view the sidebar wants.
    const std::string props = "<properties>";
    const std::string members = "<group-members>";
    size_t prop_pos = xml_text.find(props);
    while (prop_pos != std::string::npos) {
        size_t block_start = prop_pos + props.length();
        size_t next_prop = xml_text.find(props, block_start);
        size_t block_end = (next_prop == std::string::npos) ? xml_text.length() : next_prop;
        std::string top_block = xml_text.substr(block_start, block_end - block_start);
        prop_pos = next_prop;

        size_t first_members = top_block.find(members);
        if (first_members == std::string::npos) {
            // Flat single-layer entry, no category.
            parse_lyp_leaf(top_block, "");
            continue;
        }

        std::string category;
        std::string name_text;
        std::string header = top_block.substr(0, first_members);
        if (extract_tag_value(header, "name", name_text)) category = trim(name_text);

        for (size_t m = first_members; m != std::string::npos;) {
            size_t leaf_start = m + members.length();
            size_t next_m = top_block.find(members, leaf_start);
            size_t leaf_end = (next_m == std::string::npos) ? top_block.length() : next_m;
            parse_lyp_leaf(top_block.substr(leaf_start, leaf_end - leaf_start), category);
            m = next_m;
        }
    }

    apply_lyp_to_layers();
    request_redraw();
}

// Small UI-facing summary (layer number, display name, CSS colors,
// visibility) for building the sidebar layer list in JS -- no per-polygon
// geometry crosses this boundary, just one short string/bool/number tuple
// per layer. Ordered with .lyp-defined layers first (in the order they
// appeared in the file, matching KLayout's own layer panel), then any
// .lyp-less layers present in the GDS, sorted numerically.
val getLayers() {
    std::vector<const LayerBuffer*> ordered;
    ordered.reserve(g_layers.size());
    for (const LayerBuffer& l : g_layers) ordered.push_back(&l);

    std::sort(ordered.begin(), ordered.end(), [](const LayerBuffer* a, const LayerBuffer* b) {
        auto ita = g_lyp_info.find(a->tag());
        auto itb = g_lyp_info.find(b->tag());
        bool has_a = ita != g_lyp_info.end();
        bool has_b = itb != g_lyp_info.end();
        if (has_a != has_b) return has_a;
        if (has_a && has_b && ita->second.order != itb->second.order)
            return ita->second.order < itb->second.order;
        if (a->layer != b->layer) return a->layer < b->layer;
        return a->datatype < b->datatype;
    });

    val result = val::array();
    int idx = 0;
    for (const LayerBuffer* l : ordered) {
        val obj = val::object();
        obj.set("layer", l->layer);
        obj.set("datatype", l->datatype);
        auto it = g_lyp_info.find(l->tag());
        obj.set("name", it != g_lyp_info.end() ? it->second.name : std::string());
        obj.set("group", it != g_lyp_info.end() ? it->second.group : std::string());
        obj.set("fillColor", rgba_to_css(l->fill_color));
        obj.set("frameColor", rgba_to_css(l->frame_color));
        obj.set("visible", l->visible);
        result.set(idx++, obj);
    }
    return result;
}

// Toggle a single (layer, datatype). g_lyp_info is updated too so the
// visibility sticks across a GDS reload (apply_layer_colors reads it back).
void setLayerVisible(uint32_t layer_number, uint32_t datatype, bool visible) {
    uint64_t tag = make_tag(layer_number, datatype);
    for (LayerBuffer& l : g_layers) {
        if (l.tag() == tag) {
            l.visible = visible;
            break;
        }
    }
    auto it = g_lyp_info.find(tag);
    if (it != g_lyp_info.end()) it->second.visible = visible;
    request_redraw();
}

void setShowInfill(bool show) {
    g_show_infill = show;
    request_redraw();
}

// The dat.gui "Merge Overlaps" checkbox -- see g_merge_mode/draw_layer_merged.
void setMergeMode(bool on) {
    g_merge_mode = on;
    request_redraw();
}

// Discards any in-progress or finalized measurement (the label hides on the
// next draw_frame via update_measure_label). Bound to Escape in viewer.js;
// also called on mode exit and when a new file replaces the geometry the
// measurement referred to.
void clearMeasurement() {
    g_measure_has_line = false;
    g_measure_pending = false;
    // No DOM in headless (plain Node) runs -- mirror loadAndRenderGds's guard.
    if (!g_gl_ready) return;
    // draw_frame early-returns with no layers, so it can't hide the label
    // itself in the load-error path -- hide it directly.
    update_measure_label();
    request_redraw();
}

// Ruler on/off (the dat.gui "Measure" checkbox / M key in viewer.js). While
// on, canvas clicks measure instead of pan (see on_mousedown); wheel zoom
// still works. The crosshair cursor is the mode's visual cue.
void setMeasureMode(bool on) {
    g_measure_mode = on;
    g_dragging = false;
    if (!on) clearMeasurement();
    if (!g_gl_ready) return;  // no DOM in headless (plain Node) runs
    val canvas = val::global("document").call<val>("getElementById", std::string("glCanvas"));
    if (!canvas.isNull() && !canvas.isUndefined()) {
        canvas["style"].set("cursor", std::string(on ? "crosshair" : "default"));
    }
}

int main() {
    g_gl_ready = init_gl();
    if (!g_gl_ready) return 0;
    emscripten_set_mousedown_callback("#glCanvas", nullptr, false, on_mousedown);
    emscripten_set_mousemove_callback("#glCanvas", nullptr, false, on_mousemove);
    emscripten_set_mouseup_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW, nullptr, false, on_mouseup);
    emscripten_set_wheel_callback("#glCanvas", nullptr, false, on_wheel);
    emscripten_set_resize_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW, nullptr, false, on_resize);
    resize_canvas();
    return 0;
}

EMSCRIPTEN_BINDINGS(gdstk_renderer_module) {
    function("loadAndRenderGds", &loadAndRenderGds);
    function("parseGdsToLayers", &parseGdsToLayers);
    function("uploadLayers", &uploadLayers);
    function("showLoadError", &showLoadError);
    function("loadLypText", &loadLypText);
    function("getLayers", &getLayers);
    function("setLayerVisible", &setLayerVisible);
    function("resetView", &reset_view);
    function("setShowInfill", &setShowInfill);
    function("setMergeMode", &setMergeMode);
    function("setMeasureMode", &setMeasureMode);
    function("clearMeasurement", &clearMeasurement);
}
