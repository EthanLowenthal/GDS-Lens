// Owns everything viewer.js's WebGL2 code used to do: GL context + shader
// setup, layer-batched vertex buffers, camera (pan/zoom) state, input
// handling, .lyp color parsing, and scale-bar text/width. JS now only
// instantiates the module and relays postMessage payloads into
// loadAndRenderGds()/loadLypText() -- it never touches per-polygon data.
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

const char* kVertexShaderSrc =
    "#version 300 es\n"
    "in vec2 a_position;\n"
    "uniform vec2 u_resolution;\n"
    "uniform vec2 u_offset;\n"
    "uniform float u_zoom;\n"
    "void main() {\n"
    "    vec2 centeredPos = a_position - u_offset;\n"
    "    vec2 zoomedPos = centeredPos * u_zoom;\n"
    "    vec2 clipSpace = (zoomedPos / u_resolution) * 2.0;\n"
    "    gl_Position = vec4(clipSpace.x, clipSpace.y, 0.0, 1.0);\n"
    "}";

const char* kFragmentShaderSrc =
    "#version 300 es\n"
    "precision highp float;\n"
    "uniform vec4 u_color;\n"
    "out vec4 fragColor;\n"
    "void main() { fragColor = u_color; }";

struct PolygonRange {
    GLint first;
    GLsizei count;
};

// One pair of VBOs per layer (fill triangles + outline points) holding all
// of that layer's polygons back-to-back, plus per-polygon (first, count)
// ranges so each polygon still draws as its own primitive group -- LINE_LOOP
// loops can't be naively concatenated (the loop-closing edge would connect
// unrelated polygons), and triangle fans from ear-clipping are similarly
// per-polygon.
struct LayerBuffer {
    uint32_t layer;
    GLuint outline_vbo = 0;
    GLuint fill_vbo = 0;
    std::vector<PolygonRange> outline_polygons;
    std::vector<PolygonRange> fill_polygons;
    std::array<float, 4> fill_color{};
    std::array<float, 4> frame_color{};
    bool visible = true;
};

// Parsed out of a single <properties> block in a .lyp file. Persists across
// GDS reloads (same as the old g_lyp_colors did) so re-opening/replacing the
// GDS file keeps previously-applied layer styling.
struct LypEntry {
    std::string name;
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
GLint g_loc_resolution = -1;
GLint g_loc_color = -1;
GLint g_loc_offset = -1;
GLint g_loc_zoom = -1;

std::vector<LayerBuffer> g_layers;
std::unordered_map<uint32_t, LypEntry> g_lyp_info;
int g_lyp_order_counter = 0;

float g_zoom = 1.0f;
float g_pan_x = 0.0f;
float g_pan_y = 0.0f;
int g_canvas_width = 0;
int g_canvas_height = 0;

bool g_dragging = false;
int g_last_mouse_x = 0;
int g_last_mouse_y = 0;

bool g_frame_requested = false;

GLuint compile_shader(GLenum type, const char* source) {
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &source, nullptr);
    glCompileShader(shader);
    return shader;
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

    g_program = glCreateProgram();
    glAttachShader(g_program, compile_shader(GL_VERTEX_SHADER, kVertexShaderSrc));
    glAttachShader(g_program, compile_shader(GL_FRAGMENT_SHADER, kFragmentShaderSrc));
    glLinkProgram(g_program);

    g_loc_position = glGetAttribLocation(g_program, "a_position");
    g_loc_resolution = glGetUniformLocation(g_program, "u_resolution");
    g_loc_color = glGetUniformLocation(g_program, "u_color");
    g_loc_offset = glGetUniformLocation(g_program, "u_offset");
    g_loc_zoom = glGetUniformLocation(g_program, "u_zoom");

    glGenVertexArrays(1, &g_vao);
    glBindVertexArray(g_vao);

    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    return true;
}

// Mirrors the old JS per-layer color fallback hash (viewer.js:151-156) for
// layers with no matching .lyp entry.
std::array<float, 4> default_color(uint32_t layer) {
    float r = (float)((layer * 65) % 200 + 55) / 255.0f;
    float g = (float)((layer * 115) % 200 + 55) / 255.0f;
    float b = (float)((layer * 175) % 200 + 55) / 255.0f;
    return {r, g, b, 0.8f};
}

