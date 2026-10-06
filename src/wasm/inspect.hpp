// Click-to-inspect: which shapes lie under a point, and where each one came
// from in the cell hierarchy.
//
// The renderer cannot answer that from what it keeps. Its static geometry is
// flattened into one world-space buffer per layer with no record of which cell
// or placement put a polygon there, and after uploadLayers only the GPU copy
// survives. So this works from the layout itself instead: the file is read
// again (in a Worker of its own, see wasm-worker.js) and kept *unflattened*,
// as one compact geometry list per cell plus that cell's placements. A query
// walks down from the drawn top cells, carrying the point into each placed
// cell's own frame, so the cell path and the specific placement fall out of
// the walk rather than having to be stored per polygon.
//
// What that costs is the hierarchy's own size rather than the flattened one:
// 8 bytes per vertex of each cell's own geometry (int32 database units), 8
// bytes per polygon, and 48 bytes per placement record, where an array
// reference is one record however many copies it makes. Each cell's spatial
// grid is built on its first query, about 4 to 8 bytes per item. A cell placed
// a million times costs its geometry once, which is the case flattening is
// worst at. Every cell's vertices, polygons and placements sit in one shared
// array each, so the whole index moves between Workers as a few buffers (see
// Snapshot).
//
// No GL, no DOM and no embind here: renderer.cpp wraps this for the module's
// exports, and the tests drive it headlessly in Node.
#ifndef GDS_LENS_INSPECT_HPP
#define GDS_LENS_INSPECT_HPP

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include <gdstk/gdstk.hpp>

namespace inspect {

// A 2x3 affine, column vector convention: (a b; c d) then (tx, ty).
struct Xform {
    double a = 1.0, b = 0.0, c = 0.0, d = 1.0, tx = 0.0, ty = 0.0;

    gdstk::Vec2 apply(double x, double y) const { return {a * x + b * y + tx, c * x + d * y + ty}; }
    double det() const { return a * d - b * c; }
};

// One step of the path from a drawn top cell down to the cell that owns a
// shape. The first step is the top cell itself and carries no placement.
struct PathStep {
    std::string cell;
    // Which of the parent's placements of this cell the walk went through:
    // `sibling` of `siblings` references in the parent that place this same
    // cell (0-based), and for a repeated (array) reference, the copy within
    // it. column/row are set for a rectangular or regular array, `copy` for
    // every repeated reference. -1 where not applicable.
    int64_t sibling = -1;
    int64_t siblings = 0;
    int64_t copy = -1;
    int64_t copies = 0;
    int64_t column = -1;
    int64_t row = -1;
};

struct Hit {
    gdstk::Tag tag = 0;
    std::vector<PathStep> path;
    // The owning cell's frame mapped into world space: what the walk
    // composed on its way down.
    Xform placement;
    // The polygon in world space, x/y interleaved.
    std::vector<double> points;
    // Area in µm² (the absolute shoelace area, in world units).
    double area = 0.0;
    // Distance in µm from the queried point to the nearest point on the
    // polygon's outline, 0 when the point is on an edge.
    double edge_distance = 0.0;
    // Where the layer sits in the draw order the caller passed (higher is
    // drawn later, so on top); -1 when it passed none for this tag.
    double rank = -1.0;
};

// One reference, without the per-copy expansion an array would need.
struct Placement {
    double tx, ty;
    double rotation;
    double magnification;
    uint32_t child;
    // Which of the parent's references to `child` this is (0-based).
    uint32_t sibling;
    // Index into the parent's repetitions, or kNoRep.
    uint32_t rep;
    uint32_t x_reflection;
};
static_assert(sizeof(Placement) == 48, "Placement crosses between Workers as raw bytes");

constexpr uint32_t kNoRep = 0xFFFFFFFFu;

// A built index as a handful of flat arrays, which is how it moves from the
// Worker that read the file to the one that answers queries (see
// inspectLoad in renderer.cpp for why there are two). The shared arrays are
// moved out whole; `counts` says how much of each is each node's.
struct Snapshot {
    double grid = 0.001;
    std::string root;
    std::vector<std::string> names;
    std::vector<uint32_t> roots;
    // Per node: vertices, polygons, placements, repetitions.
    std::vector<double> counts;
    std::vector<int32_t> xy;
    std::vector<uint32_t> starts;
    std::vector<uint32_t> tag_index;
    std::vector<double> tags;
    std::vector<Placement> placements;
    // Per repetition: type, columns, rows, v1.x, v1.y, v2.x, v2.y (spacing in
    // v1 for a rectangular one), n, then n listed offsets (pairs for Explicit,
    // single coordinates for ExplicitX/Y).
    std::vector<double> reps;
    // 8 per node: own box, then subtree box.
    std::vector<double> boxes;
};

struct QueryResult {
    std::vector<Hit> hits;
    // Every hit found before the limit was applied.
    uint64_t total = 0;
    // The walk stopped early on its placement budget (see kMaxVisits).
    bool truncated = false;
};

class Index {
   public:
    Index() = default;
    ~Index();
    Index(const Index&) = delete;
    Index& operator=(const Index&) = delete;

