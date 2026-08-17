// The GLSL sources for every pass renderer.cpp draws. Kept apart from the
// renderer itself because they are pure data with no dependency on any of its
// state, and because having them in one small file makes the whole shader set
// readable at once -- and easy to feed to a validator (see DEVELOPING.md).
//
// Each constant is a #version 300 es (WebGL2 / GLSL ES 3.0) source string. The
// uniform and attribute names are bound by init_gl() in renderer.cpp, which is
// where the corresponding g_*_loc_* handles live.
#pragma once

namespace shaders {

// The three a_instance* attributes carry a per-instance 2x3 affine (2x2
// linear part split into two columns + a translation) mapping an instanced
// batch's unit-shape local coordinates to world space (see InstancedBatch /
// draw_frame). Their array pointers are only enabled for instanced draws; for
// every other (static) draw the arrays stay disabled and each attribute reads
// its context-level "generic" value instead, which init_gl sets to the
// identity map (col0=(1,0), col1=(0,1), translate=(0,0)) so a_position passes
// through unchanged -- no separate non-instanced shader needed.
inline const char* const kVertexShaderSrc =
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
inline const char* const kFragmentShaderSrc =
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
inline const char* const kMaskFragmentShaderSrc =
    "#version 300 es\n"
    "precision mediump float;\n"
    "out vec4 fragColor;\n"
    "void main() { fragColor = vec4(1.0); }";

// Fullscreen triangle for merge mode's composite pass, derived from
// gl_VertexID -- no vertex buffer, no attributes. (0,0)/(2,0)/(0,2) in UV
// maps to clip-space (-1,-1)/(3,-1)/(-1,3), covering the screen with one
// triangle.
inline const char* const kCompositeVertexShaderSrc =
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
inline const char* const kCompositeFragmentShaderSrc =
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

// Background reference grid (see draw_grid), drawn as a fullscreen pass over
// the cleared canvas before any geometry. Reuses kCompositeVertexShaderSrc's
// attribute-free fullscreen triangle.
//
// Two decade levels are drawn at once so the grid can level-of-detail with
// zoom without the pitch ever popping: level 0 is the finer decade (its
// on-screen pitch runs from kGridTargetPx down to a tenth of that as you zoom
// out) and level 1 is ten times coarser. Level 0's alpha fades to zero exactly
// as its pitch approaches the too-dense end, so at the moment the CPU-side
// decade counter ticks over -- level 0 becoming what level 1 was -- nothing
// visible changes: the level that leaves the pair had already faded out, and
// the new coarse level's lines are a subset of the existing ones at the same
// alpha. Both levels therefore use one alpha ceiling; a brighter "major" level
// would make that new level pop into view on every decade crossing.
//
// Lines are positioned in world space (unlike the layer hatch patterns, which
// are deliberately screen-space) -- the whole point is for a grid square to
// mean a fixed distance on the layout. Coordinates come in pre-reduced modulo
// each level's pitch (u_panMod) because a full-chip pan offset divided by a
// nanometre-scale pitch overflows highp float's 24-bit mantissa and the grid
// visibly tears; the reduction happens on the CPU in double precision. Line
// width and anti-aliasing are exact in pixels -- the distance to the nearest
// line is linear in gl_FragCoord, so no fwidth() is needed.
inline const char* const kGridFragmentShaderSrc =
    "#version 300 es\n"
    "precision highp float;\n"
    "uniform vec2 u_resolution;\n"
    "uniform float u_zoom;\n"
    "uniform vec2 u_panMod[2];\n"
    "uniform float u_spacing[2];\n"
    "uniform float u_levelAlpha[2];\n"
    "uniform vec4 u_color;\n"
    "uniform float u_halfWidthPx;\n"
    "out vec4 fragColor;\n"
    // Pixel distance from this fragment to the nearest line of a grid with the
    // given world-space pitch, turned into an anti-aliased 1-pixel-ish line.
    "float gridMask(vec2 rel, float spacing) {\n"
    "    vec2 t = abs(fract(rel / spacing + 0.5) - 0.5) * (spacing * u_zoom);\n"
    "    float d = min(t.x, t.y);\n"
    "    return 1.0 - smoothstep(u_halfWidthPx, u_halfWidthPx + 1.0, d);\n"
    "}\n"
    "void main() {\n"
    // Pixels from the canvas center; gl_FragCoord.y is bottom-up, matching
    // world +y (see screen_to_world's inverse of the same transform).
    "    vec2 p = gl_FragCoord.xy - u_resolution * 0.5;\n"
    "    float a = 0.0;\n"
    "    for (int i = 0; i < 2; i++) {\n"
    "        a = max(a, gridMask(u_panMod[i] + p / u_zoom, u_spacing[i]) * u_levelAlpha[i]);\n"
    "    }\n"
    "    if (a <= 0.0) discard;\n"
    "    fragColor = vec4(u_color.rgb, u_color.a * a);\n"
    "}";

// Label ("text") rendering: GDSII TEXT / OASIS TEXT elements draw as stroked
// glyphs at a constant on-screen size (see stroke_font.hpp / rebuild_text_buffer),
// so a_position is the label's world-space origin and a_offset is the glyph
// vertex's offset from it in *pixels* -- the offset is added after the camera
// zoom, which is what keeps the text the same size at every zoom level. That
// also means the vertex data itself never depends on the camera, so panning
// only re-picks which labels are in view, never re-shapes a glyph.
inline const char* const kTextVertexShaderSrc =
    "#version 300 es\n"
    "in vec2 a_position;\n"
    "in vec2 a_offset;\n"
    "uniform vec2 u_resolution;\n"
    "uniform vec2 u_offset;\n"
    "uniform float u_zoom;\n"
    "void main() {\n"
    "    vec2 screenPos = (a_position - u_offset) * u_zoom + a_offset;\n"
    "    vec2 clipSpace = (screenPos / u_resolution) * 2.0;\n"
    "    gl_Position = vec4(clipSpace.x, clipSpace.y, 0.0, 1.0);\n"
    "}";

// ---- Pick pass (see pick_snap_at in renderer.cpp) ---------------------------
// Answers a question the CPU has no data left to answer: where is the nearest
// vertex or edge for the ruler to snap to. The geometry only exists in VBOs --
// nothing is retained CPU-side after upload -- so the answer comes from
// rasterizing a small window of the scene into an integer framebuffer and
// reading it back.
//
// The vertex half is kVertexShaderSrc with the world position passed through to
// the fragment stage, which is what makes snapping exact rather than
// pixel-quantized: for a GL_POINTS draw the varying is constant across the
// point, so a hit texel carries the vertex's own coordinates, and for GL_LINES
// it interpolates to a point that lies on the edge. gl_PointSize is written
// unconditionally (it's ignored for every other primitive) because GLES leaves
// it undefined otherwise, and the points pass depends on it.
inline const char* const kPickVertexShaderSrc =
    "#version 300 es\n"
    "in vec2 a_position;\n"
    "in vec2 a_iCol0;\n"
    "in vec2 a_iCol1;\n"
    "in vec2 a_iTranslate;\n"
    "uniform vec2 u_resolution;\n"
    "uniform vec2 u_offset;\n"
    "uniform float u_zoom;\n"
    "out vec2 v_world;\n"
    "void main() {\n"
    "    vec2 worldPos = vec2(\n"
    "        a_iCol0.x * a_position.x + a_iCol1.x * a_position.y + a_iTranslate.x,\n"
    "        a_iCol0.y * a_position.x + a_iCol1.y * a_position.y + a_iTranslate.y);\n"
    "    v_world = worldPos;\n"
    "    vec2 clipSpace = ((worldPos - u_offset) * u_zoom / u_resolution) * 2.0;\n"
    "    gl_Position = vec4(clipSpace.x, clipSpace.y, 0.0, 1.0);\n"
    "    gl_PointSize = 1.0;\n"
    "}";

// Writes the caller's id plus the fragment's world position into an RGBA32UI
// target. The position goes through floatBitsToUint rather than into a float
// target because RGBA32UI is color-renderable in core WebGL2 while RGBA32F
// needs EXT_color_buffer_float; the bits survive the round trip untouched and
// the reader casts them back. Alpha marks the texel as written, since 0 is a
// legitimate value for all three of the others.
inline const char* const kPickFragmentShaderSrc =
    "#version 300 es\n"
    "precision highp float;\n"
    "precision highp int;\n"
    "in vec2 v_world;\n"
    "uniform uint u_pickId;\n"
    "out uvec4 fragId;\n"
    "void main() {\n"
    "    fragId = uvec4(u_pickId, floatBitsToUint(v_world.x), floatBitsToUint(v_world.y), 1u);\n"
    "}";

inline const char* const kTextFragmentShaderSrc =
    "#version 300 es\n"
    "precision mediump float;\n"
    "uniform vec4 u_color;\n"
    "out vec4 fragColor;\n"
    "void main() { fragColor = u_color; }";

}  // namespace shaders
