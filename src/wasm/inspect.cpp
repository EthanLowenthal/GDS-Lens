// See inspect.hpp for what this is and what it costs.
#include "inspect.hpp"

#include <algorithm>
#include <climits>
#include <cmath>
#include <limits>

#include "gds_common.hpp"

using namespace gdstk;

namespace inspect {

namespace {

// Ceiling on placements entered per query. Each one is a point transform and
// a box test, so this is tens of milliseconds at most; it exists for a file
// whose arrays overlap each other thousands deep, where an honest answer
// would take seconds, and the result says it stopped early.
constexpr uint64_t kMaxVisits = 4'000'000;

// Below this many items a cell is scanned whole rather than gridded: the
// grid's bookkeeping would cost more than it saves.
constexpr size_t kLinearItems = 32;

// An item whose box covers more bins than this goes on the cell's `big` list
// instead of into every bin it touches, which keeps one die-spanning wire from
// costing a grid's worth of entries.
constexpr int64_t kMaxBinsPerItem = 16;

constexpr int kMaxBinsPerAxis = 2048;

Xform compose(const Xform& outer, const Xform& inner) {
    Xform r;
    r.a = outer.a * inner.a + outer.b * inner.c;
    r.b = outer.a * inner.b + outer.b * inner.d;
    r.c = outer.c * inner.a + outer.d * inner.c;
    r.d = outer.c * inner.b + outer.d * inner.d;
    Vec2 t = outer.apply(inner.tx, inner.ty);
    r.tx = t.x;
    r.ty = t.y;
    return r;
}

// Clamps a double to the int64 range before it is converted, so a wildly
// out-of-range array index cannot overflow the cast.
int64_t clamp_index(double v, int64_t lo, int64_t hi) {
    if (!(v > (double)lo)) return lo;
    if (v >= (double)hi) return hi;
    return (int64_t)v;
}

// Which copies i in [0, n) of a one-axis array with step s can put the
// offset i*s inside [lo, hi]. Empty when first > last.
void copy_range(double lo, double hi, double s, uint64_t n, int64_t& first, int64_t& last) {
    const int64_t top = (int64_t)n - 1;
    if (s == 0.0) {
        first = (lo <= 0.0 && hi >= 0.0) ? 0 : 1;
        last = (lo <= 0.0 && hi >= 0.0) ? top : 0;
        return;
    }
    double a = lo / s, b = hi / s;
    if (a > b) std::swap(a, b);
    first = clamp_index(std::ceil(a), 0, top + 1);
    last = clamp_index(std::floor(b), -1, top);
}

}  // namespace

Index::~Index() {
    for (Node& node : nodes_) {
        for (Repetition& rep : node.reps) rep.clear();
    }
}

uint32_t Index::tag_slot(Tag tag) {
    auto it = tag_slots_.find(tag);
    if (it != tag_slots_.end()) return it->second;
    uint32_t slot = (uint32_t)tags_.size();
    tags_.push_back(tag);
    tag_slots_[tag] = slot;
    return slot;
}

uint32_t Index::node_for(Cell* cell, std::vector<Cell*>& pending) {
    auto it = index_of_.find(cell);
    if (it != index_of_.end()) return it->second;
    uint32_t index = (uint32_t)nodes_.size();
    nodes_.emplace_back();
    index_of_[cell] = index;
    pending.push_back(cell);
    return index;
}

// Quantized to the file's database unit, which every coordinate the reader
// produced sits on already (path outlines aside, which a writer would round
// the same way). Clamped rather than wrapped, for an OASIS file whose varints
// run past what 32 bits hold.
void Index::append_polygon(Node& node, const Polygon* poly, double dx, double dy) {
    const uint64_t count = poly->point_array.count;
    if (count == 0) return;
    starts_.push_back((uint32_t)node.vertices);
    for (uint64_t k = 0; k < count; k++) {
        const Vec2& p = poly->point_array[k];
        const double qx = std::round((p.x + dx) / grid_);
        const double qy = std::round((p.y + dy) / grid_);
        const int32_t ix = (int32_t)std::max((double)INT32_MIN, std::min((double)INT32_MAX, qx));
        const int32_t iy = (int32_t)std::max((double)INT32_MIN, std::min((double)INT32_MAX, qy));
        xy_.push_back(ix);
        xy_.push_back(iy);
        node.own.add(ix * grid_, iy * grid_);
    }
    node.vertices += count;
    node.polygons++;
    tag_index_.push_back(tag_slot(poly->tag));
}

// A cell's own shapes as the renderer draws them -- repetitions expanded,
// paths turned into their outlines (see collect_instanced in renderer.cpp,
// which asks gdstk for the same thing) -- and its placements, each kept as one
// record. The library's copies are freed as they are taken, so the peak is
// the file plus one cell's worth rather than the file twice.
void Index::convert(Cell* cell, uint32_t index, std::vector<Cell*>& pending) {
    // Built locally and moved in at the end: node_for below appends to
    // nodes_, which would leave a reference into it dangling.
    Node node;
    node.name = cell->name ? cell->name : "";
    // Cells are converted one at a time, so each one's runs in the shared
    // arrays are contiguous.
    node.xy_begin = xy_.size() / 2;
    node.poly_begin = starts_.size();
    node.place_begin = placements_.size();

    auto take = [this, &node](Polygon* poly) {
        if (poly->repetition.type == RepetitionType::None) {
            append_polygon(node, poly, 0.0, 0.0);
        } else {
            Array<Vec2> offsets = {};
            poly->repetition.get_offsets(offsets);
            for (uint64_t k = 0; k < offsets.count; k++) append_polygon(node, poly, offsets[k].x, offsets[k].y);
            offsets.clear();
        }
        poly->clear();
        free_allocation(poly);
    };

    for (uint64_t i = 0; i < cell->polygon_array.count; i++) take(cell->polygon_array[i]);
    cell->polygon_array.clear();

    Array<Polygon*> outlines = {};
    for (uint64_t i = 0; i < cell->flexpath_array.count; i++) {
        FlexPath* path = cell->flexpath_array[i];
        path->to_polygons(false, 0, outlines);
        for (uint64_t k = 0; k < outlines.count; k++) take(outlines[k]);
        outlines.count = 0;
        path->clear();
        free_allocation(path);
    }
    cell->flexpath_array.clear();
    for (uint64_t i = 0; i < cell->robustpath_array.count; i++) {
        RobustPath* path = cell->robustpath_array[i];
        path->to_polygons(false, 0, outlines);
        for (uint64_t k = 0; k < outlines.count; k++) take(outlines[k]);
        outlines.count = 0;
        path->clear();
        free_allocation(path);
    }
    cell->robustpath_array.clear();
    outlines.clear();

    // Text is not a shape anyone clicks to select here; the renderer keeps
    // its own copy for drawing.
    for (uint64_t i = 0; i < cell->label_array.count; i++) {
        cell->label_array[i]->clear();
        free_allocation(cell->label_array[i]);
    }
    cell->label_array.clear();

    for (uint64_t i = 0; i < cell->reference_array.count; i++) {
        Reference* ref = cell->reference_array[i];
        if (ref->type == ReferenceType::Cell && ref->cell != nullptr) {
            Placement p;
            p.tx = ref->origin.x;
            p.ty = ref->origin.y;
            p.rotation = ref->rotation;
            p.magnification = ref->magnification;
            p.x_reflection = ref->x_reflection ? 1 : 0;
            p.child = node_for(ref->cell, pending);
            p.sibling = node.sibling_counts[p.child]++;
            p.rep = kNoRep;
            if (ref->repetition.type != RepetitionType::None && ref->repetition.get_count() > 0) {
                Repetition rep = {};
                rep.copy_from(ref->repetition);
                p.rep = (uint32_t)node.reps.size();
                node.reps.push_back(rep);
            }
            placements_.push_back(p);
            node.placements++;
        }
        ref->clear();
        free_allocation(ref);
    }
    cell->reference_array.clear();

    nodes_[index] = std::move(node);
}

void Index::build(Library& lib, const std::string& root_name) {
    if (lib.unit > 0.0 && lib.precision > 0.0) grid_ = lib.precision / lib.unit;

    std::vector<Cell*> roots = gds_common::default_roots(lib);
    Cell* chosen = root_name.empty() ? nullptr : lib.get_cell(root_name.c_str());
    if (chosen) {
        roots.assign(1, chosen);
        root_ = root_name;
    }

    // The shared arrays sized up front from the whole library, which bounds
    // what the drawn tops can reach. Grown by doubling instead, the largest of
    // them would briefly need half as much again on top of the file's own
    // objects, at the point where the heap is fullest. Path outlines are not
    // counted (their size is only known once they are built) and grow as
    // needed.
    {
        uint64_t points = 0, polygons = 0, references = 0;
        for (uint64_t c = 0; c < lib.cell_array.count; c++) {
            const Cell* cell = lib.cell_array[c];
            for (uint64_t i = 0; i < cell->polygon_array.count; i++) {
                const Polygon* poly = cell->polygon_array[i];
                const uint64_t copies = std::max<uint64_t>(1, poly->repetition.get_count());
                points += poly->point_array.count * copies;
                polygons += copies;
            }
            references += cell->reference_array.count;
        }
        xy_.reserve(2 * points);
        starts_.reserve(polygons);
        tag_index_.reserve(polygons);
        placements_.reserve(references);
    }

    // Breadth-first over what the drawn tops reach; node i is pending[i].
    std::vector<Cell*> pending;
    for (Cell* cell : roots) roots_.push_back(node_for(cell, pending));
    for (size_t i = 0; i < pending.size(); i++) convert(pending[i], (uint32_t)i, pending);

    std::vector<uint8_t> state(nodes_.size(), 0);
    for (uint32_t i = 0; i < nodes_.size(); i++) subtree_box(i, state);
}

const Index::Box& Index::subtree_box(uint32_t index, std::vector<uint8_t>& state) {
    Node& node = nodes_[index];
    if (state[index] == 2) return node.subtree;
    // A malformed file whose references close a loop: the back edge
    // contributes nothing rather than recursing forever.
    if (state[index] == 1) return node.own;
    state[index] = 1;
    Box box = node.own;
    for (size_t k = 0; k < node.placements; k++) {
        const Placement& p = placements_[node.place_begin + k];
        subtree_box(p.child, state);
        box.add(placement_box(node, p));
    }
    node.subtree = box;
    state[index] = 2;
    return node.subtree;
}

namespace {

// The reference's own transform minus any array offset, matching
// reference_linear_transform/reference_placement in renderer.cpp.
template <typename P>
Xform placement_xform(const P& p, double ox, double oy) {
    const double ca = std::cos(p.rotation), sa = std::sin(p.rotation);
    const double sy = p.x_reflection ? -1.0 : 1.0;
    const double mag = p.magnification;
    Xform t;
    t.a = mag * ca;
    t.b = -mag * sy * sa;
    t.c = mag * sa;
    t.d = mag * sy * ca;
    t.tx = p.tx + ox;
    t.ty = p.ty + oy;
    return t;
}

}  // namespace

Index::Box Index::placement_box(const Node& parent, const Placement& p) const {
    const Box& child = nodes_[p.child].subtree;
    Box placed;
    if (!child.valid()) return placed;
    const Xform t = placement_xform(p, 0.0, 0.0);
    const double xs[2] = {child.min_x, child.max_x};
    const double ys[2] = {child.min_y, child.max_y};
    for (double x : xs) {
        for (double y : ys) {
            Vec2 w = t.apply(x, y);
            placed.add(w.x, w.y);
        }
    }
    if (p.rep == kNoRep) return placed;

    Array<Vec2> extrema = {};
    parent.reps[p.rep].get_extrema(extrema);
    Box spread;
    for (uint64_t k = 0; k < extrema.count; k++) {
        spread.add(placed.min_x + extrema[k].x, placed.min_y + extrema[k].y);
        spread.add(placed.max_x + extrema[k].x, placed.max_y + extrema[k].y);
    }
    extrema.clear();
    return spread;
}

void Index::build_grid(Node& node) {
    node.grid_built = true;
    const size_t polygons = node.polygons;
    const size_t count = polygons + node.placements;
    if (count <= kLinearItems) return;

    // Each item's box is worked out again on every pass rather than kept: on
    // a cell of millions of items a box apiece would cost more than the grid.
    auto box_of = [this, &node, polygons](size_t i) {
        if (i >= polygons) return placement_box(node, placements_[node.place_begin + i - polygons]);
        Box b;
        for (size_t k = poly_first(node, i), end = poly_end(node, i); k < end; k++) {
            b.add(xy_[2 * k] * grid_, xy_[2 * k + 1] * grid_);
        }
        return b;
    };
    const Box& extent = node.subtree;
    if (!extent.valid()) return;

    // About one bin per item, shaped like the cell, but never smaller than a
    // typical item: bins finer than the shapes in them only multiply entries.
    // The typical size is the median of an even sample of items, which is as
    // good as the median of all of them for this and costs a fixed amount.
    constexpr size_t kSizeSample = 4096;
    const size_t step = std::max<size_t>(1, count / kSizeSample);
    std::vector<double> widths, heights;
    for (size_t i = 0; i < count; i += step) {
        const Box b = box_of(i);
        if (!b.valid()) continue;
        widths.push_back(b.max_x - b.min_x);
        heights.push_back(b.max_y - b.min_y);
    }
    if (widths.empty()) return;
    std::nth_element(widths.begin(), widths.begin() + widths.size() / 2, widths.end());
    std::nth_element(heights.begin(), heights.begin() + heights.size() / 2, heights.end());
    const double median_w = widths[widths.size() / 2];
    const double median_h = heights[heights.size() / 2];

    const double w = std::max(extent.max_x - extent.min_x, grid_);
    const double h = std::max(extent.max_y - extent.min_y, grid_);
    double nx = std::round(std::sqrt((double)count * w / h));
    nx = std::max(1.0, std::min((double)kMaxBinsPerAxis, nx));
    double ny = std::max(1.0, std::min((double)kMaxBinsPerAxis, std::ceil((double)count / nx)));
    const double bin_w = std::max(w / nx, median_w);
    const double bin_h = std::max(h / ny, median_h);

    Grid& g = node.grid;
    g.x0 = extent.min_x;
    g.y0 = extent.min_y;
    g.bin_w = bin_w;
    g.bin_h = bin_h;
    g.nx = (int)std::max(1.0, std::min((double)kMaxBinsPerAxis, std::ceil(w / bin_w)));
    g.ny = (int)std::max(1.0, std::min((double)kMaxBinsPerAxis, std::ceil(h / bin_h)));

    auto bin_range = [&g](const Box& b, int& x0, int& x1, int& y0, int& y1) {
        x0 = (int)clamp_index(std::floor((b.min_x - g.x0) / g.bin_w), 0, g.nx - 1);
        x1 = (int)clamp_index(std::floor((b.max_x - g.x0) / g.bin_w), 0, g.nx - 1);
        y0 = (int)clamp_index(std::floor((b.min_y - g.y0) / g.bin_h), 0, g.ny - 1);
        y1 = (int)clamp_index(std::floor((b.max_y - g.y0) / g.bin_h), 0, g.ny - 1);
    };

    // Two passes, counting then filling, so the item list is one exact
    // allocation rather than a vector per bin.
    std::vector<uint32_t> counts((size_t)g.nx * g.ny + 1, 0);
    for (size_t i = 0; i < count; i++) {
        const Box b = box_of(i);
        if (!b.valid()) continue;
        int x0, x1, y0, y1;
        bin_range(b, x0, x1, y0, y1);
        if ((int64_t)(x1 - x0 + 1) * (y1 - y0 + 1) > kMaxBinsPerItem) {
            g.big.push_back((uint32_t)i);
            continue;
        }
        for (int y = y0; y <= y1; y++) {
            for (int x = x0; x <= x1; x++) counts[(size_t)y * g.nx + x]++;
        }
    }
    g.bin_start.assign(counts.size(), 0);
    for (size_t b = 1; b < counts.size(); b++) g.bin_start[b] = g.bin_start[b - 1] + counts[b - 1];
    g.items.assign(g.bin_start.back(), 0);
    std::vector<uint32_t> cursor(g.bin_start.begin(), g.bin_start.end() - 1);
    for (size_t i = 0; i < count; i++) {
        const Box b = box_of(i);
        if (!b.valid()) continue;
        int x0, x1, y0, y1;
        bin_range(b, x0, x1, y0, y1);
        if ((int64_t)(x1 - x0 + 1) * (y1 - y0 + 1) > kMaxBinsPerItem) continue;
        for (int y = y0; y <= y1; y++) {
            for (int x = x0; x <= x1; x++) g.items[cursor[(size_t)y * g.nx + x]++] = (uint32_t)i;
        }
    }
    g.big.shrink_to_fit();
}

// Inside by the even-odd rule (what a self-overlapping boundary fills as when
// triangulated is not something to promise more than that about), or within
// `tol` of the boundary, so a hairline wire is still something a pointer can
// land on.
bool Index::polygon_hit(const Node& node, uint32_t i, double x, double y, double tol) const {
    const size_t first = poly_first(node, i);
    const size_t n = poly_end(node, i) - first;
    if (n == 0) return false;
    bool inside = false;
    double best = HUGE_VAL;
    const double tol2 = tol * tol;
    for (size_t k = 0; k < n; k++) {
        const size_t a = first + k;
        const size_t b = first + (k + 1 == n ? 0 : k + 1);
        const double ax = xy_[2 * a] * grid_, ay = xy_[2 * a + 1] * grid_;
        const double bx = xy_[2 * b] * grid_, by = xy_[2 * b + 1] * grid_;
        if ((ay > y) != (by > y)) {
            const double cross_x = ax + (y - ay) * (bx - ax) / (by - ay);
            if (x < cross_x) inside = !inside;
        }
        if (tol > 0.0 && best > tol2) {
            const double ex = bx - ax, ey = by - ay;
            const double len2 = ex * ex + ey * ey;
            double t = len2 > 0.0 ? ((x - ax) * ex + (y - ay) * ey) / len2 : 0.0;
            t = std::max(0.0, std::min(1.0, t));
            const double dx = ax + t * ex - x, dy = ay + t * ey - y;
            best = std::min(best, dx * dx + dy * dy);
        }
    }
    return inside || best <= tol2;
}

void Index::descend(Node& parent, const Placement& p, const Xform& to_world, double ox, double oy, int64_t copy,
                    int64_t copies, int64_t column, int64_t row, Walk& walk) {
    if (walk.truncated) return;
    PathStep step;
    step.cell = nodes_[p.child].name;
    step.sibling = p.sibling;
    step.siblings = parent.sibling_counts[p.child];
    step.copy = copy;
    step.copies = copies;
    step.column = column;
    step.row = row;
    walk.path.push_back(std::move(step));
    visit(p.child, compose(to_world, placement_xform(p, ox, oy)), walk);
    walk.path.pop_back();
}

// Enters only the copies of a placement whose box can hold the point: worked
// out from the array's lattice for the two regular kinds, so a 4000 x 4000
// array costs the handful of copies near the point and not 16 million box
// tests. lx/ly/ltol are in the parent's frame.
void Index::visit_placement(Node& node, const Placement& p, const Xform& to_world, double lx, double ly,
                            double ltol, Walk& walk) {
    const Box& child = nodes_[p.child].subtree;
    if (!child.valid()) return;
    Box reach;
    const Xform linear = placement_xform(p, 0.0, 0.0);
    const double xs[2] = {child.min_x, child.max_x};
    const double ys[2] = {child.min_y, child.max_y};
    for (double x : xs) {
        for (double y : ys) {
            Vec2 w = linear.apply(x, y);
            reach.add(w.x - p.tx, w.y - p.ty);
        }
    }
    // The offsets that would bring a copy's box over the point.
    const double lo_x = lx - p.tx - reach.max_x - ltol, hi_x = lx - p.tx - reach.min_x + ltol;
    const double lo_y = ly - p.ty - reach.max_y - ltol, hi_y = ly - p.ty - reach.min_y + ltol;
    auto wanted = [&](double ox, double oy) { return ox >= lo_x && ox <= hi_x && oy >= lo_y && oy <= hi_y; };

    if (p.rep == kNoRep) {
        if (wanted(0.0, 0.0)) descend(node, p, to_world, 0.0, 0.0, -1, 0, -1, -1, walk);
        return;
    }
    const Repetition& rep = node.reps[p.rep];
    const int64_t copies = (int64_t)rep.get_count();
    switch (rep.type) {
        case RepetitionType::Rectangular: {
            int64_t i0, i1, j0, j1;
            copy_range(lo_x, hi_x, rep.spacing.x, rep.columns, i0, i1);
            copy_range(lo_y, hi_y, rep.spacing.y, rep.rows, j0, j1);
            for (int64_t i = i0; i <= i1 && !walk.truncated; i++) {
                for (int64_t j = j0; j <= j1 && !walk.truncated; j++) {
                    // get_offsets' order: column-major.
                    descend(node, p, to_world, (double)i * rep.spacing.x, (double)j * rep.spacing.y,
                            i * (int64_t)rep.rows + j, copies, i, j, walk);
                }
            }
            break;
        }
        case RepetitionType::Regular: {
            const Vec2 v1 = rep.v1, v2 = rep.v2;
            const double det = v1.x * v2.y - v1.y * v2.x;
            int64_t i0 = 0, i1 = (int64_t)rep.columns - 1, j0 = 0, j1 = (int64_t)rep.rows - 1;
            if (std::fabs(det) > 0.0) {
                // The rectangle of wanted offsets mapped back onto the
                // lattice's (i, j) axes, and the box around that.
                double min_i = HUGE_VAL, max_i = -HUGE_VAL, min_j = HUGE_VAL, max_j = -HUGE_VAL;
                const double cx[2] = {lo_x, hi_x}, cy[2] = {lo_y, hi_y};
                for (double ox : cx) {
                    for (double oy : cy) {
                        const double fi = (ox * v2.y - oy * v2.x) / det;
                        const double fj = (v1.x * oy - v1.y * ox) / det;
                        min_i = std::min(min_i, fi);
                        max_i = std::max(max_i, fi);
                        min_j = std::min(min_j, fj);
                        max_j = std::max(max_j, fj);
                    }
                }
                i0 = std::max(i0, clamp_index(std::ceil(min_i), 0, i1 + 1));
                i1 = std::min(i1, clamp_index(std::floor(max_i), -1, i1));
                j0 = std::max(j0, clamp_index(std::ceil(min_j), 0, j1 + 1));
                j1 = std::min(j1, clamp_index(std::floor(max_j), -1, j1));
            }
            for (int64_t i = i0; i <= i1 && !walk.truncated; i++) {
                for (int64_t j = j0; j <= j1 && !walk.truncated; j++) {
                    const double ox = (double)i * v1.x + (double)j * v2.x;
                    const double oy = (double)i * v1.y + (double)j * v2.y;
                    if (!wanted(ox, oy)) continue;
                    descend(node, p, to_world, ox, oy, i * (int64_t)rep.rows + j, copies, i, j, walk);
                }
            }
            break;
        }
        // Listed offsets have no lattice to solve against, so each is tested;
        // they are stored one by one in the file anyway.
        case RepetitionType::Explicit:
        case RepetitionType::ExplicitX:
        case RepetitionType::ExplicitY: {
            for (int64_t k = 0; k < copies && !walk.truncated; k++) {
                double ox = 0.0, oy = 0.0;
                if (k > 0) {
                    if (rep.type == RepetitionType::Explicit) {
                        ox = rep.offsets[k - 1].x;
                        oy = rep.offsets[k - 1].y;
                    } else if (rep.type == RepetitionType::ExplicitX) {
                        ox = rep.coords[k - 1];
                    } else {
                        oy = rep.coords[k - 1];
                    }
                }
                if (wanted(ox, oy)) descend(node, p, to_world, ox, oy, k, copies, -1, -1, walk);
            }
            break;
        }
        case RepetitionType::None:
            break;
    }
}

void Index::visit(uint32_t index, const Xform& to_world, Walk& walk) {
    if (walk.truncated) return;
    if (++walk.visits > kMaxVisits) {
        walk.truncated = true;
        return;
    }
    Node& node = nodes_[index];
    const double det = to_world.det();
    if (det == 0.0 || !std::isfinite(det)) return;
    // The point and the tolerance carried into this cell's frame.
    const double rx = walk.x - to_world.tx, ry = walk.y - to_world.ty;
    const double lx = (to_world.d * rx - to_world.b * ry) / det;
    const double ly = (-to_world.c * rx + to_world.a * ry) / det;
    const double ltol = walk.tolerance / std::sqrt(std::fabs(det));
    if (!node.subtree.contains(lx, ly, ltol)) return;
    if (!node.grid_built) build_grid(node);

    const size_t polygons = node.polygons;
    auto consider = [&](uint32_t item) {
        if (item >= polygons) {
            visit_placement(node, placements_[node.place_begin + item - polygons], to_world, lx, ly, ltol, walk);
            return;
        }
        auto rank = walk.ranks->find(tags_[tag_index_[node.poly_begin + item]]);
        if (rank == walk.ranks->end()) return;
        if (!polygon_hit(node, item, lx, ly, ltol)) return;
        Hit hit;
        hit.tag = rank->first;
        hit.rank = rank->second;
        hit.path = walk.path;
        hit.placement = to_world;
        const size_t first = poly_first(node, item), end = poly_end(node, item);
        hit.points.reserve((end - first) * 2);
        double twice_area = 0.0;
        for (size_t k = first; k < end; k++) {
            Vec2 w = to_world.apply(xy_[2 * k] * grid_, xy_[2 * k + 1] * grid_);
            hit.points.push_back(w.x);
            hit.points.push_back(w.y);
        }
        const size_t n = hit.points.size() / 2;
        for (size_t k = 0; k < n; k++) {
            const size_t m = k + 1 == n ? 0 : k + 1;
            twice_area += hit.points[2 * k] * hit.points[2 * m + 1] - hit.points[2 * m] * hit.points[2 * k + 1];
        }
        hit.area = std::fabs(twice_area) * 0.5;
        double nearest = std::numeric_limits<double>::infinity();
        for (size_t k = 0; k < n; k++) {
            const size_t m = k + 1 == n ? 0 : k + 1;
            const double ax = hit.points[2 * k], ay = hit.points[2 * k + 1];
            const double ex = hit.points[2 * m] - ax, ey = hit.points[2 * m + 1] - ay;
            const double len2 = ex * ex + ey * ey;
            double t = len2 > 0.0 ? ((walk.x - ax) * ex + (walk.y - ay) * ey) / len2 : 0.0;
            t = std::min(1.0, std::max(0.0, t));
            nearest = std::min(nearest, std::hypot(walk.x - (ax + t * ex), walk.y - (ay + t * ey)));
        }
        hit.edge_distance = nearest;
        walk.hits.push_back(std::move(hit));
    };

    const Grid& g = node.grid;
    if (g.nx == 0) {
        const size_t count = polygons + node.placements;
        for (size_t i = 0; i < count && !walk.truncated; i++) consider((uint32_t)i);
        return;
    }
    // Every bin the tolerance square touches, plus the big items, each once.
    std::vector<uint32_t> candidates(g.big.begin(), g.big.end());
    const int x0 = (int)clamp_index(std::floor((lx - ltol - g.x0) / g.bin_w), 0, g.nx - 1);
    const int x1 = (int)clamp_index(std::floor((lx + ltol - g.x0) / g.bin_w), 0, g.nx - 1);
    const int y0 = (int)clamp_index(std::floor((ly - ltol - g.y0) / g.bin_h), 0, g.ny - 1);
    const int y1 = (int)clamp_index(std::floor((ly + ltol - g.y0) / g.bin_h), 0, g.ny - 1);
    for (int y = y0; y <= y1; y++) {
        for (int x = x0; x <= x1; x++) {
            const size_t bin = (size_t)y * g.nx + x;
            candidates.insert(candidates.end(), g.items.begin() + g.bin_start[bin],
                              g.items.begin() + g.bin_start[bin + 1]);
        }
    }
    std::sort(candidates.begin(), candidates.end());
    candidates.erase(std::unique(candidates.begin(), candidates.end()), candidates.end());
    for (uint32_t item : candidates) {
        if (walk.truncated) break;
        consider(item);
    }
}

QueryResult Index::query(double x, double y, double tolerance, const std::unordered_map<Tag, double>& ranks,
                         size_t limit) {
    Walk walk;
    walk.x = x;
    walk.y = y;
    walk.tolerance = std::max(0.0, tolerance);
    walk.ranks = &ranks;
    for (uint32_t root : roots_) {
        PathStep top;
        top.cell = nodes_[root].name;
        walk.path.assign(1, top);
        visit(root, Xform{}, walk);
    }
    // Nearest edge first. Layers are usually drawn as outlines, so what the
    // user is pointing at is the outline closest to the pointer: the small
    // shape they clicked inside rather than a large one enclosing it (a cell
    // boundary, a floorplan box), whose edges are far away. Clicking on the
    // large shape's own edge still selects it. Ties go to the smaller shape,
    // then to the layer drawn last. Sorted here as well as in the viewer
    // because `limit` keeps only the front of this order.
    std::stable_sort(walk.hits.begin(), walk.hits.end(), [](const Hit& a, const Hit& b) {
        if (a.edge_distance != b.edge_distance) return a.edge_distance < b.edge_distance;
        if (a.area != b.area) return a.area < b.area;
        return a.rank > b.rank;
    });
    QueryResult result;
    result.total = walk.hits.size();
    result.truncated = walk.truncated;
    if (walk.hits.size() > limit) walk.hits.resize(limit);
    result.hits = std::move(walk.hits);
    return result;
}

Snapshot Index::take() {
    Snapshot out;
    out.grid = grid_;
    out.root = root_;
    out.roots = std::move(roots_);
    for (Tag tag : tags_) out.tags.push_back((double)tag);
    out.xy = std::move(xy_);
    out.starts = std::move(starts_);
    out.tag_index = std::move(tag_index_);
    out.placements = std::move(placements_);
    out.names.reserve(nodes_.size());
    out.counts.reserve(nodes_.size() * 4);
    out.boxes.reserve(nodes_.size() * 8);
    for (Node& node : nodes_) {
        out.names.push_back(std::move(node.name));
        out.counts.insert(out.counts.end(), {(double)node.vertices, (double)node.polygons,
                                             (double)node.placements, (double)node.reps.size()});
        for (Repetition& r : node.reps) {
            const bool lattice = r.type == RepetitionType::Rectangular || r.type == RepetitionType::Regular;
            const Vec2 v1 = r.type == RepetitionType::Rectangular ? r.spacing
                                                                  : (lattice ? r.v1 : Vec2{0.0, 0.0});
            const Vec2 v2 = r.type == RepetitionType::Regular ? r.v2 : Vec2{0.0, 0.0};
            uint64_t n = 0;
            if (r.type == RepetitionType::Explicit) n = r.offsets.count;
            else if (!lattice) n = r.coords.count;
            out.reps.insert(out.reps.end(), {(double)(int)r.type, lattice ? (double)r.columns : 0.0,
                                             lattice ? (double)r.rows : 0.0, v1.x, v1.y, v2.x, v2.y, (double)n});
            for (uint64_t k = 0; k < n; k++) {
                if (r.type == RepetitionType::Explicit) {
                    out.reps.push_back(r.offsets[k].x);
                    out.reps.push_back(r.offsets[k].y);
                } else {
                    out.reps.push_back(r.coords[k]);
                }
            }
            r.clear();
        }
        node.reps.clear();
        out.boxes.insert(out.boxes.end(), {node.own.min_x, node.own.min_y, node.own.max_x, node.own.max_y,
                                           node.subtree.min_x, node.subtree.min_y, node.subtree.max_x,
                                           node.subtree.max_y});
    }
    nodes_.clear();
    nodes_.shrink_to_fit();
    index_of_.clear();
    tags_.clear();
    tag_slots_.clear();
    return out;
}

void Index::restore(Snapshot&& in) {
    grid_ = in.grid;
    root_ = std::move(in.root);
    roots_ = std::move(in.roots);
    for (double tag : in.tags) tag_slot((Tag)(uint64_t)tag);
    xy_ = std::move(in.xy);
    starts_ = std::move(in.starts);
    tag_index_ = std::move(in.tag_index);
    placements_ = std::move(in.placements);
    const size_t count = in.names.size();
    nodes_.resize(count);
    size_t xy = 0, poly = 0, place = 0, rep = 0;
    for (size_t i = 0; i < count; i++) {
        Node& node = nodes_[i];
        node.name = std::move(in.names[i]);
        node.xy_begin = xy;
        node.vertices = (size_t)in.counts[4 * i];
        node.poly_begin = poly;
        node.polygons = (size_t)in.counts[4 * i + 1];
        node.place_begin = place;
        node.placements = (size_t)in.counts[4 * i + 2];
        xy += node.vertices;
        poly += node.polygons;
        place += node.placements;
        for (size_t k = 0; k < node.placements; k++) {
            node.sibling_counts[placements_[node.place_begin + k].child]++;
        }
        const size_t reps = (size_t)in.counts[4 * i + 3];
        for (size_t k = 0; k < reps; k++) {
            const double* f = in.reps.data() + rep;
            Repetition r = {};
            r.type = (RepetitionType)(int)f[0];
            const uint64_t n = (uint64_t)f[7];
            if (r.type == RepetitionType::Rectangular) {
                r.columns = (uint64_t)f[1];
                r.rows = (uint64_t)f[2];
                r.spacing = Vec2{f[3], f[4]};
            } else if (r.type == RepetitionType::Regular) {
                r.columns = (uint64_t)f[1];
                r.rows = (uint64_t)f[2];
                r.v1 = Vec2{f[3], f[4]};
                r.v2 = Vec2{f[5], f[6]};
            } else if (r.type == RepetitionType::Explicit) {
                r.offsets.ensure_slots(n);
                for (uint64_t j = 0; j < n; j++) r.offsets.append(Vec2{f[8 + 2 * j], f[9 + 2 * j]});
            } else {
                r.coords.ensure_slots(n);
                for (uint64_t j = 0; j < n; j++) r.coords.append(f[8 + j]);
            }
            // n is 0 for the two lattice kinds, which list nothing.
            rep += 8 + (r.type == RepetitionType::Explicit ? 2 * n : n);
            node.reps.push_back(r);
        }
        const double* b = in.boxes.data() + 8 * i;
        node.own = Box{b[0], b[1], b[2], b[3]};
        node.subtree = Box{b[4], b[5], b[6], b[7]};
    }
    in = Snapshot();
}

uint64_t Index::vertex_count() const { return xy_.size() / 2; }
uint64_t Index::polygon_count() const { return tag_index_.size(); }
uint64_t Index::placement_count() const { return placements_.size(); }

}  // namespace inspect