    // Converts every cell reachable from the drawn top cells (all of them, or
    // only `root_name` when it names a cell) and frees the library's geometry
    // as it goes. The caller still owns `lib` and frees what is left of it.
    void build(gdstk::Library& lib, const std::string& root_name);

    // The shapes on the given layers within `tolerance` of (x, y), all in world
    // µm. `ranks` maps each tag to its position in the draw order; shapes on a
    // tag absent from it are skipped, which is how hidden layers are left out.
    // Sorted topmost first: by rank, then smallest area first within a layer.
    // At most `limit` are returned with their geometry.
    QueryResult query(double x, double y, double tolerance, const std::unordered_map<gdstk::Tag, double>& ranks,
                      size_t limit);

    // Moves the index out into a Snapshot, leaving this one empty.
    Snapshot take();
    // Rebuilds an index from what take() produced.
    void restore(Snapshot&& snapshot);

    // The file's database unit, in µm: the step every coordinate sits on.
    double grid() const { return grid_; }
    // The cell drawn as the top, or empty when every top cell is.
    const std::string& root() const { return root_; }
    uint64_t vertex_count() const;
    uint64_t polygon_count() const;
    uint64_t placement_count() const;

   private:
    struct Box {
        double min_x = HUGE_VAL, min_y = HUGE_VAL, max_x = -HUGE_VAL, max_y = -HUGE_VAL;
        bool valid() const { return min_x <= max_x; }
        void add(double x, double y) {
            if (x < min_x) min_x = x;
            if (x > max_x) max_x = x;
            if (y < min_y) min_y = y;
            if (y > max_y) max_y = y;
        }
        void add(const Box& b) {
            if (!b.valid()) return;
            add(b.min_x, b.min_y);
            add(b.max_x, b.max_y);
        }
        bool contains(double x, double y, double pad) const {
            return x >= min_x - pad && x <= max_x + pad && y >= min_y - pad && y <= max_y + pad;
        }
    };

    // Uniform grid over a cell's items in its own frame: polygons are items
    // [0, polygon count), placements follow. Items too big for a few bins sit
    // in `big` and are checked on every query.
    struct Grid {
        double x0 = 0.0, y0 = 0.0, bin_w = 1.0, bin_h = 1.0;
        int nx = 0, ny = 0;
        std::vector<uint32_t> bin_start;
        std::vector<uint32_t> items;
        std::vector<uint32_t> big;
    };

    // A cell: its runs in the shared arrays, and what is its alone.
    struct Node {
        std::string name;
        // Its vertices are xy_[2*xy_begin ...], `vertices` of them.
        size_t xy_begin = 0, vertices = 0;
        // Its polygons are starts_/tag_index_[poly_begin ...]; polygon i's
        // first vertex is xy_begin + starts_[poly_begin + i].
        size_t poly_begin = 0, polygons = 0;
        size_t place_begin = 0, placements = 0;
        std::vector<gdstk::Repetition> reps;
        // How many of this cell's references place each child.
        std::unordered_map<uint32_t, uint32_t> sibling_counts;
        Box own;
        Box subtree;
        bool grid_built = false;
        Grid grid;
    };

    struct Walk {
        double x, y, tolerance;
        const std::unordered_map<gdstk::Tag, double>* ranks;
        std::vector<PathStep> path;
        std::vector<Hit> hits;
        uint64_t visits = 0;
        bool truncated = false;
    };

    uint32_t node_for(gdstk::Cell* cell, std::vector<gdstk::Cell*>& pending);
    void convert(gdstk::Cell* cell, uint32_t index, std::vector<gdstk::Cell*>& pending);
    void append_polygon(Node& node, const gdstk::Polygon* poly, double dx, double dy);
    // Polygon i of a node, as a range of vertex indices into xy_.
    size_t poly_first(const Node& node, size_t i) const { return node.xy_begin + starts_[node.poly_begin + i]; }
    size_t poly_end(const Node& node, size_t i) const {
        return i + 1 < node.polygons ? poly_first(node, i + 1) : node.xy_begin + node.vertices;
    }
    uint32_t tag_slot(gdstk::Tag tag);
    const Box& subtree_box(uint32_t index, std::vector<uint8_t>& state);
    Box placement_box(const Node& parent, const Placement& p) const;
    void build_grid(Node& node);
    void visit(uint32_t index, const Xform& to_world, Walk& walk);
    void visit_placement(Node& node, const Placement& p, const Xform& to_world, double lx, double ly,
                         double ltol, Walk& walk);
    void descend(Node& parent, const Placement& p, const Xform& to_world, double ox, double oy, int64_t copy,
                 int64_t copies, int64_t column, int64_t row, Walk& walk);
    bool polygon_hit(const Node& node, uint32_t i, double x, double y, double tol) const;

    std::vector<Node> nodes_;
    std::vector<int32_t> xy_;
    std::vector<uint32_t> starts_;
    std::vector<uint32_t> tag_index_;
    std::vector<Placement> placements_;
    std::vector<uint32_t> roots_;
    std::unordered_map<gdstk::Cell*, uint32_t> index_of_;
    std::vector<gdstk::Tag> tags_;
    std::unordered_map<gdstk::Tag, uint32_t> tag_slots_;
    double grid_ = 0.001;
    std::string root_;
};

}  // namespace inspect

#endif  // GDS_LENS_INSPECT_HPP