// Resolves a layer's fill/frame color + visibility from g_lyp_info (falling
// back to the hash color above for layers with no .lyp entry, or for the
// half of a fill/frame pair that's missing from the entry).
void apply_layer_colors(LayerBuffer& layer) {
    auto it = g_lyp_info.find(layer.layer);
    if (it == g_lyp_info.end()) {
        std::array<float, 4> base = default_color(layer.layer);
        layer.fill_color = {base[0], base[1], base[2], 0.4f};
        layer.frame_color = {base[0], base[1], base[2], 0.9f};
        layer.visible = true;
        return;
    }
    const LypEntry& e = it->second;
    std::array<float, 4> base = default_color(layer.layer);
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
                if (point_in_tri(pts[remaining[j]], a, b, c)) {
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

    for (const LayerBuffer& layer : g_layers) {
        if (!layer.visible) continue;

        if (layer.fill_vbo) {
            glBindBuffer(GL_ARRAY_BUFFER, layer.fill_vbo);
            glEnableVertexAttribArray(g_loc_position);
            glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
            glUniform4fv(g_loc_color, 1, layer.fill_color.data());
            for (const PolygonRange& range : layer.fill_polygons) {
                glDrawArrays(GL_TRIANGLES, range.first, range.count);
            }
        }

        glBindBuffer(GL_ARRAY_BUFFER, layer.outline_vbo);
        glEnableVertexAttribArray(g_loc_position);
        glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
        glUniform4fv(g_loc_color, 1, layer.frame_color.data());
        for (const PolygonRange& range : layer.outline_polygons) {
            glDrawArrays(GL_LINE_LOOP, range.first, range.count);
        }
    }
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
    update_scale_bar();
    request_redraw();
}

void clear_layers() {
    for (LayerBuffer& layer : g_layers) {
        if (layer.outline_vbo) glDeleteBuffers(1, &layer.outline_vbo);
        if (layer.fill_vbo) glDeleteBuffers(1, &layer.fill_vbo);
    }
    g_layers.clear();
}

void flatten_cell_by_layer(Cell* cell, std::unordered_map<uint32_t, std::vector<Polygon*>>& by_layer) {
    Array<Polygon*> polygons = {};
    // Same call shape as bindings.cpp's flatten_cell_into: apply_repetitions
    // expands AREF/array repetitions, include_paths converts
    // FlexPath/RobustPath outlines to polygons, depth=-1 recurses the full
    // reference tree.
    cell->get_polygons(true, true, -1, false, 0, polygons);
    for (uint64_t i = 0; i < polygons.count; i++) {
        Polygon* poly = polygons[i];
        by_layer[get_layer(poly->tag)].push_back(poly);
    }
    polygons.clear();
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
    g_dragging = true;
    g_last_mouse_x = e->clientX;
    g_last_mouse_y = e->clientY;
    return true;
}

bool on_mousemove(int /*eventType*/, const EmscriptenMouseEvent* e, void* /*userData*/) {
    if (!g_dragging) return false;
    int dx = e->clientX - g_last_mouse_x;
    int dy = e->clientY - g_last_mouse_y;
    g_pan_x -= dx / g_zoom;
    g_pan_y += dy / g_zoom;
    g_last_mouse_x = e->clientX;
    g_last_mouse_y = e->clientY;
    request_redraw();
    return true;
}

bool on_mouseup(int /*eventType*/, const EmscriptenMouseEvent* /*e*/, void* /*userData*/) {
    g_dragging = false;
    return true;
}

bool on_wheel(int /*eventType*/, const EmscriptenWheelEvent* e, void* /*userData*/) {
    if (e->deltaY < 0) g_zoom *= 1.15f;
    else g_zoom /= 1.15f;
    update_scale_bar();
    request_redraw();
    return true;
}

bool on_resize(int /*eventType*/, const EmscriptenUiEvent* /*e*/, void* /*userData*/) {
    resize_canvas();
    return true;
}

}  // namespace

