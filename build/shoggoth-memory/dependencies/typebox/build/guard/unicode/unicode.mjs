// ------------------------------------------------------------------
// CodePointCount (10-bit Shift Branchless)
//
// Counts code points by enumerating UTF-16 sequences and incrementing
// when not within a high/low pairing. Because surrogate blocks are
// 1024 (2^10) wide and aligned, by shifting right by (0xA), we can
// collapse each unit to a constant per block (high: 0x36, low: 0x37)
// and shift again into a packed (0x3637) for comparison. Fetch calls
// to charCodeAt(...) are kept to one call per iteration.
//
// ------------------------------------------------------------------
/** Returns the total number of Unicode code points in the string */
export function CodePointCount(value) {
    let result = 0, index = 0, prev = 0;
    while (index < value.length) {
        const next = value.charCodeAt(index++) >> 0xA; // shift  (10-bits into high/low)
        result += +(((prev << 8) | next) !== 0x3637); // packed (or +!(prev === 0x36 && next === 0x37))
        prev = next;
    }
    return result;
}
// ------------------------------------------------------------------
// IsMaxLength
// ------------------------------------------------------------------
/** Returns true if the string length in Unicode code points is less than or equal to maxLength */
export function IsMaxLength(value, maxLength) {
    return value.length <= maxLength || (value.length <= (maxLength << 1) && CodePointCount(value) <= maxLength);
}
// ------------------------------------------------------------------
// IsMinLength
// ------------------------------------------------------------------
/** Returns true if the string length in Unicode code points is greater than or equal to minLength */
export function IsMinLength(value, minLength) {
    return value.length >= (minLength << 1) || (value.length >= minLength && CodePointCount(value) >= minLength);
}
