// GDSII and OASIS properties as the JSON the viewer reads.
//
// A property list becomes an array of entries, in the order the file wrote
// them:
//
//   GDSII   {"attr": 7, "value": "text"}
//   OASIS   {"name": "S_CELL_OFFSET", "values": [12, "text", 1.5]}
//
// A GDSII PROPVALUE is text, padded to an even length with NUL bytes, which
// are dropped. A string that is not valid UTF-8, or that holds control bytes
// other than tab, newline and carriage return, is written with those bytes as
// \xNN and the entry gains "binary": true, so the viewer can say the value is
// not plain text.
//
// The lists are interned: shapes that carry the same list (a whole array of
// them, typically) share one id, and the table goes to the viewer once.
#ifndef GDS_LENS_PROPERTY_JSON_HPP
#define GDS_LENS_PROPERTY_JSON_HPP

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include <gdstk/gdstk.hpp>

namespace property_json {

// The list as a JSON array, or an empty string when it has no properties.
std::string encode(const gdstk::Property* properties);

// Interned property lists. Id 0 means "no properties"; real lists count from 1.
class Table {
   public:
    uint32_t intern(const gdstk::Property* properties);
    // A JSON array of every list, list i at position i - 1.
    std::string json() const;
    size_t size() const { return lists_.size(); }
    void clear();

   private:
    std::vector<std::string> lists_;
    std::unordered_map<std::string, uint32_t> ids_;
};

}  // namespace property_json

#endif  // GDS_LENS_PROPERTY_JSON_HPP