void loadAndRenderGds(const std::string& path) {
    if (!g_gl_ready) {
        // No WebGL2-capable canvas (e.g. running under plain Node) -- use
        // parseGds() instead for headless parse-path testing.
        return;
    }
    clear_layers();

    ErrorCode error_code = ErrorCode::NoError;
    Library lib = read_gds(path.c_str(), 1e-6, 1e-2, NULL, &error_code);

    if (gds_common::is_fatal(error_code)) {
        set_inner_html("ui", std::string("<b>Error</b><br>") + gds_common::error_string(error_code));
        lib.free_all();
        request_redraw();
        return;
    }

    Array<Cell*> top_cells = {};
    Array<RawCell*> top_rawcells = {};
    lib.top_level(top_cells, top_rawcells);

    std::unordered_map<uint32_t, std::vector<Polygon*>> by_layer;
    uint64_t rendered_top_cells = 0;
    for (uint64_t i = 0; i < top_cells.count; i++) {
        if (gds_common::is_metadata_cell(top_cells[i])) continue;
        flatten_cell_by_layer(top_cells[i], by_layer);
        rendered_top_cells++;
    }
    if (rendered_top_cells == 0 && lib.cell_array.count > 0) {
        flatten_cell_by_layer(lib.cell_array[lib.cell_array.count - 1], by_layer);
    }
    top_cells.clear();
    top_rawcells.clear();

    double min_x = HUGE_VAL, max_x = -HUGE_VAL;
    double min_y = HUGE_VAL, max_y = -HUGE_VAL;
    uint64_t total_polygons = 0;

    for (auto& entry : by_layer) {
        uint32_t layer_number = entry.first;
        std::vector<Polygon*>& polys = entry.second;

        LayerBuffer layer_buffer;
        layer_buffer.layer = layer_number;

        uint64_t point_total = 0;
        for (Polygon* poly : polys) point_total += poly->point_array.count;

        std::vector<float> vertices;
        vertices.reserve(point_total * 2);
        std::vector<float> fill_vertices;
        std::vector<uint32_t> tri_indices;

        for (Polygon* poly : polys) {
            GLint first = (GLint)(vertices.size() / 2);
            for (uint64_t i = 0; i < poly->point_array.count; i++) {
                const Vec2& pt = poly->point_array[i];
                vertices.push_back((float)pt.x);
                vertices.push_back((float)pt.y);
                min_x = std::min(min_x, pt.x);
                max_x = std::max(max_x, pt.x);
                min_y = std::min(min_y, pt.y);
                max_y = std::max(max_y, pt.y);
            }
            layer_buffer.outline_polygons.push_back({first, (GLsizei)poly->point_array.count});
            total_polygons++;

            tri_indices.clear();
            triangulate(poly->point_array, tri_indices);
            if (!tri_indices.empty()) {
                GLint fill_first = (GLint)(fill_vertices.size() / 2);
                for (uint32_t idx : tri_indices) {
                    const Vec2& pt = poly->point_array[idx];
                    fill_vertices.push_back((float)pt.x);
                    fill_vertices.push_back((float)pt.y);
                }
                layer_buffer.fill_polygons.push_back({fill_first, (GLsizei)tri_indices.size()});
            }
        }

        glGenBuffers(1, &layer_buffer.outline_vbo);
        glBindBuffer(GL_ARRAY_BUFFER, layer_buffer.outline_vbo);
        glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(vertices.size() * sizeof(float)), vertices.data(), GL_STATIC_DRAW);

        if (!fill_vertices.empty()) {
            glGenBuffers(1, &layer_buffer.fill_vbo);
            glBindBuffer(GL_ARRAY_BUFFER, layer_buffer.fill_vbo);
            glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(fill_vertices.size() * sizeof(float)), fill_vertices.data(),
                         GL_STATIC_DRAW);
        }

        apply_layer_colors(layer_buffer);

        g_layers.push_back(std::move(layer_buffer));

        for (Polygon* poly : polys) {
            poly->clear();
            free_allocation(poly);
        }
    }

    lib.free_all();

    if (total_polygons > 0 && min_x <= max_x) {
        double total_width = max_x - min_x;
        double total_height = max_y - min_y;
        g_pan_x = (float)(min_x + total_width / 2.0);
        g_pan_y = (float)(min_y + total_height / 2.0);
        double zoom_x = g_canvas_width / (total_width > 0 ? total_width : 1.0);
        double zoom_y = g_canvas_height / (total_height > 0 ? total_height : 1.0);
        g_zoom = (float)(std::min(zoom_x, zoom_y) * 0.85);
    } else {
        g_zoom = 1.0f;
        g_pan_x = 0.0f;
        g_pan_y = 0.0f;
    }

    set_inner_html("ui", "<b>GDSII Core Engine Active</b><br>Polygons: " + std::to_string(total_polygons));
    update_scale_bar();
    request_redraw();
}

