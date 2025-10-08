#pragma once

#include <optional>
#include <algorithm>
#include <string>
#include <sstream>
#include <stdexcept>
#include <functional>
#include <cctype>
#include <iterator>

// Boost compatibility layer for WASM
// Replaces Boost dependencies with C++17 STL equivalents

namespace boost {

// boost::optional -> std::optional
template<typename T>
using optional = std::optional<T>;

constexpr std::nullopt_t none = std::nullopt;

// boost::algorithm namespace
namespace algorithm {

// Just use std::clamp directly via using declaration
using std::clamp;

// to_lower_copy
inline std::string to_lower_copy(const std::string& s) {
	std::string result = s;
	std::transform(result.begin(), result.end(), result.begin(),
		[](unsigned char c) { return std::tolower(c); });
	return result;
}

// trim
inline void trim(std::string& s) {
	// Trim left
	s.erase(s.begin(), std::find_if(s.begin(), s.end(), [](unsigned char ch) {
		return !std::isspace(ch);
	}));
	// Trim right
	s.erase(std::find_if(s.rbegin(), s.rend(), [](unsigned char ch) {
		return !std::isspace(ch);
	}).base(), s.end());
}

// trim_right
inline void trim_right(std::string& s) {
	s.erase(std::find_if(s.rbegin(), s.rend(), [](unsigned char ch) {
		return !std::isspace(ch);
	}).base(), s.end());
}

// trim_if
inline void trim_if(std::string& s, std::function<bool(char)> pred) {
	// Trim left
	s.erase(s.begin(), std::find_if(s.begin(), s.end(), [&pred](char ch) {
		return !pred(ch);
	}));
	// Trim right
	s.erase(std::find_if(s.rbegin(), s.rend(), [&pred](char ch) {
		return !pred(ch);
	}).base(), s.end());
}

// trim_right_if
inline void trim_right_if(std::string& s, std::function<bool(char)> pred) {
	s.erase(std::find_if(s.rbegin(), s.rend(), [&pred](char ch) {
		return !pred(ch);
	}).base(), s.end());
}

} // namespace algorithm

// boost::range::adaptors::transformed
namespace adaptors {

template<typename Range, typename Func>
class transformed_range {
public:
	using iterator_category = std::input_iterator_tag;
	using value_type = typename std::invoke_result<Func, typename Range::value_type>::type;
	using difference_type = std::ptrdiff_t;
	using pointer = value_type*;
	using reference = value_type;

	class iterator {
	public:
		using iterator_category = std::input_iterator_tag;
		using value_type = typename transformed_range::value_type;
		using difference_type = std::ptrdiff_t;
		using pointer = value_type*;
		using reference = value_type;

		iterator(typename Range::const_iterator it, Func func)
			: it_(it), func_(func) {}

		reference operator*() const {
			return func_(*it_);
		}

		iterator& operator++() {
			++it_;
			return *this;
		}

		iterator operator++(int) {
			iterator tmp = *this;
			++(*this);
			return tmp;
		}

		bool operator==(const iterator& other) const {
			return it_ == other.it_;
		}

		bool operator!=(const iterator& other) const {
			return it_ != other.it_;
		}

	private:
		typename Range::const_iterator it_;
		Func func_;
	};

	transformed_range(const Range& range, Func func)
		: range_(range), func_(func) {}

	iterator begin() const {
		return iterator(range_.begin(), func_);
	}

	iterator end() const {
		return iterator(range_.end(), func_);
	}

private:
	const Range& range_;
	Func func_;
};

template<typename Func>
class transformed_adaptor {
public:
	transformed_adaptor(Func func) : func_(func) {}

	template<typename Range>
	transformed_range<Range, Func> operator()(const Range& range) const {
		return transformed_range<Range, Func>(range, func_);
	}

private:
	Func func_;
};

template<typename Func>
transformed_adaptor<Func> transformed(Func func) {
	return transformed_adaptor<Func>(func);
}

// map_keys adaptor - extracts keys from map
template<typename Map>
class map_keys_range {
public:
	class iterator {
	public:
		using iterator_category = std::forward_iterator_tag;
		using value_type = typename Map::key_type;
		using difference_type = std::ptrdiff_t;
		using pointer = const value_type*;
		using reference = const value_type&;

		iterator(typename Map::const_iterator it) : it_(it) {}

		reference operator*() const { return it_->first; }
		pointer operator->() const { return &(it_->first); }

		iterator& operator++() {
			++it_;
			return *this;
		}

		iterator operator++(int) {
			iterator tmp = *this;
			++(*this);
			return tmp;
		}

		bool operator==(const iterator& other) const { return it_ == other.it_; }
		bool operator!=(const iterator& other) const { return it_ != other.it_; }

	private:
		typename Map::const_iterator it_;
	};

	map_keys_range(const Map& map) : map_(map) {}

	iterator begin() const { return iterator(map_.begin()); }
	iterator end() const { return iterator(map_.end()); }

private:
	const Map& map_;
};

class map_keys_adaptor {
public:
	template<typename Map>
	map_keys_range<Map> operator()(const Map& map) const {
		return map_keys_range<Map>(map);
	}
};

static const map_keys_adaptor map_keys;

// Pipe operator for range adaptors
template<typename Range, typename Func>
auto operator|(const Range& range, const transformed_adaptor<Func>& adaptor) {
	return adaptor(range);
}

template<typename Map>
auto operator|(const Map& map, const map_keys_adaptor& adaptor) {
	return adaptor(map);
}

} // namespace adaptors

namespace range {
namespace adaptors {
	using boost::adaptors::transformed;
}
}

// boost::lexical_cast -> std::stringstream
template<typename Target, typename Source>
Target lexical_cast(const Source& arg) {
	std::stringstream ss;
	ss << arg;
	Target result;
	ss >> result;
	if (ss.fail() || !ss.eof()) {
		throw std::bad_cast();
	}
	return result;
}

// Specialization for string -> string
template<>
inline std::string lexical_cast<std::string, std::string>(const std::string& arg) {
	return arg;
}

// Specialization for const char* -> string
template<>
inline std::string lexical_cast<std::string, const char*>(const char* const& arg) {
	return std::string(arg);
}

// Specialization for types to string
template<typename Source>
std::string lexical_cast(const Source& arg) {
	std::stringstream ss;
	ss << arg;
	return ss.str();
}

// boost::io::ios_flags_saver
namespace io {

class ios_flags_saver {
public:
	explicit ios_flags_saver(std::ostream& os)
		: stream_(os), flags_(os.flags()) {}

	~ios_flags_saver() {
		stream_.flags(flags_);
	}

	ios_flags_saver(const ios_flags_saver&) = delete;
	ios_flags_saver& operator=(const ios_flags_saver&) = delete;

private:
	std::ostream& stream_;
	std::ios_base::fmtflags flags_;
};

} // namespace io
} // namespace boost