void loadLypText(const std::string& xml_text) {
    g_lyp_info.clear();
    g_lyp_order_counter = 0;

    // Split on "<properties>" and, within each chunk up to the next
    // occurrence, pull out <source> (layer[/datatype]), <name>, <visible>,
    // and <fill-color>/<frame-color>. Nested group members (<group-members>)
    // aren't handled -- same limitation the old color-only parser had.
    const std::string marker = "<properties>";
    size_t marker_pos = 0;
    while ((marker_pos = xml_text.find(marker, marker_pos)) != std::string::npos) {
        size_t content_start = marker_pos + marker.length();
        size_t next_marker = xml_text.find(marker, content_start);
        size_t content_end = (next_marker == std::string::npos) ? xml_text.length() : next_marker;
        std::string block = xml_text.substr(content_start, content_end - content_start);
        marker_pos = content_end;

        std::string source_text;
        if (!extract_tag_value(block, "source", source_text)) continue;
        std::string layer_text = trim(source_text.substr(0, source_text.find('/')));
        if (layer_text.empty()) continue;
        char* endptr = nullptr;
        long layer_number = strtol(layer_text.c_str(), &endptr, 10);
        if (endptr == layer_text.c_str()) continue;

        LypEntry entry;
        entry.order = g_lyp_order_counter++;

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
        if (!entry.has_fill && !entry.has_frame) continue;

        std::string name_text;
        if (extract_tag_value(block, "name", name_text)) entry.name = trim(name_text);

        std::string visible_text;
        if (extract_tag_value(block, "visible", visible_text)) {
            std::string v = trim(visible_text);
            entry.visible = !(v == "false" || v == "0");
        }

        g_lyp_info[(uint32_t)layer_number] = entry;
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
        auto ita = g_lyp_info.find(a->layer);
        auto itb = g_lyp_info.find(b->layer);
        bool has_a = ita != g_lyp_info.end();
        bool has_b = itb != g_lyp_info.end();
        if (has_a != has_b) return has_a;
        if (has_a && has_b) return ita->second.order < itb->second.order;
        return a->layer < b->layer;
    });

    val result = val::array();
    int idx = 0;
    for (const LayerBuffer* l : ordered) {
        val obj = val::object();
        obj.set("layer", l->layer);
        auto it = g_lyp_info.find(l->layer);
        obj.set("name", it != g_lyp_info.end() ? it->second.name : std::string());
        obj.set("fillColor", rgba_to_css(l->fill_color));
        obj.set("frameColor", rgba_to_css(l->frame_color));
        obj.set("visible", l->visible);
        result.set(idx++, obj);
    }
    return result;
}

void setLayerVisible(uint32_t layer_number, bool visible) {
    for (LayerBuffer& l : g_layers) {
        if (l.layer == layer_number) {
            l.visible = visible;
            break;
        }
    }
    auto it = g_lyp_info.find(layer_number);
    if (it != g_lyp_info.end()) it->second.visible = visible;
    request_redraw();
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
    function("loadLypText", &loadLypText);
    function("getLayers", &getLayers);
    function("setLayerVisible", &setLayerVisible);
}
